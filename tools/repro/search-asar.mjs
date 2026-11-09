#!/usr/bin/env node
// Search extracted asar text with contextual snippets (minified files => grep tool truncates lines).
// usage: node search-asar.mjs <rootDir> <regex> [--ctx N] [--max HITS] [--files-only]
import fs from 'node:fs';
import path from 'node:path';

const [, , root, pattern, ...rest] = process.argv;
if (!root || !pattern) {
  console.error('usage: node search-asar.mjs <root> <regex> [--ctx N] [--max N] [--files-only]');
  process.exit(2);
}
const getArg = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 ? Number(rest[i + 1]) : def;
};
const ctx = getArg('--ctx', 220);
const max = getArg('--max', 60);
const filesOnly = rest.includes('--files-only');
const re = new RegExp(pattern, 'g');
const TEXT = /\.(js|mjs|cjs|json|ts|map|md|txt|yml|yaml|html|css|svg)$/i;

const walk = (dir, out = []) => {
  const st = fs.statSync(dir);
  if (st.isFile()) {
    out.push(dir);
    return out;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
};
const files = walk(root);
let hits = 0;
const perFile = new Map();
for (const f of files) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  let m;
  re.lastIndex = 0;
  let first = null;
  while ((m = re.exec(txt)) && hits < max) {
    hits++;
    perFile.set(f, (perFile.get(f) || 0) + 1);
    if (filesOnly) { if (perFile.get(f) === 1) console.log(f); break; }
    const s = Math.max(0, m.index - ctx);
    const e = Math.min(txt.length, m.index + m[0].length + ctx);
    const snippet = txt.slice(s, e).replace(/\s+\n\s*/g, ' ').replace(/\n/g, ' ');
    console.log(`\n=== ${path.relative(root, f)} @${m.index} (${m[0]}) ===`);
    console.log(snippet);
    if (hits >= max) break;
  }
  if (hits >= max) break;
}
if (filesOnly) console.log(`\n-- ${perFile.size} files matched, ${hits} hits --`);
else console.log(`\n-- shown ${hits} hit(s) (cap ${max}) --`);
