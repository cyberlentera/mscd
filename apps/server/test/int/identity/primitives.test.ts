// Building blocks of the identity module without a database: RFC 4226 and RFC 6238 test vectors, RFC 4648 base32,
// the TOTP window and replay rule (F.5), recovery codes, argon2id parameters and the password policy (F.4), the
// second-factor lock arithmetic (F.3) and the CSRF token derivation (F.2).
import { existsSync, readFileSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { decayedLockLevel, hasRecentProof, mfaLockDuration } from '../../../src/modules/identity/mfa.service';
import { ARGON2_PARAMETERS, hashSecret, needsRehash, verifySecret } from '../../../src/modules/identity/password-hasher';
import { commonPasswordFileCandidates, commonPasswords, isCommonPassword, parseCommonPasswordList, passwordProblems } from '../../../src/modules/identity/password-policy';
import { newRecoveryCodes, RECOVERY_CODE_PATTERN, recoveryCodeKey } from '../../../src/modules/identity/recovery-codes';
import { handleBase } from '../../../src/modules/identity/invitation.service';
import { crossSiteSendable } from '../../../src/modules/identity/session-resolver';
import { csrfTokenFor, randomToken, RANDOM_TOKEN } from '../../../src/modules/identity/tokens';
import { base32Decode, base32Encode, hotp, matchTotp, otpauthUrl, totpAt, totpStep } from '../../../src/modules/identity/totp';

const ascii = (s: string) => Buffer.from(s, 'ascii');

describe('HOTP and TOTP (RFC 4226, RFC 6238)', () => {
  it('matches the RFC 4226 appendix D values', () => {
    const secret = ascii('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, counter) => hotp(secret, counter))).toEqual(expected);
  });

  it('matches every RFC 6238 appendix B test vector (SHA-1, SHA-256, SHA-512, 8 digits)', () => {
    const seeds = {
      sha1: ascii('12345678901234567890'),
      sha256: ascii('12345678901234567890123456789012'),
      sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
    } as const;
    const vectors: [number, string, string, string][] = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [seconds, sha1, sha256, sha512] of vectors) {
      expect(totpAt(seeds.sha1, seconds * 1000, { digits: 8, algorithm: 'sha1' }), `${seconds} sha1`).toBe(sha1);
      expect(totpAt(seeds.sha256, seconds * 1000, { digits: 8, algorithm: 'sha256' }), `${seconds} sha256`).toBe(sha256);
      expect(totpAt(seeds.sha512, seconds * 1000, { digits: 8, algorithm: 'sha512' }), `${seconds} sha512`).toBe(sha512);
    }
  });

  it('uses 6 digits, SHA-1 and 30 second steps by default (F.5)', () => {
    const secret = ascii('12345678901234567890');
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpStep(59_000)).toBe(1);
    expect(totpStep(new Date('2026-10-01T08:00:00Z'))).toBe(Math.floor(Date.parse('2026-10-01T08:00:00Z') / 30_000));
  });

  it('accepts one step before and after, and never a step at or before the last used one', () => {
    const secret = ascii('12345678901234567890');
    const at = 1_000_000 * 30_000;
    const step = totpStep(at);
    expect(matchTotp(secret, totpAt(secret, at), at)).toBe(step);
    expect(matchTotp(secret, totpAt(secret, at - 30_000), at)).toBe(step - 1);
    expect(matchTotp(secret, totpAt(secret, at + 30_000), at)).toBe(step + 1);
    expect(matchTotp(secret, totpAt(secret, at - 60_000), at)).toBeNull();
    expect(matchTotp(secret, totpAt(secret, at + 60_000), at)).toBeNull();
    expect(matchTotp(secret, totpAt(secret, at), at, { lastUsedStep: step })).toBeNull();
    expect(matchTotp(secret, totpAt(secret, at + 30_000), at, { lastUsedStep: step })).toBe(step + 1);
    expect(matchTotp(secret, totpAt(secret, at - 30_000), at, { lastUsedStep: step - 1 })).toBeNull();
    expect(matchTotp(secret, '12345', at)).toBeNull();
    expect(matchTotp(secret, 'abcdef', at)).toBeNull();
  });

  it('encodes and decodes base32 as RFC 4648 section 10 (without padding)', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(ascii(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString('ascii')).toBe(plain);
      expect(base32Decode(`${encoded.toLowerCase()}====`).toString('ascii')).toBe(plain);
    }
    expect(() => base32Decode('MZ1W')).toThrow();
    const secret = Buffer.from('00112233445566778899aabbccddeeff01234567', 'hex');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(base32Encode(secret)).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('builds the otpauth URI of F.5', () => {
    expect(otpauthUrl('MSCD', 'rina.kusuma@nusantaradigital.co.id', 'JBSWY3DPEHPK3PXP')).toBe(
      'otpauth://totp/MSCD:rina.kusuma%40nusantaradigital.co.id?secret=JBSWY3DPEHPK3PXP&issuer=MSCD',
    );
  });
});

describe('recovery codes and hashing (F.4, F.5)', () => {
  it('issues ten distinct codes xxxx-xxxx-xx in lower-case base32', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(RECOVERY_CODE_PATTERN);
    expect(recoveryCodeKey('ABCD-EFGH-IJ')).toBe('abcdefghij');
  });

  it('hashes with argon2id at the OWASP minimum and asks for a rehash of other parameters', async () => {
    const hashed = await hashSecret('a long enough passphrase');
    expect(hashed).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2_PARAMETERS.memoryCost},t=2,p=1\\$`));
    expect(await verifySecret(hashed, 'a long enough passphrase')).toBe(true);
    expect(await verifySecret(hashed, 'another passphrase')).toBe(false);
    expect(await verifySecret('not a hash', 'x')).toBe(false);
    expect(needsRehash(hashed)).toBe(false);
    expect(needsRehash(await hash('a long enough passphrase', { memoryCost: 8192, timeCost: 3 }))).toBe(true);
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });
});

describe('password policy (F.4)', () => {
  const account = { email: 'Rina.Kusuma@nusantaradigital.co.id', handle: 'rina.kusuma' };

  it('ships the 10,000 most common passwords and the 10,000 most common ones of 12 or more characters, with the SecLists licence', () => {
    const list = commonPasswords();
    expect(list.size).toBeGreaterThanOrEqual(19_900);
    expect(list.has('password')).toBe(true);
    expect(list.has('unbelievable')).toBe(true);
    for (const long of ['password1234', '123456789012', 'qwertyuiop12', '111111111111', 'passwordpassword']) expect(list.has(long), long).toBe(true);
    expect([...list].filter((p) => [...p].length >= 12).length).toBeGreaterThanOrEqual(10_000);
    // The header carries the source and the MIT copyright and permission notice; it is not part of the list.
    const file = commonPasswordFileCandidates().find((candidate) => existsSync(candidate))!;
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# Copyright (c) 2018 Daniel Miessler');
    expect(text).toContain('# The above copyright notice and this permission notice shall be included in all');
    expect(list.has('# mit license')).toBe(false);
    expect(parseCommonPasswordList('# header\n#\n# more\n\n#hashtag1\nPassword\n\nqwerty\n')).toEqual(['#hashtag1', 'password', 'qwerty']);
    expect(parseCommonPasswordList('password\n#tag\n')).toEqual(['password', '#tag']);
  });

  it('rejects common words padded with digits or symbols, character swaps, repeats and runs (F.4)', () => {
    const common = ['password1234', '123456789012', 'qwertyuiop12', '111111111111', 'passwordpassword', 'Password1234!', 'p@ssw0rd2024', '2024summer!!', 'iloveyou1234', '@dmin1234567'];
    const repetitive = ['abcabcabcabc', 'aaaaaaaaaaaab', 'abcdefghijklm', '987654321098', 'zyxwvutsrqpo', 'dragon!dragon!', 'xk7#xk7#xk7#'];
    for (const password of [...common, ...repetitive]) expect(isCommonPassword(password), password).toBe(true);
    for (const password of ['Correct-Horse-Battery-77', 'kucing-hitam-lompat-7', '739201846257', 'Jakarta2026!Aman', 'MyDogIsCute12', 'Rina.Kusuma-2026']) {
      expect(isCommonPassword(password), password).toBe(false);
    }
    expect(passwordProblems('password1234', account, 'body.password')).toEqual([{ path: 'body.password', message: 'This password is too common; choose another one' }]);
  });

  it('accepts 12 to 256 characters that are not the email, the handle or a common password', () => {
    expect(passwordProblems('Correct-Horse-Battery-77', account, 'body.password')).toEqual([]);
    expect(passwordProblems('Correct-Horse-Battery-77/'.repeat(11).slice(0, 256), account, 'body.password')).toEqual([]);
    expect(passwordProblems('short-pw-1', account, 'body.password')).toEqual([{ path: 'body.password', message: 'Use at least 12 characters' }]);
    expect(passwordProblems('x'.repeat(257), account, 'body.password')[0]?.message).toBe('Use at most 256 characters');
    expect(passwordProblems('rina.kusuma@NUSANTARADIGITAL.co.id', account, 'body.password')[0]?.message).toMatch(/email address or user name/);
    expect(passwordProblems('unbelievable', account, 'body.newPassword')).toEqual([{ path: 'body.newPassword', message: 'This password is too common; choose another one' }]);
    expect(passwordProblems('UnBelievable', account, 'body.password')).toHaveLength(1);
    expect(passwordProblems('kata sandi rahasia ✓✓', account, 'body.password')).toEqual([]);
  });
});

describe('second-factor lock, proofs and tokens', () => {
  it('locks for 15 minutes, doubling per level up to 24 hours (F.3)', () => {
    expect([0, 1, 2, 3, 6, 7, 20].map((level) => mfaLockDuration(level) / 60_000)).toEqual([15, 30, 60, 120, 960, 1440, 1440]);
  });

  it('decays the lock level by one per 24 hours since the last lock ended', () => {
    const ended = new Date('2026-10-01T00:00:00Z');
    expect(decayedLockLevel(3, ended, new Date('2026-10-01T23:59:00Z'))).toBe(3);
    expect(decayedLockLevel(3, ended, new Date('2026-10-02T00:00:00Z'))).toBe(2);
    expect(decayedLockLevel(3, ended, new Date('2026-10-04T01:00:00Z'))).toBe(0);
    expect(decayedLockLevel(3, ended, new Date('2026-09-30T23:00:00Z'))).toBe(3);
    expect(decayedLockLevel(0, null, ended)).toBe(0);
  });

  it('counts a password or TOTP proof of the last 5 minutes as recent (F.5)', () => {
    const now = new Date('2026-10-01T08:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(hasRecentProof({ password_at: ago(299_000), mfa_at: null }, now)).toBe(true);
    expect(hasRecentProof({ password_at: null, mfa_at: ago(60_000) }, now)).toBe(true);
    expect(hasRecentProof({ password_at: ago(301_000), mfa_at: ago(400_000) }, now)).toBe(false);
    expect(hasRecentProof({ password_at: null, mfa_at: null }, now)).toBe(false);
  });

  it('derives a session CSRF token from the cookie value that differs from it (F.2)', () => {
    const cookie = randomToken();
    expect(cookie).toMatch(RANDOM_TOKEN);
    const token = csrfTokenFor(cookie);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(cookie);
    expect(csrfTokenFor(cookie)).toBe(token);
    expect(csrfTokenFor(randomToken())).not.toBe(token);
  });

  it('tells which requests without Origin and Referer a page of another site could send (F.2)', () => {
    const sendable = (headers: Record<string, string>) => crossSiteSendable({ headers });
    for (const type of ['text/plain', 'TEXT/PLAIN; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(sendable({ 'content-type': type, 'content-length': '10' }), type).toBe(true);
    }
    expect(sendable({ 'content-length': '10' })).toBe(true);
    expect(sendable({ 'transfer-encoding': 'chunked' })).toBe(true);
    expect(sendable({ 'content-type': 'application/json', 'content-length': '10' })).toBe(false);
    expect(sendable({})).toBe(false);
    expect(sendable({ 'content-length': '0' })).toBe(false);
  });

  it('makes handles from email addresses', () => {
    expect(handleBase('Rina.Kusuma@nusantaradigital.co.id')).toBe('rina.kusuma');
    expect(handleBase('1st+ops@x.test')).toBe('st.ops');
    expect(handleBase('a@x.test')).toBe('usera');
    expect(handleBase(`${'b'.repeat(60)}@x.test`)).toHaveLength(34);
  });
});
