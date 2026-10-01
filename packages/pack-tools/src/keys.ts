// Ed25519 keys for packs, licences and audit anchors (E.8, D-16, F.11): generation, loading and the trusted key
// sets that verification uses. Key ids follow E.8 (`keyId`).
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { keyId } from './key-id.js';

/** Kinds of trusted key compiled into a server build (B.4 `TRUSTED_KEYS`). */
export type TrustedKeyKind = 'licence' | 'pack' | 'anchor';

/**
 * A key a verifier trusts: a public key object, a PEM text or DER buffer (SPKI), or an entry of the server's
 * `TRUSTED_KEYS` (`{kind, keyId, publicKeyPem}`). An entry that names a `kind` is used only for that kind, so a
 * licence key never verifies a pack (A-17). A stated `keyId` must match the key.
 */
export type TrustedKeyInput =
  | KeyObject
  | string
  | Buffer
  | { readonly publicKeyPem: string; readonly keyId?: string; readonly kind?: string };

/** Signing key input: a private key object or a PKCS#8 PEM text or buffer. */
export type SigningKeyInput = KeyObject | string | Buffer;

export interface SigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;
}

export interface GeneratedKeyPair extends SigningKey {
  /** PKCS#8 PEM of the private key. */
  readonly privateKeyPem: string;
  /** SPKI PEM of the public key. */
  readonly publicKeyPem: string;
}

/** Generates an Ed25519 key pair. */
export function generateSigningKeyPair(): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    keyId: keyId(publicKey),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Loads an Ed25519 private key; throws an Error naming the problem. */
export function loadSigningKey(input: SigningKeyInput): SigningKey {
  let privateKey: KeyObject;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    try {
      privateKey = createPrivateKey(input);
    } catch (error) {
      throw new Error(`not a private key in PEM form (${(error as Error).message})`);
    }
  } else {
    privateKey = input;
  }
  if (privateKey.type !== 'private') throw new Error('expected a private key, got a public key');
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected an Ed25519 key, got ${privateKey.asymmetricKeyType ?? 'an unknown key type'}`);
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyId(publicKey) };
}

/** Loads an Ed25519 public key (a private key gives its public half); throws an Error naming the problem. */
export function loadPublicKey(input: KeyObject | string | Buffer): KeyObject {
  let key: KeyObject;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    try {
      key = createPublicKey(input);
    } catch (error) {
      throw new Error(`not a public key in PEM form (${(error as Error).message})`);
    }
  } else {
    key = input.type === 'private' ? createPublicKey(input) : input;
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected an Ed25519 key, got ${key.asymmetricKeyType ?? 'an unknown key type'}`);
  }
  return key;
}

/**
 * The trusted keys of one kind, by key id. Entries that name another kind are left out; entries without a kind
 * are trusted for every kind (the caller chose them, for example the CLI `--trusted` files). Throws when an entry
 * is not an Ed25519 key or states a key id that does not match its key.
 */
export function trustedKeysById(keys: Iterable<TrustedKeyInput>, kind: TrustedKeyKind): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  for (const entry of keys) {
    let key: KeyObject;
    if (typeof entry === 'object' && !Buffer.isBuffer(entry) && 'publicKeyPem' in entry) {
      if (entry.kind !== undefined && entry.kind !== kind) continue;
      key = loadPublicKey(entry.publicKeyPem);
      const id = keyId(key);
      if (entry.keyId !== undefined && entry.keyId !== id) {
        throw new Error(`trusted key states key id ${entry.keyId} but its key has id ${id}`);
      }
    } else {
      key = loadPublicKey(entry as KeyObject | string | Buffer);
    }
    out.set(keyId(key), key);
  }
  return out;
}
