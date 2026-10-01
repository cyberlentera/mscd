// Reading a pack archive before trusting anything in it (E.8 install step 1): gunzip with a decompressed size cap,
// untar with an entry cap, regular files only, no absolute paths, no `..` segments, unique names after
// normalisation, every file at the archive root or under `mappings/`, and exactly the files the manifest lists.
import { constants as bufferConstants } from 'node:buffer';
import { gunzipSync } from 'node:zlib';
import { PackError } from './errors.js';
import { readTar, TarFormatError, type TarReadEntry } from './tar.js';

export const MANIFEST_FILE = 'manifest.json';
export const SIGNATURE_FILE = 'signature';

export interface PackLimits {
  /** Largest total size of the archive after gunzip (the tar stream), in bytes. */
  readonly maxDecompressedBytes: number;
  /** Largest number of tar entries. */
  readonly maxEntries: number;
}

/** E.8 step 1: 200 MB decompressed (MiB), at most 500 entries. */
export const DEFAULT_PACK_LIMITS: PackLimits = Object.freeze({
  maxDecompressedBytes: 200 * 1024 * 1024,
  maxEntries: 500,
});

/**
 * The limits `readPack` applies: each limit the caller gives, or the default for a limit that is absent, `undefined`
 * or `null`, so a missing setting can never turn a cap off. A given limit must be a positive safe integer (and the
 * decompressed size no more than the largest Node.js buffer); anything else throws `RangeError`, a caller error.
 */
export function resolvePackLimits(limits: Partial<PackLimits> | null | undefined = {}): PackLimits {
  const given = limits ?? {};
  const resolved: PackLimits = {
    maxDecompressedBytes: given.maxDecompressedBytes ?? DEFAULT_PACK_LIMITS.maxDecompressedBytes,
    maxEntries: given.maxEntries ?? DEFAULT_PACK_LIMITS.maxEntries,
  };
  for (const [name, value] of Object.entries(resolved) as [keyof PackLimits, unknown][]) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`pack limit ${name} must be a positive safe integer, got ${String(value)}`);
    }
  }
  if (resolved.maxDecompressedBytes > bufferConstants.MAX_LENGTH) {
    throw new RangeError(`pack limit maxDecompressedBytes must be at most ${bufferConstants.MAX_LENGTH}`);
  }
  return resolved;
}

/** A pack archive that passed the archive rules. Nothing in it is verified yet. */
export interface PackArchive {
  /** Every file by its normalised name, in archive order. */
  readonly files: ReadonlyMap<string, Buffer>;
  /** The exact bytes of `manifest.json` (the signature covers them). */
  readonly manifestBytes: Buffer;
  /** The bytes of the `signature` file. */
  readonly signatureBytes: Buffer;
  /** The dataset names listed in `manifest.datasets`, which are exactly the other files of the archive. */
  readonly datasetNames: readonly string[];
}

function fail(message: string): never {
  throw new PackError('archive', message);
}

const ENTRY_TYPE_TEXT: Readonly<Record<string, string>> = {
  hardlink: 'a hard link',
  symlink: 'a symbolic link',
  'char-device': 'a character device',
  'block-device': 'a block device',
  directory: 'a folder entry',
  fifo: 'a FIFO',
  contiguous: 'a contiguous file entry',
  'pax-header': 'a pax extended header',
  'pax-global-header': 'a pax global header',
  'gnu-long-name': 'a GNU long name entry',
  'gnu-long-link': 'a GNU long link entry',
};

/**
 * Checks the path rules and returns the normalised name: no absolute path (`/x`, `\x`, `C:x`), no `..` segment
 * (with `/` or `\` as separator), no control characters or backslashes; `.` and empty segments are dropped and the
 * text is put in Unicode NFC, so `./manifest.json` and `manifest.json` are the same name.
 */
