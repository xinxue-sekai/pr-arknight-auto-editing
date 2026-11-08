#!/usr/bin/env node
/**
 * verify-package.js —— 校验 tools/package.js 产出的包是否正确
 *
 * 为什么单独一个脚本：这段检查必须能跑在干净的 CI runner 上，
 * 而 `unzip` 在 ubuntu-latest 上**并不预装**，写 shell 解压会直接失败（踩过）。
 * 这里改用 Node 标准库，零外部依赖、跨平台。
 *
 * 校验内容：
 *   1. 精确选择当前 manifest 版本的面板 ZIP（--setup 选择统一安装 ZIP）
 *   2. zip 是合法归档，且**所有条目都在同一个顶层目录下**
 *      （否则用户解压出来是一堆散文件，得手工建目录，很容易放错）
 *   3. 顶层目录名 == manifest 里的 ExtensionManifest@ExtensionBundleId
 *      （CEP 按目录名定位扩展，不一致会静默不加载）
 *   4. 装有必需文件
 *   5. 不该进包的东西确实不在（install/ 与 .debug）
 *
 * 用法：先 node tools/package.js，再 node tools/verify-package.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

let failed = 0;
const pass = m => console.log('  \u2713 ' + m);
const fail = m => { failed++; console.log('  \u2717 ' + m); };

console.log('\n校验发布包\n');

// ------------------------------------------------------------------
//  1. 找到 zip
// ------------------------------------------------------------------

if (!fs.existsSync(DIST)) {
    fail('dist/ 不存在 —— 请先运行 node tools/package.js');
    process.exit(1);
}

const setup = process.argv.includes('--setup');
const expected = require('./manifest').parseManifest(fs.readFileSync(path.join(ROOT, 'cep-extension/CSXS/manifest.xml'), 'utf8'));
const expectedName = setup ? `arknight-pr-setup-v${expected.version}-windows-x64.zip` : `${expected.bundleId}-v${expected.version}.zip`;
const zips = fs.readdirSync(DIST).filter(f => f === expectedName);
if (zips.length === 0) {
    fail('dist/ 下没有 zip');
    process.exit(1);
}
if (zips.length > 1) {
    fail(`dist/ 下有 ${zips.length} 个 zip，无法判断该校验哪个：${zips.join(', ')}`);
    process.exit(1);
}

const zipPath = path.join(DIST, zips[0]);
const zipSize = fs.statSync(zipPath).size;
pass(`找到 ${zips[0]}（${(zipSize / 1024).toFixed(1)} KB）`);

// ------------------------------------------------------------------
//  2. 解析 zip 的中央目录，取出全部条目名
// ------------------------------------------------------------------

/**
 * 读 zip 的 End of Central Directory（EOCD），再顺着中央目录列出文件名。
 * 不依赖任何外部库，也不解压内容 —— 我们只需要条目列表。
 */
function listZipEntries(file) {
    const buf = fs.readFileSync(file);

    // EOCD 签名 PK\x05\x06，从尾部往前找（注释最长 65535 字节）
    const EOCD = 0x06054b50;
    let eocd = -1;
    const scanFrom = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= scanFrom; i--) {
        if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) { return { ok: false, error: '找不到 EOCD，不是合法 zip' }; }

    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset >= buf.length) { return { ok: false, error: '中央目录偏移越界' }; }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
            return { ok: false, error: `第 ${i + 1} 个中央目录项损坏` };
        }
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        entries.push(name);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { ok: true, entries };
}

const listed = listZipEntries(zipPath);
if (!listed.ok) {
    fail(`zip 解析失败：${listed.error}`);
    process.exit(1);
}
pass(`zip 合法，含 ${listed.entries.length} 个条目`);

// ------------------------------------------------------------------
//  3. 顶层目录唯一
// ------------------------------------------------------------------

const tops = new Set();
for (const name of listed.entries) {
    // 只取第一段；zip 里目录条目以 / 结尾
    const top = name.split('/')[0];
    if (top) { tops.add(top); }
}

if (tops.size === 1) {
    pass(`所有条目都在同一个顶层目录下（${[...tops][0]}/）`);
} else {
    fail(`顶层目录不唯一，解压后会散落：${[...tops].join(', ')}\n` +
         '     用户需要手工建目录，很容易放错位置。');
}

const topDir = [...tops][0] || '';

