// Managed Vault object encryption (build plan D-10, F.11). Every object has its own random 32-byte content key,
// sealed with the tenant data key (`obj:<orgId>:<objectId>`). The plaintext is cut into chunks of 64 KiB; each chunk
// is encrypted with AES-256-GCM under the content key with nonce = 4-byte random prefix plus an 8-byte big-endian
// chunk counter, and additional data = content id, chunk index and a final-chunk flag. The stored object is the
// sequence of `ciphertext || 16-byte tag` per chunk; the last chunk (possibly empty, possibly full) carries the
// final flag, so a cut at a chunk boundary, a missing tail or appended bytes fail authentication, and a changed byte
// fails the tag of its chunk.
//
// Header (S3 metadata `x-amz-meta-mscd-enc`): `{"v":1,"alg":"A256GCM-CHUNK64K","ck":"<sealed>","np":"<prefix>","cid":"<id>"}`.
// `cid` is the id the chunk additional data uses: the object id where the content was first encrypted. A server-side
// copy keeps the ciphertext and `cid` and re-seals `ck` for the new object id ("re-encryption header copy").
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const CHUNK_SIZE = 64 * 1024;
export const TAG_SIZE = 16;
export const NONCE_PREFIX_SIZE = 4;
export const ENCRYPTION_ALG = 'A256GCM-CHUNK64K';
export const ENCRYPTION_HEADER_VERSION = 1;

/** The `x-amz-meta-mscd-enc` header of a vault object. */
export interface VaultEncryptionHeader {
  v: 1;
  alg: typeof ENCRYPTION_ALG;
  /** Content key sealed with the tenant data key (SecretBox, `obj:<orgId>:<objectId>`). */
  ck: string;
  /** Nonce prefix, base64url of 4 bytes. */
  np: string;
  /** Id used in the chunk additional data. */
  cid: string;
}

/** Thrown when an object fails authentication: changed, truncated or extended ciphertext, or a wrong key. */
export class DecryptionError extends Error {
  constructor(message = 'The object failed decryption: it was changed or truncated') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function serializeHeader(header: VaultEncryptionHeader): string {
  return JSON.stringify({ v: header.v, alg: header.alg, ck: header.ck, np: header.np, cid: header.cid });
}

/** Parses and checks an encryption header; null when it is not one this build reads. */
export function parseHeader(text: string | undefined): VaultEncryptionHeader | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const h = value as Record<string, unknown>;
  if (h.v !== ENCRYPTION_HEADER_VERSION || h.alg !== ENCRYPTION_ALG) return null;
  if (typeof h.ck !== 'string' || typeof h.np !== 'string' || typeof h.cid !== 'string' || h.cid === '') return null;
  if (Buffer.from(h.np, 'base64url').length !== NONCE_PREFIX_SIZE) return null;
  return { v: 1, alg: ENCRYPTION_ALG, ck: h.ck, np: h.np, cid: h.cid };
}

/** A new random nonce prefix. */
export function newNoncePrefix(): Buffer {
  return randomBytes(NONCE_PREFIX_SIZE);
}

function chunkNonce(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, NONCE_PREFIX_SIZE);
  nonce.writeBigUInt64BE(BigInt(index), NONCE_PREFIX_SIZE);
  return nonce;
}

function chunkAad(cid: string, index: number, final: boolean): Buffer {
  return Buffer.from(`${cid}:${index}:${final ? 1 : 0}`, 'utf8');
}

/** Ciphertext length of a plaintext length. */
export function ciphertextLength(plainLength: number): number {
  const chunks = Math.max(1, Math.ceil(plainLength / CHUNK_SIZE));
  return plainLength + chunks * TAG_SIZE;
}

/** Plaintext length of a well-formed ciphertext length; null when no plaintext has that ciphertext length. */
export function plaintextLength(cipherLength: number): number | null {
  if (!Number.isInteger(cipherLength) || cipherLength < TAG_SIZE) return null;
  const chunks = Math.max(1, Math.ceil(cipherLength / (CHUNK_SIZE + TAG_SIZE)));
  const plain = cipherLength - chunks * TAG_SIZE;
  return plain >= 0 && ciphertextLength(plain) === cipherLength ? plain : null;
}

