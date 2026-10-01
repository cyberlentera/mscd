import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEV_KEY_IDS, keyId } from '../src/index.js';

describe('keyId', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const expected = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

  it('is the first 16 hex characters of the SHA-256 of the SPKI DER (E.8)', () => {
    expect(keyId(publicKey)).toBe(expected);
    expect(keyId(publicKey.export({ type: 'spki', format: 'pem' }) as string)).toBe(expected);
  });

  it('gives the id of the public half for a private key', () => {
    expect(keyId(privateKey)).toBe(expected);
  });

  it('rejects keys that are not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => keyId(rsa.publicKey)).toThrow(/Ed25519/);
  });
});

describe('DEV_KEY_IDS', () => {
  it('is a frozen list of 16-character hexadecimal ids', () => {
    expect(Object.isFrozen(DEV_KEY_IDS)).toBe(true);
    for (const id of DEV_KEY_IDS) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
