// Area `storage` (owner from wave 5: WP-13): repositories, credentials, OAuth consent, move requests, routing rules
// and storage object metadata (D.2, D.3 "Administration", D-08, BR-30, BR-38, F.8).
import { z } from 'zod';
import {
  Classification, ConnectionStatus, HashAlgorithm, HashSource, LinkStatus, LinkStatusReason, ObjectKind, OwnershipType, RepoStatus,
  RoutingApprovalStatus, StorageAdapter, StorageMode,
} from '../enums.js';
import { RepoAction } from '../ui/snapshot.js';
import {
  CommandResult, IdParams, Instant, MsId, NoBody, Pair, PersonId, RepositorySlug, Text, Uuid, commandResultWith, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

/** Microsoft Graph drive and item id pattern (D.5). */
export const GRAPH_ID_RE = /^[A-Za-z0-9!_-]+$/;
/** Google Drive id pattern (D.5). */
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

const GraphId = z.string().max(300).regex(GRAPH_ID_RE);
const DriveId = z.string().max(300).regex(DRIVE_ID_RE);
const FolderPath = z.string().min(1).max(1024);

export const M365RepositoryConfig = named(
  'M365RepositoryConfig',
  z.strictObject({ siteId: z.string().min(1).max(300), driveId: GraphId, rootFolderId: GraphId, roots: z.record(MsId, z.strictObject({ folderId: GraphId, path: FolderPath })) }),
  'Microsoft 365 repository: SharePoint site and drive, the Compliance root folder and one folder per system (D.2, D.5)',
  { valid: [{ siteId: 'contoso.sharepoint.com,1,2', driveId: 'drive-sp-compliance', rootFolderId: 'root-compliance', roots: { isms: { folderId: 'f-isms', path: 'Compliance/ISMS' } } }], invalid: [{ siteId: 's', driveId: 'drive/1', rootFolderId: 'r', roots: {} }] },
);
export type M365RepositoryConfig = z.infer<typeof M365RepositoryConfig>;

export const GoogleDriveRepositoryConfig = named(
  'GoogleDriveRepositoryConfig',
  z.strictObject({ driveId: DriveId, rootFolderId: DriveId, roots: z.record(MsId, z.strictObject({ folderId: DriveId, path: FolderPath })), oauthClientId: z.string().min(1).max(300).optional() }),
  'Google Shared Drive repository: drive, the Compliance root folder and one folder per system (D.2, D.5)',
  { valid: [{ driveId: 'drive-gd-bcms', rootFolderId: 'root-compliance', roots: { bcms: { folderId: 'f-bcms', path: 'Compliance/BCMS' } } }], invalid: [{ driveId: 'drive!gd', rootFolderId: 'r', roots: {} }] },
);
export type GoogleDriveRepositoryConfig = z.infer<typeof GoogleDriveRepositoryConfig>;

export const VaultRepositoryConfig = named('VaultRepositoryConfig', z.strictObject({ prefix: z.string().max(200).regex(/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+$/, 'relative key prefix of path segments, each ending in /, no segment starting with a dot') }), 'Managed Vault repository: object key prefix tenants/<org_id>/ (C.8 step 5)', {
  valid: [{ prefix: 'tenants/00000000-0000-4000-8000-00000000a001/' }],
  invalid: [{ prefix: 'tenants' }, { prefix: '../x/' }, { prefix: '/tenants/x/' }, { prefix: 'tenants//x/' }, {}],
});
export type VaultRepositoryConfig = z.infer<typeof VaultRepositoryConfig>;

const Display = z.record(z.string(), z.unknown());
const commonRepositoryShape = {
  slug: RepositorySlug,
  name: z.string().trim().min(1).max(150),
  ownershipType: OwnershipType,
  metadataMinimization: z.boolean(),
  retentionConfirmed: z.boolean(),
  display: Display.optional(),
};
const ProviderModes = z.array(z.enum(['pass_through', 'link', 'zero_transit'])).min(1);

export const RepositoryCreate = named(
  'RepositoryCreate',
  z.discriminatedUnion('adapter', [
    z.strictObject({ ...commonRepositoryShape, adapter: z.literal('managed_vault'), modes: z.tuple([z.literal('stored')]), config: VaultRepositoryConfig }),
    z.strictObject({ ...commonRepositoryShape, adapter: z.literal('m365'), modes: ProviderModes, config: M365RepositoryConfig }),
    z.strictObject({ ...commonRepositoryShape, adapter: z.literal('google_drive'), modes: ProviderModes, config: GoogleDriveRepositoryConfig }),
    z.strictObject({ ...commonRepositoryShape, adapter: z.enum(['smb', 's3', 'webdav']), modes: ProviderModes, config: z.record(z.string(), z.unknown()) }),
  ]),
  'POST /admin/storage/repositories body: config per adapter (no secrets); adapters that are not licensed or not enabled answer 422',
  {
    valid: [
      { slug: 'sp', name: 'SharePoint Online', adapter: 'm365', modes: ['link', 'pass_through'], ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: true, config: { siteId: 'contoso.sharepoint.com,1,2', driveId: 'drive-sp-compliance', rootFolderId: 'root-compliance', roots: { isms: { folderId: 'f-isms', path: 'Compliance/ISMS' } } } },
      { slug: 'vault2', name: 'Restricted vault', adapter: 'managed_vault', modes: ['stored'], ownershipType: 'organizational', metadataMinimization: true, retentionConfirmed: true, config: { prefix: 'tenants/00000000-0000-4000-8000-00000000a001/' } },
    ],
    invalid: [
      { slug: 'v', name: 'x', adapter: 'managed_vault', modes: ['link'], ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: true, config: { prefix: 'tenants/x/' } },
      { slug: 'sp', name: 'x', adapter: 'm365', modes: ['stored'], ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: true, config: {} },
      { slug: 'db', name: 'x', adapter: 'dropbox', modes: ['link'], ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: true, config: {} },
    ],
  },
);
export type RepositoryCreate = z.infer<typeof RepositoryCreate>;

export const RepositoryPatch = named(
  'RepositoryPatch',
  z.strictObject({
    name: commonRepositoryShape.name.optional(),
    modes: z.array(StorageMode).min(1).optional(),
    config: z.union([M365RepositoryConfig, GoogleDriveRepositoryConfig, VaultRepositoryConfig]).optional(),
    ownershipType: OwnershipType.optional(),
    metadataMinimization: z.boolean().optional(),
    retentionConfirmed: z.boolean().optional(),
    display: Display.optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /admin/storage/repositories/{id} body; a config change needs a new sealed credential (D-08)',
  { valid: [{ name: 'SharePoint Compliance' }, { retentionConfirmed: true, metadataMinimization: true }], invalid: [{}, { adapter: 'm365' }] },
);
export type RepositoryPatch = z.infer<typeof RepositoryPatch>;

export const RepositoryCredential = named(
  'RepositoryCredential',
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('m365_certificate'), secret: z.strictObject({ tenantId: Uuid, clientId: z.string().min(1).max(200), certificatePem: z.string().includes('BEGIN CERTIFICATE'), privateKeyPem: z.string().includes('PRIVATE KEY') }) }),
    z.strictObject({ kind: z.literal('google_service_account'), secret: z.strictObject({ clientEmail: z.email(), privateKeyPem: z.string().includes('PRIVATE KEY') }) }),
    z.strictObject({ kind: z.literal('oauth_refresh_token'), secret: z.strictObject({ clientId: z.string().min(1).max(300), clientSecret: z.string().min(1).max(1024) }) }),
  ]),
  'PUT /admin/storage/repositories/{id}/credentials body: sealed by the gateway, never stored in clear; a refresh token arrives only through the consent flow (D.2, D-08)',
  {
    valid: [
      { kind: 'google_service_account', secret: { clientEmail: 'mscd@project.iam.gserviceaccount.com', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n' } },
      { kind: 'oauth_refresh_token', secret: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret' } },
    ],
    invalid: [{ kind: 'oauth_refresh_token', secret: { refreshToken: 'x' } }, { kind: 's3_access_key', secret: {} }],
  },
);
export type RepositoryCredential = z.infer<typeof RepositoryCredential>;

export const RepositoryTestResult = named(
  'RepositoryTestResult',
  z.object({ status: ConnectionStatus, permissions: z.array(z.string()), references: z.int().min(0), nextCheckAt: Instant.nullable(), message: Pair }),
  'Result of a connection test (D.2); the route returns it as CommandResult data with message',
  { valid: [{ status: 'ok', permissions: ['Sites.Selected: read'], references: 76, nextCheckAt: '2026-09-30T02:00:00Z', message: ['Connected', 'Terhubung'] }], invalid: [{ status: 'connected', permissions: [], references: 0, nextCheckAt: null, message: ['a', 'b'] }] },
);
export type RepositoryTestResult = z.infer<typeof RepositoryTestResult>;

const EXAMPLE_REPOSITORY_VIEW = {
  id: 'gd', ref: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', name: 'Google Shared Drive', type: 'Google Workspace', status: 'bad',
  msg: ['Delegated token expired 27 Sep 2026', 'Token delegasi kedaluwarsa 27 Sep 2026'], tenant: 'Compliance BCMS drive, drive.file', ms: ['BCMS'],
  last: '27 Sep 2026 06:00', adapter: 'google_drive', modes: ['zero_transit', 'link'], ownershipType: 'organizational', connectionStatus: 'revoked',
  retentionConfirmed: true, metadataMinimization: false, readOnly: false, credentialSet: true, credentialExpiresAt: null,
  config: { driveId: 'drive-gd-bcms', rootFolderId: 'root-compliance', roots: {} }, actions: ['test', 'reauthorise'],
} as const;

export const RepositoryView = named(
  'RepositoryView',
  z.object({
    id: RepositorySlug,
    ref: Uuid,
    name: z.string(),
    type: z.string(),
    status: RepoStatus,
    msg: Text.optional(),
    tenant: Text,
    ms: z.array(z.string()),
    last: z.string(),
    adapter: StorageAdapter,
    modes: z.array(StorageMode),
    ownershipType: OwnershipType,
    connectionStatus: ConnectionStatus,
    retentionConfirmed: z.boolean(),
    metadataMinimization: z.boolean(),
    readOnly: z.boolean(),
    credentialSet: z.boolean(),
    credentialExpiresAt: Instant.nullable(),
    config: z.record(z.string(), z.unknown()),
    actions: z.array(RepoAction),
  }),
  'Repository as the administration screen sees it: the REPOS card fields (modes as values), connection state, credential state and config without secrets (D.2)',
  { valid: [EXAMPLE_REPOSITORY_VIEW], invalid: [{ ...EXAMPLE_REPOSITORY_VIEW, modes: 'Zero-transit, Link' }, { ...EXAMPLE_REPOSITORY_VIEW, connectionStatus: 'down' }] },
);
export type RepositoryView = z.infer<typeof RepositoryView>;

export const MoveRequest = named('MoveRequest', z.strictObject({ ms: MsId, note: z.string().trim().min(1).max(1000).optional() }), 'POST /admin/storage/repositories/{id}/move-requests body: the system on whose behalf the move is asked (BR-30)', {
  valid: [{ ms: 'isms' }, { ms: 'isms', note: 'Account disabled' }],
  invalid: [{}, { ms: 'ISMS' }],
});
export type MoveRequest = z.infer<typeof MoveRequest>;

export const RoutingRuleRequest = named(
  'RoutingRuleRequest',
  z.strictObject({
    ms: MsId.optional(), classification: Classification.optional(), objectKind: ObjectKind.optional(), repository: RepositorySlug, mode: StorageMode,
    priority: z.int().min(0).max(32767), note: z.string().trim().max(500).optional(), confirm: z.boolean().optional(),
  }),
  'POST /admin/storage/routing-rules body (A-37 precedence); confirm after 409 confirmation-required (BR-38); changes may wait for a second Tenant Admin (A-50)',
  { valid: [{ ms: 'bcms', classification: 'internal', repository: 'gd', mode: 'link', priority: 50, note: 'Internal to Link' }, { repository: 'vault', mode: 'stored', priority: 100 }], invalid: [{ repository: 'vault', mode: 'cloud', priority: 1 }, { mode: 'stored', priority: 1 }] },
);
export type RoutingRuleRequest = z.infer<typeof RoutingRuleRequest>;

export const RoutingRulePatch = named(
  'RoutingRulePatch',
  z.strictObject({
    classification: Classification.nullable().optional(), objectKind: ObjectKind.nullable().optional(), repository: RepositorySlug.optional(), mode: StorageMode.optional(),
    priority: z.int().min(0).max(32767).optional(), note: z.string().trim().max(500).nullable().optional(), confirm: z.boolean().optional(),
  }).refine((p) => Object.entries(p).some(([k, v]) => k !== 'confirm' && v !== undefined), { message: 'Give at least one field' }),
  'PATCH /admin/storage/routing-rules/{id} body',
  { valid: [{ mode: 'zero_transit', confirm: true }], invalid: [{}, { confirm: true }] },
);
export type RoutingRulePatch = z.infer<typeof RoutingRulePatch>;

export const RoutingRuleView = named(
  'RoutingRuleView',
  z.object({
    id: Uuid, ms: MsId.nullable(), classification: Classification.nullable(), objectKind: ObjectKind.nullable(), repository: RepositorySlug, mode: StorageMode,
    priority: z.int(), note: z.string().nullable(), approvalStatus: RoutingApprovalStatus, requestedBy: PersonId.nullable(), approvedBy: PersonId.nullable(), createdAt: Instant,
  }),
  'Routing rule with its approval state',
  { valid: [{ id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', ms: 'bcms', classification: 'internal', objectKind: null, repository: 'gd', mode: 'link', priority: 50, note: 'Internal to Link', approvalStatus: 'pending_approval', requestedBy: 'rina', approvedBy: null, createdAt: '2026-09-20T03:00:00Z' }], invalid: [{ id: 'x', ms: null }] },
);
export type RoutingRuleView = z.infer<typeof RoutingRuleView>;

export const StorageObjectListQuery = named('StorageObjectListQuery', z.strictObject({ ...pageQueryShape, repository: RepositorySlug.optional(), status: LinkStatus.optional() }), 'GET /admin/storage/objects query', {
  valid: [{}, { repository: 'sp', status: 'missing' }],
  invalid: [{ status: 'broken' }],
});
export type StorageObjectListQuery = z.infer<typeof StorageObjectListQuery>;

const EXAMPLE_OBJECT_META = {
  id: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', repository: 'sp', externalItemId: 'demo-sp-EV-0313', externalVersionId: '3.0', versionLabel: 'v3.0',
  displayName: 'Backup-Job-Log-Q3.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 48211, hashAlgorithm: 'quickxor',
  hashValue: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', hashSource: 'provider', folderPath: 'Compliance / ISMS / Evidence / 2026 / Q3', linkStatus: 'missing',
  linkStatusSince: '2026-09-20T02:00:00Z', linkStatusReason: null, lastVerifiedAt: '2026-09-29T02:00:00Z', lastGoodCheckAt: '2026-09-19T02:00:00Z', nextCheckAt: '2026-09-30T02:00:00Z',
} as const;

export const StorageObjectMeta = named(
  'StorageObjectMeta',
  z.object({
    id: Uuid, repository: RepositorySlug, externalItemId: z.string(), externalVersionId: z.string().nullable(), versionLabel: z.string().nullable(),
    displayName: z.string().nullable(), mimeType: z.string().nullable(), sizeBytes: z.int().min(0).nullable(), hashAlgorithm: HashAlgorithm,
    hashValue: z.string().nullable(), hashSource: HashSource, folderPath: z.string().nullable(), linkStatus: LinkStatus, linkStatusSince: Instant,
    linkStatusReason: LinkStatusReason.nullable(), lastVerifiedAt: Instant.nullable(), lastGoodCheckAt: Instant.nullable(), nextCheckAt: Instant.nullable(),
  }),
  'Storage object metadata for storage administrators: no file content and no web_url',
  { valid: [EXAMPLE_OBJECT_META], invalid: [{ ...EXAMPLE_OBJECT_META, webUrl: undefined, linkStatus: 'ok' }] },
);
export type StorageObjectMeta = z.infer<typeof StorageObjectMeta>;

export const OAuthCallbackQuery = named(
  'OAuthCallbackQuery',
  z.looseObject({ state: z.string().min(1).max(512), code: z.string().max(4096).optional(), error: z.string().max(200).optional(), scope: z.string().max(2000).optional() }),
  'Repository OAuth consent callback query (F.8)',
  { valid: [{ state: 'c3RhdGU', code: '4/0Ab', scope: 'https://www.googleapis.com/auth/drive.file' }, { state: 's', error: 'access_denied' }], invalid: [{ code: '4/0Ab' }] },
);
export type OAuthCallbackQuery = z.infer<typeof OAuthCallbackQuery>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const admin = { owner: 'WP-13' as const, auth: 'session' as const, scope: 'org' as const };

export const repositoriesListRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.list', method: 'GET', path: '/api/v1/admin/storage/repositories', summary: 'Storage repositories of the organisation',
  permission: 'storage.repository.read', response: z.array(RepositoryView), errors: [],
});
export const repositoriesCreateRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.create', method: 'POST', path: '/api/v1/admin/storage/repositories', summary: 'Add a repository (adapter licensed and enabled, id patterns checked)',
  permission: 'storage.repository.manage', body: RepositoryCreate, response: RepositoryView, status: 201, errors: [409, 422], idempotent: true,
});
export const repositoriesUpdateRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.update', method: 'PATCH', path: '/api/v1/admin/storage/repositories/:id', summary: 'Change a repository; a config change marks the credential for re-sealing',
  permission: 'storage.repository.manage', params: IdParams, body: RepositoryPatch, response: RepositoryView, errors: [404, 409],
});
export const repositoriesCredentialsRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.credentials', method: 'PUT', path: '/api/v1/admin/storage/repositories/:id/credentials', summary: 'Set the credential of a repository (sealed by the gateway, D-08)',
  permission: 'storage.repository.manage', params: IdParams, body: RepositoryCredential, response: NoBody, status: 204, errors: [404, 409, 422, 503],
});
export const repositoriesTestRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.test', method: 'POST', path: '/api/v1/admin/storage/repositories/:id/test', summary: 'Test the connection of a repository',
  permission: 'storage.repository.test', params: IdParams, response: commandResultWith(RepositoryTestResult), errors: [404, 503],
});
export const repositoriesReauthorizeRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.reauthorize', method: 'POST', path: '/api/v1/admin/storage/repositories/:id/reauthorize', summary: 'Start OAuth consent for a delegated credential; returns redirectUrl',
  permission: 'storage.repository.manage', params: IdParams, response: CommandResult, errors: [404, 409],
});
export const repositoriesOauthCallbackRoute = defineRoute({
  owner: 'WP-13', auth: 'session', id: 'admin.storage.oauth.callback', method: 'GET', path: '/api/v1/admin/storage/repositories/oauth/callback',
  summary: 'OAuth consent callback: same user, binding cookie and expiry as the repo_oauth transaction; redirects to /storage',
  query: OAuthCallbackQuery, response: NoBody, status: 302, errors: [],
});
export const repositoriesMoveRequestRoute = defineRoute({
  ...admin, id: 'admin.storage.repositories.move-request', method: 'POST', path: '/api/v1/admin/storage/repositories/:id/move-requests',
  summary: 'Ask to move the evidence of a personal repository to a team library (BR-30)', permission: 'storage.move.request', scope: 'ms', msSource: 'body',
  params: IdParams, body: MoveRequest, response: CommandResult, status: 201, errors: [404, 422], idempotent: true,
});
export const routingRulesListRoute = defineRoute({
  ...admin, id: 'admin.storage.routing-rules.list', method: 'GET', path: '/api/v1/admin/storage/routing-rules', summary: 'Routing rules with their approval state',
  permission: 'storage.repository.read', response: z.array(RoutingRuleView), errors: [],
});
export const routingRulesCreateRoute = defineRoute({
  ...admin, id: 'admin.storage.routing-rules.create', method: 'POST', path: '/api/v1/admin/storage/routing-rules',
  summary: 'Add a routing rule (BR-38 confirmation; pending approval for four-eyes cases)', permission: 'storage.routing.manage', body: RoutingRuleRequest,
  response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});
