// Area `evidence-packs` (owner from wave 10: WP-26): evidence pack build, list and downloads (D.2, D.3, E.7, D-34).
import { z } from 'zod';
import { EvidencePackStatus, HashAlgorithm, LinkStatus } from '../enums.js';
import { BinaryBody, CommandResult, Instant, IsoDate, MsParams, MsRecordParams, Uuid, defineRoute, named, pageOf, pageQueryShape } from './common.js';
import type { RouteDef } from './common.js';

export const EvidencePackRequest = named(
  'EvidencePackRequest',
  z.strictObject({
    auditEventId: Uuid.optional(),
    scope: z.strictObject({ clauses: z.array(z.string().min(1).max(20)).optional(), codes: z.array(z.string().min(1).max(30)).optional() }).optional(),
  }),
  'POST /ms/{ms}/evidence-packs body: the audit event and an optional scope by clause or code (default all)',
  { valid: [{}, { auditEventId: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', scope: { clauses: ['8'], codes: ['A.8.13'] } }], invalid: [{ scope: { controls: ['A.8'] } }, { auditEventId: 'next' }] },
);
export type EvidencePackRequest = z.infer<typeof EvidencePackRequest>;

const EXAMPLE_ITEM = {
  evidenceCode: 'EV-0313', requirementCodes: ['A.8.13'], producedAt: '2026-05-31', externalVersionId: '3.0', hashAlgorithm: 'quickxor',
  hashValue: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', linkStatus: 'missing', copyLocation: null, deleted: false, exceptionReason: 'File missing at the pinned location',
} as const;

export const EvidencePackItem = named(
  'EvidencePackItem',
  z.object({
    evidenceCode: z.string(), requirementCodes: z.array(z.string()), producedAt: IsoDate.nullable(), externalVersionId: z.string().nullable(),
    hashAlgorithm: HashAlgorithm.nullable(), hashValue: z.string().nullable(), linkStatus: LinkStatus.nullable(), copyLocation: z.string().nullable(),
    deleted: z.boolean(), exceptionReason: z.string().nullable(), copyObjectId: Uuid.optional(),
  }),
  'One manifest row of an evidence pack (E.7 step 4); external auditors open only copyObjectId (D-34)',
  { valid: [EXAMPLE_ITEM, { ...EXAMPLE_ITEM, linkStatus: 'intact', copyLocation: 'Compliance/_packs/ISMS/Surveillance 1/x.xlsx', exceptionReason: null, copyObjectId: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' }], invalid: [{ ...EXAMPLE_ITEM, linkStatus: 'ok' }] },
);
export type EvidencePackItem = z.infer<typeof EvidencePackItem>;

export const EvidencePackView = named(
  'EvidencePackView',
  z.object({
    id: Uuid, status: EvidencePackStatus, auditEventId: Uuid.nullable(), packFolder: z.string().nullable(), itemCount: z.int().min(0), exceptionCount: z.int().min(0),
    manifestUrls: z.object({ pdf: z.string(), csv: z.string() }), archiveUrl: z.string().optional(), builtAt: Instant.nullable(), items: z.array(EvidencePackItem),
  }),
  'Evidence pack with its manifests (D.2)',
  {
    valid: [{ id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', status: 'ready', auditEventId: null, packFolder: '/Compliance/_packs/ISMS/Surveillance 1/', itemCount: 79, exceptionCount: 3, manifestUrls: { pdf: '/api/v1/ms/isms/evidence-packs/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e/download?file=manifest_pdf', csv: '/api/v1/ms/isms/evidence-packs/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e/download?file=manifest_csv' }, builtAt: '2026-09-29T03:00:00Z', items: [EXAMPLE_ITEM] }],
    invalid: [{ id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', status: 'done' }],
  },
);
export type EvidencePackView = z.infer<typeof EvidencePackView>;

export const EvidencePackListQuery = named('EvidencePackListQuery', z.strictObject(pageQueryShape), 'GET /ms/{ms}/evidence-packs query', {
  valid: [{}, { page: '2' }],
  invalid: [{ status: 'ready' }],
});

export const EvidencePackDownloadQuery = named('EvidencePackDownloadQuery', z.strictObject({ file: z.enum(['manifest_pdf', 'manifest_csv', 'archive']) }), 'Which file of the pack to download', {
  valid: [{ file: 'manifest_csv' }],
  invalid: [{ file: 'zip' }, {}],
});
export type EvidencePackDownloadQuery = z.infer<typeof EvidencePackDownloadQuery>;

export const evidencePacksBuildRoute = defineRoute({
  id: 'evidence-packs.build',
  owner: 'WP-26',
  method: 'POST',
  path: '/api/v1/ms/:ms/evidence-packs',
  summary: 'Build an evidence pack (queues evidence-pack.build; message names the repository)',
  auth: 'session',
  permission: 'evidence_pack.build',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: EvidencePackRequest,
  response: CommandResult,
  status: 202,
  errors: [404, 422, 429],
  idempotent: true,
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});

export const evidencePacksListRoute = defineRoute({
  id: 'evidence-packs.list',
  owner: 'WP-26',
  method: 'GET',
  path: '/api/v1/ms/:ms/evidence-packs',
  summary: 'Evidence packs of the system (external auditors: ready packs of their system)',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  query: EvidencePackListQuery,
  response: pageOf(EvidencePackView),
  errors: [404],
});

export const evidencePacksGetRoute = defineRoute({
  id: 'evidence-packs.get',
  owner: 'WP-26',
  method: 'GET',
  path: '/api/v1/ms/:ms/evidence-packs/:id',
  summary: 'One evidence pack with its items',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  response: EvidencePackView,
  errors: [404],
});

export const evidencePacksDownloadRoute = defineRoute({
  id: 'evidence-packs.download',
  owner: 'WP-26',
  method: 'GET',
  path: '/api/v1/ms/:ms/evidence-packs/:id/download',
  summary: 'Download a manifest or the archive of a pack as an attachment (audited evidence_pack.downloaded)',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  query: EvidencePackDownloadQuery,
  response: BinaryBody,
  responseType: 'application/octet-stream',
  file: true,
  errors: [404, 409],
});

export const routes: RouteDef[] = [evidencePacksBuildRoute, evidencePacksListRoute, evidencePacksGetRoute, evidencePacksDownloadRoute];
