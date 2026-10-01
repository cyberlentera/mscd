// Minimal tar (POSIX ustar) writer and a strict reader for pack archives (E.8).
//
// The writer produces deterministic archives: the entries in the order given, mode 0644 for files (0755 for
// folders), uid and gid 0, empty user and group names, one fixed mtime, no extended headers, and the two zero
// blocks that end an archive. GNU tar and node-tar read them (both are tested).
//
// The reader trusts nothing: it checks every header checksum and the ustar magic, never follows an extended
// header, refuses entries past the limit before reading them, refuses truncated data, and requires zero bytes after
// the end-of-archive marker. It reports every entry with its raw path and type; the pack rules (regular files only,
// path rules, unique names) are applied by `readPack`.

const BLOCK = 512;

/** Entry types of a tar header (typeflag byte). */
export type TarEntryType =
  | 'file'
  | 'hardlink'
  | 'symlink'
  | 'char-device'
  | 'block-device'
  | 'directory'
  | 'fifo'
  | 'contiguous'
  | 'pax-header'
  | 'pax-global-header'
  | 'gnu-long-name'
  | 'gnu-long-link'
  | 'other';

const TYPE_FLAGS: Readonly<Record<string, TarEntryType>> = {
  '0': 'file',
  '\0': 'file',
  '1': 'hardlink',
  '2': 'symlink',
  '3': 'char-device',
  '4': 'block-device',
  '5': 'directory',
  '6': 'fifo',
  '7': 'contiguous',
  x: 'pax-header',
  g: 'pax-global-header',
  L: 'gnu-long-name',
  K: 'gnu-long-link',
};

const FLAG_OF_TYPE: Readonly<Partial<Record<TarEntryType, string>>> = {
  file: '0',
  hardlink: '1',
  symlink: '2',
  'char-device': '3',
  'block-device': '4',
  directory: '5',
  fifo: '6',
  contiguous: '7',
  'pax-header': 'x',
  'pax-global-header': 'g',
  'gnu-long-name': 'L',
  'gnu-long-link': 'K',
};

export interface TarWriteEntry {
  /** Path inside the archive, `/`-separated. Written as is (the writer does not judge it). */
  readonly path: string;
  /** Content; required for files, ignored for other types. */
  readonly data?: Buffer;
  /** Default `file`. */
  readonly type?: TarEntryType;
  /** Link target for `symlink` and `hardlink`. */
  readonly linkPath?: string;
  /** Permission bits; default 0644 for files and 0755 for folders. */
  readonly mode?: number;
}

export interface TarWriteOptions {
  /** Modification time of every entry. */
  readonly mtime: Date;
}

export interface TarReadEntry {
  /** Raw path: the ustar prefix and name joined with `/`, decoded as UTF-8 (invalid bytes are replaced). */
  readonly path: string;
  /** Whether the raw path bytes are valid UTF-8. */
  readonly pathIsUtf8: boolean;
  readonly type: TarEntryType;
  /** Raw typeflag character. */
  readonly typeFlag: string;
  readonly size: number;
  readonly data: Buffer;
}

/** Thrown by `readTar` for any structural problem. */
export class TarFormatError extends Error {
  override name = 'TarFormatError';
}

// ---------------------------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------------------------

function writeString(header: Buffer, offset: number, length: number, value: Buffer, field: string): void {
  if (value.length > length) throw new Error(`tar ${field} is longer than ${length} bytes`);
  value.copy(header, offset);
}

