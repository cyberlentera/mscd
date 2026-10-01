import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * Key id of an Ed25519 public key (build plan E.8): the first 16 hexadecimal characters of the SHA-256 of the
 * public key in DER (SPKI) form. Accepts a PEM string, a DER buffer or a key object; private keys give the id of
 * their public half.
 */
export function keyId(key: string | Buffer | KeyObject): string {
  const publicKey = typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : toPublic(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected an Ed25519 key, got ${publicKey.asymmetricKeyType ?? 'an unknown key type'}`);
  }
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function toPublic(key: KeyObject): KeyObject {
  return key.type === 'private' ? createPublicKey(key) : key;
}
