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
const { version } = require('./manifest').parseManifest(xml);

/**
 * v0.2.0 是最后一份不含离线安装包的 Release。之后的版本都要求在发布前
 * 生成并校验 arknight-pr-setup-offline-v<version>-windows-x64.zip。
 */
const OFFLINE_SINCE = [0, 2, 1];

function atLeast(value, minimum) {
    const a = value.split('.').map(Number);
    const b = minimum;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return true;
}

function expectedAssets() {
    const assets = [
        'arknight-pr-setup-v' + version + '-windows-x64.zip',
        'com.arknight.autoediting-v' + version + '.zip'
    ];
    if (atLeast(version, OFFLINE_SINCE)) {
        assets.push('arknight-pr-setup-offline-v' + version + '-windows-x64.zip');
    }
    return assets;
}

function checkAssets() {
    const assets = expectedAssets();
    for (const name of assets) {
        if (!fs.existsSync(path.join(DIST, name))) throw new Error('Missing release asset: ' + name);
    }
    console.log('Release assets present: ' + assets.join(', '));
}

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
    const notesFile = path.join(ROOT, 'docs', 'releases', 'v' + version + '.md');
    if (fs.existsSync(notesFile)) {
        checkAssets();
        const notes = fs.readFileSync(notesFile, 'utf8').replace(/\]\((\.\.\/[^)]+)\)/g, (match, target) => {
            const resolved = path.resolve(path.dirname(notesFile), target);
            const relative = path.relative(ROOT, resolved).split(path.sep).join('/');
            if (relative.startsWith('../')) throw new Error('Release notes link escapes repository: ' + target);
            return '](https://github.com/xinxue-sekai/pr-arknight-auto-editing/blob/v' + version + '/' + relative + ')';
        });
        fs.writeFileSync(outPath, notes, 'utf8');
        process.stdout.write(notes);
        return;
    }
    throw new Error('Missing versioned release notes: ' + notesFile);
}

const mode = process.argv[2];
if (mode === '--check-tag') {
    checkTag(process.argv[3] || '');
} else if (mode === '--check-assets') {
    checkAssets();
} else if (mode === '--write-notes') {
    writeNotes(process.argv[3] || path.join(ROOT, 'release-notes.md'));
} else {
    console.error('用法: node tools/release-info.js --check-tag v0.1.1');
    console.error('      node tools/release-info.js --check-assets');
    console.error('      node tools/release-info.js --write-notes release-notes.md');
    process.exit(2);
}
