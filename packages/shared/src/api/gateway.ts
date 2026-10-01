// Area `gateway` (owner from wave 5: WP-13): the storage gateway protocol of D.5. Base URL
// https://storage-gateway:8443; every call carries the gateway bearer token and, in mtls mode, a client certificate.
// The gateway keeps no state besides a short cache of unwrapped data keys.
import { z } from 'zod';
import {
  ConnectionStatus, CredentialKind, HashAlgorithm, HashSource, OwnershipType, StorageAdapter, StorageMode,
} from '../enums.js';
import { BinaryBody, Instant, Messages, RepositorySlug, Uuid, defineRoute, named } from './common.js';
import type { GatewayProblemSlug } from '../enums.js';
import type { RouteDef } from './common.js';

/** HTTP status of every gateway problem slug (D.5). */
export const GATEWAY_PROBLEM_STATUS: Readonly<Record<GatewayProblemSlug, number>> = {
  'bad-request': 400,
  'forbidden': 403,
  'outside-root': 403,
  'not-found': 404,
  'too-large': 413,
  'unsupported': 422,
  'rate-limited': 429,
  'internal': 500,
  'unreachable': 502,
};

const TENANT = { orgId: '00000000-0000-4000-8000-00000000a001', wrappedDek: 'v1.1a2b3c4d.aXY.Y2lwaGVydGV4dA' } as const;
const REPOSITORY = {
  id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', slug: 'sp', adapter: 'm365', modes: ['link', 'pass_through'],
  config: { siteId: 's', driveId: 'drive-sp-compliance', rootFolderId: 'root-compliance', roots: {} },
  credential: { ref: 'cred-sp', sealedBlob: 'v1.9f8e7d6c.aXY.c2VhbGVk', kind: 'm365_certificate' },
} as const;
const SCOPE_ROOT = { folderId: 'f-isms', path: 'Compliance/ISMS' } as const;
const OBJECT = { externalItemId: 'demo-sp-EV-0313', externalVersionId: '3.0', hashAlgorithm: 'quickxor', hashValue: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', hashSource: 'provider', folderPath: 'Compliance/ISMS/Evidence/2026/Q3' } as const;
const METADATA = {
  externalItemId: 'demo-sp-EV-0313', externalVersionId: '3.0', versionLabel: 'v3.0', name: 'Backup-Job-Log-Q3.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 48211, hashAlgorithm: 'quickxor',
  hashValue: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', hashSource: 'provider', providerCreatedAt: '2026-07-01T02:00:00Z', providerModifiedAt: '2026-09-28T02:00:00Z',
  modifiedBy: 'Bagus Prasetyo', createdByEmail: 'bagus.prasetyo@nusantaradigital.co.id', folderPath: 'Compliance/ISMS/Evidence/2026/Q3', folderId: 'f-q3',
  webUrl: 'https://contoso.sharepoint.com/sites/compliance/x',
} as const;

export const GatewayTenant = named('GatewayTenant', z.strictObject({ orgId: Uuid, wrappedDek: z.string().min(1) }), 'Tenant of a gateway call: organisation id and its wrapped data key (unwrapped with AAD dek:<orgId>)', {
  valid: [TENANT],
  invalid: [{ orgId: 'ndt', wrappedDek: 'x' }, { orgId: TENANT.orgId }],
});
export type GatewayTenant = z.infer<typeof GatewayTenant>;

export const GatewayRepository = named(
  'GatewayRepository',
  z.strictObject({
    id: Uuid, slug: RepositorySlug, adapter: StorageAdapter, modes: z.array(StorageMode).min(1), config: z.record(z.string(), z.unknown()),
    credential: z.strictObject({ ref: z.string().min(1).max(200), sealedBlob: z.string().min(1), kind: CredentialKind }).optional(),
  }),
  'Repository descriptor of a gateway call; the credential binding is recomputed from id and config on every call (D-08)',
  { valid: [REPOSITORY, { ...REPOSITORY, credential: undefined }], invalid: [{ ...REPOSITORY, adapter: 'dropbox' }, { ...REPOSITORY, modes: [] }] },
);
export type GatewayRepository = z.infer<typeof GatewayRepository>;

export const ScopeRoot = named('ScopeRoot', z.strictObject({ folderId: z.string().min(1).nullable(), path: z.string() }), "The system's root folder of the repository (config.roots[<ms>]), chosen by the api", {
  valid: [SCOPE_ROOT, { folderId: null, path: 'QMS' }],
  invalid: [{ path: 'x' }, { folderId: '', path: 'x' }],
});
export type ScopeRoot = z.infer<typeof ScopeRoot>;

export const GatewayObjectRef = named(
  'GatewayObjectRef',
  z.strictObject({
    externalItemId: z.string().min(1).max(300), externalVersionId: z.string().nullable(), hashAlgorithm: HashAlgorithm, hashValue: z.string().nullable(),
    hashSource: HashSource, folderPath: z.string().nullable(),
  }),
  'Stored facts of a storage object that a gateway call compares with the provider',
  { valid: [OBJECT], invalid: [{ ...OBJECT, hashAlgorithm: 'crc32' }] },
);
export type GatewayObjectRef = z.infer<typeof GatewayObjectRef>;

export const ObjectMetadata = named(
  'ObjectMetadata',
  z.object({
    externalItemId: z.string(), externalVersionId: z.string().nullable(), versionLabel: z.string().nullable(), name: z.string(), mimeType: z.string().nullable(),
    detectedMimeType: z.string().optional(), sizeBytes: z.int().min(0).nullable(), hashAlgorithm: HashAlgorithm, hashValue: z.string().nullable(),
    hashSource: HashSource, providerCreatedAt: Instant.nullable(), providerModifiedAt: Instant.nullable(), modifiedBy: z.string().nullable(),
    createdByEmail: z.string().optional(), folderPath: z.string().nullable(), folderId: z.string().nullable(), webUrl: z.string().nullable(),
  }),
  'Metadata of a provider item (D.5 ObjectMetadata); mimeType is provider-reported, detectedMimeType comes from the first bytes',
  { valid: [METADATA], invalid: [{ ...METADATA, hashSource: 'guess' }, { ...METADATA, name: undefined }] },
);
export type ObjectMetadata = z.infer<typeof ObjectMetadata>;

export const DataKeyRequest = named('DataKeyRequest', z.strictObject({ orgId: Uuid }), 'POST /v1/keys/data-key body', { valid: [{ orgId: TENANT.orgId }], invalid: [{}] });
export const DataKeyResponse = named('DataKeyResponse', z.object({ wrappedDek: z.string().min(1), kekId: z.string().regex(/^[0-9a-f]{8}$/) }), 'A new tenant data key wrapped by storage.key', {
  valid: [{ wrappedDek: 'v1.1a2b3c4d.aXY.Y2lwaGVydGV4dA', kekId: '1a2b3c4d' }],
  invalid: [{ wrappedDek: 'x', kekId: 'KEK' }],
});

export const SealCredentialRequest = named(
  'SealCredentialRequest',
  z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository, kind: CredentialKind, secret: z.record(z.string(), z.unknown()) }),
  'POST /v1/credentials/seal body: seal a secret with AAD cred:<orgId>:<repositoryId>:<config sha256> (D-08)',
  { valid: [{ tenant: TENANT, repository: REPOSITORY, kind: 'google_service_account', secret: { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem: '-----BEGIN PRIVATE KEY-----' } }], invalid: [{ tenant: TENANT, repository: REPOSITORY, kind: 'password', secret: {} }] },
);
export const SealedCredential = named(
  'SealedCredential',
  z.object({ sealedBlob: z.string().min(1), keyId: z.string().min(1), configSha256: z.string().regex(/^[0-9a-f]{64}$/), externalAccount: z.string().optional() }),
  'A sealed credential and the config hash it is bound to',
  { valid: [{ sealedBlob: 'v1.9f8e7d6c.aXY.c2VhbGVk', keyId: '9f8e7d6c', configSha256: 'ab'.repeat(32) }], invalid: [{ sealedBlob: 'x', keyId: 'k', configSha256: 'abc' }] },
);
export const OAuthExchangeRequest = named(
  'OAuthExchangeRequest',
  z.strictObject({
    tenant: GatewayTenant, repository: GatewayRepository, credential: z.strictObject({ ref: z.string(), sealedBlob: z.string(), kind: z.literal('oauth_refresh_token') }),
    code: z.string().min(1).max(4096), redirectUri: z.url(), codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  'POST /v1/credentials/oauth-exchange body: the gateway exchanges the code, checks drive and root access, then seals the refresh token',
  { valid: [{ tenant: TENANT, repository: REPOSITORY, credential: { ref: 'cred-gd', sealedBlob: 'v1.x.y.z', kind: 'oauth_refresh_token' }, code: '4/0Ab', redirectUri: 'https://mscd.example.internal/api/v1/admin/storage/repositories/oauth/callback', codeVerifier: 'a'.repeat(43) }], invalid: [{ tenant: TENANT, repository: REPOSITORY, code: '4/0Ab' }] },
);
export const TestConnectionRequest = named('TestConnectionRequest', z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository }), 'POST /v1/test-connection body', {
  valid: [{ tenant: TENANT, repository: REPOSITORY }],
  invalid: [{ tenant: TENANT }],
});
export const TestConnectionResponse = named(
  'TestConnectionResponse',
  z.object({ status: ConnectionStatus, permissions: z.array(z.string()), ownership: OwnershipType, message: Messages, latencyMs: z.int().min(0), credentialExpiresAt: Instant.optional() }),
  'Result of a connection test (TS 5.7)',
  { valid: [{ status: 'ok', permissions: ['read', 'write'], ownership: 'organizational', message: { en: 'Connected', id: 'Terhubung' }, latencyMs: 120 }], invalid: [{ status: 'ok', permissions: [], ownership: 'shared', message: { en: 'x', id: 'x' }, latencyMs: 1 }] },
);
export const ListRequest = named(
  'ListRequest',
  z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository, scopeRoot: ScopeRoot, folderPath: z.string().max(1024).optional(), pageToken: z.string().max(2048).optional() }),
  'POST /v1/list body: items below the scope root',
  { valid: [{ tenant: TENANT, repository: REPOSITORY, scopeRoot: SCOPE_ROOT, folderPath: 'Evidence/2026/Q3' }], invalid: [{ tenant: TENANT, repository: REPOSITORY }] },
);
export const ListResponse = named('ListResponse', z.object({ path: z.string(), items: z.array(ObjectMetadata), nextPageToken: z.string().optional() }), 'One page of a folder listing', {
  valid: [{ path: 'Compliance/ISMS/Evidence/2026/Q3', items: [METADATA] }],
  invalid: [{ items: [] }],
});
export const EnsureFolderRequest = named('EnsureFolderRequest', z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository, path: z.string().min(1).max(1024) }), 'POST /v1/ensure-folder body', {
  valid: [{ tenant: TENANT, repository: REPOSITORY, path: 'Compliance/_packs/ISMS/Surveillance 1' }],
  invalid: [{ tenant: TENANT, repository: REPOSITORY, path: '' }],
});
export const EnsureFolderResponse = named('EnsureFolderResponse', z.object({ folderId: z.string(), path: z.string() }), 'Created or existing folder', {
  valid: [{ folderId: 'f-pack', path: 'Compliance/_packs/ISMS/Surveillance 1' }],
  invalid: [{ path: 'x' }],
});

