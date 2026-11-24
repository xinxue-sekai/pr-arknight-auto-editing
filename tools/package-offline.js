#!/usr/bin/env node
/**
 * package-offline.js —— tools/package.js --offline 的离线安装包构建助手
 *
 * 为什么单独一个文件：
 *   在线 setup ZIP 的产品结构由 package-setup.js 维护，本助手不复制它的
 *   面板/后端快照逻辑，而是先让它构建 ordinary（面板 + 在线 setup）包，
 *   再把同一份暂存内容复制到隔离目录，追加锁定运行时文件与离线入口。
 *
 * 离线包与在线包共用同一个顶层目录（arknight-pr-setup/），区别只有：
 *   runtime-deps/  恰好三个、来自 runtime-lock.json 的归档/轮子，不重打包
 *   setup.bat      本助手生成的离线入口，转调 setup.ps1 -Offline
 *
 * 依赖来源（只读，不写用户缓存）：
 *   1. ARKNIGHT_TEST_DOWNLOAD_CACHE/<filename>（测试/CI 种子）
 *   2. %LOCALAPPDATA%\ArknightPR\cache\<filename>（安装器用户缓存）
 *   3. 缺失或种子哈希不符时，从 runtime-lock.json 的固定 URL 下载
 * 所有来源都必须 SHA256 相符；下载、复制、暂存各自在隔离目录中进行。
 * 只按锁文件里的文件名复制，因此种子目录里的其他文件不可能进入离线包。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const { writeZip } = require('./zip');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'cep-extension', 'install');
const LOCK_FILE = path.join(INSTALL, 'runtime-lock.json');
const DIST = path.join(ROOT, 'dist');
const ONLINE_STAGE = path.join(DIST, 'arknight-pr-setup');
const STAGE_NAME = 'arknight-pr-setup';
const RUNTIME_DIR = 'runtime-deps';
const LOCKED_FILE_COUNT = 3;
const ALLOWED_HOSTS = new Set(['www.python.org', 'files.pythonhosted.org']);
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// 离线入口由本构建助手拥有，不修改 cep-extension/install/setup.ps1。
// 必须保持纯 ASCII + CRLF：cmd.exe 对批处理的换行和编码很敏感。
const OFFLINE_BAT = [
    '@echo off',
    'setlocal',
    'echo Starting Arknight offline setup - using bundled runtime dependencies...',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Offline %*',
    'set "result=%errorlevel%"',
    'if not "%result%"=="0" echo Setup failed. See the error above.',
    'pause',
    'exit /b %result%',
    ''
].join('\r\n');

function fail(message) {
    throw new Error('Offline package: ' + message);
}

function humanSize(bytes) {
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function loadLockedDependencies() {
    let lock;
    try {
        lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch (error) {
        fail('cannot read runtime-lock.json: ' + error.message);
    }
    if (!lock || typeof lock !== 'object') { fail('runtime-lock.json must be an object'); }
    if (lock.platform !== 'win_amd64') {
        fail(`runtime-lock platform must be win_amd64, got ${JSON.stringify(lock.platform)}`);
    }
    if (!lock.python || !Array.isArray(lock.wheels)) {
        fail('runtime-lock.json must contain python and wheels');
    }

    const items = [lock.python, ...lock.wheels];
    if (items.length !== LOCKED_FILE_COUNT) {
        fail(`runtime-lock.json must pin exactly ${LOCKED_FILE_COUNT} files (found ${items.length})`);
    }

    const names = new Set();
    for (const item of items) {
        if (!item || typeof item !== 'object') { fail('runtime-lock entry must be an object'); }
        const filename = item.filename;
        if (typeof filename !== 'string' || !filename ||
            path.basename(filename) !== filename ||
            filename === '.' || filename === '..' ||
            /[\\/:*?"<>|\x00-\x1f]/.test(filename)) {
            fail(`unsafe locked filename: ${JSON.stringify(filename)}`);
        }
        if (!/\.(?:zip|whl)$/i.test(filename)) {
            fail(`locked file must be a .zip or .whl: ${filename}`);
        }
        if (!/^[a-f0-9]{64}$/.test(item.sha256 || '')) {
            fail(`locked file has invalid SHA256: ${filename}`);
        }
        let url;
        try {
            url = new URL(item.url);
        } catch (error) {
            fail(`locked file has invalid URL: ${filename}`);
        }
        if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password) {
            fail(`locked file URL must be pinned HTTPS on python.org/pythonhosted.org: ${filename}`);
        }
        if (names.has(filename)) { fail(`duplicate locked filename: ${filename}`); }
        names.add(filename);
    }
    return { lock, items };
}

function seedDirectories() {
    const seeds = [];
    const seen = new Set();
    const add = (label, dir) => {
        if (!dir) { return; }
        const absolute = path.resolve(dir);
        const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
        if (seen.has(key)) { return; }
        seen.add(key);
        seeds.push({ label, dir: absolute });
    };
    add('ARKNIGHT_TEST_DOWNLOAD_CACHE', process.env.ARKNIGHT_TEST_DOWNLOAD_CACHE);
    if (process.env.LOCALAPPDATA) {
        add('user cache', path.join(process.env.LOCALAPPDATA, 'ArknightPR', 'cache'));
    }
    return seeds;
}

async function downloadPinned(item, destination) {
    if (typeof fetch !== 'function') {
        fail('Node.js 18+ is required: global fetch is unavailable');
    }
    console.log(`  downloading ${item.filename} from pinned URL`);
    let response;
    try {
        response = await fetch(item.url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            headers: { 'User-Agent': 'arknight-pr-offline-packager' }
        });
    } catch (error) {
        fail(`download failed for ${item.filename}: ${error && error.message ? error.message : error}`);
    }
    if (!response.ok) {
        fail(`download failed for ${item.filename}: HTTP ${response.status}`);
    }
    if (!response.body) {
        fail(`download failed for ${item.filename}: empty response body`);
    }
    try {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
    } catch (error) {
        fs.rmSync(destination, { force: true });
        fail(`download failed for ${item.filename}: ${error && error.message ? error.message : error}`);
    }
    const actual = sha256File(destination);
    if (actual !== item.sha256) {
        fs.rmSync(destination, { force: true });
        fail(`SHA256 mismatch for ${item.filename}: expected ${item.sha256}, got ${actual}`);
    }
    console.log(`  verified ${item.filename} (SHA256 ${item.sha256})`);
}

async function obtainDependency(item, workspace, index, seeds) {
    for (const seed of seeds) {
        const candidate = path.join(seed.dir, item.filename);
        let stat;
        try {
            stat = fs.statSync(candidate);
        } catch (error) {
            continue;
        }
        if (!stat.isFile()) {
            console.warn(`  ignored ${seed.label}: not a regular file: ${candidate}`);
            continue;
        }
        let actual;
        try {
            actual = sha256File(candidate);
        } catch (error) {
            console.warn(`  ignored ${seed.label} ${item.filename}: ${error.message}`);
            continue;
        }
        if (actual === item.sha256) {
            // Copy the verified seed into the build workspace immediately: later
            // staging must not depend on a mutable external cache path.
            const isolatedDir = path.join(workspace, 'deps', String(index));
            fs.mkdirSync(isolatedDir, { recursive: true });
            const isolated = path.join(isolatedDir, item.filename);
            fs.copyFileSync(candidate, isolated);
            const copied = sha256File(isolated);
            if (copied !== item.sha256) {
                fs.rmSync(isolated, { force: true });
                console.warn(`  ignored ${seed.label} ${item.filename}: changed while copying`);
                continue;
            }
            console.log(`  using ${item.filename} from ${seed.label}`);
            return isolated;
        }
        console.warn(`  ignored ${seed.label} ${item.filename}: SHA256 mismatch`);
    }

    const downloadDir = path.join(workspace, 'downloads', String(index));
    fs.mkdirSync(downloadDir, { recursive: true });
    const destination = path.join(downloadDir, item.filename);
    await downloadPinned(item, destination);
    return destination;
}

function packageVersion() {
    const xml = fs.readFileSync(path.join(ROOT, 'cep-extension', 'CSXS', 'manifest.xml'), 'utf8');
    const { version } = require('./manifest').parseManifest(xml);
    if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
        fail(`invalid manifest version: ${JSON.stringify(version)}`);
    }
    return version;
}

function offlineZipName(version) {
    return `arknight-pr-setup-offline-v${version}-windows-x64.zip`;
}

function runOrdinaryBuild() {
    console.log('\nBuilding ordinary panel + online setup ZIPs before the offline ZIP...');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'package-setup.js')], {
        cwd: ROOT,
        stdio: 'inherit',
        env: process.env
    });
    if (result.error) { fail('ordinary build failed: ' + result.error.message); }
    if (result.status !== 0) { fail(`ordinary build failed with exit code ${result.status}`); }
    let stageIsDirectory = false;
    try {
        stageIsDirectory = fs.statSync(ONLINE_STAGE).isDirectory();
    } catch (error) {
        stageIsDirectory = false;
    }
    if (!stageIsDirectory) {
        fail('ordinary build did not produce dist/arknight-pr-setup');
    }

    const required = [
        'setup.bat',
        'setup.ps1',
        'runtime-lock.json',
        'LICENSE',
        'INSTALLATION.md',
        'panel/CSXS/manifest.xml',
        'backend/pr_cli.py'
    ];
    for (const relative of required) {
        if (!fs.existsSync(path.join(ONLINE_STAGE, relative))) {
            fail('ordinary stage is missing ' + relative);
        }
    }
    for (const name of ['setup.ps1', 'runtime-lock.json']) {
        const staged = fs.readFileSync(path.join(ONLINE_STAGE, name));
        const source = fs.readFileSync(path.join(INSTALL, name));
        if (!staged.equals(source)) {
            fail(`ordinary stage ${name} differs from cep-extension/install/${name}`);
        }
    }
}

function stageOffline(workspace, resolved) {
    const stage = path.join(workspace, STAGE_NAME);
    fs.cpSync(ONLINE_STAGE, stage, { recursive: true });

    const runtimeDir = path.join(stage, RUNTIME_DIR);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });

    for (const { item, source } of resolved) {
        const destination = path.join(runtimeDir, item.filename);
        fs.copyFileSync(source, destination);
        const actual = sha256File(destination);
        if (actual !== item.sha256) {
            fail(`staged copy of ${item.filename} has SHA256 ${actual}, expected ${item.sha256}`);
        }
    }

    const entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile())) {
        fail('runtime-deps/ must contain files only');
    }
    const actualNames = entries.map(entry => entry.name).sort();
    const expectedNames = resolved.map(entry => entry.item.filename).sort();
    if (actualNames.length !== expectedNames.length ||
        actualNames.some((name, index) => name !== expectedNames[index])) {
        fail(`runtime-deps/ must contain exactly the locked files: ${expectedNames.join(', ')}`);
    }

    fs.writeFileSync(path.join(stage, 'setup.bat'), OFFLINE_BAT, 'utf8');
    return stage;
}

async function buildOfflinePackage() {
    const version = packageVersion();
    const { items } = loadLockedDependencies();
    const seeds = seedDirectories();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'arknight-offline-'));

    try {
        console.log(`\nOffline setup package ${offlineZipName(version)}`);
        console.log(`Locked runtime files: ${items.length}`);
        if (seeds.length) {
            console.log('Dependency seeds: ' + seeds.map(seed => `${seed.label}=${seed.dir}`).join('; '));
        } else {
            console.log('Dependency seeds: none; all runtime files will be downloaded');
        }

        const resolved = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const source = await obtainDependency(item, workspace, index, seeds);
            resolved.push({ item, source });
        }

        runOrdinaryBuild();
        const stage = stageOffline(workspace, resolved);

        const zipName = offlineZipName(version);
        const zipPath = path.join(DIST, zipName);
        fs.mkdirSync(DIST, { recursive: true });
        fs.rmSync(zipPath, { force: true });
        let fileCount;
        try {
            fileCount = writeZip(stage, zipPath);
        } catch (error) {
            fs.rmSync(zipPath, { force: true });
            throw error;
        }

        console.log(`\nOffline package: dist/${zipName}`);
        console.log(`Contents: ${fileCount} files, ${humanSize(fs.statSync(zipPath).size)}`);
        console.log(`Layout: ${STAGE_NAME}/setup.bat -> setup.ps1 -Offline; ${RUNTIME_DIR}/ contains exactly ${resolved.length} locked files`);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

module.exports = {
    OFFLINE_BAT,
    offlineZipName,
    buildOfflinePackage
};
