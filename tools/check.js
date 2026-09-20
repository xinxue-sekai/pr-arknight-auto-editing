#!/usr/bin/env node
/**
 * check.js —— 本仓库的静态检查（CI 与本地共用）
 *
 * 这些检查全部是「踩过的坑」，不是泛泛的 lint：
 *   1. node --check      —— JS/JSX 语法。JSX 也要查，因为它同样是手写的、
 *                           且 ES3 报错在 Premiere 里极难定位。
 *   2. manifest 一致性   —— CEP 用「文件夹名 == ExtensionBundle@Id」来定位扩展，
 *                           不一致时扩展会静默不加载，菜单里根本不出现。
 *   3. install.ps1 BOM   —— 缺 BOM 时 Windows PowerShell 5.1 会按 GBK 解析，
 *                           中文乱码 + 语法错误。这个坑踩过好几次。
 *   4. Chromium 74 语法  —— CEP 11（PR 2021）内嵌 Chromium 74，不支持 ?. 与 ??，
 *                           用整个面板会白屏。
 *
 * 用法：node tools/check.js        （退出码 0 = 全部通过）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'cep-extension');

let failed = 0;

function pass(msg) { console.log('  \u2713 ' + msg); }
function fail(msg, detail) {
    failed++;
    console.log('  \u2717 ' + msg);
    if (detail) { console.log('      ' + String(detail).split('\n').join('\n      ')); }
}
function section(title) { console.log('\n' + title); }

// ------------------------------------------------------------------
//  1. JS / JSX 语法
// ------------------------------------------------------------------

section('[1/4] JS / JSX 语法');

const jsFiles = [
    'js/bridge.js',
    'js/csinterface.js',
    'js/main.js',
    'js/timeline.js'
];

for (const rel of jsFiles) {
    const abs = path.join(EXT, rel);
    try {
        execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
        pass(rel);
    } catch (e) {
        fail(rel, (e.stderr || e.message).toString());
    }
}

// hostscript.jsx 是 ExtendScript，但语法上是普通 JS。
// node --check 不认 .jsx 扩展名，所以复制成临时 .js 再查。
const jsxSrc = path.join(EXT, 'hostscript.jsx');
const jsxTmp = path.join(require('os').tmpdir(),
    'arknight_hostscript_' + process.pid + '.js');
try {
    fs.copyFileSync(jsxSrc, jsxTmp);
    execFileSync(process.execPath, ['--check', jsxTmp], { stdio: 'pipe' });
    pass('hostscript.jsx');
} catch (e) {
    fail('hostscript.jsx', (e.stderr || e.message).toString());
} finally {
    try { fs.unlinkSync(jsxTmp); } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------------
//  2. manifest 一致性
// ------------------------------------------------------------------

section('[2/4] manifest.xml 一致性');

const manifestPath = path.join(EXT, 'CSXS', 'manifest.xml');

/** 极简 XML 取值：只够读属性，不值得为 CI 引依赖。 */
function attrOf(xml, tag, attr) {
    const re = new RegExp('<' + tag + '\\b[^>]*?\\b' + attr + '\\s*=\\s*"([^"]*)"', 'i');
    const m = xml.match(re);
    return m ? m[1] : '';
}

let manifestXml = '';
try {
    manifestXml = fs.readFileSync(manifestPath, 'utf8');
    pass('manifest.xml 可读');
} catch (e) {
    fail('manifest.xml 可读', e.message);
}

if (manifestXml) {
    // 用栈做真正的配平校验。
    // 不要用「数开标签 / 数闭标签」那种做法：`<Host ... />` 这类自闭合标签
    // 会被粗略正则同时算进开标签，导致永远对不上（踩过）。
    const xmlNoComment = manifestXml.replace(/<!--[\s\S]*?-->/g, '');
    const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    const stack = [];
    let m;
    let balanced = true;
    let detail = '';

    while ((m = tagRe.exec(xmlNoComment)) !== null) {
        const isClose = m[1] === '/';
        const name = m[2];
        const isSelf = m[4] === '/';

        if (isSelf) { continue; }              // 自闭合，不入栈

        if (isClose) {
            const top = stack.pop();
            if (top !== name) {
                balanced = false;
                detail = `</${name}> 与之对应的应为 </${top || '(无)'}>`;
                break;
            }
        } else {
            stack.push(name);
        }
    }

    if (balanced && stack.length > 0) {
        balanced = false;
        detail = '以下标签未闭合：' + stack.join(', ');
    }

    if (balanced) {
        pass(`标签配平（栈式校验通过）`);
    } else {
        fail('标签配平失败', detail);
    }

    const bundleId = attrOf(manifestXml, 'ExtensionBundle', 'Id');
    const version = attrOf(manifestXml, 'ExtensionBundle', 'Version');

    if (bundleId) {
        pass(`ExtensionBundle@Id = ${bundleId}`);
    } else {
        fail('读不到 ExtensionBundle@Id');
    }

    // 注意：**不检查**「仓库里的文件夹名是否等于 Id」。
    // 仓库里的目录叫 cep-extension，安装时才由 install.ps1 复制成
    // %APPDATA%\Adobe\CEP\extensions\<Id>\，两者本来就不该相同。
    // 真正要对齐的是 install.ps1 里的 $ExtId 与 manifest 的 Id ——
    // 不一致会导致扩展被复制到一个 CEP 不认的文件夹名下，静默不加载。
    const ps1Path = path.join(EXT, 'install', 'install.ps1');
    try {
        const ps1Text = fs.readFileSync(ps1Path, 'utf8');
        const m = ps1Text.match(/\$ExtId\s*=\s*'([^']+)'/);
        if (!m) {
            fail('install.ps1 里找不到 $ExtId 定义');
        } else if (m[1] === bundleId) {
            pass(`install.ps1 的 $ExtId 与 manifest Id 一致（${m[1]}）`);
        } else {
            fail('install.ps1 的 $ExtId 与 manifest Id 不一致',
                `install.ps1 = ${m[1]}\nmanifest    = ${bundleId}\n` +
                '不一致会让扩展被装进 CEP 不认的目录，菜单里看不到。');
        }
    } catch (e) {
        fail('读取 install.ps1 校验 $ExtId', e.message);
    }

    if (/^\d+\.\d+\.\d+$/.test(version)) {
        pass(`版本号格式合法（${version}）`);
    } else {
        fail(`版本号不是 x.y.z 格式：${version}`);
    }

    // 每个 DispatchInfo/Extension@Id 都应当以 bundle Id 为前缀
    const extIds = (manifestXml.match(/<Extension\s+Id="([^"]+)"/g) || [])
        .map(s => s.replace(/.*Id="([^"]+)".*/, '$1'));
    if (extIds.length === 0) {
        fail('未找到 DispatchInfoList 里的 Extension@Id');
    } else if (extIds.every(id => id.indexOf(bundleId + '.') === 0)) {
        pass(`${extIds.length} 个 Extension@Id 均以 bundle Id 为前缀`);
    } else {
        fail('存在不以 bundle Id 为前缀的 Extension@Id', extIds.join(', '));
    }
}

