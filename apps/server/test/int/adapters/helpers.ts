// Helpers of the provider adapter tests (build plan J.7, WP-15): the mock providers (tools/mock-providers) with a
// fixture document made for these tests, adapters pointed at them, adapter contexts with opened credentials, the
// mock's admin API and the E.4 link status precedence the link health job (WP-23) applies to `stat` results.
// Certificates and keys are made at run time (no key material is committed, R-11).
import { createHash, randomUUID } from 'node:crypto';
import {
  createSelfSignedCertificate,
  quickXorHash,
  startMockProviders,
  type FixtureDocument,
  type RunningMockProviders,
  type SelfSignedCertificate,
} from '@mscd/mock-providers';
import type { GatewayRepository, ObjectMetadata, StatResult, StorageMode } from '@mscd/shared';
import type { OpenedCredential } from '../../../src/gateway/crypto/credentials';
import type { AdapterContext } from '../../../src/gateway/adapters/types';
import { M365Adapter, type M365AdapterSettings } from '../../../src/gateway/adapters/m365';
import { GoogleDriveAdapter, type GoogleDriveAdapterSettings } from '../../../src/gateway/adapters/google-drive';
import type { ProviderAdapterOptions } from '../../../src/gateway/adapters/m365/provider/options';

export const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
export const TENANT_ID = '11111111-2222-4333-8444-555555555555';
export const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const SA_EMAIL = 'mscd-gateway@mscd-test.iam.gserviceaccount.com';
export const OAUTH_CLIENT_ID = 'mscd-test.apps.googleusercontent.com';
export const OAUTH_CLIENT_SECRET = 'oauth-client-secret';
export const REDIRECT_URI = 'https://mscd.test/api/v1/admin/storage/repositories/oauth/callback';
export const REFRESH_TOKEN = '1//refresh-tono-valid';