// ------------------------------------------------------------------
//  4. 目录名 == manifest Id
// ------------------------------------------------------------------

const panelRoot = topDir + (setup ? '/panel' : '');
const manifestRel = panelRoot + '/CSXS/manifest.xml';
const manifestEntry = listed.entries.find(e => e.replace(/\/$/, '') === manifestRel.replace(/\/$/, ''));
if (!manifestEntry) {
    fail(`包里找不到 ${manifestRel}`);
    process.exit(1);
}

// 解压出 manifest 内容（zip 用 deflate，Node 内置 zlib 可解）
const archiveBuffers = new Map();
function readZipEntry(file, wantName, binary = false) {
    if (!archiveBuffers.has(file)) archiveBuffers.set(file, fs.readFileSync(file));
    const buf = archiveBuffers.get(file);
    const EOCD = 0x06054b50;
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i++) {
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

        if (name === wantName) {
            // 本地文件头长度不固定，从其中读出真实的数据起点
            const lNameLen = buf.readUInt16LE(localOffset + 26);
            const lExtraLen = buf.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + lNameLen + lExtraLen;
            const raw = buf.slice(dataStart, dataStart + compSize);
            if (method === 0) { return binary ? raw : raw.toString('utf8'); }
            if (method === 8) {
                const decoded = zlib.inflateRawSync(raw);
                return binary ? decoded : decoded.toString('utf8');
            }
            throw new Error(`不支持的压缩方式 ${method}`);
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

let manifestText;
try {
    manifestText = readZipEntry(zipPath, manifestEntry);
} catch (e) {
    fail(`解出 manifest 失败：${e.message}`);
    process.exit(1);
}

let bundleId;
let version;
try {
    ({ bundleId, version } = require('./manifest').parseManifest(manifestText));
    pass('CEP ExtensionManifest 7.0 结构与 ExtensionList/DispatchInfoList ID 一致');
} catch (e) {
    fail(e.message);
    process.exit(1);
}

if (!bundleId) {
    fail('manifest 里读不到 ExtensionManifest@ExtensionBundleId');
} else if (topDir === (setup ? 'arknight-pr-setup' : bundleId)) {
    pass(`顶层目录名与 manifest Id 一致（${bundleId}）`);
} else {
    fail(`顶层目录名(${topDir}) != manifest Id(${bundleId})\n` +
         '     CEP 按目录名定位扩展，不一致会被静默忽略，菜单里看不到。');
}

// zip 文件名里的版本应与 manifest 一致
const verInName = (zips[0].match(/-v(\d+\.\d+\.\d+)/) || [])[1];
if (verInName && version && verInName === version) {
    pass(`zip 文件名与 manifest 版本一致（v${version}）`);
} else if (verInName) {
    fail(`zip 文件名版本(v${verInName}) != manifest 版本(v${version})`);
} else {
    fail(`zip 文件名里读不到版本号：${zips[0]}`);
}

// ------------------------------------------------------------------
//  5. 必需文件齐备 + 不该有的东西不在
// ------------------------------------------------------------------

const entriesSet = new Set(listed.entries.map(e => e.replace(/\/+$/, '')));

const REQUIRED = [
    'CSXS/manifest.xml', 'index.html', 'hostscript.jsx',
    'js/main.js', 'js/bridge.js', 'js/timeline.js', 'js/csinterface.js',
    'css/style.css', 'LICENSE', 'js/preview.js', 'js/preview-bridge.js'
];
const missing = REQUIRED.filter(r => !entriesSet.has(panelRoot + '/' + r));
if (setup) {
    const requiredSetup = ['setup.bat', 'setup.ps1', 'runtime-lock.json', 'LICENSE', 'INSTALLATION.md', 'backend/pr_cli.py', 'backend/analyzer.py', 'backend/frame_types.py', 'backend/session_store.py', 'backend/LICENSE', 'backend/SOURCE_VERSION.json'];
    for (const file of fs.readdirSync(path.join(ROOT, 'backend'))) {
        if (file.endsWith('.py') && !file.startsWith('test_')) requiredSetup.push('backend/' + file);
    }
    for (const kind of ['pause', '1x', '2x', 'play']) {
        for (const prefix of ['templates_', 'source_images_']) {
            if (!listed.entries.some(e => e.startsWith(topDir + '/backend/' + prefix + kind + '/') && e.endsWith('.png'))) missing.push(prefix + kind);
        }
    }
    missing.push(...requiredSetup.filter(r => !entriesSet.has(topDir + '/' + r)));
    for (const file of ['setup.bat', 'setup.ps1', 'runtime-lock.json']) {
        const packaged = readZipEntry(zipPath, topDir + '/' + file);
        const source = fs.readFileSync(path.join(ROOT, 'cep-extension/install', file), 'utf8');
        if (packaged !== source) fail('Setup file differs from source: ' + file);
        else pass('Setup file matches source: ' + file);
    }
}
if (missing.length === 0) {
    pass(`装有必需文件（${REQUIRED.length} 项）`);
} else {
    fail(`包里缺少必需文件：${missing.join(', ')}`);
}

const FORBIDDEN = ['install', '.debug'];
const present = FORBIDDEN.filter(f => [...entriesSet].some(e => e === panelRoot + '/' + f || e.startsWith(panelRoot + '/' + f + '/')));
if (listed.entries.some(e => e.includes('\\') || e.split('/').includes('..') || e.startsWith('/') || e.includes('__pycache__'))) fail('Unsafe or cached archive entry');
if (present.length === 0) {
    pass('不含 install/ 与 .debug（安装器与调试端口不该发给用户）');
} else {
    fail(`包里不应包含：${present.join(', ')}`);
}

// Verify actual bytes, including binary templates, rather than only file names.
const expectedFiles = new Map();
function includeTree(dir, archiveDir, skip) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip && skip(entry.name)) continue;
        const source = path.join(dir, entry.name);
        const target = archiveDir + '/' + entry.name;
        if (entry.isDirectory()) includeTree(source, target, skip);
        else expectedFiles.set(target, fs.readFileSync(source));
    }
}
includeTree(path.join(ROOT, 'cep-extension'), panelRoot,
    name => name === 'install' || name === '.debug' || name === '__pycache__' || name === '.git');
