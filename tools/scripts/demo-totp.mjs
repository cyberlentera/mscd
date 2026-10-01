#!/usr/bin/env node
// Prints the current TOTP code of a demo or test user (build plan G.3 and F.5).
//
// Secret rule (G.3): the first 20 bytes of HMAC-SHA256(key = "mscd-demo-totp", message = handle), shown as
// RFC 4648 base32 without padding (32 characters). Codes follow RFC 6238: HMAC-SHA1, 30 second step, 6 digits.
//
// Usage: node tools/scripts/demo-totp.mjs <handle> [--secret] [--time <unix seconds>]
//        node tools/scripts/demo-totp.mjs --self-test
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEMO_TOTP_KEY = 'mscd-demo-totp';
export const STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The 20-byte TOTP key of a demo handle. */
export function demoSecretBytes(handle) {
  return createHmac('sha256', DEMO_TOTP_KEY).update(handle, 'utf8').digest().subarray(0, 20);
}

/** The base32 secret of a demo handle, as stored at enrolment (32 characters). */
export function demoSecret(handle) {
  return base32(demoSecretBytes(handle)).slice(0, 32);
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

// RFC 6238 appendix B, SHA-1 rows (key "12345678901234567890", 8 digits).
const RFC6238_SHA1 = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

export function selfTest() {
  const key = Buffer.from('12345678901234567890', 'ascii');
  const failures = RFC6238_SHA1.filter(([time, code]) => totp(key, time, 8) !== code);
  if (base32(Buffer.from('foobar', 'ascii')) !== 'MZXW6YTBOI') failures.push(['base32', 'MZXW6YTBOI']);
  return failures;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      secret: { type: 'boolean', default: false },
      time: { type: 'string' },
      'self-test': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('Usage: demo-totp.mjs <handle> [--secret] [--time <unix seconds>] | --self-test\n');
    return 0;
  }
  if (values['self-test']) {
    const failures = selfTest();
    if (failures.length > 0) {
      process.stderr.write(`demo-totp: self-test failed for ${failures.map(([t]) => t).join(', ')}\n`);
      return 1;
    }
    process.stdout.write('demo-totp: RFC 6238 SHA-1 vectors and base32 pass\n');
    return 0;
  }
  if (positionals.length !== 1 || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(positionals[0])) {
    process.stderr.write('Usage: demo-totp.mjs <handle> [--secret] [--time <unix seconds>] (handle in lowercase, for example rina)\n');
    return 2;
  }
  const handle = positionals[0];
  if (values.secret) {
    process.stdout.write(`${demoSecret(handle)}\n`);
    return 0;
  }
  let now = Math.floor(Date.now() / 1000);
  if (values.time !== undefined) {
    if (!/^\d+$/.test(values.time)) {
      process.stderr.write('demo-totp: --time must be a Unix time in seconds\n');
      return 2;
    }
    now = Number(values.time);
  }
  process.stdout.write(`${totp(demoSecretBytes(handle), now)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