export const TONO = { displayName: 'Tono Hartono', email: 'tono.hartono@nusantaradigital.co.id' };
export const BAGUS = { displayName: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id' };
export const RINA = { displayName: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id' };

/** Microsoft 365 fixture ids. */
export const SP = {
  driveId: 'drive-sp-compliance',
  root: 'FOLDER-COMPLIANCE',
  isms: 'FOLDER-ISMS',
  ismsEvidence: 'FOLDER-ISMS-Q3',
  qms: 'FOLDER-QMS',
  other: 'FOLDER-OTHER',
  backup: 'ITEM-BACKUP',
  policy: 'ITEM-POLICY',
  qmsManual: 'ITEM-QMS-MANUAL',
  outside: 'ITEM-OUTSIDE',
  personalDrive: 'drive-od-rina',
  personalRoot: 'FOLDER-OD-EVIDENCE',
  businessDrive: 'drive-odb-bagus',
  businessRoot: 'FOLDER-ODB-EVIDENCE',
};

/** Google Drive fixture ids. */
export const GD = {
  driveId: 'drive-gd-bcms',
  root: 'folder-compliance',
  bcms: 'folder-bcms',
  evidence: 'folder-bcms-evidence',
  isms: 'folder-isms',
  other: 'folder-other',
  plan: 'file-bc-plan',
  notes: 'file-bia-notes',
  ismsFile: 'file-isms-register',
  outside: 'file-outside',
  myDrive: 'drive-my-tono',
  myRoot: 'mydrive-root-tono',
  myFolder: 'folder-my-compliance',
  myFile: 'file-my-evidence',
};

export const BACKUP_V3 = 'backup log, September 2026, signed off';
export const PLAN_R3 = 'business continuity plan, third revision';
export const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

let certificate: SelfSignedCertificate | undefined;

/** The certificate and key of the app registration and the service account (made once per test file). */
export function testCertificate(): SelfSignedCertificate {
  certificate ??= createSelfSignedCertificate({ commonName: 'mscd-wp15-adapters' });
  return certificate;
}

export function fixtureDocument(): FixtureDocument {
  const cert = testCertificate();
  return {
    version: 1,
    settings: { copyPendingPolls: 1 },
    credentials: [
      { kind: 'm365_certificate', tenantId: TENANT_ID, clientId: CLIENT_ID, certificatePem: cert.certificatePem, displayName: 'MSCD Storage Gateway' },
      { kind: 'google_service_account', clientEmail: SA_EMAIL, publicKeyPem: cert.publicKeyPem, displayName: 'MSCD Gateway' },
      { kind: 'google_oauth_client', clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET, redirectUris: [REDIRECT_URI], defaultAccount: TONO },
      { kind: 'google_refresh_token', clientId: OAUTH_CLIENT_ID, refreshToken: REFRESH_TOKEN, account: TONO, scope: 'https://www.googleapis.com/auth/drive.file' },
    ],
    m365: {
      drives: [
        {
          id: SP.driveId,
          name: 'Compliance',
          driveType: 'documentLibrary',
          tenantId: TENANT_ID,
          webUrl: 'https://nusantaradigital.sharepoint.com/sites/compliance/Shared%20Documents',
          folders: [
            { id: SP.root, path: 'Compliance' },
            { id: SP.isms, path: 'Compliance/ISMS' },
            { id: SP.ismsEvidence, path: 'Compliance/ISMS/Evidence/2026/Q3' },
            { id: SP.qms, path: 'Compliance/QMS' },
            { id: SP.other, path: 'Other' },
          ],
          items: [
            {
              id: SP.backup,
              path: 'Compliance/ISMS/Evidence/2026/Q3',
              name: 'Backup-Job-Log-Sep-2026.xlsx',
              description: 'Backup job log',
              createdAt: '2026-09-20T01:00:00Z',
              createdBy: BAGUS,
              versions: [
                { id: '1.0', content: 'backup log, first draft', modifiedAt: '2026-09-20T01:00:00Z', modifiedBy: BAGUS },
                { id: '2.0', content: 'backup log, second draft', modifiedAt: '2026-09-24T01:00:00Z', modifiedBy: BAGUS },
                { id: '3.0', content: BACKUP_V3, modifiedAt: '2026-09-28T02:00:00Z', modifiedBy: BAGUS },
              ],
            },
            { id: SP.policy, path: 'Compliance/ISMS', name: 'Access-Control-Policy.pdf', contentBase64: PDF_BYTES.toString('base64'), createdBy: RINA, createdAt: '2026-02-01T00:00:00Z' },
            { id: SP.qmsManual, path: 'Compliance/QMS', name: 'Quality-Manual.docx', content: 'quality manual', createdBy: RINA },
            { id: SP.outside, path: 'Other', name: 'Not-Compliance.txt', content: 'outside the root', createdBy: RINA },
          ],
        },
        {
          id: SP.personalDrive,
          name: 'OneDrive',
          driveType: 'personal',
          tenantId: TENANT_ID,
          owner: RINA,
          webUrl: 'https://nusantaradigital-my.sharepoint.com/personal/rina/Documents',
          folders: [{ id: SP.personalRoot, path: 'Evidence' }],
          items: [{ id: 'ITEM-OD-NOTE', path: 'Evidence', name: 'Firewall-Review.txt', content: 'review notes', createdBy: RINA }],
        },
        {
          id: SP.businessDrive,
          name: 'OneDrive',
          driveType: 'business',
          tenantId: TENANT_ID,
          owner: BAGUS,
          webUrl: 'https://nusantaradigital-my.sharepoint.com/personal/bagus/Documents',
          folders: [{ id: SP.businessRoot, path: 'Evidence' }],
        },
      ],
    },
    google: {
      drives: [
        {
          id: GD.driveId,
          name: 'Compliance BCMS',
          kind: 'shared_drive',
          folders: [
            { id: GD.root, path: 'Compliance' },
            { id: GD.bcms, path: 'Compliance/BCMS' },
            { id: GD.evidence, path: 'Compliance/BCMS/Evidence/2026' },
            { id: GD.isms, path: 'Compliance/ISMS' },
            { id: GD.other, path: 'Other' },
          ],
          items: [
            {
              id: GD.plan,
              path: 'Compliance/BCMS/Evidence/2026',
              name: 'BC-Plan-2026.pdf',
              createdBy: TONO,
              createdAt: '2026-09-10T00:00:00Z',
              versions: [
                { id: 'rev-a', content: 'business continuity plan, first revision', modifiedAt: '2026-09-10T00:00:00Z', modifiedBy: TONO },
                { id: 'rev-b', content: 'business continuity plan, second revision', modifiedAt: '2026-09-12T00:00:00Z', modifiedBy: TONO },
                { id: 'rev-c', content: PLAN_R3, modifiedAt: '2026-09-15T00:00:00Z', modifiedBy: TONO },
              ],
            },
            {
              id: GD.notes,
              path: 'Compliance/BCMS/Evidence/2026',
              name: 'BIA-Workshop-Notes',
              mimeType: 'application/vnd.google-apps.document',
              createdBy: TONO,
              versions: [{ id: '6', modifiedBy: TONO }, { id: '7', modifiedBy: TONO, modifiedAt: '2026-09-25T03:00:00Z' }],
            },
            { id: GD.ismsFile, path: 'Compliance/ISMS', name: 'Asset-Register.xlsx', content: 'asset register', createdBy: RINA },
            { id: GD.outside, path: 'Other', name: 'Holiday-Plan.txt', content: 'outside the root', createdBy: RINA },
          ],
        },
        {
          id: GD.myDrive,
          kind: 'my_drive',
          rootId: GD.myRoot,
          owner: TONO,
          allowedPrincipals: [SA_EMAIL],
          folders: [{ id: GD.myFolder, path: 'Compliance' }],
          items: [{ id: GD.myFile, path: 'Compliance', name: 'Tabletop-Exercise.txt', content: 'tabletop exercise notes', createdBy: TONO }],
        },
      ],
    },
  };
}

export async function startMock(): Promise<RunningMockProviders> {
  return startMockProviders({ port: 0, fixtures: fixtureDocument() });
}

/** Records the waits of retries and copy polls without waiting. */
export class Waits {
  readonly calls: number[] = [];
  readonly sleep = async (ms: number): Promise<void> => {
    this.calls.push(ms);
  };
}

/** Fast retries for tests; `Retry-After` up to 5 seconds is waited for (recorded, not slept). */
export function testOptions(waits: Waits, extra: ProviderAdapterOptions = {}): ProviderAdapterOptions {
  return { retry: { baseDelayMs: 1, maxDelayMs: 4, maxRetryAfterMs: 5000 }, sleep: waits.sleep, copyPoll: { initialMs: 10, maxMs: 20, timeoutMs: 60_000 }, ...extra };
}

export function m365Settings(mock: RunningMockProviders, overrides: Partial<M365AdapterSettings> = {}): M365AdapterSettings {
  return { graphBaseUrl: `${mock.url}/v1.0`, loginBaseUrl: mock.url, egressAllowlist: [], demo: true, ...overrides };
}

export function googleSettings(mock: RunningMockProviders, overrides: Partial<GoogleDriveAdapterSettings> = {}): GoogleDriveAdapterSettings {
  return { apiBaseUrl: mock.url, tokenUrl: `${mock.url}/token`, egressAllowlist: [], demo: true, ...overrides };
}

export function m365Adapter(mock: RunningMockProviders, waits = new Waits(), extra: ProviderAdapterOptions = {}): M365Adapter {
  return new M365Adapter(m365Settings(mock), testOptions(waits, extra));
}

export function googleAdapter(mock: RunningMockProviders, waits = new Waits(), extra: ProviderAdapterOptions = {}): GoogleDriveAdapter {
  return new GoogleDriveAdapter(googleSettings(mock), testOptions(waits, extra));
}

export function m365Credential(secret: Partial<Record<string, unknown>> = {}): OpenedCredential {
  const cert = testCertificate();
  return {
    ref: 'cred-sp',
    kind: 'm365_certificate',
    secret: { tenantId: TENANT_ID, clientId: CLIENT_ID, certificatePem: cert.certificatePem, privateKeyPem: cert.privateKeyPem, ...secret },
  };
}

export function serviceAccountCredential(): OpenedCredential {
  return { ref: 'cred-gd', kind: 'google_service_account', secret: { clientEmail: SA_EMAIL, privateKeyPem: testCertificate().privateKeyPem } };
}

export function refreshTokenCredential(refreshToken = REFRESH_TOKEN): OpenedCredential {
  return { ref: 'cred-gd-oauth', kind: 'oauth_refresh_token', secret: { clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET, refreshToken } };
}

export function m365Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: 'nusantaradigital.sharepoint.com,1,2',
    driveId: SP.driveId,
    rootFolderId: SP.root,
    roots: { isms: { folderId: SP.isms, path: 'Compliance/ISMS' }, qms: { folderId: SP.qms, path: 'Compliance/QMS' } },
    ...overrides,
  };
}

