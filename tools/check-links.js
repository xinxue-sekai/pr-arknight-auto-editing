#!/usr/bin/env node
/**
 * check-links.js —— 校验 Markdown 里的本地相对链接是否指向真实存在的文件
 *
 * 为什么需要它：README 与 docs 里引用了不少相对路径（文件、目录、带 #L 的锚点）。
 * 改动目录结构后极容易留下死链，而这类问题在 GitHub 上只有点开才发现。
 *
 * 只检查本地相对链接；http(s)、mailto、页内 #anchor 一律跳过。
 *
 * 用法：node tools/check-links.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failed = 0;

function fail(msg) {
    failed++;
    console.log('  \u2717 ' + msg);
}
function pass(msg) { console.log('  \u2713 ' + msg); }

/** 收集要检查的 Markdown 文件，跳过 node_modules 与其他杂项。 */
function collectMarkdown(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') { continue; }
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectMarkdown(abs, out);
        } else if (/\.md$/i.test(entry.name)) {
            out.push(abs);
        }
    }
    return out;
}

const files = collectMarkdown(ROOT, []);
console.log(`\n检查 ${files.length} 个 Markdown 文件里的本地链接\n`);

for (const file of files) {
    const relFile = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');

    // 只取 markdown 链接的 (url) 部分：[文字](url)
    const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    const broken = [];

    while ((m = linkRe.exec(text)) !== null) {
        let url = m[1];

        // 跳过外部链接与页内锚点
        if (/^(https?:|mailto:|tel:|data:)/i.test(url)) { continue; }
        if (url.startsWith('#')) { continue; }

        // 去掉锚点与查询串
        url = url.split('#')[0].split('?')[0];
        if (!url) { continue; }

        // 允许 URL 编码（例如含空格的路径）
        let decoded = url;
        try { decoded = decodeURIComponent(url); } catch (e) { /* 保持原样 */ }

        const target = path.resolve(path.dirname(file), decoded);
        if (!fs.existsSync(target)) {
            broken.push(`${url}  →  期望路径 ${path.relative(ROOT, target).replace(/\\/g, '/')}`);
        }
    }

    if (broken.length === 0) {
        pass(relFile);
    } else {
        fail(`${relFile} 有 ${broken.length} 个死链`);
        for (const b of broken) { console.log('      ' + b); }
    }
}

console.log('');
if (failed === 0) {
    console.log('所有本地链接有效。');
    process.exit(0);
} else {
    console.log(`有 ${failed} 个文件存在死链。`);
    process.exit(1);
}
