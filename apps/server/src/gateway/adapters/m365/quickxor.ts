// quickXorHash, the content hash OneDrive for Business and SharePoint report in `file.hashes.quickXorHash`
// (Microsoft's published algorithm, https://learn.microsoft.com/onedrive/developer/code-snippets/quickxorhash).
// The pass-through upload computes it next to the SHA-256 so the gateway can confirm that Microsoft 365 stored
// exactly the bytes it streamed.
//
// The algorithm XORs input byte k into a 160-bit register at bit position (11 * k) mod 160 and finally XORs the
// input length (64-bit little endian) into the last 8 of the 20 bytes. As 11 * 160 is a multiple of 160, the bit
// position depends only on k mod 160: bytes are first XORed into 160 one-byte lanes, and the lanes are placed into
// the register when the digest is taken.

const WIDTH_BITS = 160;
const WIDTH_BYTES = WIDTH_BITS / 8;
const SHIFT = 11;

export class QuickXorHash {
  private readonly lanes = new Uint8Array(WIDTH_BITS);
  private length = 0;

  update(chunk: Uint8Array): this {
    const lanes = this.lanes;
    let lane = this.length % WIDTH_BITS;
    for (let i = 0; i < chunk.length; i += 1) {
      lanes[lane] ^= chunk[i];
      lane += 1;
      if (lane === WIDTH_BITS) lane = 0;
    }
    this.length += chunk.length;
    return this;
  }

  /** The digest in standard base64 (28 characters), as Graph reports it. */
  digest(): string {
    const register = new Uint8Array(WIDTH_BYTES);
    for (let lane = 0; lane < WIDTH_BITS; lane += 1) {
      const value = this.lanes[lane];
      if (value === 0) continue;
      const bit = (lane * SHIFT) % WIDTH_BITS;
      const index = bit >>> 3;
      const offset = bit & 7;
      register[index] ^= (value << offset) & 0xff;
      if (offset !== 0) register[(index + 1) % WIDTH_BYTES] ^= value >>> (8 - offset);
    }
    let length = BigInt(this.length);
    for (let i = WIDTH_BYTES - 8; i < WIDTH_BYTES; i += 1) {
      register[i] ^= Number(length & 0xffn);
      length >>= 8n;
    }
    return Buffer.from(register).toString('base64');
  }
}