export function googleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    driveId: GD.driveId,
    rootFolderId: GD.root,
    roots: { bcms: { folderId: GD.bcms, path: 'Compliance/BCMS' }, isms: { folderId: GD.isms, path: 'Compliance/ISMS' } },
    ...overrides,
  };
}

export interface ContextOptions {
  config?: Record<string, unknown>;
  credential?: OpenedCredential | null;
  modes?: StorageMode[];
  signal?: AbortSignal;
}

function context(adapter: 'm365' | 'google_drive', slug: string, defaults: { config: Record<string, unknown>; credential: OpenedCredential }, options: ContextOptions): AdapterContext {
  const credential = options.credential === undefined ? defaults.credential : options.credential;
  const repository: GatewayRepository = {
    id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    slug,
    adapter,
    modes: options.modes ?? ['link', 'pass_through', 'zero_transit'],
    config: options.config ?? defaults.config,
    ...(credential ? { credential: { ref: credential.ref, sealedBlob: 'v1.00000000.unused.unused', kind: credential.kind } } : {}),
  };
  return {
    orgId: ORG_ID,
    dataKey: { orgId: ORG_ID, key: Buffer.alloc(32, 7), id: '00000000' },
    repository,
    credential,
    requestId: randomUUID(),
    signal: options.signal ?? new AbortController().signal,
  };
}

