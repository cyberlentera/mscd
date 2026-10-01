// Area `license` (owner from wave 5: WP-12): the licence of the organisation (D.2 `LicenceView`, D.3, D-15, D-32).
import { z } from 'zod';
import { StorageAdapter } from '../enums.js';
import { LicenceDocument } from '../pack/licence.js';
import { EXAMPLE_LICENCE } from '../examples.js';
import { IsoDate, OrgSlug, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

/** Derived licence state (D-15, digest 5.11): valid, in grace after valid_until, or read-only after grace (BR-37). */
export const LICENCE_STATES = ['valid', 'grace', 'read_only'] as const;
export const LicenceState = z.enum(LICENCE_STATES).meta({ id: 'LicenceState', description: 'Derived licence state (D-15, BR-37)' });
export type LicenceState = z.infer<typeof LicenceState>;

const EXAMPLE_VIEW = {
  licenseId: 'LIC-DEMO-NDT', organization: 'PT Nusantara Digital Teknologi', binding: { organizationId: '00000000-0000-4000-8000-00000000a001', trial: false },
  validFrom: '2026-04-01', validUntil: '2027-03-31', graceDays: 30, state: 'valid', clockRollback: false, frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'],
  maxManagementSystems: 10, maxUsers: 150, activeUsers: 86, managementSystems: 4, storageAdapters: ['managed_vault', 'm365', 'google_drive', 'smb'],
  features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
  signature: { alg: 'Ed25519', keyId: '0a1b2c3d4e5f6789', verified: true, offline: true },
} as const;

export const LicenceView = named(
  'LicenceView',
  z.object({
    licenseId: z.string(),
    organization: z.string(),
    binding: z.object({ installationId: Uuid.optional(), organizationId: Uuid.optional(), trial: z.boolean() }),
    validFrom: IsoDate,
    validUntil: IsoDate,
    graceDays: z.int().min(0),
    state: LicenceState,
    clockRollback: z.boolean(),
    frameworks: z.array(z.string()),
    maxManagementSystems: z.int().min(0),
    maxUsers: z.int().min(0),
    activeUsers: z.int().min(0),
    managementSystems: z.int().min(0),
    storageAdapters: z.array(StorageAdapter),
    features: z.array(z.string()),
    signature: z.object({ alg: z.literal('Ed25519'), keyId: z.string(), verified: z.boolean(), offline: z.boolean() }),
  }),
  'Verified licence with its derived state and the current usage (D.2); nothing derived is stored (D-15)',
  { valid: [EXAMPLE_VIEW, { ...EXAMPLE_VIEW, state: 'grace', clockRollback: true }], invalid: [{ ...EXAMPLE_VIEW, state: 'expired' }, { ...EXAMPLE_VIEW, signature: { alg: 'RSA', keyId: 'k', verified: true, offline: true } }] },
);
export type LicenceView = z.infer<typeof LicenceView>;

export const LicenceInstallRequest = named(
  'LicenceInstallRequest',
  z.union([LicenceDocument, z.strictObject({ org: OrgSlug, licence: LicenceDocument })]),
  'PUT /admin/license body: the signed licence document; with tenancy.mode multi the platform operator wraps it as {org, licence}',
  {
    valid: [EXAMPLE_LICENCE, { org: 'ndt', licence: EXAMPLE_LICENCE }],
    invalid: [{ org: 'ndt' }, { license_id: 'LIC-1' }],
  },
);
export type LicenceInstallRequest = z.infer<typeof LicenceInstallRequest>;

export const licenseGetRoute = defineRoute({
  id: 'license.get',
  owner: 'WP-12',
  method: 'GET',
  path: '/api/v1/license',
  summary: "The organisation's licence with its derived state and usage",
  auth: 'session',
  permission: 'license.read',
  scope: 'org',
  response: LicenceView,
  errors: [404],
});

export const licensePutRoute = defineRoute({
  id: 'admin.license.put',
  owner: 'WP-12',
  method: 'PUT',
  path: '/api/v1/admin/license',
  summary: 'Install a signed licence (Tenant Admin with single tenancy, platform operator with multi, who names the organisation); allowed in read-only mode',
  auth: 'session',
  permission: 'license.manage',
  scope: 'org',
  body: LicenceInstallRequest,
  response: LicenceView,
  errors: [404, 422],
  readOnlyAllowed: true,
});

export const routes: RouteDef[] = [licenseGetRoute, licensePutRoute];
