// Building, signing and verifying framework packs (E.8, D-16).
//
// A pack `<pack_id>-<pack_version>.pack` is a gzipped tar of `manifest.json`, the dataset files and `signature`.
// `manifest.json` carries the SHA-256 of every dataset; `signature` holds the Ed25519 signature over the exact bytes
// of `manifest.json` (`ed25519:<base64>` on the first line, `key:<key id>` on the second). Builds are deterministic:
// sorted entries, then `signature`, fixed mtime 2026-01-01T00:00:00Z, uid and gid 0, mode 0644, gzip level 9.
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PackManifest, PackSourceManifest } from '@mscd/shared';
import { MANIFEST_FILE, SIGNATURE_FILE, readPack, type PackLimits } from './archive.js';
import { parsePackDatasets, type PackDatasets } from './datasets.js';
import { PackError } from './errors.js';
import { loadSigningKey, trustedKeysById, type SigningKeyInput, type TrustedKeyInput } from './keys.js';
import { writeTar } from './tar.js';

/** Modification time of every archive entry. */
export const PACK_MTIME = new Date('2026-01-01T00:00:00Z');

/** Order of the manifest members in a built `manifest.json` (E.8). */
const MANIFEST_KEY_ORDER = [
  'pack_id', 'pack_version', 'framework_code', 'framework_name', 'edition', 'status', 'pre_release', 'supersedes',
  'engine_min_version', 'modules', 'applicability_target', 'catalogue', 'datasets',
] as const;

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** File name of a pack archive: `<pack_id>-<pack_version>.pack`. */
export function packFileName(manifest: { readonly pack_id: string; readonly pack_version: string }): string {
  return `${manifest.pack_id}-${manifest.pack_version}.pack`;
}

// ---------------------------------------------------------------------------------------------------------------
// Signature file
// ---------------------------------------------------------------------------------------------------------------

const SIGNATURE_RE = /^ed25519:([A-Za-z0-9+/]{86}==)\nkey:([0-9a-f]{16})\n?$/;

/** Text of a `signature` file. */
export function formatSignatureFile(signature: Buffer, keyId: string): string {
  return `ed25519:${signature.toString('base64')}\nkey:${keyId}\n`;
}

/** Reads a `signature` file; throws `PackError` (`signature`) when it is malformed. */
export function parseSignatureFile(bytes: Buffer): { signature: Buffer; keyId: string } {
  const match = SIGNATURE_RE.exec(bytes.toString('latin1'));
  if (!match) {
    throw new PackError('signature', `${SIGNATURE_FILE} file is malformed: expected "ed25519:<base64 signature>" and "key:<16 hex key id>" lines`);
  }
  const signature = Buffer.from(match[1] as string, 'base64');
  if (signature.length !== 64) throw new PackError('signature', `${SIGNATURE_FILE} file does not hold a 64-byte Ed25519 signature`);
  return { signature, keyId: match[2] as string };
}

// ---------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------

export interface PackSource {
  readonly manifest: PackSourceManifest;
  /** Dataset files by name (`requirements.csv`, `mappings/<target>.csv`, ...), without `manifest.json`. */
  readonly datasets: ReadonlyMap<string, Buffer>;
}

/**
 * Reads a pack source folder (`packs/sources/<pack_id>`): `manifest.json` (every E.8 field except `datasets`) and
 * the dataset files, with `mappings/*.csv` as the only subfolder. Symbolic links, other file types, nested folders
 * and a `signature` file are refused. Throws `PackError` (`source` or `manifest`).
 */
