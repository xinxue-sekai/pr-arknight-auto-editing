'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeZip } = require('./zip');
const { parseManifest } = require('./manifest');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const { bundleId, version } = parseManifest(fs.readFileSync(path.join(root, 'cep-extension/CSXS/manifest.xml'), 'utf8'));
execFileSync(process.execPath, [path.join(__dirname, 'package.js')], { stdio: 'inherit' });
const stage = path.join(dist, 'arknight-pr-setup');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(dist, bundleId), path.join(stage, 'panel'), { recursive: true });
const required = ['pr_cli.py', 'analyzer.py', 'frame_types.py', 'session_store.py', 'LICENSE', 'SOURCE_VERSION.json'];
for (const file of fs.readdirSync(path.join(root, 'backend'))) {
    if (file.endsWith('.py') && !file.startsWith('test_') && !required.includes(file)) required.push(file);
}
for (const kind of ['pause', '1x', '2x', 'play']) required.push('templates_' + kind, 'source_images_' + kind);
for (const name of required) {
    const from = path.join(root, 'backend', name);
    if (!fs.existsSync(from)) throw new Error('Missing backend input: ' + name);
    fs.cpSync(from, path.join(stage, 'backend', name), { recursive: true });
}
for (const name of ['setup.bat', 'setup.ps1', 'runtime-lock.json']) fs.copyFileSync(path.join(root, 'cep-extension/install', name), path.join(stage, name));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.writeFileSync(path.join(stage, 'INSTALLATION.md'), fs.readFileSync(path.join(root, 'docs/installation-options.md'), 'utf8').replace('../cep-extension/install/runtime-lock.json', 'runtime-lock.json'));
writeZip(stage, path.join(dist, `arknight-pr-setup-v${version}-windows-x64.zip`));
console.log('Unified online setup ZIP built (runtime downloaded and hash-verified at install time).');
