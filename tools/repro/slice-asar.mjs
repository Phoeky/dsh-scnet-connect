#!/usr/bin/env node
// Print a character slice of a file (minified bundles: one giant line).
// usage: node slice-asar.mjs <file> <startChar> <endChar> [--pretty]
import fs from 'node:fs';
const [, , file, start, end] = process.argv;
if (!file || start === undefined || end === undefined) {
  console.error('usage: node slice-asar.mjs <file> <startChar> <endChar>');
  process.exit(2);
}
const txt = fs.readFileSync(file, 'utf8');
const s = Math.max(0, Number(start));
const e = Math.min(txt.length, Number(end));
process.stdout.write(txt.slice(s, e));
