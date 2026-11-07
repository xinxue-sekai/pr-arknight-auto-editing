#!/usr/bin/env node
/**
 * release-info.js —— Release workflow 的跨平台版本/说明生成器
 *
 * 不依赖 grep/sed/cat 等 shell 工具；Release runner 是 Windows，
 * 所有 manifest 解析与 Release 说明生成统一由 Node 完成。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'cep-extension', 'CSXS', 'manifest.xml');
const DIST = path.join(ROOT, 'dist');
const xml = fs.readFileSync(MANIFEST, 'utf8');
const match = xml.match(/<ExtensionBundle\b[^>]*\bVersion\s*=\s*"([^"]+)"/);
if (!match) {
    console.error('无法从 manifest.xml 读取 ExtensionBundle@Version');
    process.exit(1);
}
const version = match[1];

function checkTag(tag) {
    const expected = 'v' + version;
    console.log('tag = ' + tag);
    console.log('manifest 版本 = ' + version);
    if (tag !== expected) {
        console.error('::error::tag (' + tag + ') 与 manifest 版本 (' + expected + ') 不一致。');
        process.exit(1);
    }
}

function writeNotes(outPath) {
    const zips = fs.readdirSync(DIST).filter(name => /\.zip$/i.test(name)).sort();
    if (zips.length !== 1) {
        console.error('dist 中应有且只有一个 zip，实际找到: ' + zips.join(', '));
        process.exit(1);
    }
    const zip = zips[0];
    const body = [
        'CEP 扩展包。',
        '',
        '## 安装',
        '',
        '1. 下载并解压 `' + zip + '`，得到 `com.arknight.autoediting` 文件夹',
        '2. 整个文件夹放进 `%APPDATA%\\Adobe\\CEP\\extensions\\`',
        '   最终路径应为 `…\\Roaming\\Adobe\\CEP\\extensions\\com.arknight.autoediting\\CSXS\\manifest.xml`',
        '3. 开启未签名扩展的调试模式：把 `PlayerDebugMode`（字符串 `1`）写入',
        '   `HKCU\\Software\\Adobe\\CSXS.10`、`.11`、`.12`',
        '4. 重启 Premiere Pro，然后打开 `窗口 → 扩展 → Arknight Auto Editing`',
        '',
        '## 还需要准备分析器',
        '',
        '本扩展**不含**视频分析能力。分析器是独立的第三方项目，',
        '需要自行获取并在面板的「环境设置」里指定其目录。',
        '详见仓库 README 的「准备分析器」一节。',
        '',
        '## 已知情况',
        '',
        '版本 `' + version + '`。面板与 ExtendScript 宿主层已在真实的 Premiere Pro 25.3.0',
        '上完成真机验证（环境检测 / getHostInfo / analyze / 导出 EDL 全链路跑通）；',
        '「落地到 Premiere」（createSubClip → 拼装序列）环节待带真实素材的项目验证，',
        '遇到问题欢迎开 issue 反馈 `checkCapabilities` 的输出。',
        ''
    ].join('\n');
    fs.writeFileSync(outPath, body, 'utf8');
    process.stdout.write(body);
}

const mode = process.argv[2];
if (mode === '--check-tag') {
    checkTag(process.argv[3] || '');
} else if (mode === '--write-notes') {
    writeNotes(process.argv[3] || path.join(ROOT, 'release-notes.md'));
} else {
    console.error('用法: node tools/release-info.js --check-tag v0.1.1');
    console.error('      node tools/release-info.js --write-notes release-notes.md');
    process.exit(2);
}
