// A streaming ustar writer for the Managed Vault pack archive (build plan E.7 step 5, PRD 11.5): entries are written
// one after another from their byte streams, so the archive never sits in memory; the caller gzips the result.
// Entry names are ASCII, at most 99 bytes, regular files only (mode 0644).
import { Readable } from 'node:stream';

export interface TarEntry {
  name: string;
  size: number;
  mtime: Date;
  /** The bytes of the entry; exactly `size` bytes must come out. */
  open(): Promise<AsyncIterable<Uint8Array> | Buffer>;
}

const BLOCK = 512;

/** A safe ASCII entry name of at most 99 bytes (path separators allowed, no `..`). */
export function tarEntryName(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\:*?"<>|]/g, '-')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/');
  return (ascii || 'file').slice(0, 99);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** The 512-byte ustar header of a regular file. */
export function tarHeader(name: string, size: number, mtime: Date): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'ascii');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156); // checksum field counts as spaces
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('mscd', 265, 32, 'ascii');
  header.write('mscd', 297, 32, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return header;
}

async function* tarChunks(entries: readonly TarEntry[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    yield tarHeader(tarEntryName(entry.name), entry.size, entry.mtime);
    const body = await entry.open();
    let written = 0;
    if (Buffer.isBuffer(body)) {
      written = body.length;
      yield body;
    } else {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        written += buffer.length;
        if (written > entry.size) throw new Error(`Archive entry ${entry.name} is longer than its announced ${entry.size} bytes`);
        yield buffer;
      }
    }
    if (written !== entry.size) throw new Error(`Archive entry ${entry.name} has ${written} bytes, not ${entry.size}`);
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (pad > 0) yield Buffer.alloc(pad, 0);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}

/** The tar stream of the entries (not compressed). */
export function tarStream(entries: readonly TarEntry[]): Readable {
  return Readable.from(tarChunks(entries), { objectMode: false });
}
