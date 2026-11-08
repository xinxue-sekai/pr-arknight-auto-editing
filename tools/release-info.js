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
    const expectedAssets = [
        'arknight-pr-setup-v' + version + '-windows-x64.zip',
        'com.arknight.autoediting-v' + version + '.zip'
    ];
    if (fs.existsSync(notesFile)) {
        for (const name of expectedAssets) {
            if (!fs.existsSync(path.join(DIST, name))) throw new Error('Missing release asset: ' + name);
        }
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
} else if (mode === '--write-notes') {
    writeNotes(process.argv[3] || path.join(ROOT, 'release-notes.md'));
} else {
    console.error('用法: node tools/release-info.js --check-tag v0.1.1');
    console.error('      node tools/release-info.js --write-notes release-notes.md');
    process.exit(2);
}
