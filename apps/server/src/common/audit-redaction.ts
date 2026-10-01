// Redaction of audit entry data (build plan F.11). Before `before_data` and `after_data` are written, the value of
// every key that names a secret is replaced by "[redacted]", at any depth: `password`, `secret`, `clientSecret`,
// `privateKeyPem`, `certificatePem`, `refreshToken`, `token`, `code`, `otp`, `sealedBlob`, `wrappedDek`, keys
// ending in `_sealed` or `_hash`, and the compound forms the request schemas of D.2 use for the same secrets
// (`newPassword`, `currentPassword`, `recoveryCode`, `currentCode`, `oidc_client_secret_sealed`, `token_hash`).
// Business codes such as `docCode`, `riskCodes` or `frequencyCode` are kept; the entry's own code is stored in
// `entity_code` anyway.

export const AUDIT_REDACTED = '[redacted]';

/** Exact key names of F.11, compared without case, `_` and `-`. */
const EXACT = new Set([
  'password',
  'secret',
  'clientsecret',
  'privatekeypem',
  'certificatepem',
  'refreshtoken',
  'token',
  'code',
  'otp',
  'sealedblob',
  'wrappeddek',
]);

/** Suffixes that name the same secrets inside a longer key (`newPassword`, `accessToken`, `client_secret`). */
const SECRET_SUFFIXES = ['password', 'secret', 'token', 'privatekey', 'privatekeypem', 'certificatepem', 'sealedblob', 'wrappeddek', 'otp'];

/** One-time and second-factor codes (`recoveryCode`, `currentCode`, `otp_code`, `mfaCode`, `verificationCode`). */
const SECRET_CODE = /^(current|recovery|verification|otp|mfa|totp|auth|authorization|one_?time|guest|reset|invitation)_?code$/;

/** True when the value of `key` must not be written to the audit trail (F.11). */
export function isRedactedKey(key: string): boolean {
  if (/_sealed$|Sealed$|_hash$|Hash$/.test(key)) return true;
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  if (EXACT.has(normalised)) return true;
  if (SECRET_SUFFIXES.some((suffix) => normalised.endsWith(suffix))) return true;
  return SECRET_CODE.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

const MAX_DEPTH = 32;

/**
 * Returns a copy of `value` with every secret value replaced by `[redacted]` (objects at any depth, arrays
 * included). Dates become ISO strings, buffers are redacted (they never belong in an audit entry), functions and
 * undefined members are dropped, so the result is plain JSON.
 */
export function redactAuditData<T>(value: T): T {
  return redact(value, 0, new WeakSet()) as T;
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return AUDIT_REDACTED;
  if (depth >= MAX_DEPTH) return AUDIT_REDACTED;
  if (seen.has(value)) return AUDIT_REDACTED;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function') continue;
      out[key] = isRedactedKey(key) && item !== null ? AUDIT_REDACTED : redact(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