export interface ChunkKeys {
  contentKey: Buffer;
  noncePrefix: Buffer;
  cid: string;
}

function checkKeys(keys: ChunkKeys): void {
  if (keys.contentKey.length !== 32) throw new Error('The content key must be 32 bytes');
  if (keys.noncePrefix.length !== NONCE_PREFIX_SIZE) throw new Error('The nonce prefix must be 4 bytes');
}

/** Encrypts one chunk: ciphertext followed by its 16-byte tag. */
function sealChunk(keys: ChunkKeys, index: number, plain: Buffer, final: boolean): Buffer {
  const cipher = createCipheriv('aes-256-gcm', keys.contentKey, chunkNonce(keys.noncePrefix, index));
  cipher.setAAD(chunkAad(keys.cid, index, final));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** Decrypts one chunk; `DecryptionError` when its tag does not verify. */
function openChunk(keys: ChunkKeys, index: number, sealed: Buffer, final: boolean): Buffer {
  if (sealed.length < TAG_SIZE) throw new DecryptionError('The object is truncated');
  const decipher = createDecipheriv('aes-256-gcm', keys.contentKey, chunkNonce(keys.noncePrefix, index));
  decipher.setAAD(chunkAad(keys.cid, index, final));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_SIZE)), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Encrypts a plaintext stream into the chunk format. */
export class ChunkEncryptor extends Transform {
  private buffer = Buffer.alloc(0);
  private index = 0;

  constructor(private readonly keys: ChunkKeys) {
    super();
    checkKeys(keys);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      // A full chunk is written only when more bytes follow it; the last one waits for the final flag.
      while (this.buffer.length > CHUNK_SIZE) {
        this.push(this.seal(this.buffer.subarray(0, CHUNK_SIZE), false));
        this.buffer = this.buffer.subarray(CHUNK_SIZE);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.push(this.seal(this.buffer, true));
      this.buffer = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private seal(plain: Buffer, final: boolean): Buffer {
    const sealed = sealChunk(this.keys, this.index, plain, final);
    this.index += 1;
    return sealed;
  }
}

/** Decrypts the chunk format; fails with `DecryptionError` on any change, cut or extension. */
export class ChunkDecryptor extends Transform {
  private buffer = Buffer.alloc(0);
  private index = 0;

  constructor(private readonly keys: ChunkKeys) {
    super();
    checkKeys(keys);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      const sealedChunk = CHUNK_SIZE + TAG_SIZE;
      while (this.buffer.length > sealedChunk) {
        this.push(this.open(this.buffer.subarray(0, sealedChunk), false));
        this.buffer = this.buffer.subarray(sealedChunk);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.buffer.length < TAG_SIZE) throw new DecryptionError('The object is truncated');
      this.push(this.open(this.buffer, true));
      this.buffer = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private open(sealed: Buffer, final: boolean): Buffer {
    const plain = openChunk(this.keys, this.index, sealed, final);
    this.index += 1;
    return plain;
  }
}

/** Encrypts a whole buffer (tests, small objects such as anchors). */
export function encryptBuffer(plain: Buffer, keys: ChunkKeys): Buffer {
  checkKeys(keys);
  const parts: Buffer[] = [];
  const chunks = Math.max(1, Math.ceil(plain.length / CHUNK_SIZE));
  for (let index = 0; index < chunks; index += 1) {
    parts.push(sealChunk(keys, index, plain.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), index === chunks - 1));
  }
  return Buffer.concat(parts);
}

/** Decrypts a whole buffer (tests, small objects); throws `DecryptionError`. */
export function decryptBuffer(sealed: Buffer, keys: ChunkKeys): Buffer {
  checkKeys(keys);
  if (plaintextLength(sealed.length) === null) throw new DecryptionError('The object has a length no encrypted object has');
  const step = CHUNK_SIZE + TAG_SIZE;
  const chunks = Math.max(1, Math.ceil(sealed.length / step));
  const parts: Buffer[] = [];
  for (let index = 0; index < chunks; index += 1) {
    parts.push(openChunk(keys, index, sealed.subarray(index * step, (index + 1) * step), index === chunks - 1));
  }
  return Buffer.concat(parts);
}