export function normaliseEntryPath(entry: Pick<TarReadEntry, 'path' | 'pathIsUtf8'>): string {
  const raw = entry.path;
  const shown = JSON.stringify(raw);
  if (!entry.pathIsUtf8) fail(`entry ${shown} has a name that is not valid UTF-8`);
  if (raw === '') fail('an entry has an empty name');
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) fail(`entry ${shown} has an absolute path`);
  const segments = raw.split(/[/\\]/);
  if (segments.includes('..')) fail(`entry ${shown} has a ".." path segment`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) fail(`entry ${shown} has a control character in its name`);
  if (raw.includes('\\')) fail(`entry ${shown} has a backslash in its name`);
  const name = segments
    .filter((s) => s !== '' && s !== '.')
    .join('/')
    .normalize('NFC');
  if (name === '') fail(`entry ${shown} has no file name`);
  return name;
}

/** Whether a normalised name may appear in a pack: a file at the root or directly under `mappings/`. */
function allowedLocation(name: string): boolean {
  const parts = name.split('/');
  return parts.length === 1 || (parts.length === 2 && parts[0] === 'mappings');
}

function gunzip(buffer: Buffer, limit: number): Buffer {
  if (buffer.length < 18 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) fail('archive is not gzip compressed');
  try {
    return gunzipSync(buffer, { maxOutputLength: limit });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
      fail(`archive is larger than ${limit} bytes when decompressed`);
    }
    fail(`archive is not valid gzip data (${(error as Error).message})`);
  }
}

/** The dataset names of a manifest, read without trusting the manifest (only its shape is needed here). */
function listedDatasets(manifestBytes: Buffer): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new PackError('manifest', `${MANIFEST_FILE} is not valid UTF-8 JSON (${(error as Error).message})`);
  }
  const datasets = (manifest as { datasets?: unknown } | null)?.datasets;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new PackError('manifest', `${MANIFEST_FILE} is not a JSON object`);
  }
  if (typeof datasets !== 'object' || datasets === null || Array.isArray(datasets)) {
    throw new PackError('manifest', `${MANIFEST_FILE} has no datasets object`);
  }
  return Object.keys(datasets);
}

/**
 * Reads a pack archive in memory and applies the E.8 step 1 rules. Any violation throws `PackError` with code
 * `archive` (or `manifest` when `manifest.json` cannot be read for the file set check). Nothing is verified yet:
 * call `verifyPack` for the signature, checksums and schemas. `limits` goes through `resolvePackLimits`.
 */
export function readPack(buffer: Buffer, limits: Partial<PackLimits> = {}): PackArchive {
  const { maxDecompressedBytes, maxEntries } = resolvePackLimits(limits);
  const tarBytes = gunzip(buffer, maxDecompressedBytes);
  let entries: TarReadEntry[];
  try {
    entries = readTar(tarBytes, { maxEntries });
  } catch (error) {
    if (error instanceof TarFormatError) fail(error.message);
    throw error;
  }
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type !== 'file') {
      fail(`entry ${JSON.stringify(entry.path)} is ${ENTRY_TYPE_TEXT[entry.type] ?? `of tar type ${JSON.stringify(entry.typeFlag)}`}; packs hold regular files only`);
    }
    const name = normaliseEntryPath(entry);
    if (files.has(name)) fail(`archive holds ${JSON.stringify(name)} more than once`);
    if (!allowedLocation(name)) fail(`entry ${JSON.stringify(name)} is not at the archive root or directly under mappings/`);
    files.set(name, entry.data);
  }
  const manifestBytes = files.get(MANIFEST_FILE);
  if (!manifestBytes) fail(`archive has no ${MANIFEST_FILE}`);
  const signatureBytes = files.get(SIGNATURE_FILE);
  if (!signatureBytes) fail(`archive has no ${SIGNATURE_FILE} file`);
  const datasetNames = listedDatasets(manifestBytes);
  const expected = new Set<string>([MANIFEST_FILE, SIGNATURE_FILE, ...datasetNames]);
  const extra = [...files.keys()].filter((name) => !expected.has(name));
  const missing = [...expected].filter((name) => !files.has(name));
  if (extra.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (extra.length > 0) parts.push(`files not listed in the manifest: ${extra.join(', ')}`);
    if (missing.length > 0) parts.push(`files listed but missing: ${missing.join(', ')}`);
    fail(`archive does not hold exactly the files of its manifest (${parts.join('; ')})`);
  }
  return { files, manifestBytes, signatureBytes, datasetNames };
}
