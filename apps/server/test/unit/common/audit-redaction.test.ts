// F.11: secrets never reach before_data or after_data. Every request schema of D.2 that carries a secret is run
// through the redaction with its own valid examples; no secret value may survive.
import * as shared from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { AUDIT_REDACTED, isRedactedKey, redactAuditData } from '../../../src/common/audit-redaction';

/** D.2 request schemas that carry a secret, with the members that hold it. */
const SECRET_SCHEMAS: Record<string, string[]> = {
  LoginRequest: ['password'],
  MfaVerifyRequest: ['code', 'recoveryCode'],
  MfaEnrolStartRequest: ['currentCode', 'password'],
  MfaEnrolConfirmRequest: ['code'],
  PasswordResetConfirm: ['token', 'password'],
  PasswordChangeRequest: ['currentPassword', 'newPassword'],
  GuestStartRequest: ['token'],
  GuestVerifyRequest: ['code'],
  RepositoryCredential: ['secret'],
  IdentityProviderRequest: ['clientSecret'],
};

/** String leaves of a value (object members and array items at any depth). */
function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(leaves);
}

/** The values held under the secret members, at any depth (six characters or more, so they are recognisable). */
function secretValues(value: unknown, members: readonly string[]): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => (members.includes(k) ? leaves(v) : secretValues(v, members)))
    .filter((s) => s.length >= 6);
}

function examplesOf(name: string): unknown[] {
  const schema = (shared as unknown as Record<string, ZodType>)[name];
  expect(schema, `schema ${name} is exported by @mscd/shared`).toBeDefined();
  const meta = schema!.meta() as { examples?: unknown[] } | undefined;
  return meta?.examples ?? [];
}

describe('audit redaction (F.11)', () => {
  it('names the F.11 keys and their compound forms, and keeps business codes', () => {
    for (const key of [
      'password', 'secret', 'clientSecret', 'privateKeyPem', 'certificatePem', 'refreshToken', 'token', 'code', 'otp', 'sealedBlob',
      'wrappedDek', 'secret_sealed', 'oidc_client_secret_sealed', 'password_hash', 'tokenHash', 'currentPassword', 'newPassword',
      'recoveryCode', 'currentCode', 'client_secret', 'csrfToken', 'access_token',
    ]) {
      expect(isRedactedKey(key), key).toBe(true);
    }
    for (const key of ['docCode', 'riskCodes', 'frequencyCode', 'entityCode', 'targetCode', 'title', 'ownerHandle', 'hashValue', 'hashAlgorithm', 'passwordChangedAt']) {
      expect(isRedactedKey(key), key).toBe(false);
    }
  });

  for (const [name, members] of Object.entries(SECRET_SCHEMAS)) {
    it(`redacts every secret of ${name}`, () => {
      const examples = examplesOf(name);
      expect(examples.length).toBeGreaterThan(0);
      let checked = 0;
      for (const example of examples) {
        const secrets = secretValues(example, members);
        const redacted = leaves(redactAuditData({ request: example }));
        for (const secret of secrets) {
          expect(redacted.filter((value) => value.includes(secret)), `${name}: ${secret}`).toEqual([]);
          checked += 1;
        }
      }
      expect(checked, `${name} examples carry at least one secret`).toBeGreaterThan(0);
    });
  }

  it('redacts at any depth, inside arrays, and turns dates and buffers into JSON-safe values', () => {
    const input = {
      title: 'Policy',
      nested: { list: [{ token: 't-1', keep: 1 }, { otp: '123456' }] },
      at: new Date('2026-09-29T00:00:00Z'),
      blob: Buffer.from('raw'),
      gone: undefined,
      empty: { password: null },
    };
    expect(redactAuditData(input)).toEqual({
      title: 'Policy',
      nested: { list: [{ token: AUDIT_REDACTED, keep: 1 }, { otp: AUDIT_REDACTED }] },
      at: '2026-09-29T00:00:00.000Z',
      blob: AUDIT_REDACTED,
      empty: { password: null },
    });
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactAuditData(a)).toEqual({ name: 'a', self: AUDIT_REDACTED });
  });
});
