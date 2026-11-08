#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseManifest } = require('./manifest');
const xml = fs.readFileSync(path.join(__dirname, '../cep-extension/CSXS/manifest.xml'), 'utf8');
const parsed = parseManifest(xml);
assert.strictEqual(parsed.schemaVersion, '7.0');
assert.strictEqual(parsed.bundleId, 'com.arknight.autoediting');
assert.deepStrictEqual(parsed.extensionIds, ['com.arknight.autoediting.panel']);
assert.notStrictEqual(parsed.version, parsed.schemaVersion);
assert.strictEqual(parseManifest(xml.replace(/"/g, "'")).version, parsed.version);

const invalid = [
    ['legacy root', xml.replace(/<ExtensionManifest[\s\S]*?>/, '<ExtensionBundle Id="com.arknight.autoediting" Version="0.1.1">').replace('</ExtensionManifest>', '</ExtensionBundle>'), /root must be ExtensionManifest/],
    ['missing schema version', xml.replace('Version="7.0"', ''), /@Version/],
    ['empty schema version', xml.replace('Version="7.0"', 'Version=""'), /@Version/],
    ['release version used as schema', xml.replace('Version="7.0"', 'Version="0.1.1"'), /@Version/],
    ['missing bundle version', xml.replace(/ExtensionBundleVersion="[^"]*"/, ''), /ExtensionBundleVersion/],
    ['missing bundle ID', xml.replace(/ExtensionBundleId="[^"]*"/, ''), /ExtensionBundleId/],
    ['missing ExtensionList', xml.replace(/<ExtensionList>[\s\S]*?<\/ExtensionList>/, ''), /expected ExtensionList/],
    ['empty ExtensionList', xml.replace(/<ExtensionList>[\s\S]*?<\/ExtensionList>/, '<ExtensionList />'), /must contain Extension/],
    ['mismatched panel IDs', xml.replace('Id="com.arknight.autoediting.panel"', 'Id="com.arknight.autoediting.other"'), /IDs must match/],
    ['duplicate listed IDs', xml.replace('</ExtensionList>', '<Extension Id="com.arknight.autoediting.panel" /></ExtensionList>'), /duplicate Extension@Id/],
    ['comment cannot supply list', xml.replace(/(<ExtensionList>[\s\S]*?<\/ExtensionList>)/, '<!--$1-->'), /expected ExtensionList/],
    ['wrong namespace', xml.replace('xmlns:xsi=', 'xmlns='), /default namespace/],
    ['unbalanced XML', xml.replace('</DispatchInfoList>', '</ExtensionList>'), /unbalanced/],
    ['multiple roots', xml + '<Extra />', /root must be/],
    ['duplicate attributes', xml.replace('Version="7.0"', 'Version="7.0" Version="7.0"'), /duplicate attribute/]
];
for (const [name, input, expected] of invalid) {
    assert.throws(() => parseManifest(input), expected, name);
}

// Run each consumer in a sandbox with a legacy manifest. This verifies that the
// actual entry points reject it, without touching source, dist, or signing tools.
const legacy = invalid[0][1];
for (const file of ['check.js', 'package.js', 'release-info.js', 'make-zxp.js', 'verify-package.js']) {
    let validated = false;
    const stop = new Error('test stop');
    const sandboxFs = {
        readFileSync: () => legacy,
        existsSync: () => true,
        readdirSync: () => ['com.arknight.autoediting-v0.1.1.zip'],
        copyFileSync: () => {},
        unlinkSync: () => {}
    };
    let source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    if (file === 'verify-package.js') {
        // ZIP decoding is tested by verify-package itself; inject decoded XML
        // here to test its schema gate independently of archive construction.
        source = source.slice(source.indexOf('let bundleId;'));
    }
    try {
        vm.runInNewContext(source, {
            require: name => {
                if (name === 'fs') { return sandboxFs; }
                if (name === 'child_process') { return { execFileSync: () => {} }; }
                if (name === './manifest') {
                    return { parseManifest: text => {
                        validated = true;
                        assert.throws(() => parseManifest(text), /root must be ExtensionManifest/);
                        throw stop;
                    } };
                }
                return require(name);
            },
            __dirname,
            manifestText: legacy,
            pass: () => {},
            fail: () => { throw stop; },
            console: { log: () => {}, error: () => {} },
            process: { argv: [], execPath: process.execPath, pid: process.pid, exit: () => { throw stop; } }
        }, { filename: file });
    } catch (e) {
        assert.strictEqual(e, stop, file);
    }
    assert.ok(validated, file + ' must validate the CEP schema');
}
console.log('Manifest regression passed: valid manifest, 15 invalid structures, 5 consumer gates.');
