// MFA recovery codes (build plan F.5): ten codes of ten characters in lower-case base32, written `xxxx-xxxx-xx`,
// shown once at enrolment and stored argon2id-hashed. Each code carries 50 random bits.
import { randomInt } from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const RECOVERY_CODE_PATTERN = /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/;

/** One new recovery code `xxxx-xxxx-xx`. */
export function newRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i += 1) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Ten distinct new codes. */
export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newRecoveryCode());
  return [...codes];
}

/** The form a code is hashed in: lower case without separators, so `ABCD-EFGH-IJ` and `abcdefghij` match. */
export function recoveryCodeKey(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase();
}
