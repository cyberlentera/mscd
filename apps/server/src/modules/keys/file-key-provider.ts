// `file` driver of the key provider (build plan D-09, F.11). The key-encryption key (KEK) is 32 random bytes,
// base64, in a file readable by its container only (`kms.file.path`, mode 0400); `kms.file.previous_paths` hold
// older KEKs that still unwrap during a rotation. Wrapped values use the SecretBox format
// `v1.<kekId>.<base64url iv>.<base64url ciphertext and tag>` (AES-256-GCM, 12-byte IV, 16-byte tag) with additional
// authenticated data that names the purpose and binding, so a value sealed for one purpose cannot be opened for
// another.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const SECRET_BOX_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** F.11 `KeyProvider`. */
export interface KeyProvider {
  /** First 8 hex characters of the SHA-256 of the current KEK. */
  readonly kekId: string;
  wrap(plain: Buffer, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Buffer>;
}

export class KeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyFileError';
  }
}

/** The id of a KEK: first 8 hex characters of its SHA-256 (F.11). */
export function kekIdOf(kek: Buffer): string {
  return createHash('sha256').update(kek).digest('hex').slice(0, 8);
}

/** Reads a KEK file: base64 of exactly 32 bytes (a trailing line break is allowed). */
export function readKekFile(file: string): Buffer {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new KeyFileError(`Cannot read the key file ${file}: ${(error as Error).message}`);
  }
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new KeyFileError(`The key file ${file} does not hold base64 text`);
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new KeyFileError(`The key file ${file} must hold 32 bytes, found ${key.length}`);
  return key;
}

/** True when a key file can be read by its group or by others (F.11 asks for mode 0400). */
export function keyFileTooOpen(file: string): boolean {
  try {
    return (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/** Seals `plain` with a KEK in the SecretBox format. */
export function sealWithKek(kek: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return `${SECRET_BOX_VERSION}.${kekIdOf(kek)}.${iv.toString('base64url')}.${sealed.toString('base64url')}`;
}

/** The parts of a SecretBox value, or null when it is not one. */
export function parseSealed(wrapped: string): { kekId: string; iv: Buffer; sealed: Buffer } | null {
  const parts = wrapped.split('.');
  if (parts.length !== 4 || parts[0] !== SECRET_BOX_VERSION || !/^[0-9a-f]{8}$/.test(parts[1]!)) return null;
  const iv = Buffer.from(parts[2]!, 'base64url');
  const sealed = Buffer.from(parts[3]!, 'base64url');
  if (iv.length !== IV_BYTES || sealed.length < TAG_BYTES) return null;
  return { kekId: parts[1]!, iv, sealed };
}

/** Opens a SecretBox value with a KEK; throws on a wrong key, wrong additional data or tampering. */
export function openWithKek(kek: Buffer, wrapped: string, aad: string): Buffer {
  const parsed = parseSealed(wrapped);
  if (!parsed) throw new Error('Not a sealed value');
  const decipher = createDecipheriv('aes-256-gcm', kek, parsed.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(parsed.sealed.subarray(parsed.sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(parsed.sealed.subarray(0, parsed.sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error('The sealed value cannot be opened: wrong key, wrong purpose or tampered');
  }
}

/** KEK files as F.11 describes them: the current key and the previous keys of a rotation. */
export class FileKeyProvider implements KeyProvider {
  readonly kekId: string;
  private readonly current: Buffer;
  private readonly byId: ReadonlyMap<string, Buffer>;

  constructor(current: Buffer, previous: readonly Buffer[] = []) {
    if (current.length !== 32) throw new KeyFileError('A key-encryption key must be 32 bytes');
    this.current = current;
    this.kekId = kekIdOf(current);
    const byId = new Map<string, Buffer>();
    for (const key of [...previous, current]) byId.set(kekIdOf(key), key);
    this.byId = byId;
  }

  /** Loads the current and previous KEK files. */
  static fromFiles(path: string, previousPaths: readonly string[] = []): FileKeyProvider {
    return new FileKeyProvider(readKekFile(path), previousPaths.map((p) => readKekFile(p)));
  }

  /** Key ids this provider can unwrap (current first). */
  get knownKekIds(): string[] {
    return [this.kekId, ...[...this.byId.keys()].filter((id) => id !== this.kekId)];
  }

  async wrap(plain: Buffer, aad: string): Promise<string> {
    return sealWithKek(this.current, plain, aad);
  }

  async unwrap(wrapped: string, aad: string): Promise<Buffer> {
    const parsed = parseSealed(wrapped);
    if (!parsed) throw new Error('Not a sealed value');
    const kek = this.byId.get(parsed.kekId);
    if (!kek) throw new Error(`The sealed value was made with key ${parsed.kekId}, which this process does not hold`);
    return openWithKek(kek, wrapped, aad);
  }

  /** True when the value was sealed with an older KEK and should be re-sealed (`keys rewrap`). */
  needsRewrap(wrapped: string): boolean {
    const parsed = parseSealed(wrapped);
    return parsed !== null && parsed.kekId !== this.kekId;
  }

  /** HMAC key for one purpose, derived from the current KEK (HKDF-SHA256), for token MACs (D-09). */
  macKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.current, Buffer.alloc(0), `mscd-mac:${purpose}`, 32));
  }
}