export function readPackSource(sourceDir: string): PackSource {
  const issues: string[] = [];
  const files = new Map<string, Buffer>();
  const visit = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      throw new PackError('source', `cannot read pack source folder ${dir} (${(error as Error).message})`);
    }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path.join(dir, name));
      if (stat.isSymbolicLink()) issues.push(`${rel}: is a symbolic link`);
      else if (stat.isDirectory()) {
        if (prefix === '' && name === 'mappings') visit(path.join(dir, name), rel);
        else issues.push(`${rel}: folders other than mappings/ are not allowed`);
      } else if (!stat.isFile()) issues.push(`${rel}: is not a regular file`);
      else if (rel === SIGNATURE_FILE) issues.push(`${rel}: a source folder has no signature file; the builder writes it`);
      else files.set(rel, readFileSync(path.join(dir, name)));
    }
  };
  visit(sourceDir, '');
  if (issues.length > 0) throw new PackError('source', `pack source folder ${sourceDir} cannot be built`, issues);
  const manifestBytes = files.get(MANIFEST_FILE);
  if (!manifestBytes) throw new PackError('manifest', `pack source folder ${sourceDir} has no ${MANIFEST_FILE}`);
  files.delete(MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new PackError('manifest', `${sourceDir}/${MANIFEST_FILE} is not valid UTF-8 JSON (${(error as Error).message})`);
  }
  const parsed = PackSourceManifest.safeParse(raw);
  if (!parsed.success) {
    throw new PackError('manifest', `${sourceDir}/${MANIFEST_FILE} is not a valid source manifest`, parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return { manifest: parsed.data, datasets: files };
}

export interface BuildPackOptions {
  /** Refuse to sign with these key ids (a release build passes `DEV_KEY_IDS`, D-16). */
  readonly rejectKeyIds?: Iterable<string>;
}

export interface BuiltPack {
  /** `<pack_id>-<pack_version>.pack`. */
  readonly fileName: string;
  readonly bytes: Buffer;
  readonly manifest: PackManifest;
  readonly datasets: PackDatasets;
  /** Key id of the signing key. */
  readonly keyId: string;
  /** SHA-256 of the archive bytes, hexadecimal. */
  readonly sha256: string;
}

function orderedManifest(source: PackSourceManifest, datasets: Record<string, string>): Record<string, unknown> {
  const all: Record<string, unknown> = { ...source, datasets };
  const out: Record<string, unknown> = {};
  for (const key of MANIFEST_KEY_ORDER) if (all[key] !== undefined) out[key] = all[key];
  return out;
}

/** Byte order of UTF-8 names (code unit order equals code point order for the ASCII names packs use). */
function byName(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Builds and signs a pack from a source that is already in memory (see `buildPack`). */
export function buildPackFromSource(source: PackSource, signingKey: SigningKeyInput, options: BuildPackOptions = {}): BuiltPack {
  let key;
  try {
    key = loadSigningKey(signingKey);
  } catch (error) {
    throw new PackError('signing_key', `pack signing key: ${(error as Error).message}`);
  }
  if (new Set(options.rejectKeyIds ?? []).has(key.keyId)) {
    throw new PackError('signing_key', `pack signing key ${key.keyId} is a development key; a release build never signs with it`);
  }
  const datasets = parsePackDatasets(source.datasets, source.manifest);
  const names = [...source.datasets.keys()].sort(byName);
  const checksums: Record<string, string> = {};
  for (const name of names) checksums[name] = `sha256:${sha256Hex(source.datasets.get(name) as Buffer)}`;
  const manifestObject = orderedManifest(source.manifest, checksums);
  const manifest = PackManifest.parse(manifestObject);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`, 'utf8');
  const signature = sign(null, manifestBytes, key.privateKey);
  const signatureBytes = Buffer.from(formatSignatureFile(signature, key.keyId), 'latin1');
  const contents = new Map<string, Buffer>([[MANIFEST_FILE, manifestBytes], ...names.map((n) => [n, source.datasets.get(n) as Buffer] as const)]);
  const entries = [...contents.keys()]
    .sort(byName)
    .map((name) => ({ path: name, data: contents.get(name) as Buffer }));
  entries.push({ path: SIGNATURE_FILE, data: signatureBytes });
  const bytes = gzipSync(writeTar(entries, { mtime: PACK_MTIME }), { level: 9 });
  // The archive must pass the same checks as any pack the server installs.
  verifyPack(bytes, [key.publicKey]);
  return { fileName: packFileName(manifest), bytes, manifest, datasets, keyId: key.keyId, sha256: sha256Hex(bytes) };
}

/**
 * Builds and signs the pack of a source folder: validates `manifest.json` and every dataset with the schemas of
 * `@mscd/shared`, writes the dataset checksums into the manifest, signs it and creates the deterministic archive.
 * Throws `PackError`.
 */
export function buildPack(sourceDir: string, signingKey: SigningKeyInput, options: BuildPackOptions = {}): BuiltPack {
  return buildPackFromSource(readPackSource(sourceDir), signingKey, options);
}

// ---------------------------------------------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------------------------------------------

export interface VerifyPackOptions {
  /** Key ids to refuse even when trusted (a release build passes `DEV_KEY_IDS`, D-16). */
  readonly rejectKeyIds?: Iterable<string>;
  /** Archive limits; each absent or `undefined` limit takes its `DEFAULT_PACK_LIMITS` value (`resolvePackLimits`). */
  readonly limits?: Partial<PackLimits>;
}

export interface VerifiedPack {
  readonly manifest: PackManifest;
  /** Exact bytes of `manifest.json`. */
  readonly manifestBytes: Buffer;
  readonly datasets: PackDatasets;
  /** Dataset files by name, exactly as in the archive. */
  readonly files: ReadonlyMap<string, Buffer>;
  /** Key id of the key that signed the pack. */
  readonly keyId: string;
  /** SHA-256 of the archive bytes, hexadecimal. */
  readonly sha256: string;
}

/**
 * Verifies a pack archive: the archive rules of `readPack`, then the signature over the exact bytes of
 * `manifest.json` with a trusted pack key (entries of another `kind` are ignored; key ids in `rejectKeyIds` are
 * refused first), then the manifest schema, every dataset checksum, and every dataset with the schemas of
 * `@mscd/shared`. Throws `PackError`; returns the parsed pack.
 */
export function verifyPack(buffer: Buffer, trustedKeys: Iterable<TrustedKeyInput>, options: VerifyPackOptions = {}): VerifiedPack {
  const archive = readPack(buffer, options.limits);
  const { signature, keyId } = parseSignatureFile(archive.signatureBytes);
  if (new Set(options.rejectKeyIds ?? []).has(keyId)) {
    throw new PackError('rejected_key', `pack is signed with development key ${keyId}, which this build does not accept`);
  }
  const trusted: Map<string, KeyObject> = trustedKeysById(trustedKeys, 'pack');
  const publicKey = trusted.get(keyId);
  if (!publicKey) throw new PackError('untrusted_key', `pack is signed with key ${keyId}, which is not a trusted pack key`);
  if (!verify(null, archive.manifestBytes, publicKey, signature)) {
    throw new PackError('signature', `pack signature does not match ${MANIFEST_FILE} for key ${keyId}`);
  }
  const parsed = PackManifest.safeParse(JSON.parse(archive.manifestBytes.toString('utf8')));
  if (!parsed.success) {
    throw new PackError('manifest', `${MANIFEST_FILE} is not a valid pack manifest`, parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const manifest = parsed.data;
  const files = new Map<string, Buffer>();
  const mismatched: string[] = [];
  for (const [name, expected] of Object.entries(manifest.datasets)) {
    const bytes = archive.files.get(name) as Buffer;
    if (`sha256:${sha256Hex(bytes)}` !== expected) mismatched.push(name);
    files.set(name, bytes);
  }
  if (mismatched.length > 0) {
    throw new PackError('checksum', `pack ${manifest.pack_id} ${manifest.pack_version}: datasets do not match their checksums`, mismatched);
  }
  const datasets = parsePackDatasets(files, manifest);
  return { manifest, manifestBytes: archive.manifestBytes, datasets, files, keyId, sha256: sha256Hex(buffer) };
}
