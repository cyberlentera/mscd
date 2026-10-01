// The tar writer produces standard ustar archives that other tools read; the reader is strict about structure.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as nodeTar from 'tar';
import { describe, expect, it } from 'vitest';
import { PACK_MTIME, TarFormatError, readTar, writeTar } from '../src/index.js';
import { tempDir, testPack } from './helpers.js';

const MTIME_SECONDS = Date.UTC(2026, 0, 1) / 1000;

function systemTarAvailable(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('writeTar', () => {
  const tar = writeTar([{ path: 'a.csv', data: Buffer.from('x,y\n') }, { path: 'mappings/b.csv', data: Buffer.alloc(600, 0x61) }], { mtime: PACK_MTIME });

  it('writes ustar headers with fixed metadata, padded data and the end-of-archive marker', () => {
    const header = tar.subarray(0, 512);
    expect(header.subarray(0, 5).toString()).toBe('a.csv');
    expect(header.subarray(100, 108).toString('latin1')).toBe('0000644\0');
    expect(header.subarray(108, 116).toString('latin1')).toBe('0000000\0');
    expect(header.subarray(116, 124).toString('latin1')).toBe('0000000\0');
    expect(header.subarray(124, 136).toString('latin1')).toBe('00000000004\0');
    expect(Number.parseInt(header.subarray(136, 147).toString('latin1'), 8)).toBe(MTIME_SECONDS);
    expect(String.fromCharCode(header[156] as number)).toBe('0');
    expect(header.subarray(257, 265).toString('latin1')).toBe('ustar\u000000');
    expect(header.subarray(265, 329).every((b) => b === 0)).toBe(true);
    // header, 1 data block, header, 2 data blocks, 2 end blocks
    expect(tar.length).toBe(512 * 7);
    expect(tar.subarray(512 * 5).every((b) => b === 0)).toBe(true);
  });

  it('round-trips through readTar', () => {
    const entries = readTar(tar, { maxEntries: 10 });
    expect(entries.map((e) => [e.path, e.type, e.size])).toEqual([['a.csv', 'file', 4], ['mappings/b.csv', 'file', 600]]);
    expect(entries[1]?.data.equals(Buffer.alloc(600, 0x61))).toBe(true);
  });

  it('splits long paths into the ustar prefix and name', () => {
    const long = `${'d'.repeat(120)}/file.csv`;
    const entries = readTar(writeTar([{ path: long, data: Buffer.from('1') }], { mtime: PACK_MTIME }), { maxEntries: 1 });
    expect(entries[0]?.path).toBe(long);
    expect(() => writeTar([{ path: 'x'.repeat(101) }], { mtime: PACK_MTIME })).toThrow(/too long/);
  });

  it('is read by node-tar with the same names, sizes, owners and times', async () => {
    const { pack } = testPack();
    const seen: { path: string; size: number; uid: number | undefined; gid: number | undefined; mtime: number | undefined; mode: number | undefined }[] = [];
    const parser = new nodeTar.Parser({
      onReadEntry: (entry) => {
        seen.push({ path: entry.path, size: entry.size, uid: entry.uid, gid: entry.gid, mtime: entry.mtime?.getTime(), mode: entry.mode });
        entry.resume();
      },
    });
    await new Promise<void>((resolve, reject) => {
      parser.on('end', () => resolve());
      parser.on('error', reject);
      parser.end(pack.bytes);
    });
    const ours = readTar(gunzipSync(pack.bytes), { maxEntries: 100 });
    expect(seen.map((e) => [e.path, e.size])).toEqual(ours.map((e) => [e.path, e.size]));
    for (const e of seen) {
      expect(e.uid).toBe(0);
      expect(e.gid).toBe(0);
      expect(e.mtime).toBe(PACK_MTIME.getTime());
      expect(e.mode).toBe(0o644);
    }
  });

  it.runIf(systemTarAvailable())('is read by the system tar', () => {
    const { pack } = testPack();
    const file = path.join(tempDir(), 'p.pack');
    writeFileSync(file, pack.bytes);
    const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
    expect(listing).toEqual([...readTar(gunzipSync(pack.bytes), { maxEntries: 100 }).map((e) => e.path)]);
    const manifest = execFileSync('tar', ['-xzOf', file, 'manifest.json'], { encoding: 'utf8' });
    expect(JSON.parse(manifest).pack_id).toBe('ISO27001-2022');
  });
});

describe('readTar', () => {
  const good = writeTar([{ path: 'a', data: Buffer.from('hello') }], { mtime: PACK_MTIME });

  it('refuses a header with a bad checksum', () => {
    const bad = Buffer.from(good);
    bad[0] = 0x62;
    expect(() => readTar(bad, { maxEntries: 5 })).toThrow(/bad checksum/);
  });

  it('refuses a header without the ustar magic', () => {
    const bad = Buffer.from(good);
    bad.write('xxxxx', 257, 'latin1');
    // fix the checksum so only the magic is wrong
    bad.write('        ', 148, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += bad[i] as number;
    bad.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    expect(() => readTar(bad, { maxEntries: 5 })).toThrow(/not a ustar header/);
  });

  it('refuses truncated data, a missing end marker and trailing data', () => {
    expect(() => readTar(good.subarray(0, 600), { maxEntries: 5 })).toThrow(TarFormatError);
    expect(() => readTar(good.subarray(0, 1024), { maxEntries: 5 })).toThrow(/end-of-archive marker/);
    expect(() => readTar(good.subarray(0, 1536), { maxEntries: 5 })).toThrow(/two zero blocks/);
    expect(() => readTar(Buffer.concat([good, Buffer.from('junk')]), { maxEntries: 5 })).toThrow(/after the end-of-archive marker/);
    expect(readTar(Buffer.concat([good, Buffer.alloc(8192)]), { maxEntries: 5 })).toHaveLength(1);
  });

  it('stops at the entry limit before reading the next entry', () => {
    const three = writeTar(['a', 'b', 'c'].map((p) => ({ path: p, data: Buffer.from(p) })), { mtime: PACK_MTIME });
    expect(readTar(three, { maxEntries: 3 })).toHaveLength(3);
    expect(() => readTar(three, { maxEntries: 2 })).toThrow(/more than 2 entries/);
  });

  it('reports every entry type without applying extended headers', () => {
    const tar = writeTar([
      { path: 'pax', type: 'pax-header', data: Buffer.from('30 path=manifest.json\n') },
      { path: 'dir', type: 'directory' },
      { path: 'link', type: 'symlink', linkPath: '/etc/passwd' },
    ], { mtime: PACK_MTIME });
    expect(readTar(tar, { maxEntries: 5 }).map((e) => [e.path, e.type])).toEqual([['pax', 'pax-header'], ['dir', 'directory'], ['link', 'symlink']]);
  });
});
