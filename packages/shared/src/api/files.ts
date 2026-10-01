// Area `files` (owner from wave 8: WP-21): repository browse, upload intents, evidence files, document versions and
// storage object access (D.2, D.3, D.5, F.13). Files are served only through FileResponder.
import { z } from 'zod';
import { HashAlgorithm, ObjectKind, StorageAdapter, UploadMode } from '../enums.js';
import {
  BinaryBody, CommandResult, IdParams, Instant, IsoDate, MsId, MsRecordParams, NoBody, QueryBoolean, RepositorySlug, Uuid, defineRoute, hasControlCharacter, named,
} from './common.js';
import type { RouteDef } from './common.js';

/** Item id of a provider (Microsoft Graph `^[A-Za-z0-9!_-]+$`, Google Drive `^[A-Za-z0-9_-]+$`, D.5). */
export const ExternalItemId = named('ExternalItemId', z.string().regex(/^[A-Za-z0-9!_-]{1,300}$/), 'Provider item id (D.5 id patterns); the gateway checks the adapter pattern', {
  valid: ['01ABCDEF2GHIJKLMNOP!123', 'demo-sp-EV-0313', '1a2B3c_d-E'],
  invalid: ['../etc', 'a/b', 'id?x=1', ''],
});
export type ExternalItemId = z.infer<typeof ExternalItemId>;

/** File name of an upload: no path separators, no control characters. */
const FileName = z.string().min(1).max(255).regex(/^[^/\\]+$/).refine((n) => n !== '.' && n !== '..' && !hasControlCharacter(n), { message: 'Not a file name' });

export const RepositoryParams = named('RepositoryParams', z.strictObject({ slug: RepositorySlug }), 'Path parameter {slug} of a storage repository', {
  valid: [{ slug: 'sp' }],
  invalid: [{ slug: 'SP' }],
});
export type RepositoryParams = z.infer<typeof RepositoryParams>;

