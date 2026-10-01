// E.8 install step 1: the archive rules every pack must pass before anything in it is trusted.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as nodeTar from 'tar';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACK_LIMITS, PACK_MTIME, PackError, readPack, resolvePackLimits, verifyPack, writeTar, type PackLimits,
} from '../src/index.js';
import { archive, archiveOf, tempDir, testPack } from './helpers.js';

function expectArchiveError(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).code).toBe('archive');
    expect((error as PackError).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected a PackError matching ${pattern}`);
}

/**
 * A tar header announcing a 201 MiB file, followed by 201 gzip members of 1 MiB of zeros each (about 200 KB
 * compressed): the decompressed stream passes the 200 MiB cap before the tar is read.
 */
function gzipBomb(): Buffer {
  const header = writeTar([{ path: 'requirements.csv', data: Buffer.alloc(0) }], { mtime: PACK_MTIME }).subarray(0, 512);
  const zeros = gzipSync(Buffer.alloc(1024 * 1024), { level: 9 });
  return Buffer.concat([gzipSync(header), ...Array.from({ length: 201 }, () => zeros)]);
}

describe('readPack', () => {
  it('reads a built pack: the manifest, the signature and exactly the listed datasets', () => {
    const { pack } = testPack();
    const archived = readPack(pack.bytes);
    expect([...archived.files.keys()].at(-1)).toBe('signature');
    expect(archived.datasetNames).toHaveLength(17);
    expect(archived.files.size).toBe(19);
    expect(JSON.parse(archived.manifestBytes.toString()).pack_id).toBe('ISO27001-2022');
  });

  it('applies the E.8 limits by default', () => {
    expect(DEFAULT_PACK_LIMITS).toEqual({ maxDecompressedBytes: 200 * 1024 * 1024, maxEntries: 500 });
  });

  it('refuses data that is not gzip', () => {
    const { pack } = testPack();
    expectArchiveError(() => readPack(Buffer.from('not a pack at all, just some text')), /not gzip/);
    expectArchiveError(() => readPack(pack.bytes.subarray(0, pack.bytes.length - 40)), /not valid gzip/);
  });

  it('refuses path traversal with ".." segments', () => {
    const { files } = testPack();
    for (const evil of ['../manifest.json', 'mappings/../../etc/passwd', 'a/../requirements.csv', '..\\x.csv', '..']) {
      expectArchiveError(() => readPack(archiveOf([...files, [evil, Buffer.from('x')]])), /"\.\." path segment/);
    }
  });

  it('refuses absolute paths', () => {
    const { files } = testPack();
    for (const evil of ['/etc/passwd', '/manifest.json', '\\windows\\x', 'C:\\x.csv', 'c:x']) {
      expectArchiveError(() => readPack(archiveOf([...files, [evil, Buffer.from('x')]])), /absolute path/);
    }
  });

  it('refuses names with control characters, backslashes or invalid UTF-8', () => {
    const { files } = testPack();
    expectArchiveError(() => readPack(archiveOf([...files, ['bad\u0001.csv', Buffer.from('x')]])), /control character/);
    expectArchiveError(() => readPack(archiveOf([...files, ['mappings\\x.csv', Buffer.from('x')]])), /backslash/);
    const tar = writeTar([...files].map(([n, d]) => ({ path: n, data: d })), { mtime: PACK_MTIME });
    // Replace the first byte of the first name with an invalid UTF-8 byte and fix the checksum.
    tar[0] = 0xff;
    tar.write('        ', 148, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += tar[i] as number;
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    expectArchiveError(() => readPack(gzipSync(tar)), /not valid UTF-8/);
  });

  it('refuses symbolic links, hard links, folders and other entry types', () => {
    const { files } = testPack();
    const base = [...files].map(([name, data]) => ({ path: name, data }));
    const cases = [
      [{ path: 'requirements.csv', type: 'symlink', linkPath: '/etc/passwd' }, /symbolic link/],
      [{ path: 'link.csv', type: 'hardlink', linkPath: 'manifest.json' }, /hard link/],
      [{ path: 'mappings', type: 'directory' }, /folder entry/],
      [{ path: 'fifo', type: 'fifo' }, /FIFO/],
      [{ path: 'dev', type: 'char-device' }, /character device/],
      [{ path: 'PaxHeader', type: 'pax-header', data: Buffer.from('30 path=manifest.json\n') }, /pax extended header/],
      [{ path: '././@LongLink', type: 'gnu-long-name', data: Buffer.from('manifest.json\0') }, /GNU long name/],
    ] as const;
    for (const [entry, pattern] of cases) {
      expectArchiveError(() => readPack(archive([entry, ...base])), pattern);
    }
  });

  it('refuses a symbolic link in an archive made by node-tar', async () => {
    const dir = tempDir();
    const { files } = testPack();
    for (const [name, data] of files) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), data);
    }
    symlinkSync('/etc/passwd', path.join(dir, 'evil.csv'));
    const file = path.join(dir, '..', `${path.basename(dir)}.pack`);
    await nodeTar.create({ gzip: true, file, cwd: dir, portable: true }, ['manifest.json', 'evil.csv']);
    expectArchiveError(() => readPack(readFileSync(file)), /symbolic link/);
  });

  it('refuses duplicate names, also after normalisation', () => {
    const { files } = testPack();
    const manifest = files.get('manifest.json') as Buffer;
    for (const dup of ['manifest.json', './manifest.json', './/manifest.json', 'manifest.json/']) {
      expectArchiveError(() => readPack(archiveOf([...files, [dup, manifest]])), /more than once/);
    }
    // NFC and NFD spellings of the same name are one name.
    const nfc = 'mappings/caf\u00e9.csv';
    const nfd = 'mappings/cafe\u0301.csv';
    expectArchiveError(() => readPack(archiveOf([...files, [nfc, Buffer.from('a')], [nfd, Buffer.from('b')]])), /more than once/);
  });

  it('refuses files outside the archive root and mappings/', () => {
    const { files } = testPack();
    expectArchiveError(() => readPack(archiveOf([...files, ['data/requirements.csv', Buffer.from('x')]])), /not at the archive root/);
    expectArchiveError(() => readPack(archiveOf([...files, ['mappings/deep/x.csv', Buffer.from('x')]])), /not at the archive root/);
  });

  it('refuses an extra file, a missing dataset, and a missing manifest or signature', () => {
    const { files } = testPack();
    expectArchiveError(() => readPack(archiveOf([...files, ['notes.txt', Buffer.from('hi')]])), /not listed in the manifest: notes\.txt/);
    expectArchiveError(() => readPack(archiveOf([...files, ['mappings/ISO9001-2015.csv', Buffer.from('x')]])), /not listed in the manifest: mappings\/ISO9001-2015\.csv/);
    const without = (name: string) => [...files].filter(([n]) => n !== name);
    expectArchiveError(() => readPack(archiveOf(without('lookups.csv'))), /listed but missing: lookups\.csv/);
    expectArchiveError(() => readPack(archiveOf(without('manifest.json'))), /no manifest\.json/);
    expectArchiveError(() => readPack(archiveOf(without('signature'))), /no signature file/);
  });

  it('refuses a manifest that cannot be read for the file set check', () => {
    const { files } = testPack();
    const withManifest = (text: string) => archiveOf([...files].map(([n, d]) => [n, n === 'manifest.json' ? Buffer.from(text) : d] as const));
    for (const text of ['{not json', '[]', '{"pack_id":"x"}', '{"datasets":[]}']) {
      try {
        readPack(withManifest(text));
        throw new Error('expected a rejection');
      } catch (error) {
        expect((error as PackError).code).toBe('manifest');
      }
    }
  });

  it('refuses more entries than allowed', () => {
    const { files } = testPack();
    const many = Array.from({ length: 482 }, (_, i) => [`extra-${i}.csv`, Buffer.from('x')] as const);
    // 19 pack files + 482 = 501 entries
    expectArchiveError(() => readPack(archiveOf([...files, ...many])), /more than 500 entries/);
    expectArchiveError(() => readPack(archiveOf(files), { maxEntries: 18 }), /more than 18 entries/);
  });

  it('refuses an archive larger than 200 MB when decompressed', () => {
    const bomb = gzipBomb();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expectArchiveError(() => readPack(bomb), new RegExp(`larger than ${200 * 1024 * 1024} bytes`));
    // The cap applies to any limit the caller sets.
    const { pack } = testPack();
    expectArchiveError(() => readPack(pack.bytes, { maxDecompressedBytes: 4096 }), /larger than 4096 bytes/);
  });

  it('keeps the default caps for limits passed as undefined or null', () => {
    const { files, key } = testPack();
    const many = Array.from({ length: 482 }, (_, i) => [`extra-${i}.csv`, Buffer.from('x')] as const);
    const tooMany = archiveOf([...files, ...many]);
    const bomb = gzipBomb();
    const unset = { maxEntries: undefined, maxDecompressedBytes: undefined };
    const sizeCap = new RegExp(`larger than ${200 * 1024 * 1024} bytes`);
    expectArchiveError(() => readPack(tooMany, unset), /more than 500 entries/);
    expectArchiveError(() => readPack(bomb, unset), sizeCap);
    expectArchiveError(() => verifyPack(tooMany, [key.publicKey], { limits: unset }), /more than 500 entries/);
    expectArchiveError(() => verifyPack(bomb, [key.publicKey], { limits: unset }), sizeCap);
    // A JavaScript caller (or configuration read at run time) may pass null.
    const nulls = { maxEntries: null, maxDecompressedBytes: null } as unknown as Partial<PackLimits>;
    expectArchiveError(() => readPack(tooMany, nulls), /more than 500 entries/);
    expectArchiveError(() => readPack(bomb, null as unknown as Partial<PackLimits>), sizeCap);
    expect(resolvePackLimits(unset)).toEqual(DEFAULT_PACK_LIMITS);
    expect(resolvePackLimits({ maxEntries: 20 })).toEqual({ ...DEFAULT_PACK_LIMITS, maxEntries: 20 });
  });

  it('refuses a limit that is not a positive safe integer', () => {
    const { pack, key } = testPack();
    const bad: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '500', true];
    for (const value of bad) {
      for (const name of ['maxEntries', 'maxDecompressedBytes'] as const) {
        const limits = { [name]: value } as unknown as Partial<PackLimits>;
        expect(() => readPack(pack.bytes, limits)).toThrow(RangeError);
        expect(() => readPack(pack.bytes, limits)).toThrow(new RegExp(`${name} must be a positive safe integer`));
        expect(() => verifyPack(pack.bytes, [key.publicKey], { limits })).toThrow(RangeError);
      }
    }
  });

  it('is applied by verifyPack before the signature is looked at', () => {
    const { files, key } = testPack();
    expect(() => verifyPack(archiveOf([...files, ['../x', Buffer.from('x')]]), [key.publicKey])).toThrow(/"\.\." path segment/);
  });
});
