// Time-based one-time passwords (build plan F.5): RFC 4226 HOTP and RFC 6238 TOTP on node:crypto, with RFC 4648
// base32 for the secret. MSCD uses SHA-1, 6 digits and a 30 second step, and accepts one step before and after the
// current one; the other algorithms and lengths exist so the RFC 6238 test vectors can be checked.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  algorithm?: TotpAlgorithm;
  digits?: number;
  /** Seconds per step. */
  period?: number;
}

/** The F.5 parameters. */
export const TOTP_DEFAULTS: Required<TotpOptions> = { algorithm: 'sha1', digits: 6, period: 30 };

/** Steps accepted before and after the current one (F.5). */
export const TOTP_WINDOW = 1;

/** Bytes of a new TOTP secret (F.5: 20 random bytes). */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, without padding. */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 to bytes; case, spaces, hyphens and padding are ignored. Throws on any other character. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random TOTP secret. */
export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4226 HOTP value of `counter`, left-padded to `digits`. */
export function hotp(secret: Uint8Array, counter: bigint | number, digits = TOTP_DEFAULTS.digits, algorithm: TotpAlgorithm = 'sha1'): string {
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error('HOTP digits must be 6 to 10');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 time step of an instant. */
export function totpStep(at: Date | number, period = TOTP_DEFAULTS.period): number {
  const ms = typeof at === 'number' ? at : at.getTime();
  return Math.floor(ms / 1000 / period);
}

/** RFC 6238 code at an instant. */
export function totpAt(secret: Uint8Array, at: Date | number, options: TotpOptions = {}): string {
  const o = { ...TOTP_DEFAULTS, ...options };
  return hotp(secret, totpStep(at, o.period), o.digits, o.algorithm);
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The step a code belongs to within the accepted window around `at`, or null. Steps at or below `lastUsedStep` are
 * never accepted (F.5 replay protection). Every candidate is compared, so the time taken does not depend on which
 * step matched.
 */
export function matchTotp(
  secret: Uint8Array,
  code: string,
  at: Date | number,
  options: TotpOptions & { window?: number; lastUsedStep?: number | null } = {},
): number | null {
  const o = { ...TOTP_DEFAULTS, ...options };
  const window = options.window ?? TOTP_WINDOW;
  if (!new RegExp(`^\\d{${o.digits}}$`).test(code)) return null;
  const current = totpStep(at, o.period);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step += 1) {
    const ok = sameCode(hotp(secret, step, o.digits, o.algorithm), code);
    const fresh = options.lastUsedStep === null || options.lastUsedStep === undefined || step > options.lastUsedStep;
    if (ok && fresh && matched === null) matched = step;
  }
  return matched;
}

/** `otpauth://` URI for authenticator apps (F.5): `otpauth://totp/MSCD:<email>?secret=...&issuer=MSCD`. */
export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}`;
}
