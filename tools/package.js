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

// ------------------------------------------------------------------
//  3. 压缩（内置写入器）
// ------------------------------------------------------------------

/**
 * 为什么手写 zip 而不调外部工具 —— 每个都有坑（都实测踩过）：
 *   zip           Windows 上通常没有
 *   GNU tar -a    对 .zip 后缀不认识，却不报错、静默产出纯 tar
 *   Compress-Archive / python -m zipfile
 *                 在 Windows 上用反斜杠做条目路径分隔符，zip 规范
 *                 要求 /，Linux/macOS 的 unzip 会解出文件名里带
 *                 字面反斜杠的散文件
 * 内置写入器零依赖、全平台产物一致；verify-package.js 用另一套
 * 代码独立解析校验，防这里写错。
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    const date = (((year - 1980) & 0x7f) << 9)
               | (((d.getMonth() + 1) & 0xf) << 5)
               | (d.getDate() & 0x1f);
    const time = ((d.getHours() & 0x1f) << 11)
               | ((d.getMinutes() & 0x3f) << 5)
               | ((d.getSeconds() / 2) & 0x1f);
    return { date, time };
}

function listFiles(dir, rel) {
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
        const relPath = rel ? rel + '/' + entry.name : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listFiles(full, relPath));
        } else {
            out.push({ full, relPath });
        }
    }
    return out;
}

function writeZip(stageDir, outPath) {
    // 条目名以暂存目录名（即扩展 Id）为顶层前缀，保证解压出一个目录
    const files = listFiles(stageDir, path.basename(stageDir));
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
        const data = fs.readFileSync(f.full);
        const comp = zlib.deflateRawSync(data);
        const useDeflate = comp.length < data.length;
        const body = useDeflate ? comp : data;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(data);
        const { date, time } = dosDateTime(fs.statSync(f.full).mtime);
        const nameBuf = Buffer.from(f.relPath, 'utf8');

        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);   // local file header 签名
        lfh.writeUInt16LE(20, 4);           // version needed
        lfh.writeUInt16LE(0, 6);            // flags
        lfh.writeUInt16LE(method, 8);
        lfh.writeUInt16LE(time, 10);
        lfh.writeUInt16LE(date, 12);
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(body.length, 18); // 压缩后大小
        lfh.writeUInt32LE(data.length, 22); // 原始大小
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);           // extra 长度
        parts.push(lfh, nameBuf, body);

        const cdh = Buffer.alloc(46);
        cdh.writeUInt32LE(0x02014b50, 0);   // central directory 签名
        cdh.writeUInt16LE(20, 4);           // version made by
        cdh.writeUInt16LE(20, 6);           // version needed
        cdh.writeUInt16LE(0, 8);
        cdh.writeUInt16LE(method, 10);
        cdh.writeUInt16LE(time, 12);
        cdh.writeUInt16LE(date, 14);
        cdh.writeUInt32LE(crc, 16);
        cdh.writeUInt32LE(body.length, 20);
        cdh.writeUInt32LE(data.length, 24);
        cdh.writeUInt16LE(nameBuf.length, 28);
        cdh.writeUInt16LE(0, 30);           // extra 长度
        cdh.writeUInt16LE(0, 32);           // comment 长度
        cdh.writeUInt16LE(0, 34);           // 起始盘号
        cdh.writeUInt16LE(0, 36);           // 内部属性
        cdh.writeUInt32LE(0, 38);           // 外部属性
        cdh.writeUInt32LE(offset, 42);      // 本地文件头偏移
        central.push(cdh, nameBuf);

        offset += 30 + nameBuf.length + body.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { cdSize += c.length; }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);

    fs.writeFileSync(outPath, Buffer.concat([...parts, ...central, eocd]));
    return files.length;
}

const fileCount = writeZip(STAGE, zipPath);

const zipSize = fs.statSync(zipPath).size;
const stageSize = dirSize(STAGE);

console.log(`\n产物：dist/${zipName}`);
console.log(`内容：${humanSize(stageSize)} → 压缩后 ${humanSize(zipSize)}（${fileCount} 个文件）`);
console.log('\n使用方式（分发给用户时写进 Release 说明）：');
console.log(`  1. 解压出 ${EXT_ID} 文件夹`);
console.log('  2. 整个文件夹放进 %APPDATA%\\Adobe\\CEP\\extensions\\');
console.log(`     即 …\\Roaming\\Adobe\\CEP\\extensions\\${EXT_ID}\\CSXS\\manifest.xml`);
console.log('  3. 开启 PlayerDebugMode（见仓库 README），然后重启 Premiere Pro');
console.log('  4. 菜单：窗口 → 扩展 → Arknight Auto Editing');
console.log('');
