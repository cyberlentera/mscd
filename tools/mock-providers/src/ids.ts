import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Identifier rules and generators (build plan D.5). The mock answers 400 for any drive, item, file or revision id
// that fails these patterns, so an adapter that skips its own validation fails its tests.

/** Microsoft Graph drive and item ids (D.5). */
export const GRAPH_ID_PATTERN = /^[A-Za-z0-9!_-]+$/;
/** Google Drive file, drive and revision ids (D.5). */
export const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Graph version ids such as "1.0", "3.0" or a GUID. Dots are allowed, a bare "." or ".." is not. */
export const GRAPH_VERSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** Entra ID tenant in GUID or domain-name form. */
export const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export const MAX_ID_LENGTH = 256;

export function isGraphId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && GRAPH_ID_PATTERN.test(value);
}

export function isDriveId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && DRIVE_ID_PATTERN.test(value);
}

export function isGraphVersionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ID_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    GRAPH_VERSION_ID_PATTERN.test(value)
  );
}

export function isTenant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && TENANT_PATTERN.test(value);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array, length: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

function digest(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

/** A new Graph item id in the shape SharePoint uses ("01" followed by 32 base32 characters). */
export function newGraphItemId(): string {
  return `01${base32(randomBytes(20), 32)}`;
}

/** A Graph item id derived from a seed, so fixture folders keep their id across resets. */
export function stableGraphItemId(seed: string): string {
  return `01${base32(digest(seed), 32)}`;
}

/** A new Google Drive file id (33 characters of the Drive id alphabet). */
export function newDriveFileId(): string {
  return `1${randomBytes(24).toString('base64url').slice(0, 32)}`;
}

/** A Google Drive id derived from a seed. */
export function stableDriveFileId(seed: string): string {
  return `1${digest(seed).toString('base64url').slice(0, 32)}`;
}

/** A Google Drive binary revision id derived from a seed (binary revisions have long opaque ids). */
export function stableDriveRevisionId(seed: string): string {
  return `0B${digest(seed).toString('base64url').slice(0, 40)}`;
}

/** An upper-case GUID derived from a seed (eTag and identity ids). */
export function stableGuid(seed: string): string {
  const hex = digest(seed).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A numeric id derived from a seed (Drive permission ids). */
export function stableDigits(seed: string, length = 20): string {
  const hex = digest(seed).toString('hex');
  return BigInt(`0x${hex.slice(0, 30)}`).toString().padStart(length, '0').slice(0, length);
}

/** An opaque random token with a readable prefix. */
export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function newRequestId(): string {
  return randomUUID();
}