export const BrowseQuery = named(
  'BrowseQuery',
  z.strictObject({ ms: MsId, kind: ObjectKind, recordId: Uuid, path: z.string().max(1024).optional() }),
  'GET /storage/repositories/{slug}/browse query: the system, the kind and id of the record the file is for, and a folder below the system root',
  { valid: [{ ms: 'isms', kind: 'evidence', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }, { ms: 'isms', kind: 'document', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', path: 'Evidence/2026/Q3' }], invalid: [{ kind: 'evidence', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }, { ms: 'isms', kind: 'policy', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }] },
);
export type BrowseQuery = z.infer<typeof BrowseQuery>;

export const PickerListing = named(
  'PickerListing',
  z.object({
    path: z.string(),
    files: z.array(z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()])),
    refs: z.array(z.object({ repositoryId: RepositorySlug, externalItemId: ExternalItemId, externalVersionId: z.string().optional() })),
  }),
  'Files of a repository folder in the picker shape of UI 1.15: [name, date label, version, hash algorithm, modified by], with one ref per file (repositoryId is the repository slug)',
  {
    valid: [{ path: 'Compliance / ISMS / Evidence / 2026 / Q3', files: [['Backup-Job-Log-Sep-2026.xlsx', '28 Sep 2026', 'v3.0', 'quickXorHash', 'Bagus Prasetyo']], refs: [{ repositoryId: 'sp', externalItemId: 'demo-sp-picker-1', externalVersionId: '3.0' }] }],
    invalid: [{ path: 'x', files: [['a', 'b']], refs: [] }, { path: 'x', files: [], refs: [{ repositoryId: 'sp' }] }],
  },
);
export type PickerListing = z.infer<typeof PickerListing>;

export const UploadIntentRequest = named(
  'UploadIntentRequest',
  z.strictObject({ ms: MsId, kind: ObjectKind, recordId: Uuid, fileName: FileName, size: z.int().min(0) }),
  'POST /storage/upload-intents body; no content type: the gateway detects it (F.13)',
  { valid: [{ ms: 'qms', kind: 'evidence', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', fileName: 'Supplier-Evaluation-Q3.pdf', size: 482113 }], invalid: [{ ms: 'qms', kind: 'evidence', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', fileName: '../x.pdf', size: 1 }, { ms: 'qms', kind: 'evidence', recordId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', fileName: 'x.pdf', size: -1 }] },
);
export type UploadIntentRequest = z.infer<typeof UploadIntentRequest>;

const EXAMPLE_INTENT = {
  intentId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', mode: 'stored', repository: { slug: 'vault', name: 'Managed Vault', adapter: 'managed_vault' },
  contentUrl: '/api/v1/storage/upload-intents/5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e/content', maxBytes: 104857600, expiresAt: '2026-09-29T07:00:00Z',
  correlationCode: 'MSCD-EQ-0103-7F3A', folderPath: '/vault/QMS/Cl84',
} as const;

export const UploadIntent = named(
  'UploadIntent',
  z.object({
    intentId: Uuid,
    mode: UploadMode,
    repository: z.object({ slug: RepositorySlug, name: z.string(), adapter: StorageAdapter }),
    contentUrl: z.string().optional(),
    maxBytes: z.int().min(1),
    expiresAt: Instant,
    correlationCode: z.string(),
    folderPath: z.string(),
  }),
  'Where and how to upload: contentUrl for stored and pass-through modes; zero-transit uploads go to the provider directly (D.2)',
  { valid: [EXAMPLE_INTENT, { ...EXAMPLE_INTENT, mode: 'zero_transit', contentUrl: undefined, repository: { slug: 'gd', name: 'Google Shared Drive', adapter: 'google_drive' } }], invalid: [{ ...EXAMPLE_INTENT, mode: 'link' }, { ...EXAMPLE_INTENT, maxBytes: 0 }] },
);
export type UploadIntent = z.infer<typeof UploadIntent>;

export const UploadResult = named(
  'UploadResult',
  z.object({ storageObjectId: Uuid, hashAlgorithm: HashAlgorithm, hashValue: z.string().nullable(), sizeBytes: z.int().min(0), versionLabel: z.string() }),
  'Stored object of an upload (D.2)',
  { valid: [{ storageObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', hashAlgorithm: 'sha256', hashValue: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sizeBytes: 0, versionLabel: 'v4' }], invalid: [{ storageObjectId: 'x', hashAlgorithm: 'sha256', hashValue: null, sizeBytes: 0, versionLabel: 'v1' }] },
);
export type UploadResult = z.infer<typeof UploadResult>;

export const UploadCompleteRequest = named('UploadCompleteRequest', z.strictObject({ externalItemId: ExternalItemId }), 'POST /storage/upload-intents/{id}/complete body: the item the browser uploaded (zero-transit)', {
  valid: [{ externalItemId: '1a2B3c_d-E' }],
  invalid: [{}, { externalItemId: 'a/b' }],
});
export type UploadCompleteRequest = z.infer<typeof UploadCompleteRequest>;

const FileMode = z.enum(['submit', 'relink']);

export const EvidenceFileRequest = named(
  'EvidenceFileRequest',
  z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('link'), repository: RepositorySlug, externalItemId: ExternalItemId, producedAt: IsoDate, mode: FileMode }),
    z.strictObject({ source: z.literal('upload'), uploadIntentId: Uuid, producedAt: IsoDate, mode: FileMode }),
    z.strictObject({ source: z.literal('client_upload'), uploadIntentId: Uuid, producedAt: IsoDate, mode: FileMode }),
  ]),
  'POST /ms/{ms}/evidence/{id}/files body: link an existing item, or attach an upload (relink replaces an unverifiable file)',
  {
    valid: [{ source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', producedAt: '2026-09-29', mode: 'submit' }, { source: 'upload', uploadIntentId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', producedAt: '2026-09-29', mode: 'relink' }],
    invalid: [{ source: 'link', uploadIntentId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', producedAt: '2026-09-29', mode: 'submit' }, { source: 'email', producedAt: '2026-09-29', mode: 'submit' }],
  },
);
export type EvidenceFileRequest = z.infer<typeof EvidenceFileRequest>;

export const DocumentVersionRequest = named(
  'DocumentVersionRequest',
  z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('link'), repository: RepositorySlug, externalItemId: ExternalItemId }),
    z.strictObject({ source: z.literal('upload'), uploadIntentId: Uuid }),
  ]),
  'POST /ms/{ms}/documents/{id}/versions body: the new version goes to in_review (A.4 5.7)',
  { valid: [{ source: 'link', repository: 'sp', externalItemId: 'demo-sp-doc-1' }, { source: 'upload', uploadIntentId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e' }], invalid: [{ source: 'upload' }, { source: 'link', repository: 'sp' }] },
);
export type DocumentVersionRequest = z.infer<typeof DocumentVersionRequest>;

export const ObjectOpenQuery = named('ObjectOpenQuery', z.strictObject({ ms: MsId }), 'Query of storage object open: the system on whose behalf the file is opened', {
  valid: [{ ms: 'isms' }],
  invalid: [{}],
});
export type ObjectOpenQuery = z.infer<typeof ObjectOpenQuery>;

export const ObjectOpenResponse = named(
  'ObjectOpenResponse',
  z.object({ url: z.string().min(1), expiresAt: Instant }),
  'Short-lived URL to open a file: the content route (vault, pass-through) or the api redirect (link, zero-transit); never the provider URL',
  { valid: [{ url: '/api/v1/storage/objects/6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f/redirect?t=abc', expiresAt: '2026-09-29T06:05:00Z' }], invalid: [{ url: '' }] },
);
export type ObjectOpenResponse = z.infer<typeof ObjectOpenResponse>;

export const ObjectRedirectQuery = named('ObjectRedirectQuery', z.strictObject({ t: z.string().regex(/^[A-Za-z0-9_.-]{16,512}$/) }), 'Query of storage object redirect: the HMAC token (5 minutes) from open', {
  valid: [{ t: 'eyJ1IjoiYSJ9.c2lnbmF0dXJl' }],
  invalid: [{}, { t: 'short' }],
});
export type ObjectRedirectQuery = z.infer<typeof ObjectRedirectQuery>;

export const ObjectContentQuery = named('ObjectContentQuery', z.strictObject({ ms: MsId, inline: QueryBoolean.optional() }), 'Query of storage object content; inline only for PDF and raster images (F.13)', {
  valid: [{ ms: 'isms' }, { ms: 'isms', inline: 'true' }],
  invalid: [{ inline: 'true' }, { ms: 'isms', inline: 'yes' }],
});
export type ObjectContentQuery = z.infer<typeof ObjectContentQuery>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

/** D.3: `evidence.file.submit` or `document.version.create` (own), both in the system of the request. */
const submitFileChecks = [
  { permission: 'evidence.file.submit', scope: 'ms' },
  { permission: 'document.version.create', scope: 'ms' },
] as const;

export const storageBrowseRoute = defineRoute({
  id: 'storage.browse',
  owner: 'WP-21',
  method: 'GET',
  path: '/api/v1/storage/repositories/:slug/browse',
  summary: "Files below the system's root folder of a repository, for the record the user may submit to (BR-29)",
  auth: 'session',
  anyOf: submitFileChecks,
  msSource: 'query',
  params: RepositoryParams,
  query: BrowseQuery,
  response: PickerListing,
  errors: [404, 422],
});

export const uploadIntentsCreateRoute = defineRoute({
  id: 'storage.upload-intents.create',
  owner: 'WP-21',
  method: 'POST',
  path: '/api/v1/storage/upload-intents',
  summary: 'Prepare an upload: repository and mode from the routing rules, stored name, size limit, correlation code',
  auth: 'session',
  anyOf: submitFileChecks,
  msSource: 'body',
  body: UploadIntentRequest,
  response: UploadIntent,
  status: 201,
  errors: [413, 422, 429],
  idempotent: true,
  rateLimits: [{ key: 'user', max: 60, windowSeconds: 3600 }],
});

export const uploadIntentsContentRoute = defineRoute({
  id: 'storage.upload-intents.content',
  owner: 'WP-21',
  method: 'PUT',
  path: '/api/v1/storage/upload-intents/:id/content',
  summary: 'Stream the file of an open intent to the gateway (creator of the intent only)',
  auth: 'session',
  params: IdParams,
  body: BinaryBody,
  requestType: 'application/octet-stream',
  response: UploadResult,
  errors: [404, 409, 413, 422],
});

export const uploadIntentsCompleteRoute = defineRoute({
  id: 'storage.upload-intents.complete',
  owner: 'WP-21',
  method: 'POST',
  path: '/api/v1/storage/upload-intents/:id/complete',
  summary: 'Register a zero-transit upload: the item must be under the system root, newer than the intent, by the same account and carry the correlation code',
  auth: 'session',
  params: IdParams,
  body: UploadCompleteRequest,
  response: UploadResult,
  errors: [404, 409, 422],
});

export const evidenceFilesRoute = defineRoute({
  id: 'evidence.files',
  owner: 'WP-21',
  method: 'POST',
  path: '/api/v1/ms/:ms/evidence/:id/files',
  summary: 'Attach a linked or uploaded file to evidence (BR-29; warnings BR-23, BR-30, BR-36)',
  auth: 'session',
  permission: 'evidence.file.submit',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: EvidenceFileRequest,
  response: CommandResult,
  errors: [404, 409, 422],
  idempotent: true,
});

export const documentVersionsRoute = defineRoute({
  id: 'documents.versions',
  owner: 'WP-21',
  method: 'POST',
  path: '/api/v1/ms/:ms/documents/:id/versions',
  summary: 'Add a document version from a linked or uploaded file; the document goes to in_review',
  auth: 'session',
  permission: 'document.version.create',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: DocumentVersionRequest,
  response: CommandResult,
  errors: [404, 409, 422],
  idempotent: true,
});

export const storageObjectOpenRoute = defineRoute({
  id: 'storage.objects.open',
  owner: 'WP-21',
  method: 'GET',
  path: '/api/v1/storage/objects/:id/open',
  summary: 'Short-lived URL to open a file the user may read (external auditors: pack copies only; BR-35)',
  auth: 'session',
  permission: 'storage.object.read',
  scope: 'ms',
  msSource: 'query',
  params: IdParams,
  query: ObjectOpenQuery,
  response: ObjectOpenResponse,
  errors: [404, 422],
});

export const storageObjectRedirectRoute = defineRoute({
  id: 'storage.objects.redirect',
  owner: 'WP-21',
  method: 'GET',
  path: '/api/v1/storage/objects/:id/redirect',
  summary: 'Redirect to the provider URL after re-checking the token and the permission (never for external auditors)',
  auth: 'session',
  params: IdParams,
  query: ObjectRedirectQuery,
  response: NoBody,
  status: 302,
  errors: [404],
});

export const storageObjectContentRoute = defineRoute({
  id: 'storage.objects.content',
  owner: 'WP-21',
  method: 'GET',
  path: '/api/v1/storage/objects/:id/content',
  summary: 'File bytes of a Managed Vault or pass-through object through FileResponder (F.13)',
  auth: 'session',
  permission: 'storage.object.read',
  scope: 'ms',
  msSource: 'query',
  params: IdParams,
  query: ObjectContentQuery,
  response: BinaryBody,
  responseType: 'application/octet-stream',
  file: true,
  errors: [404, 422],
});

export const routes: RouteDef[] = [
  storageBrowseRoute, uploadIntentsCreateRoute, uploadIntentsContentRoute, uploadIntentsCompleteRoute, evidenceFilesRoute,
  documentVersionsRoute, storageObjectOpenRoute, storageObjectRedirectRoute, storageObjectContentRoute,
];
