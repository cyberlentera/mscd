// quickXorHash, the content hash of OneDrive for Business and SharePoint (Microsoft's published algorithm:
// https://learn.microsoft.com/onedrive/developer/code-snippets/quickxorhash).
//
// The reference keeps a 160-bit register (two 64-bit cells and one 32-bit cell) and XORs byte k of the input at
// bit position (11 * k) mod 160, wrapping around the register. Because 11 * 160 is a multiple of 160, the
// position depends only on k mod 160, so this implementation XORs each byte into one of 160 accumulators (one
// operation per input byte) and places the accumulators into the register when the digest is taken. The file
// length, as a little-endian 64-bit integer, is then XORed into the last 8 bytes of the 20-byte result.

const WIDTH_IN_BITS = 160;
const WIDTH_IN_BYTES = WIDTH_IN_BITS / 8;
const SHIFT = 11;

export class QuickXorHash {
  private readonly accumulators = new Uint8Array(WIDTH_IN_BITS);
  private length = 0;

  /** Adds bytes; may be called any number of times with chunks of any size. */
  update(data: Uint8Array): this {
    const accumulators = this.accumulators;
    let position = this.length % WIDTH_IN_BITS;
    for (let i = 0; i < data.length; i += 1) {
      accumulators[position] ^= data[i];
      position = position === WIDTH_IN_BITS - 1 ? 0 : position + 1;
    }
    this.length += data.length;
    return this;
  }

  /** The 20-byte digest. The hash object can keep receiving data afterwards. */
  digest(): Buffer {
    const out = Buffer.alloc(WIDTH_IN_BYTES);
    for (let residue = 0; residue < WIDTH_IN_BITS; residue += 1) {
      const value = this.accumulators[residue];
      if (value === 0) continue;
      const bit = (residue * SHIFT) % WIDTH_IN_BITS;
      const byteIndex = bit >> 3;
      const offset = bit & 7;
      out[byteIndex] ^= (value << offset) & 0xff;
      if (offset !== 0) out[(byteIndex + 1) % WIDTH_IN_BYTES] ^= value >> (8 - offset);
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(this.length));
    for (let i = 0; i < length.length; i += 1) out[WIDTH_IN_BYTES - length.length + i] ^= length[i];
    return out;
  }

  /** The digest in standard base64, as Graph reports it in `file.hashes.quickXorHash`. */
  digestBase64(): string {
    return this.digest().toString('base64');
  }
}

/** quickXorHash of a byte array or a UTF-8 string, in base64. */
export function quickXorHash(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return new QuickXorHash().update(bytes).digestBase64();
}
