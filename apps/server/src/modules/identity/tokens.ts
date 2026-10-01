// Random values of the identity module (build plan F.1, F.2, F.4): session ids, link tokens (password reset,
// invitation) and their SHA-256 hashes. Only hashes are stored; values travel once, in a cookie or a link fragment.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Shape of a value made by `randomToken`. */
export const RANDOM_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 of a UTF-8 string. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of two byte strings of any length. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Label of the CSRF token derivation (F.2); a new label invalidates every token. */
const CSRF_LABEL = 'mscd-csrf-v1';

/**
 * The synchronizer token of a session (F.2): HMAC-SHA256 of a fixed label keyed with the 32 random bytes of the
 * session cookie, base64url. Only `sha256(token)` is stored (`session.csrf_token_hash`); the value can be derived
 * again from the cookie, so `GET /me` returns it after a reload without the server keeping it. JavaScript cannot
 * read the HttpOnly cookie, so a page of another origin can learn the token neither from the cookie nor from the
 * stored hash.
 */
export function csrfTokenFor(cookieValue: string): string {
  return createHmac('sha256', Buffer.from(cookieValue, 'base64url')).update(CSRF_LABEL, 'utf8').digest('base64url');
}