export function m365Context(options: ContextOptions = {}): AdapterContext {
  return context('m365', 'sp', { config: m365Config(), credential: m365Credential() }, options);
}

export function googleContext(options: ContextOptions = {}): AdapterContext {
  return context('google_drive', 'gd', { config: googleConfig(), credential: serviceAccountCredential() }, options);
}

/** The scope root of a system as the api passes it. */
export const scope = (folderId: string, path: string) => ({ folderId, path });

// Mock admin API -----------------------------------------------------------------------------------------------

export async function admin<T = Record<string, unknown>>(mock: RunningMockProviders, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${mock.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`admin ${method} ${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function resetMock(mock: RunningMockProviders): Promise<void> {
  await admin(mock, 'POST', '/_admin/reset');
}

export interface LoggedRequest {
  seq: number;
  api: string;
  method: string;
  url: string;
  status: number;
  authorization: boolean;
  principal: string | null;
}

/** Provider requests the mock saw (optionally of one API) since the given sequence number. */
export async function requests(mock: RunningMockProviders, api?: string, since = 0): Promise<LoggedRequest[]> {
  const query = new URLSearchParams({ ...(api ? { api } : {}), since: String(since) });
  return (await admin<{ requests: LoggedRequest[] }>(mock, 'GET', `/_admin/requests?${query.toString()}`)).requests;
}

export async function lastSeq(mock: RunningMockProviders): Promise<number> {
  const all = await requests(mock);
  return all.length === 0 ? 0 : all[all.length - 1]!.seq;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export { quickXorHash };

// E.4 -------------------------------------------------------------------------------------------------------------

/** A storage object as the api stores it after link, register or put. */
export type StoredObject = Pick<ObjectMetadata, 'externalItemId' | 'externalVersionId' | 'hashAlgorithm' | 'hashValue' | 'hashSource' | 'folderPath'>;

export function stored(metadata: ObjectMetadata): StoredObject {
  return {
    externalItemId: metadata.externalItemId,
    externalVersionId: metadata.externalVersionId,
    hashAlgorithm: metadata.hashAlgorithm,
    hashValue: metadata.hashValue,
    hashSource: metadata.hashSource,
    folderPath: metadata.folderPath,
  };
}

/** The link status the link health check derives from a `stat` result (E.4 precedence, A-06). */
export function linkStatus(object: StoredObject, result: StatResult): string {
  if (result.outcome === 'rate_limited') return 'unchanged (rate limited)';
  if (result.outcome === 'unreachable') return `verification_pending (${result.detail === 'credential_invalid' ? 'credential_invalid' : 'unreachable'})`;
  if (result.outcome === 'not_found') return 'missing';
  if (result.outcome === 'forbidden') return 'access_denied';
  const current = result.current!;
  if (object.hashSource === 'provider' && current.externalVersionId === object.externalVersionId && current.hashValue !== object.hashValue) return 'hash_mismatch';
  if (current.externalVersionId !== object.externalVersionId) return result.pinnedVersionAvailable ? 'version_changed' : 'pinned_version_lost';
  if (current.folderPath !== object.folderPath) return 'moved';
  return 'intact';
}

/** The object reference a gateway call carries for a stored object. */
export function ref(object: StoredObject) {
  return { ...object };
}
