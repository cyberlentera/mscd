// Building every pack source folder into an output folder (`mscd-pack build-all`, D-14, G.7).
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackError } from './errors.js';
import { buildPack, type BuildPackOptions, type BuiltPack } from './pack.js';
import type { SigningKeyInput } from './keys.js';

/** `packs/sources` of the repository this package belongs to. */
export const DEFAULT_SOURCES_DIR = fileURLToPath(new URL('../../../packs/sources', import.meta.url));

/** Writes a file through a temporary name in the same folder, so readers never see a partial file. */
export function writeFileAtomic(file: string, data: Buffer | string, mode = 0o644): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, data, { mode, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface BuildAllResult {
  readonly packs: readonly (BuiltPack & { readonly file: string })[];
  /** `.pack` files of the output folder that no source produces any more, removed by this run. */
  readonly removed: readonly string[];
}

/**
 * Builds every pack source folder under `sourcesDir` (each folder name must equal its `pack_id`) and writes
 * `<outDir>/<pack_id>-<pack_version>.pack`. Every pack is built and checked before anything is written. Other
 * `.pack` files directly in `outDir` are removed afterwards, so the folder holds exactly the current packs.
 */
export function buildAllPacks(sourcesDir: string, signingKey: SigningKeyInput, outDir: string, options: BuildPackOptions = {}): BuildAllResult {
  let folders: string[];
  try {
    folders = readdirSync(sourcesDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => {
        if (!entry.isDirectory()) throw new PackError('source', `${path.join(sourcesDir, entry.name)} is not a pack source folder`);
        return entry.name;
      })
      .sort();
  } catch (error) {
    if (error instanceof PackError) throw error;
    throw new PackError('source', `cannot read pack sources folder ${sourcesDir} (${(error as Error).message})`);
  }
  if (folders.length === 0) throw new PackError('source', `${sourcesDir} holds no pack source folders`);
  const built = folders.map((folder) => {
    const pack = buildPack(path.join(sourcesDir, folder), signingKey, options);
    if (pack.manifest.pack_id !== folder) {
      throw new PackError('source', `pack source folder ${folder} holds pack ${pack.manifest.pack_id}; the folder name must equal the pack_id`);
    }
    return pack;
  });
  const names = new Set(built.map((pack) => pack.fileName));
  if (names.size !== built.length) throw new PackError('source', 'two source folders produce the same pack file name');

  mkdirSync(outDir, { recursive: true });
  const packs = built.map((pack) => {
    const file = path.join(outDir, pack.fileName);
    writeFileAtomic(file, pack.bytes);
    return { ...pack, file };
  });
  const removed: string[] = [];
  for (const name of readdirSync(outDir).sort()) {
    if (!name.endsWith('.pack') || names.has(name)) continue;
    const file = path.join(outDir, name);
    if (!lstatSync(file).isFile()) continue;
    rmSync(file);
    removed.push(file);
  }
  return { packs, removed };
}