/** Octal number with leading zeros in `length - 1` digits and a terminating NUL. */
function writeOctal(header: Buffer, offset: number, length: number, value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tar ${field} ${value} is not a non-negative integer`);
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new Error(`tar ${field} ${value} does not fit the header`);
  header.write(text, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

/** Splits a path into the ustar `prefix` (155 bytes) and `name` (100 bytes) at a `/`. */
function splitPath(path: string): { name: Buffer; prefix: Buffer } {
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length <= 100) return { name: bytes, prefix: Buffer.alloc(0) };
  for (let i = bytes.length - 1; i > 0; i -= 1) {
    if (bytes[i] !== 0x2f) continue;
    const prefix = bytes.subarray(0, i);
    const name = bytes.subarray(i + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`tar path is too long for a ustar header: ${path}`);
}

function headerBlock(entry: TarWriteEntry, size: number, mtime: number): Buffer {
  const type = entry.type ?? 'file';
  const flag = FLAG_OF_TYPE[type];
  if (flag === undefined) throw new Error(`tar entry type ${type} cannot be written`);
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitPath(entry.path);
  writeString(header, 0, 100, name, 'name');
  writeOctal(header, 100, 8, entry.mode ?? (type === 'directory' ? 0o755 : 0o644), 'mode');
  writeOctal(header, 108, 8, 0, 'uid');
  writeOctal(header, 116, 8, 0, 'gid');
  writeOctal(header, 124, 12, size, 'size');
  writeOctal(header, 136, 12, mtime, 'mtime');
  header.write('        ', 148, 8, 'ascii');
  header.write(flag, 156, 1, 'latin1');
  writeString(header, 157, 100, Buffer.from(entry.linkPath ?? '', 'utf8'), 'link name');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0, 'devmajor');
  writeOctal(header, 337, 8, 0, 'devminor');
  writeString(header, 345, 155, prefix, 'prefix');
  let sum = 0;
  for (const byte of header) sum += byte;
  // Six octal digits, NUL, space (the form GNU tar writes).
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Writes a tar archive (uncompressed) of the entries, in the order given. */
export function writeTar(entries: readonly TarWriteEntry[], options: TarWriteOptions): Buffer {
  const mtime = Math.floor(options.mtime.getTime() / 1000);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const carriesData = type === 'file' || type === 'contiguous' || type.startsWith('pax') || type.startsWith('gnu');
    const data = carriesData ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    parts.push(headerBlock(entry, data.length, mtime));
    if (data.length > 0) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------------------------

function isZero(buffer: Buffer): boolean {
  for (const byte of buffer) if (byte !== 0) return false;
  return true;
}

/** Bytes of a NUL-terminated field. */
function cString(header: Buffer, offset: number, length: number): Buffer {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
}

/** Octal number field (leading spaces or zeros, terminated by NUL or space). Base-256 numbers are refused. */
function readOctal(header: Buffer, offset: number, length: number, field: string, at: number): number {
  const raw = header.subarray(offset, offset + length);
  if (raw[0] !== undefined && (raw[0] & 0x80) !== 0) {
    throw new TarFormatError(`header at byte ${at}: ${field} uses base-256 encoding, which pack archives never need`);
  }
  const text = raw.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`header at byte ${at}: ${field} is not an octal number`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarFormatError(`header at byte ${at}: ${field} is too large`);
  return value;
}

function checksumMatches(header: Buffer, at: number): boolean {
  const stored = readOctal(header, 148, 8, 'checksum', at);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : (header[i] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodePath(bytes: Buffer): { path: string; ok: boolean } {
  try {
    return { path: UTF8.decode(bytes), ok: true };
  } catch {
    return { path: bytes.toString('utf8'), ok: false };
  }
}

export interface TarReadOptions {
  /** Largest number of entries (headers of any type); the next header is refused before it is read. */
  readonly maxEntries: number;
}

/**
 * Reads an uncompressed tar archive. Accepts POSIX ustar (`ustar\0` `00`) and GNU (`ustar ` ` \0`) headers and
 * returns every entry, of any type, in archive order; it never applies extended headers. Throws `TarFormatError`
 * for a bad checksum or magic, a truncated entry, a missing end-of-archive marker, data after it, or more entries
 * than allowed.
 */
export function readTar(data: Buffer, options: TarReadOptions): TarReadEntry[] {
  const entries: TarReadEntry[] = [];
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > data.length) {
      throw new TarFormatError('archive is truncated: the end-of-archive marker is missing');
    }
    const header = data.subarray(offset, offset + BLOCK);
    if (isZero(header)) {
      if (offset + 2 * BLOCK > data.length || !isZero(data.subarray(offset + BLOCK, offset + 2 * BLOCK))) {
        throw new TarFormatError('archive is truncated: the end-of-archive marker needs two zero blocks');
      }
      if (!isZero(data.subarray(offset + 2 * BLOCK))) {
        throw new TarFormatError('archive holds data after the end-of-archive marker');
      }
      return entries;
    }
    if (!checksumMatches(header, offset)) throw new TarFormatError(`header at byte ${offset} has a bad checksum`);
    const magic = header.subarray(257, 265).toString('latin1');
    const posix = magic === 'ustar\u000000';
    const gnu = magic === 'ustar  \u0000';
    if (!posix && !gnu) throw new TarFormatError(`header at byte ${offset} is not a ustar header`);
    if (entries.length >= options.maxEntries) {
      throw new TarFormatError(`archive holds more than ${options.maxEntries} entries`);
    }
    const typeFlag = String.fromCharCode(header[156] as number);
    const type = TYPE_FLAGS[typeFlag] ?? 'other';
    const name = cString(header, 0, 100);
    // In GNU headers the bytes from 345 hold times and offsets, not a path prefix.
    const prefix = posix ? cString(header, 345, 155) : Buffer.alloc(0);
    const rawPath = prefix.length > 0 ? Buffer.concat([prefix, Buffer.from('/'), name]) : name;
    const { path, ok } = decodePath(rawPath);
    const size = readOctal(header, 124, 12, 'size', offset);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > data.length) throw new TarFormatError(`entry ${JSON.stringify(path)} is truncated`);
    entries.push({ path, pathIsUtf8: ok, type, typeFlag, size, data: data.subarray(start, end) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}
