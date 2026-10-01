// Area `audit-trail` (owner from wave 4: WP-08): reading, exporting and verifying the audit chains (D.2, D.3, F.11).
import { z } from 'zod';
import { ActorKind } from '../enums.js';
import { Ed25519Signature, KeyId } from '../pack/licence.js';
import {
  BinaryBody, EntityTypeName, Instant, IsoDate, MsId, PersonId, Uuid, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

const metaShape = {
  seq: z.int().min(1),
  occurredAt: Instant,
  actor: z.object({ handle: PersonId.nullable(), displayName: z.string().nullable(), kind: ActorKind }),
  action: z.string().min(1).max(60),
  entityType: z.string().nullable(),
  entityId: Uuid.nullable(),
  ms: MsId.nullable().optional(),
  edition: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  sourceIp: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
};

const EXAMPLE_ENTRY = {
  seq: 1042, occurredAt: '2026-09-29T03:15:00Z', actor: { handle: 'rina', displayName: 'Rina Kusuma', kind: 'user' }, action: 'applicability.transition',
  entityType: 'applicability_entry', entityId: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c', entityCode: 'A.8.13', ms: 'isms',
  before: { implementation_status: 'complete' }, after: { implementation_status: 'implemented' }, edition: 'ISO27001-2022 1.2.0', requestId: 'req-12345678',
  sourceIp: '172.31.250.10', userAgent: 'Mozilla/5.0',
} as const;

export const AuditEntry = named(
  'AuditEntry',
  z.object({ ...metaShape, entityCode: z.string().nullable(), before: z.unknown().optional(), after: z.unknown().optional() }),
  'Full audit entry with changed fields (audit_trail.read, F.11)',
  { valid: [EXAMPLE_ENTRY], invalid: [{ ...EXAMPLE_ENTRY, seq: 0 }, { ...EXAMPLE_ENTRY, actor: { handle: 'rina', displayName: 'Rina', kind: 'admin' } }] },
);
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditEntryMeta = named(
  'AuditEntryMeta',
  z.strictObject(metaShape),
  'Audit entry without before, after and entityCode (Tenant Admin view, audit_trail.metadata.read)',
  { valid: [{ seq: 1042, occurredAt: '2026-09-29T03:15:00Z', actor: { handle: 'rina', displayName: 'Rina Kusuma', kind: 'user' }, action: 'applicability.transition', entityType: 'applicability_entry', entityId: null }], invalid: [EXAMPLE_ENTRY] },
);
export type AuditEntryMeta = z.infer<typeof AuditEntryMeta>;

export const AuditTrailQuery = named(
  'AuditTrailQuery',
  z.strictObject({ ...pageQueryShape, ms: MsId.optional(), entityType: EntityTypeName.optional(), entityId: Uuid.optional(), from: IsoDate.optional(), to: IsoDate.optional() }),
  'GET /admin/audit-trail query: full entries of one system with audit_trail.read in ms, metadata of the organisation with audit_trail.metadata.read',
  { valid: [{}, { ms: 'isms', entityType: 'risk', from: '2026-09-01', to: '2026-09-30' }], invalid: [{ ms: 'ISMS' }, { action: 'x' }] },
);
export type AuditTrailQuery = z.infer<typeof AuditTrailQuery>;

export const AuditTrailExportQuery = named('AuditTrailExportQuery', z.strictObject({ ms: MsId, format: z.literal('csv') }), 'GET /admin/audit-trail/export query', {
  valid: [{ ms: 'isms', format: 'csv' }],
  invalid: [{ ms: 'isms', format: 'xlsx' }, { format: 'csv' }],
});
export type AuditTrailExportQuery = z.infer<typeof AuditTrailExportQuery>;

export const AuditAnchorsQuery = named('AuditAnchorsQuery', z.strictObject({ from: IsoDate.optional(), to: IsoDate.optional() }), 'GET /admin/audit-trail/anchors query', {
  valid: [{}, { from: '2026-09-01' }],
  invalid: [{ from: 'yesterday' }],
});
export type AuditAnchorsQuery = z.infer<typeof AuditAnchorsQuery>;

export const AuditAnchor = named(
  'AuditAnchor',
  z.object({ chain: z.string().min(1).max(80), seq: z.int().min(0), rowHash: z.string().regex(/^[0-9a-f]{64}$/), anchoredAt: Instant, keyId: KeyId, signature: Ed25519Signature }),
  'Signed anchor of a chain head; the signature covers the canonical JSON of the other fields (D-33, F.11)',
  { valid: [{ chain: 'org_ndt.audit_trail', seq: 1042, rowHash: 'ab'.repeat(32), anchoredAt: '2026-09-29T04:00:00Z', keyId: '0a1b2c3d4e5f6789', signature: 'ed25519:' + 'A'.repeat(86) + '==' }], invalid: [{ chain: 'x', seq: 1, rowHash: 'xyz', anchoredAt: '2026-09-29T04:00:00Z', keyId: 'k', signature: 's' }] },
);
export type AuditAnchor = z.infer<typeof AuditAnchor>;

export const AuditChainVerifyResult = named(
  'AuditChainVerifyResult',
  z.object({ chain: z.string(), checked: z.int().min(0), firstBrokenSeq: z.int().min(1).nullable().optional(), anchorOk: z.boolean() }),
  'Result of the chain verification query and the anchor comparison of one chain (F.11)',
  { valid: [{ chain: 'platform.audit_log', checked: 120, firstBrokenSeq: null, anchorOk: true }], invalid: [{ chain: 'x', checked: -1, anchorOk: true }] },
);
export type AuditChainVerifyResult = z.infer<typeof AuditChainVerifyResult>;

export const NdjsonText = named('NdjsonText', z.string(), 'Newline-delimited JSON (application/x-ndjson): one signed anchor per line', {
  valid: ['{"chain":"platform.audit_log","seq":1}\n'],
  invalid: [42],
});

const trail = { owner: 'WP-08' as const, auth: 'session' as const, method: 'GET' as const };

export const auditTrailListRoute = defineRoute({
  ...trail, id: 'audit-trail.list', path: '/api/v1/admin/audit-trail',
  summary: 'Audit entries: full entries of a system with audit_trail.read in ms, else metadata with audit_trail.metadata.read',
  anyOf: ['audit_trail.read', 'audit_trail.metadata.read'], scope: 'org', msSource: 'query',
  query: AuditTrailQuery, response: z.union([pageOf(AuditEntry), pageOf(AuditEntryMeta)]), errors: [404],
});
export const auditTrailExportRoute = defineRoute({
  ...trail, id: 'audit-trail.export', path: '/api/v1/admin/audit-trail/export', summary: 'Audit entries of a system as CSV, formula-neutralised (F.15)',
  permission: 'audit_trail.read', scope: 'ms', msSource: 'query', query: AuditTrailExportQuery, response: BinaryBody, responseType: 'text/csv', file: true, errors: [404],
});
export const auditTrailVerifyRoute = defineRoute({
  ...trail, id: 'audit-trail.verify', path: '/api/v1/admin/audit-trail/verify', summary: 'Verify the tenant and platform chains and their newest anchors',
  anyOf: ['audit_trail.read', 'audit_trail.metadata.read'], scope: 'org', response: z.array(AuditChainVerifyResult), errors: [],
});
export const auditTrailAnchorsRoute = defineRoute({
  ...trail, id: 'audit-trail.anchors', path: '/api/v1/admin/audit-trail/anchors', summary: 'Signed anchors as NDJSON, verifiable offline with the anchor public key',
  anyOf: ['audit_trail.read', 'audit_trail.metadata.read'], scope: 'org', query: AuditAnchorsQuery, response: NdjsonText, responseType: 'application/x-ndjson', errors: [],
});

export const routes: RouteDef[] = [auditTrailListRoute, auditTrailExportRoute, auditTrailVerifyRoute, auditTrailAnchorsRoute];
