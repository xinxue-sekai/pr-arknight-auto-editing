'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { writeZip } = require('./zip');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-zip-'));
try {
    const stage = path.join(temp, 'bundle');
    fs.mkdirSync(stage);
    const filename = '模板 中文.png';
    const bytes = Buffer.from([0, 255, 128, 0, 1, 2, 3]);
    fs.writeFileSync(path.join(stage, filename), bytes);
    const archive = path.join(temp, 'bundle.zip');
    writeZip(stage, archive);
    const zip = fs.readFileSync(archive);
    assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
    assert(zip.readUInt16LE(6) & 0x0800, 'local header must declare UTF-8');
    const nameLength = zip.readUInt16LE(26);
    assert.strictEqual(zip.subarray(30, 30 + nameLength).toString('utf8'), 'bundle/' + filename);
    const start = 30 + nameLength + zip.readUInt16LE(28);
    const compressed = zip.subarray(start, start + zip.readUInt32LE(18));
    const decoded = zip.readUInt16LE(8) === 8 ? zlib.inflateRawSync(compressed) : compressed;
    assert.deepStrictEqual(decoded, bytes);
    const eocd = zip.length - 22;
    const central = zip.readUInt32LE(eocd + 16);
    assert.strictEqual(zip.readUInt32LE(central), 0x02014b50);
    assert(zip.readUInt16LE(central + 8) & 0x0800, 'central header must declare UTF-8');
    console.log('PASS ZIP Unicode filename metadata and exact binary payload');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