export const PutHeader = named(
  'PutHeader',
  z.strictObject({
    tenant: GatewayTenant, repository: GatewayRepository, scopeRoot: ScopeRoot, folderPath: z.string().max(1024), fileName: z.string().min(1).max(255),
    maxBytes: z.int().min(1), metadataMinimization: z.boolean(),
  }),
  'Decoded X-MSCD-Put header of PUT /v1/objects (base64 JSON)',
  { valid: [{ tenant: TENANT, repository: REPOSITORY, scopeRoot: SCOPE_ROOT, folderPath: 'Evidence/2026/Q3', fileName: 'EV-0313-4.xlsx', maxBytes: 104857600, metadataMinimization: true }], invalid: [{ tenant: TENANT, repository: REPOSITORY, scopeRoot: SCOPE_ROOT, folderPath: 'x', fileName: '', maxBytes: 1, metadataMinimization: true }] },
);
export type PutHeader = z.infer<typeof PutHeader>;

export const PutHeaders = named('PutHeaders', z.looseObject({ 'x-mscd-put': z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(65536) }), 'Request headers of PUT /v1/objects', {
  valid: [{ 'x-mscd-put': 'eyJ0ZW5hbnQiOnt9fQ==', 'content-type': 'application/octet-stream' }],
  invalid: [{}, { 'x-mscd-put': '{json}' }],
});

