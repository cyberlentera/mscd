// Installation of pack files from disk: every `*.pack` of a folder (`migrate`, C.3 step 5, `packs.dir`) or one file
// (`mscd-server packs install <file>`), as `mscd_pack_installer` on a dedicated connection (D-17). Packs already
// installed at the same version are left alone; a rejected or failed pack does not stop the others. In a folder, a
// lower version than the installed one is skipped (C.3 step 5 installs only what is not installed yet: the image's
// `packs.dir` may still ship a version older than one imported later); `packs install` refuses it (E.8 step 4).
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditWriter } from '../../common/tokens';
import { openDedicatedDatabase } from '../../db/migrator';
import type { DB } from '../../db/types';
import { VERSION } from '../../generated/build-info';
import { compiledTrustAnchors, type TrustAnchors } from '../license/trust-anchors';
import { PackInstallFailedError, PackInstaller, type PackInstallActor } from './pack-installer';
import { PackRejectedError } from './pack-verification';
import type { Kysely } from 'kysely';

/** Largest pack file read from disk (the archive rules cap the decompressed size at 200 MiB). */
export const MAX_PACK_FILE_BYTES = 200 * 1024 * 1024;

export interface PackFileResult {
  file: string;
  /** `skipped`: a lower version than the installed one, found in a folder (not an error, nothing written). */
  status: 'installed' | 'unchanged' | 'skipped' | 'rejected' | 'failed';
  packId?: string;
  version?: string;
  message?: string;
}

export interface PackFolderReport {
  dir: string;
  /** False when the folder does not exist (nothing to install). */
  found: boolean;
  results: PackFileResult[];
}

export interface PackFileInstallOptions {
  /** URL of role `mscd_pack_installer`. */
  installerUrl: string;
  /** Writes the `pack.*` platform audit entries; built on the installer connection by the caller. */
  audit: (installerDb: Kysely<DB>) => Pick<AuditWriter, 'record'>;
  actor?: PackInstallActor;
  trust?: TrustAnchors;
  serverVersion?: string;
  log?: (line: string) => void;
}

/** Host, port and database of a PostgreSQL URL (to check that two role URLs name the same database). */
export function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${database}`;
}

async function withInstaller<T>(options: PackFileInstallOptions, fn: (installer: PackInstaller) => Promise<T>): Promise<T> {
  const installerDb = openDedicatedDatabase<DB>(options.installerUrl, { platformScope: true, applicationName: 'mscd-packs' });
  try {
    const installer = new PackInstaller({
      installerDb,
      audit: options.audit(installerDb),
      trust: options.trust ?? compiledTrustAnchors(),
      serverVersion: options.serverVersion ?? VERSION,
      logger: { warn: (message) => options.log?.(`warning: ${message}`) },
    });
    return await fn(installer);
  } finally {
    await installerDb.destroy();
  }
}

async function installOne(installer: PackInstaller, file: string, actor: PackInstallActor, whenOlder: 'reject' | 'skip'): Promise<PackFileResult> {
  const name = path.basename(file);
  try {
    const info = await stat(file);
    if (!info.isFile()) return { file: name, status: 'rejected', message: 'not a regular file' };
    if (info.size > MAX_PACK_FILE_BYTES) return { file: name, status: 'rejected', message: `larger than ${MAX_PACK_FILE_BYTES} bytes` };
    const outcome = await installer.install(await readFile(file), { actor, orgId: null, whenOlder });
    if (outcome.status === 'skipped') {
      return { file: name, status: 'skipped', packId: outcome.packId, version: outcome.version, message: `older than the installed version ${outcome.installedVersion}` };
    }
    return { file: name, status: outcome.status, packId: outcome.packId, version: outcome.version };
  } catch (error) {
    if (error instanceof PackRejectedError) {
      return { file: name, status: 'rejected', packId: error.pack?.packId, version: error.pack?.version, message: [error.message, ...error.issues.slice(0, 10)].join('; ') };
    }
    if (error instanceof PackInstallFailedError) {
      return { file: name, status: 'failed', packId: error.pack.packId, version: error.pack.version, message: error.message };
    }
    return { file: name, status: 'failed', message: (error as Error).message };
  }
}

function line(result: PackFileResult): string {
  const what = result.packId ? `${result.packId} ${result.version}` : result.file;
  return `${what}: ${result.status}${result.message ? ` (${result.message})` : ''}`;
}

/** Installs one pack file. */
export async function installPackFile(file: string, options: PackFileInstallOptions): Promise<PackFileResult> {
  const actor = options.actor ?? { userId: null, kind: 'operator' };
  const result = await withInstaller(options, (installer) => installOne(installer, path.resolve(file), actor, 'reject'));
  options.log?.(line(result));
  return result;
}

/** Installs every `*.pack` file of a folder, in name order (C.3 step 5); a version older than the installed one is skipped. */
export async function installPacksFromDir(dir: string, options: PackFileInstallOptions): Promise<PackFolderReport> {
  const resolved = path.resolve(dir);
  let names: string[];
  try {
    names = (await readdir(resolved)).filter((name) => name.endsWith('.pack')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      options.log?.(`packs: ${resolved} does not exist; no pack installed`);
      return { dir: resolved, found: false, results: [] };
    }
    throw error;
  }
  if (names.length === 0) {
    options.log?.(`packs: no pack file in ${resolved}`);
    return { dir: resolved, found: true, results: [] };
  }
  const actor = options.actor ?? { userId: null, kind: 'operator' };
  const results = await withInstaller(options, async (installer) => {
    const out: PackFileResult[] = [];
    for (const name of names) {
      const result = await installOne(installer, path.join(resolved, name), actor, 'skip');
      options.log?.(`packs: ${line(result)}`);
      out.push(result);
    }
    return out;
  });
  return { dir: resolved, found: true, results };
}
