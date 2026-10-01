import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QuickXorHash, quickXorHash } from '../src/quickxor.js';

interface Vector {
  size: number;
  inputBase64: string;
  quickXorHash: string;
}

const RCLONE_VECTORS = JSON.parse(readFileSync(new URL('./fixtures/quickxorhash-rclone-vectors.json', import.meta.url), 'utf8')) as Vector[];

/**
 * Literal port of Microsoft's published C# QuickXorHash (64-bit cells, the last one 32 bits wide), used as an
 * independent oracle for the optimised implementation.
 */
function referenceQuickXorHash(chunks: Uint8Array[]): string {
  const BITS_IN_LAST_CELL = 32;
  const SHIFT = 11;
  const WIDTH_IN_BITS = 160;
  const MASK = (1n << 64n) - 1n;
  const data = [0n, 0n, 0n];
  let lengthSoFar = 0n;
  let shiftSoFar = 0;
  for (const array of chunks) {
    const cbSize = array.length;
    let vectorArrayIndex = Math.floor(shiftSoFar / 64);
    let vectorOffset = shiftSoFar % 64;
    const iterations = Math.min(cbSize, WIDTH_IN_BITS);
    for (let i = 0; i < iterations; i += 1) {
      const isLastCell = vectorArrayIndex === data.length - 1;
      const bitsInVectorCell = isLastCell ? BITS_IN_LAST_CELL : 64;
      if (vectorOffset <= bitsInVectorCell - 8) {
        for (let j = i; j < cbSize; j += WIDTH_IN_BITS) {
          data[vectorArrayIndex] = (data[vectorArrayIndex] ^ (BigInt(array[j]) << BigInt(vectorOffset))) & MASK;
        }
      } else {
        const index1 = vectorArrayIndex;
        const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
        const low = bitsInVectorCell - vectorOffset;
        let xoredByte = 0;
        for (let j = i; j < cbSize; j += WIDTH_IN_BITS) xoredByte ^= array[j];
        data[index1] = (data[index1] ^ (BigInt(xoredByte) << BigInt(vectorOffset))) & MASK;
        data[index2] = (data[index2] ^ (BigInt(xoredByte) >> BigInt(low))) & MASK;
      }
      vectorOffset += SHIFT;
      while (vectorOffset >= bitsInVectorCell) {
        vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
        vectorOffset -= bitsInVectorCell;
      }
    }
    shiftSoFar = (shiftSoFar + SHIFT * (cbSize % WIDTH_IN_BITS)) % WIDTH_IN_BITS;
    lengthSoFar += BigInt(cbSize);
  }
  const rgb = Buffer.alloc(20);
  rgb.writeBigUInt64LE(data[0], 0);
  rgb.writeBigUInt64LE(data[1], 8);
  rgb.writeUInt32LE(Number(data[2] & 0xffffffffn), 16);
  const lengthBytes = Buffer.alloc(8);
  lengthBytes.writeBigInt64LE(lengthSoFar);
  for (let i = 0; i < 8; i += 1) rgb[12 + i] ^= lengthBytes[i];
  return rgb.toString('base64');
}

function chunked(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, Math.min(i + size, data.length)));
  return chunks;
}

describe('quickXorHash', () => {
  it('hashes the empty input to 20 zero bytes', () => {
    expect(quickXorHash(Buffer.alloc(0))).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(new QuickXorHash().digestBase64()).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });

  it('matches the 1 KiB vectors computed with rclone', () => {
    const pattern = Buffer.alloc(1024);
    for (let i = 0; i < pattern.length; i += 1) pattern[i] = (i * 7 + 3) % 256;
    expect(quickXorHash(pattern)).toBe('MMeylbw5oAJeFB6zssPZc2At1Vc=');

    const line = 'MSCD quickXorHash test vector\n';
    const text = line.repeat(Math.ceil(1024 / line.length)).slice(0, 1024);
    expect(Buffer.byteLength(text)).toBe(1024);
    expect(quickXorHash(text)).toBe('JTAiPuI1vyDyV+KX2DiX5EkuYJA=');

    expect(quickXorHash(Buffer.alloc(1024))).toBe('AAAAAAAAAAAAAAAAAAQAAAAAAAA=');
  });

  it('matches every rclone test vector, in one piece and in chunks', () => {
    expect(RCLONE_VECTORS).toHaveLength(70);
    for (const vector of RCLONE_VECTORS) {
      const input = Buffer.from(vector.inputBase64, 'base64');
      expect(input.length).toBe(vector.size);
      expect(quickXorHash(input), `size ${vector.size}`).toBe(vector.quickXorHash);
      for (const size of [1, 7, 64, 159, 160, 161]) {
        const hash = new QuickXorHash();
        for (const chunk of chunked(input, size)) hash.update(chunk);
        expect(hash.digestBase64(), `size ${vector.size} in chunks of ${size}`).toBe(vector.quickXorHash);
      }
    }
  });

  it('agrees with a literal port of the C# reference on random input', () => {
    for (const size of [1, 19, 20, 159, 160, 161, 319, 320, 1000, 4096, 100_000]) {
      const input = randomBytes(size);
      const expected = referenceQuickXorHash([input]);
      expect(quickXorHash(input), `size ${size}`).toBe(expected);
      const chunks = chunked(input, 333);
      expect(referenceQuickXorHash(chunks), `reference in chunks, size ${size}`).toBe(expected);
      const hash = new QuickXorHash();
      for (const chunk of chunks) hash.update(chunk);
      expect(hash.digestBase64(), `chunks of 333, size ${size}`).toBe(expected);
    }
  });

  it('accepts UTF-8 strings and keeps accepting data after a digest', () => {
    const hash = new QuickXorHash().update(Buffer.from('ab'));
    const partial = hash.digestBase64();
    hash.update(Buffer.from('c'));
    expect(partial).toBe(quickXorHash('ab'));
    expect(hash.digestBase64()).toBe(quickXorHash('abc'));
  });
});
