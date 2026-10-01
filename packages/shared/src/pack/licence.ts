// Licence document (TS 2.5 fields, D-15 binding fields, E.8 signature format). The signature is Ed25519 over the
// canonical JSON of the document without `signature` (`licenceSigningPayload`). The schema keeps members it does not
// know (a newer licence format still verifies over every member it carries).
import { z } from 'zod';
import { StorageAdapter } from '../enums.js';
import { IsoDate, Uuid, named } from '../api/common.js';
import { canonicalJsonWithout } from './canonical-json.js';
import { FrameworkCode } from './manifest.js';
import { EXAMPLE_LICENCE } from '../examples.js';

/** Longest validity of an unbound licence, which must carry `"trial": true` (D-15). */
export const TRIAL_MAX_DAYS = 90;

export const KeyId = named('KeyId', z.string().regex(/^[0-9a-f]{16}$/), 'Key id: first 16 hexadecimal characters of the SHA-256 of the public key in DER (SPKI) form (E.8)', {
  valid: ['0a1b2c3d4e5f6789'],
  invalid: ['0A1B2C3D4E5F6789', '0a1b2c', 'licence-signing'],
});
export type KeyId = z.infer<typeof KeyId>;

export const Ed25519Signature = named('Ed25519Signature', z.string().regex(/^ed25519:[A-Za-z0-9+/]{86}==$/), 'Signature ed25519:<base64 of the 64 signature bytes> (E.8)', {
  valid: ['ed25519:' + 'A'.repeat(86) + '=='],
  invalid: ['ed25519:abc', 'rsa:' + 'A'.repeat(86) + '==', 'A'.repeat(88)],
});
export type Ed25519Signature = z.infer<typeof Ed25519Signature>;


export const LicenceDocument = named(
  'LicenceDocument',
  z.looseObject({
    license_id: z.string().min(1).max(60),
    organization: z.string().min(1).max(200),
    valid_from: IsoDate,
    valid_until: IsoDate,
    grace_days: z.int().min(0).max(365),
    frameworks: z.array(FrameworkCode),
    max_management_systems: z.int().min(0),
    max_users: z.int().min(0),
    storage_adapters: z.array(StorageAdapter),
    features: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)),
    installation_id: Uuid.optional(),
    organization_id: Uuid.optional(),
    trial: z.boolean().optional(),
    key_id: KeyId,
    signature: Ed25519Signature,
  })
    .refine((d) => d.valid_until >= d.valid_from, { message: 'valid_until is before valid_from', path: ['valid_until'] })
    .refine((d) => !(d.installation_id && d.organization_id), { message: 'a licence binds to an installation or to an organisation, not both', path: ['organization_id'] }),
  'Signed licence (TS 2.5, D-15): bound to an installation (on-premise) or an organisation (SaaS), or an unbound trial of at most 90 days',
  {
    valid: [
      EXAMPLE_LICENCE,
      { ...EXAMPLE_LICENCE, organization_id: undefined, installation_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' },
      { ...EXAMPLE_LICENCE, organization_id: undefined, trial: true, valid_until: '2026-06-30' },
    ],
    invalid: [
      { ...EXAMPLE_LICENCE, signature: 'ed25519:short' },
      { ...EXAMPLE_LICENCE, valid_until: '2026-03-01' },
      { ...EXAMPLE_LICENCE, installation_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' },
      { ...EXAMPLE_LICENCE, storage_adapters: ['dropbox'] },
    ],
  },
);
export type LicenceDocument = z.infer<typeof LicenceDocument>;

/** What a licence binds to (D-15). `unbound` is accepted only as a trial of at most `TRIAL_MAX_DAYS` days. */
export type LicenceBinding =
  | { kind: 'installation'; id: string }
  | { kind: 'organization'; id: string }
  | { kind: 'trial' }
  | { kind: 'unbound'; reason: 'not_trial' | 'trial_too_long' };

/** Days between two ISO dates (UTC calendar arithmetic). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Binding of a licence document (D-15). The server rejects `unbound` and a binding to another target (422 LIC-BINDING). */
export function licenceBinding(doc: LicenceDocument): LicenceBinding {
  if (doc.installation_id) return { kind: 'installation', id: doc.installation_id };
  if (doc.organization_id) return { kind: 'organization', id: doc.organization_id };
  if (doc.trial !== true) return { kind: 'unbound', reason: 'not_trial' };
  if (daysBetween(doc.valid_from, doc.valid_until) > TRIAL_MAX_DAYS) return { kind: 'unbound', reason: 'trial_too_long' };
  return { kind: 'trial' };
}

/** The exact text the licence signature covers: canonical JSON without `signature` (D-15). */
export function licenceSigningPayload(doc: Readonly<Record<string, unknown>>): string {
  return canonicalJsonWithout(doc, ['signature']);
}
