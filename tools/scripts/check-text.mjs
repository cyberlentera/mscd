#!/usr/bin/env node
// Writing rule check (build plan R-08): fails when a file under the given folders (or a given file) contains an
// em dash (U+2014) or a centre dot (U+00B7). Prints "file:line:column: character" for every occurrence.
//
// Usage: node tools/scripts/check-text.mjs <folder or file>...
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN = new Map([
  ['\u2014', 'U+2014 (em dash)'],
  ['\u00b7', 'U+00B7 (centre dot)'],
]);
const PATTERN = /[\u2014\u00b7]/g;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

const targets = process.argv.slice(2);
if (targets.length === 0 || targets.includes('--help')) {
  process.stderr.write('Usage: node tools/scripts/check-text.mjs <folder or file>...\n');
  process.exit(targets.length === 0 ? 2 : 0);
}

async function* walk(target) {
  const info = await stat(target);
  if (info.isFile()) {
    yield target;
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(target, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

let files = 0;
let findings = 0;
for (const target of targets) {
  try {
    await stat(target);
  } catch {
    process.stderr.write(`check-text: ${target} does not exist\n`);
    process.exit(2);
  }
  for await (const file of walk(target)) {
    const buffer = await readFile(file);
    if (isBinary(buffer)) continue;
    files += 1;
    const lines = buffer.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PATTERN)) {
        findings += 1;
        process.stdout.write(`${file}:${index + 1}:${match.index + 1}: ${FORBIDDEN.get(match[0])}\n`);
      }
    });
  }
}

if (findings > 0) {
  process.stderr.write(`check-text: ${findings} forbidden character(s) found; use plain punctuation instead\n`);
  process.exit(1);
}
process.stdout.write(`check-text: ${files} file(s) checked, no em dash or centre dot found\n`);