export const routingRulesUpdateRoute = defineRoute({
  ...admin, id: 'admin.storage.routing-rules.update', method: 'PATCH', path: '/api/v1/admin/storage/routing-rules/:id', summary: 'Change a routing rule (BR-38)',
  permission: 'storage.routing.manage', params: IdParams, body: RoutingRulePatch, response: CommandResult, errors: [404, 409, 422],
});
export const routingRulesApproveRoute = defineRoute({
  ...admin, id: 'admin.storage.routing-rules.approve', method: 'POST', path: '/api/v1/admin/storage/routing-rules/:id/approve', summary: 'Approve a pending routing rule (not the requester)',
  permission: 'storage.routing.manage', params: IdParams, response: CommandResult, errors: [404, 409, 422],
});
export const routingRulesRejectRoute = defineRoute({
  ...admin, id: 'admin.storage.routing-rules.reject', method: 'POST', path: '/api/v1/admin/storage/routing-rules/:id/reject', summary: 'Reject a pending routing rule (not the requester)',
  permission: 'storage.routing.manage', params: IdParams, response: CommandResult, errors: [404, 409, 422],
});
export const storageObjectsListRoute = defineRoute({
  ...admin, id: 'admin.storage.objects.list', method: 'GET', path: '/api/v1/admin/storage/objects', summary: 'Storage object metadata (no content, no web_url)',
  permission: 'storage.object.metadata.read', query: StorageObjectListQuery, response: pageOf(StorageObjectMeta), errors: [],
});

export const routes: RouteDef[] = [
  repositoriesListRoute, repositoriesCreateRoute, repositoriesUpdateRoute, repositoriesCredentialsRoute, repositoriesTestRoute,
  repositoriesReauthorizeRoute, repositoriesOauthCallbackRoute, repositoriesMoveRequestRoute, routingRulesListRoute, routingRulesCreateRoute,
  routingRulesUpdateRoute, routingRulesApproveRoute, routingRulesRejectRoute, storageObjectsListRoute,
];