export const PutResult = named(
  'PutResult',
  z.object({
    externalItemId: z.string(), externalVersionId: z.string().nullable(), versionLabel: z.string(), hashAlgorithm: z.literal('sha256'), hashValue: z.string().regex(/^[0-9a-f]{64}$/),
    hashSource: z.literal('computed'), sizeBytes: z.int().min(0), detectedMimeType: z.string(), providerCreatedAt: Instant.nullable(), webUrl: z.string().optional(),
    folderPath: z.string(), encryption: z.record(z.string(), z.unknown()).optional(),
  }),
  'Stored object of a streamed upload; SHA-256 computed while streaming (D.5)',
  { valid: [{ externalItemId: 'tenants/00000000-0000-4000-8000-00000000a001/6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', externalVersionId: null, versionLabel: 'v4', hashAlgorithm: 'sha256', hashValue: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', hashSource: 'computed', sizeBytes: 0, detectedMimeType: 'application/pdf', providerCreatedAt: null, folderPath: '/vault/QMS/Cl84' }], invalid: [{ externalItemId: 'x', hashAlgorithm: 'md5' }] },
);
export type PutResult = z.infer<typeof PutResult>;

export const LinkRequest = named('LinkRequest', z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository, scopeRoot: ScopeRoot, externalItemId: z.string().min(1).max(300) }), 'POST /v1/link body: pin the current version of an item below the scope root', {
  valid: [{ tenant: TENANT, repository: REPOSITORY, scopeRoot: SCOPE_ROOT, externalItemId: 'demo-sp-picker-1' }],
  invalid: [{ tenant: TENANT, repository: REPOSITORY, externalItemId: 'x' }],
});
export const RegisterClientUploadRequest = named(
  'RegisterClientUploadRequest',
  z.strictObject({
    tenant: GatewayTenant, repository: GatewayRepository, scopeRoot: ScopeRoot, externalItemId: z.string().min(1).max(300),
    intent: z.strictObject({ folderPath: z.string(), notBefore: Instant, correlationCode: z.string().min(1).max(40), creatorEmail: z.email() }),
  }),
  'POST /v1/register-client-upload body: zero-transit item checks (folder, creation time, creator, correlation code)',
  { valid: [{ tenant: TENANT, repository: REPOSITORY, scopeRoot: SCOPE_ROOT, externalItemId: '1a2B3c', intent: { folderPath: 'Compliance/BCMS', notBefore: '2026-09-29T06:00:00Z', correlationCode: 'MSCD-EB-0101-7F3A', creatorEmail: 'tono.hartono@nusantaradigital.co.id' } }], invalid: [{ tenant: TENANT, repository: REPOSITORY, scopeRoot: SCOPE_ROOT, externalItemId: '1a2B3c', intent: {} }] },
);
export const ObjectRequest = named('ObjectRequest', z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository, object: GatewayObjectRef }), 'Body of the gateway calls that act on one stored object (stat, pin-version, open-url, stream, rehash)', {
  valid: [{ tenant: TENANT, repository: REPOSITORY, object: OBJECT }],
  invalid: [{ tenant: TENANT, repository: REPOSITORY }],
});
export const StatResult = named(
  'StatResult',
  z.object({
    outcome: z.enum(['found', 'not_found', 'forbidden', 'unreachable', 'rate_limited']), detail: z.literal('credential_invalid').optional(), current: ObjectMetadata.optional(),
    pinnedVersionAvailable: z.boolean(), pinnedHash: z.string().optional(), folderPath: z.string().optional(), retryAfterSeconds: z.int().min(0).optional(),
  }),
  'Provider state of a stored object for the link health check (E.4)',
  { valid: [{ outcome: 'found', current: METADATA, pinnedVersionAvailable: true, folderPath: 'Compliance/ISMS/Evidence/2026/Q3' }, { outcome: 'unreachable', detail: 'credential_invalid', pinnedVersionAvailable: false }], invalid: [{ outcome: 'error', pinnedVersionAvailable: false }] },
);
export type StatResult = z.infer<typeof StatResult>;
export const PinVersionResult = named('PinVersionResult', z.object({ result: z.enum(['ok', 'unsupported']) }), 'Result of a version pin (Google Drive keepForever)', {
  valid: [{ result: 'unsupported' }],
  invalid: [{ result: 'failed' }],
});
export const OpenUrlResult = named('OpenUrlResult', z.object({ url: z.string().min(1) }), 'Provider URL of an item; the api never returns it directly', {
  valid: [{ url: 'https://contoso.sharepoint.com/sites/compliance/x' }],
  invalid: [{}],
});
export const CopyWithinRequest = named(
  'CopyWithinRequest',
  z.strictObject({ tenant: GatewayTenant, repository: GatewayRepository, objects: z.array(GatewayObjectRef).min(1), targetFolderPath: z.string().min(1).max(1024) }),
  'POST /v1/copy-within body: copy items into the evidence pack folder of the same repository (E.7)',
  { valid: [{ tenant: TENANT, repository: REPOSITORY, objects: [OBJECT], targetFolderPath: 'Compliance/_packs/ISMS/Surveillance 1' }], invalid: [{ tenant: TENANT, repository: REPOSITORY, objects: [], targetFolderPath: 'x' }] },
);
export const CopyWithinResult = named('CopyWithinResult', z.object({ items: z.array(z.object({ externalItemId: z.string(), newItemId: z.string(), location: z.string() })) }), 'Copies made by copy-within', {
  valid: [{ items: [{ externalItemId: 'demo-sp-EV-0313', newItemId: 'copy-1', location: 'Compliance/_packs/ISMS/Surveillance 1/Backup-Job-Log-Q3.xlsx' }] }],
  invalid: [{ items: [{ newItemId: 'x' }] }],
});
export const RehashResult = named('RehashResult', z.object({ hashValue: z.string().regex(/^[0-9a-f]{64}$/), matches: z.boolean() }), 'Result of a Managed Vault re-hash (A-08)', {
  valid: [{ hashValue: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', matches: true }],
  invalid: [{ hashValue: 'x', matches: true }],
});
export const AnchorWriteRequest = named(
  'AnchorWriteRequest',
  z.strictObject({ tenant: z.null(), objectKey: z.string().regex(/^audit-anchors\/[A-Za-z0-9._/-]+\.json$/), body: z.record(z.string(), z.unknown()) }),
  'POST /v1/anchors body (worker only): write a signed audit anchor under audit-anchors/ (D-33, F.11)',
  { valid: [{ tenant: null, objectKey: 'audit-anchors/platform/2026-09-29.json', body: { chain: 'platform', seq: 120 } }], invalid: [{ tenant: null, objectKey: '../x.json', body: {} }, { tenant: {}, objectKey: 'audit-anchors/x.json', body: {} }] },
);
export const AnchorWriteResult = named('AnchorWriteResult', z.object({ location: z.string().min(1) }), 'Where the anchor file was written', {
  valid: [{ location: 's3://mscd-vault/audit-anchors/platform/2026-09-29.json' }],
  invalid: [{}],
});

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const gw = { owner: 'WP-13' as const, auth: 'gateway' as const, method: 'POST' as const };
const REPO_ERRORS = [404, 422, 429, 502] as const;

export const gatewayDataKeyRoute = defineRoute({ ...gw, id: 'gateway.keys.data-key', path: '/v1/keys/data-key', summary: 'Issue a tenant data key wrapped by storage.key', body: DataKeyRequest, response: DataKeyResponse, errors: [] });
export const gatewaySealRoute = defineRoute({ ...gw, id: 'gateway.credentials.seal', path: '/v1/credentials/seal', summary: 'Seal a repository credential bound to organisation, repository and config', body: SealCredentialRequest, response: SealedCredential, errors: [422] });
export const gatewayOauthExchangeRoute = defineRoute({ ...gw, id: 'gateway.credentials.oauth-exchange', path: '/v1/credentials/oauth-exchange', summary: 'Exchange an OAuth code and seal the refresh token (google_drive)', body: OAuthExchangeRequest, response: SealedCredential, errors: [...REPO_ERRORS] });
export const gatewayTestConnectionRoute = defineRoute({ ...gw, id: 'gateway.test-connection', path: '/v1/test-connection', summary: 'Test the connection and permissions of a repository', body: TestConnectionRequest, response: TestConnectionResponse, errors: [...REPO_ERRORS] });
export const gatewayListRoute = defineRoute({ ...gw, id: 'gateway.list', path: '/v1/list', summary: 'List a folder below the scope root', body: ListRequest, response: ListResponse, errors: [...REPO_ERRORS] });
export const gatewayEnsureFolderRoute = defineRoute({ ...gw, id: 'gateway.ensure-folder', path: '/v1/ensure-folder', summary: 'Create a folder when it does not exist', body: EnsureFolderRequest, response: EnsureFolderResponse, errors: [...REPO_ERRORS] });
export const gatewayPutObjectRoute = defineRoute({
  ...gw, id: 'gateway.objects.put', method: 'PUT', path: '/v1/objects', summary: 'Stream a file into the vault or a pass-through repository (type detected from the first bytes)',
  headers: PutHeaders, body: BinaryBody, requestType: 'application/octet-stream', response: PutResult, errors: [...REPO_ERRORS, 413],
});
export const gatewayLinkRoute = defineRoute({ ...gw, id: 'gateway.link', path: '/v1/link', summary: 'Link an existing item and pin its current version (m365, google_drive)', body: LinkRequest, response: ObjectMetadata, errors: [...REPO_ERRORS] });
export const gatewayRegisterClientUploadRoute = defineRoute({ ...gw, id: 'gateway.register-client-upload', path: '/v1/register-client-upload', summary: 'Register a zero-transit upload after the creator and correlation checks', body: RegisterClientUploadRequest, response: ObjectMetadata, errors: [...REPO_ERRORS] });
export const gatewayStatRoute = defineRoute({ ...gw, id: 'gateway.stat', path: '/v1/stat', summary: 'Provider state of a stored object for the link health check', body: ObjectRequest, response: StatResult, errors: [...REPO_ERRORS] });
export const gatewayPinVersionRoute = defineRoute({ ...gw, id: 'gateway.pin-version', path: '/v1/pin-version', summary: 'Keep the pinned revision (google_drive keepForever)', body: ObjectRequest, response: PinVersionResult, errors: [...REPO_ERRORS] });
export const gatewayOpenUrlRoute = defineRoute({ ...gw, id: 'gateway.open-url', path: '/v1/open-url', summary: 'Provider URL of an item (m365, google_drive; 422 for the vault)', body: ObjectRequest, response: OpenUrlResult, errors: [...REPO_ERRORS] });
export const gatewayStreamRoute = defineRoute({
  ...gw, id: 'gateway.stream', path: '/v1/stream', summary: 'Decrypted bytes of a vault or pass-through object, with X-MSCD-Detected-Type',
  body: ObjectRequest, response: BinaryBody, responseType: 'application/octet-stream', errors: [...REPO_ERRORS],
});
export const gatewayCopyWithinRoute = defineRoute({ ...gw, id: 'gateway.copy-within', path: '/v1/copy-within', summary: 'Copy items into a folder of the same repository (evidence packs)', body: CopyWithinRequest, response: CopyWithinResult, errors: [...REPO_ERRORS] });
export const gatewayRehashRoute = defineRoute({ ...gw, id: 'gateway.rehash', path: '/v1/rehash', summary: 'Recompute the SHA-256 of a vault object', body: ObjectRequest, response: RehashResult, errors: [...REPO_ERRORS] });
export const gatewayAnchorsRoute = defineRoute({ ...gw, id: 'gateway.anchors', path: '/v1/anchors', summary: 'Write a signed audit anchor to the vault bucket (worker certificate only)', body: AnchorWriteRequest, response: AnchorWriteResult, errors: [422, 502] });

export const routes: RouteDef[] = [
  gatewayDataKeyRoute, gatewaySealRoute, gatewayOauthExchangeRoute, gatewayTestConnectionRoute, gatewayListRoute, gatewayEnsureFolderRoute,
  gatewayPutObjectRoute, gatewayLinkRoute, gatewayRegisterClientUploadRoute, gatewayStatRoute, gatewayPinVersionRoute, gatewayOpenUrlRoute,
  gatewayStreamRoute, gatewayCopyWithinRoute, gatewayRehashRoute, gatewayAnchorsRoute,
];
