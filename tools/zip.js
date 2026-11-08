'use strict';
const fs = require('fs');
const path = require('path');
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
        lfh.writeUInt16LE(0x0800, 6);       // UTF-8 file names
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
        cdh.writeUInt16LE(0x0800, 8);      // UTF-8 file names
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


module.exports = { writeZip };