// ------------------------------------------------------------------
//  3. install.ps1 的 UTF-8 BOM
// ------------------------------------------------------------------

section('[3/4] install.ps1 编码');

const ps1 = path.join(EXT, 'install', 'install.ps1');
try {
    const buf = fs.readFileSync(ps1);
    const hasBom = buf.length >= 3 &&
        buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    if (hasBom) {
        pass('install.ps1 以 UTF-8 BOM 开头');
    } else {
        fail('install.ps1 缺少 UTF-8 BOM',
            'Windows PowerShell 5.1 会按系统 ANSI(GBK) 解析，中文乱码且可能语法错误。\n' +
            '修复：以「带 BOM 的 UTF-8」重新保存该文件。');
    }
} catch (e) {
    fail('读取 install.ps1', e.message);
}

// install.bat 必须保持纯 ASCII：cmd.exe 对批处理源文件的非 ASCII 字节解码不可靠
const bat = path.join(EXT, 'install', 'install.bat');
try {
    const buf = fs.readFileSync(bat);
    const nonAscii = [];
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 127) { nonAscii.push(i); }
    }
    if (nonAscii.length === 0) {
        pass('install.bat 是纯 ASCII');
    } else {
        fail(`install.bat 含 ${nonAscii.length} 个非 ASCII 字节`,
            'cmd.exe 在部分代码页下会解析错误。用户可见文案请放在 install.ps1 里。');
    }
} catch (e) {
    fail('读取 install.bat', e.message);
}

// ------------------------------------------------------------------
//  4. Chromium 74 兼容（CEP 11 / Premiere Pro 2021）
// ------------------------------------------------------------------

section('[4/4] Chromium 74 兼容（CEP 11）');

// 面板侧 JS 的解析失败会导致整个面板白屏，所以要扫。
// index.html 不能整份当 JS 扫：HTML 属性、URL、注释里的 `??` / `?.` 会误报，
// 只提取其中 <script> 标签的内联代码。
const panelSources = [];
for (const rel of ['js/bridge.js', 'js/csinterface.js', 'js/main.js', 'js/timeline.js']) {
    panelSources.push({ rel, text: () => fs.readFileSync(path.join(EXT, rel), 'utf8') });
}
panelSources.push({
    rel: 'index.html 的内联 <script>',
    text: () => {
        const html = fs.readFileSync(path.join(EXT, 'index.html'), 'utf8');
        const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
        // 有 src 的外链 script 内容为空，无妨；内联的才是有代码的
        return blocks.map(b => b.replace(/<\/?script\b[^>]*>/gi, '')).join('\n');
    }
});

const BANNED = [
    { re: /\?\./, name: '可选链 ?.', since: 'Chrome 80' },
    { re: /\?\?/, name: '空值合并 ??', since: 'Chrome 80' },
    { re: /\.flatMap\s*\(/, name: 'Array.flatMap', since: 'Chrome 69' },
    { re: /Object\.fromEntries\s*\(/, name: 'Object.fromEntries', since: 'Chrome 73' },
    { re: /\.replaceAll\s*\(/, name: 'String.replaceAll', since: 'Chrome 85' },
    { re: /globalThis\b/, name: 'globalThis', since: 'Chrome 71' }
];

/** 去掉行注释与块注释，避免把说明文字里的符号误判为代码。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

for (const src of panelSources) {
    let text;
    try {
        text = stripComments(src.text());
    } catch (e) {
        fail(`读取 ${src.rel}`, e.message);
        continue;
    }

    const lines = text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        for (const b of BANNED) {
            if (b.re.test(lines[i])) {
                hits.push(`第 ${i + 1} 行用了 ${b.name}（需 ${b.since}）：${lines[i].trim().slice(0, 90)}`);
            }
        }
    }

    if (hits.length === 0) {
        pass(`${src.rel} 未使用高版本语法`);
    } else {
        fail(`${src.rel} 含 Chromium 74 不支持的语法`, hits.join('\n'));
    }
}

// ------------------------------------------------------------------

console.log('');
if (failed === 0) {
    console.log('全部检查通过。');
    process.exit(0);
} else {
    console.log(`检查未通过：${failed} 项失败。`);
    process.exit(1);
}
