// Values of the guest auditor flow (build plan F.14, D-27): the access link token, the binding cookie of the emailed
// one-time code, the code itself and the address hint of the answers.
//
// The access link token is `<organisation id, 16 bytes base64url><32 random bytes base64url>` (65 characters, within
// the `LinkToken` pattern of the contract). The grant lives in the tenant schema of its organisation; the prefix
// names that organisation so `POST /auth/guest/start` reads one schema instead of searching every tenant. The prefix
// is not secret (an organisation id) and adds nothing to guessing: the 32 random bytes are the secret, and only the
// SHA-256 of the whole token is stored (`auditor_access_grant.token_hash`).
import { randomBytes, randomInt } from 'node:crypto';

/** Cookie that binds a one-time code transaction to the browser that asked for it (F.14 step 2). */
export const GUEST_TX_COOKIE = 'mscd_guest_tx';
/** The cookie goes only to the guest routes. */
export const GUEST_TX_COOKIE_PATH = '/api/v1/auth/guest/';
/** Lifetime of a one-time code and its transaction (D.2 `GuestVerifyRequest`: 10 minutes). */
export const GUEST_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed per transaction (F.3, F.14 step 3). */
export const GUEST_CODE_ATTEMPTS = 5;
/** SecretBox MAC purpose of stored one-time codes. */
export const GUEST_CODE_MAC_PURPOSE = 'guest-otp';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_PART = 22;
const SECRET_PART = 43;

function uuidBytes(id: string): Buffer {
  if (!UUID.test(id)) throw new Error(`Not a uuid: ${id}`);
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function uuidOf(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A new access link token for a grant of `orgId`. */
export function newGuestLinkToken(orgId: string): string {
  return `${uuidBytes(orgId).toString('base64url')}${randomBytes(32).toString('base64url')}`;
}

/** The organisation a link token names, or null for anything that is not a link token of this build. */
export function organisationOfLinkToken(token: string): string | null {
  if (token.length !== ORG_PART + SECRET_PART || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const bytes = Buffer.from(token.slice(0, ORG_PART), 'base64url');
  if (bytes.length !== 16 || bytes.toString('base64url') !== token.slice(0, ORG_PART)) return null;
  return uuidOf(bytes);
}

/** A 6-digit one-time code (uniform over 000000 to 999999). */
export function newGuestCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** The data the stored MAC of a code covers: the transaction id binds the code to one transaction. */
export function guestCodeMacInput(transactionId: string, code: string): string {
  return `${transactionId}:${code}`;
}

/**
 * The address hint of `GuestStartResponse`: the first letter and the domain (`e***@mscd.test`). Built from the
 * address the request named (returning guest) or the grant address (link), so it reveals nothing new.
 */
export function emailHint(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${trimmed[0]}***${trimmed.slice(at)}`;
}

/** Handle of a guest account: `guest-<8 hex>` (F.14 step 1). */
export function newGuestHandle(): string {
  return `guest-${randomBytes(4).toString('hex')}`;
}
