// Private key of the demo Microsoft 365 app registration (build plan G.6, G.8). The key is derived from a fixed label,
// so no key file exists anywhere: `apps/web/scripts/export-sample-snapshot.mjs` derives the same key to sign the
// certificate it writes into the snapshot and the mock provider fixture, and the seed derives it again here to seal
// the repository credential. Like the demo TOTP secrets (G.3), it is development material for the mock providers only.
//
// Derivation (keep it identical to `deriveRsaKey` of the export script): a byte stream whose block i is
// HMAC-SHA256(key = label, data = i as a 4-byte big-endian integer); two 1024-bit primes, each the first 128-byte
// candidate (top two bits and the low bit set) that passes trial division by the first 300 odd primes and Miller-Rabin
// with the bases 2 to 37 and whose value minus one is not a multiple of 65537; e = 65537.
import { createHmac, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';

const SMALL_PRIMES: readonly bigint[] = (() => {
  const primes: number[] = [];
  for (let n = 3; primes.length < 300; n += 2) if (primes.every((p) => n % p !== 0)) primes.push(n);
  return primes.map(BigInt);
})();
const MILLER_RABIN_BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n] as const;
const RSA_E = 65537n;

function byteStream(label: string): (length: number) => Buffer {
  let counter = 0;
  let buffer = Buffer.alloc(0);
  return (length) => {
    while (buffer.length < length) {
      const block = Buffer.alloc(4);
      block.writeUInt32BE(counter++);
      buffer = Buffer.concat([buffer, createHmac('sha256', label).update(block).digest()]);
    }
    const out = Buffer.from(buffer.subarray(0, length));
    buffer = buffer.subarray(length);
    return out;
  };
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function modInverse(a: bigint, m: bigint): bigint {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

function isProbablePrime(n: bigint): boolean {
  for (const p of SMALL_PRIMES) if (n % p === 0n) return n === p;
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1;
  }
  witness: for (const a of MILLER_RABIN_BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witness;
    }
    return false;
  }
  return true;
}

function base64Url(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex').toString('base64url');
}

/** The RSA-2048 private key derived from `label`. */
export function deriveRsaKey(label: string): KeyObject {
  const read = byteStream(label);
  const prime = (): bigint => {
    for (;;) {
      const bytes = read(128);
      bytes[0]! |= 0xc0;
      bytes[127]! |= 0x01;
      const candidate = BigInt(`0x${bytes.toString('hex')}`);
      if ((candidate - 1n) % RSA_E !== 0n && isProbablePrime(candidate)) return candidate;
    }
  };
  const p = prime();
  let q = prime();
  while (q === p) q = prime();
  const n = p * q;
  const d = modInverse(RSA_E, (p - 1n) * (q - 1n));
  return createPrivateKey({
    key: {
      kty: 'RSA',
      n: base64Url(n),
      e: base64Url(RSA_E),
      d: base64Url(d),
      p: base64Url(p),
      q: base64Url(q),
      dp: base64Url(d % (p - 1n)),
      dq: base64Url(d % (q - 1n)),
      qi: base64Url(modInverse(q, p)),
    },
    format: 'jwk',
  });
}

/**
 * The PKCS #8 PEM of the key derived from `label`, checked against the certificate the export wrote: the
 * certificate's public key must be the derived key's, so a change on one side never goes unnoticed.
 */
export function demoPrivateKeyPem(label: string, certificatePem: string): string {
  const key = deriveRsaKey(label);
  const certificateKey = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
  const derivedKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (!certificateKey.equals(derivedKey)) {
    throw new Error(
      `The key derived from ${label} does not match the demo certificate of the snapshot; ` +
        'keep apps/server/src/seed/demo-key.ts and deriveRsaKey of apps/web/scripts/export-sample-snapshot.mjs identical',
    );
  }
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}
