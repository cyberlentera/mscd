// Area `auditor-access` (owner from wave 10: WP-26): guest auditor grants (D.2, D.3, D-27, F.14, feature
// auditor_guest_access). The access link is emailed to the auditor and never returned.
import { z } from 'zod';
import { Handle, Instant, MsParams, MsRecordParams, Uuid, CommandResult, commandResultWith, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

export const AuditorAccessRequest = named(
  'AuditorAccessRequest',
  z.strictObject({ email: z.email().max(254), expiresInDays: z.int().min(1).max(30).default(14) }),
  'POST /ms/{ms}/auditor-access body: the auditor address and the grant length (1 to 30 days, default 14)',
  { valid: [{ email: 'lead.auditor@certifier.co.id' }, { email: 'lead.auditor@certifier.co.id', expiresInDays: 30 }], invalid: [{ email: 'auditor' }, { email: 'a@b.co', expiresInDays: 31 }] },
);
export type AuditorAccessRequest = z.infer<typeof AuditorAccessRequest>;

export const AuditorAccessResult = named(
  'AuditorAccessResult',
  commandResultWith(z.object({ grantId: Uuid, expiresAt: Instant })),
  'Result of a grant: its id and expiry; the link goes to the auditor by email only (F.14)',
  { valid: [{ ok: true, changed: ['isms'], data: { grantId: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', expiresAt: '2026-10-13T06:00:00Z' } }], invalid: [{ ok: true, changed: ['isms'], data: { link: 'https://x/guest#t' } }] },
);
export type AuditorAccessResult = z.infer<typeof AuditorAccessResult>;

const EXAMPLE_GRANT = {
  id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', email: 'ext.auditor@mscd.test', guestHandle: 'guest-1a2b3c4d', createdBy: 'rina', createdAt: '2026-09-29T06:00:00Z',
  expiresAt: '2026-10-13T06:00:00Z', linkUsedAt: '2026-09-29T07:00:00Z', lastUsedAt: '2026-09-29T07:05:00Z', revokedAt: null, revokedBy: null, active: true,
} as const;

export const AuditorAccessGrantView = named(
  'AuditorAccessGrantView',
  z.object({
    id: Uuid, email: z.string(), guestHandle: Handle.nullable(), createdBy: Handle.nullable(), createdAt: Instant, expiresAt: Instant,
    linkUsedAt: Instant.nullable(), lastUsedAt: Instant.nullable(), revokedAt: Instant.nullable(), revokedBy: Handle.nullable(), active: z.boolean(),
  }),
  'Guest auditor grant of the system (auditor_access_grant), without its token',
  { valid: [EXAMPLE_GRANT], invalid: [{ ...EXAMPLE_GRANT, token: undefined, active: 'yes' }] },
);
export type AuditorAccessGrantView = z.infer<typeof AuditorAccessGrantView>;

export const auditorAccessGrantRoute = defineRoute({
  id: 'auditor-access.grant',
  owner: 'WP-26',
  method: 'POST',
  path: '/api/v1/ms/:ms/auditor-access',
  summary: 'Grant time-boxed guest access to an external auditor (feature auditor_guest_access); the link is emailed',
  auth: 'session',
  permission: 'auditor_access.grant',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: AuditorAccessRequest,
  response: AuditorAccessResult,
  status: 201,
  errors: [404, 422],
  idempotent: true,
});

export const auditorAccessListRoute = defineRoute({
  id: 'auditor-access.list',
  owner: 'WP-26',
  method: 'GET',
  path: '/api/v1/ms/:ms/auditor-access',
  summary: 'Guest auditor grants of the system',
  auth: 'session',
  permission: 'auditor_access.grant',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  response: z.array(AuditorAccessGrantView),
  errors: [404],
});

export const auditorAccessRevokeRoute = defineRoute({
  id: 'auditor-access.revoke',
  owner: 'WP-26',
  method: 'POST',
  path: '/api/v1/ms/:ms/auditor-access/:id/revoke',
  summary: "Revoke a grant: ends the guest's sessions and role at once",
  auth: 'session',
  permission: 'auditor_access.grant',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  response: CommandResult,
  errors: [404, 409],
});

export const routes: RouteDef[] = [auditorAccessGrantRoute, auditorAccessListRoute, auditorAccessRevokeRoute];
