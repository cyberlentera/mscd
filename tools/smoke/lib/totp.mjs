// TOTP codes of the demo users for the full-stack smoke test (build plan J.9, G.3 and F.5).
//
// Copied from tools/scripts/demo-totp.mjs so the smoke test has no dependency outside tools/smoke. Keep the two
// in step: the secret rule and the code rule below are the same in both files.
//
// Secret rule (G.3): the first 20 bytes of HMAC-SHA256(key = "mscd-demo-totp", message = handle).
// Codes follow RFC 6238: HMAC-SHA1, 30 second step, 6 digits.
import { createHmac } from 'node:crypto';

export const DEMO_TOTP_KEY = 'mscd-demo-totp';
export const STEP_SECONDS = 30;

/** The 20-byte TOTP key of a demo handle. */
export function demoSecretBytes(handle) {
  return createHmac('sha256', DEMO_TOTP_KEY).update(handle, 'utf8').digest().subarray(0, 20);
}

/** RFC 4226 HOTP over HMAC-SHA1 with dynamic truncation. */
export function hotp(key, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP for a Unix time in seconds. */
export function totp(key, unixSeconds = Math.floor(Date.now() / 1000), digits = 6) {
  return hotp(key, Math.floor(unixSeconds / STEP_SECONDS), digits);
}

/** The current code of a demo handle. */
export function demoCode(handle, unixSeconds = Math.floor(Date.now() / 1000)) {
  return totp(demoSecretBytes(handle), unixSeconds);
}

/** Seconds left in the current 30 second step. */
export function secondsLeftInStep(unixSeconds = Math.floor(Date.now() / 1000)) {
  return STEP_SECONDS - (unixSeconds % STEP_SECONDS);
}

// RFC 6238 appendix B, SHA-1 rows (key "12345678901234567890", 8 digits).
const RFC6238_SHA1 = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

/** The RFC 6238 vectors that fail (an empty list when the copy is correct). */
export function selfTest() {
  const key = Buffer.from('12345678901234567890', 'ascii');
  return RFC6238_SHA1.filter(([time, code]) => totp(key, time, 8) !== code).map(([time]) => time);
}
