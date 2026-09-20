#!/usr/bin/env node
/**
 * package.js —— 生成可分发的 CEP 扩展包
 *
 * 为什么需要它：
 *   仓库里的扩展目录叫 `cep-extension/`，而 CEP 要求**目录名必须等于
 *   manifest 里的 ExtensionBundle@Id**（`com.arknight.autoediting`）。
 *   直接下载源码压缩包的人会拿到一个名字不对的目录，手工改名既麻烦又容易出错。
 *   本脚本负责改名、剔除不该发给用户的东西、并压成 zip。
 *
 * 打包时会剔除：
 *   install/   安装器自身。包的使用者只是解压到扩展目录，不需要它；
 *              而且它引用了仓库内的相对路径，脱离仓库后本就不可用。
 *   .debug     远程调试端口。开了之后任何本地程序都能连上面板，不该随包分发。
 *
 * 用法：
 *   node tools/package.js              → dist/com.arknight.autoediting.zip
 *   node tools/package.js --keep-debug → 保留 .debug（自用调试包）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'cep-extension');
const DIST = path.join(ROOT, 'dist');

const KEEP_DEBUG = process.argv.indexOf('--keep-debug') >= 0;

// 扩展 Id 以 manifest 为唯一来源，避免两处手写不一致
const manifestXml = fs.readFileSync(path.join(SRC, 'CSXS', 'manifest.xml'), 'utf8');
const idMatch = manifestXml.match(/<ExtensionBundle\b[^>]*\bId\s*=\s*"([^"]+)"/);
if (!idMatch) {
    console.error('无法从 manifest.xml 读出 ExtensionBundle@Id');
    process.exit(1);
}
const EXT_ID = idMatch[1];
const versionMatch = manifestXml.match(/<ExtensionBundle\b[^>]*\bVersion\s*=\s*"([^"]+)"/);
const VERSION = versionMatch ? versionMatch[1] : '0.0.0';

const STAGE = path.join(DIST, EXT_ID);

// ------------------------------------------------------------------

function rmrf(p) {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); }
}

/** 递归复制，按回调决定是否跳过某个条目（rel 为相对 SRC 的 POSIX 路径）。 */
function copyFiltered(srcDir, destDir, shouldSkip, relBase) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const rel = relBase ? relBase + '/' + entry.name : entry.name;
        if (shouldSkip(rel, entry)) { continue; }

        const s = path.join(srcDir, entry.name);
        const d = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyFiltered(s, d, shouldSkip, rel);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

function humanSize(bytes) {
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function dirSize(p) {
    let total = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const abs = path.join(p, entry.name);
        total += entry.isDirectory() ? dirSize(abs) : fs.statSync(abs).size;
    }
    return total;
}

// ------------------------------------------------------------------
//  1. 暂存
// ------------------------------------------------------------------

console.log(`\n打包 ${EXT_ID} v${VERSION}${KEEP_DEBUG ? '（保留 .debug）' : ''}\n`);

rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

const skipped = [];
const shouldSkip = (rel, entry) => {
    // 顶层 install 目录
    if (rel === 'install') { skipped.push('install/'); return true; }
    // .debug（除非显式保留）
    if (!KEEP_DEBUG && rel === '.debug') { skipped.push('.debug'); return true; }
    // 各类垃圾
    if (entry.isDirectory() && (entry.name === '__pycache__' || entry.name === '.git')) {
        skipped.push(rel + '/');
        return true;
    }
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') {
        skipped.push(rel);
        return true;
    }
    return false;
};

copyFiltered(SRC, STAGE, shouldSkip, '');

console.log('已暂存到 dist/' + EXT_ID + '/');
if (skipped.length) {
    console.log('已剔除：' + skipped.join(', '));
}

// ------------------------------------------------------------------
//  2. 打包前校验：包里必须有的东西
// ------------------------------------------------------------------

const REQUIRED = [
    'CSXS/manifest.xml',
    'index.html',
    'hostscript.jsx',
    'js/main.js',
    'js/bridge.js',
    'js/timeline.js',
    'js/csinterface.js',
    'css/style.css'
];

let missing = [];
for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(STAGE, rel))) { missing.push(rel); }
}
if (missing.length) {
    console.error('\n打包中止：暂存目录缺少必需文件：');
    for (const m of missing) { console.error('  - ' + m); }
    process.exit(1);
}
console.log(`必需文件齐备（${REQUIRED.length} 项）`);

// 包的目录名必须等于 Id，否则 CEP 不认
if (path.basename(STAGE) !== EXT_ID) {
    console.error(`\n打包中止：目录名 ${path.basename(STAGE)} != manifest Id ${EXT_ID}`);
    process.exit(1);
}

// ------------------------------------------------------------------
//  3. 压缩
// ------------------------------------------------------------------

const zipName = `${EXT_ID}-v${VERSION}${KEEP_DEBUG ? '-debug' : ''}.zip`;
const zipPath = path.join(DIST, zipName);

/** 跨平台 zip：优先用系统命令，都没有就报错（不引 npm 依赖）。 */
function makeZip() {
    // -r 递归，-q 安静；cwd 设为 DIST 以保证压缩包里带扩展目录这一层
    try {
        execFileSync('zip', ['-r', '-q', zipName, EXT_ID], { cwd: DIST, stdio: 'pipe' });
        return 'zip';
    } catch (e) { /* 试下一个 */ }

    if (process.platform === 'win32') {
        // Windows 10+ 自带 tar（bsdtar），能直接产出 zip
        try {
            execFileSync('tar', ['-a', '-c', '-f', zipName, EXT_ID], { cwd: DIST, stdio: 'pipe' });
            return 'tar';
        } catch (e) { /* 试下一个 */ }
    }

    try {
        execFileSync('powershell',
            ['-NoProfile', '-Command',
             `Compress-Archive -Path '${EXT_ID}' -DestinationPath '${zipName}' -Force`],
            { cwd: DIST, stdio: 'pipe' });
        return 'powershell';
    } catch (e) { /* 全部失败 */ }

    return null;
}

const tool = makeZip();
if (!tool) {
    console.error('\n打包失败：找不到可用的压缩工具（试过 zip / tar / Compress-Archive）');
    process.exit(1);
}

const zipSize = fs.statSync(zipPath).size;
const stageSize = dirSize(STAGE);

console.log(`\n压缩工具：${tool}`);
console.log(`产物：dist/${zipName}`);
console.log(`内容：${humanSize(stageSize)} → 压缩后 ${humanSize(zipSize)}`);
console.log('\n使用方式（分发给用户时写进 Release 说明）：');
console.log(`  1. 解压出 ${EXT_ID} 文件夹`);
console.log('  2. 整个文件夹放进 %APPDATA%\\Adobe\\CEP\\extensions\\');
console.log(`     即 …\\Roaming\\Adobe\\CEP\\extensions\\${EXT_ID}\\CSXS\\manifest.xml`);
console.log('  3. 开启 PlayerDebugMode（见仓库 README），然后重启 Premiere Pro');
console.log('  4. 菜单：窗口 → 扩展 → Arknight Auto Editing');
console.log('');
