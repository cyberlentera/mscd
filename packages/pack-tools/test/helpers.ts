// Test helpers: temporary folders, repository paths, a pack built once from the repository sources with a test
// key, and archive builders for hand-made (also hostile) packs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll } from 'vitest';
import {
  PACK_MTIME, buildPack, generateSigningKeyPair, readPack, writeTar, type BuiltPack, type GeneratedKeyPair, type TarWriteEntry,
} from '../src/index.js';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '../..');
export const SOURCES_DIR = path.join(REPO_ROOT, 'packs/sources');
export const DEV_KEYS_DIR = path.join(PACKAGE_DIR, 'dev-keys');
export const DEV_LICENCES_DIR = path.join(PACKAGE_DIR, 'dev-licences');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary folder removed after the test file. */
export function tempDir(prefix = 'mscd-pack-tools-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let cached: { key: GeneratedKeyPair; pack: BuiltPack } | undefined;

/** ISO27001-2022 built from the repository sources with a fresh test key (built once per test file). */
export function testPack(): { key: GeneratedKeyPair; pack: BuiltPack; files: Map<string, Buffer> } {
  cached ??= (() => {
    const key = generateSigningKeyPair();
    return { key, pack: buildPack(path.join(SOURCES_DIR, 'ISO27001-2022'), key.privateKey) };
  })();
  return { ...cached, files: new Map(readPack(cached.pack.bytes).files) };
}

/** Gzipped tar of the entries (no checks). */
export function archive(entries: readonly TarWriteEntry[]): Buffer {
  return gzipSync(writeTar(entries, { mtime: PACK_MTIME }));
}

/** Gzipped tar of named files, in the order given. */
export function archiveOf(files: Iterable<readonly [string, Buffer]>): Buffer {
  return archive([...files].map(([name, data]) => ({ path: name, data })));
}
