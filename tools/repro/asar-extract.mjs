#!/usr/bin/env node
// Minimal Electron asar extractor for recon purposes.
// Usage: node asar-extract.mjs <archive.asar> <outDir> [--text-only]
// Format: 8-byte header: uint32 pickle size (=4), uint32 header json length,
// then header JSON, then concatenated file payloads at offset base=8+jsonLen.
import fs from 'node:fs';
import path from 'node:path';

const [, , archive, outDir, ...flags] = process.argv;
if (!archive || !outDir) {
  console.error('usage: node asar-extract.mjs <archive.asar> <outDir> [--text-only]');
  process.exit(2);
}
const textOnly = flags.includes('--text-only');

const fd = fs.openSync(archive, 'r');
const st = fs.fstatSync(fd);
const sz = st.size;
// Outer pickle: [u32 payloadSize=4][u32 headerPickleSize]
const head = Buffer.alloc(8);
fs.readSync(fd, head, 0, 8, 0);
const pickleSize = head.readUInt32LE(0);
const headerSize = head.readUInt32LE(4); // size of header pickle incl. its own u32 payloadSize
const headerPickle = Buffer.alloc(headerSize);
fs.readSync(fd, headerPickle, 0, headerSize, 8);
// Inner pickle: [u32 payloadSize][u32 jsonLen][json bytes][padding]
const innerPayload = headerPickle.readUInt32LE(0);
const jsonLen = headerPickle.readUInt32LE(4);
const jsonBuf = headerPickle.subarray(8, 8 + jsonLen);
const header = JSON.parse(jsonBuf.toString('utf8'));
const base = 8 + headerSize; // == offset 0 of first file payload
console.error(`archive=${archive} size=${sz} pickleSize=${pickleSize} jsonLen=${jsonLen} base=${base}`);

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.ts', '.tsx', '.jsx', '.map', '.md', '.txt',
  '.yml', '.yaml', '.html', '.htm', '.css', '.svg', '.scss', '.less', '.xml',
  '.toml', '.ini', '.cfg', '.conf', '.sh', '.ps1', '.py', '.gql', '.graphql',
]);
const MAX_TEXT = 40 * 1024 * 1024; // skip absurdly big text files
let files = 0;
let bytes = 0;
const manifest = [];

function walk(node, rel) {
  for (const [name, ent] of Object.entries(node.files || {})) {
    const p = rel ? `${rel}/${name}` : name;
    if (ent.files) {
      const dir = path.join(outDir, p);
      fs.mkdirSync(dir, { recursive: true });
      walk(ent, p);
    } else {
      const ext = path.extname(name).toLowerCase();
      const isText = TEXT_EXT.has(ext);
      if (ent.unpacked || typeof ent.offset === 'undefined') {
        manifest.push({ path: p, size: ent.size, unpacked: true, text: isText });
        return;
      }
      const off = base + Number(ent.offset);
      const len = Number(ent.size);
      bytes += len;
      files++;
      manifest.push({ path: p, offset: Number(ent.offset), size: len, text: isText });
      if (textOnly && !isText) return;
      if (isText && len > MAX_TEXT) {
        console.error(`skip huge text ${p} (${len})`);
        return;
      }
      const dest = path.join(outDir, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      fs.writeFileSync(dest, buf);
    }
  }
}
walk(header, '');
fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify({ archive, size: sz, base, fileCount: files, totalBytes: bytes, entries: manifest }, null, 2));
fs.closeSync(fd);
console.error(`extracted ${files} files (${bytes} bytes) -> ${outDir}`);