expectedFiles.set(panelRoot + '/LICENSE', fs.readFileSync(path.join(ROOT, 'LICENSE')));
if (setup) {
    for (const name of fs.readdirSync(path.join(ROOT, 'backend'))) {
        const source = path.join(ROOT, 'backend', name);
        if (/^(templates_|source_images_)/.test(name) && fs.statSync(source).isDirectory()) {
            includeTree(source, topDir + '/backend/' + name, n => n === '__pycache__');
        } else if ((name.endsWith('.py') && !name.startsWith('test_')) || ['LICENSE', 'SOURCE_VERSION.json'].includes(name)) {
            expectedFiles.set(topDir + '/backend/' + name, fs.readFileSync(source));
        }
    }
    for (const name of ['setup.bat', 'setup.ps1', 'runtime-lock.json']) {
        expectedFiles.set(topDir + '/' + name, fs.readFileSync(path.join(ROOT, 'cep-extension/install', name)));
    }
    expectedFiles.set(topDir + '/LICENSE', fs.readFileSync(path.join(ROOT, 'LICENSE')));
    expectedFiles.set(topDir + '/INSTALLATION.md', Buffer.from(fs.readFileSync(path.join(ROOT, 'docs/installation-options.md'), 'utf8')
        .replace('../cep-extension/install/runtime-lock.json', 'runtime-lock.json')
        .replace('releases/v' + version + '.md', 'https://github.com/xinxue-sekai/pr-arknight-auto-editing/releases/tag/v' + version)));
}
let byteMatches = 0;
for (const [name, source] of expectedFiles) {
    try {
        const actual = readZipEntry(zipPath, name, true);
        if (!actual || !actual.equals(source)) fail('Archive content differs from source: ' + name);
        else byteMatches++;
    } catch (e) { fail('Cannot verify archive content: ' + name, e.message); }
}
for (const name of listed.entries) {
    if (!name.endsWith('/') && !expectedFiles.has(name)) fail('Unexpected archive file: ' + name);
}
if (new Set(listed.entries).size !== listed.entries.length) fail('Duplicate archive entries');
if (byteMatches === expectedFiles.size) pass(`全部 ${byteMatches} 个文件与源码逐字节一致`);

// ------------------------------------------------------------------

console.log('');
if (failed === 0) {
    console.log('发布包校验通过。');
    process.exit(0);
} else {
    console.log(`发布包校验未通过：${failed} 项失败。`);
    process.exit(1);
}
