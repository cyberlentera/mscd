// The provider adapters behind the storage gateway's HTTP protocol (build plan D.5, J.7, WP-15): the run mode's
// GatewayModule with the Microsoft 365 and Google Drive factories, against the mock providers. Covers sealed
// credentials (a credential sealed for one drive or root folder is refused with another), the pass-through
// upload through `PUT /v1/objects`, problems with their HTTP status and `Retry-After`, `pin-version` for both
// adapters and the Google consent exchange through `/v1/credentials/oauth-exchange`.
import { createHash, randomUUID } from 'node:crypto';
import type { RunningMockProviders } from '@mscd/mock-providers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { googleDriveAdapterFactory } from '../../../src/gateway/adapters/google-drive';
import { m365AdapterFactory } from '../../../src/gateway/adapters/m365';
import { gatewayCall, gatewayConfig, putObject, startGateway, type RunningGateway } from '../gateway/helpers';
import {
  BACKUP_V3,
  CLIENT_ID,
  GD,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  ORG_ID,
  PDF_BYTES,
  REDIRECT_URI,
  SA_EMAIL,
  SP,
  TENANT_ID,
  TONO,
  admin,
  googleConfig,
  m365Config,
  quickXorHash,
  resetMock,
  sha256,
  startMock,
  testCertificate,
} from './helpers';

let mock: RunningMockProviders;
let gateway: RunningGateway;
let tenant: { orgId: string; wrappedDek: string };

const ISMS = { folderId: SP.isms, path: 'Compliance/ISMS' };
const BCMS = { folderId: GD.bcms, path: 'Compliance/BCMS' };

function m365Repository(config = m365Config(), credential?: { ref: string; sealedBlob: string; kind: string }) {
  return { id: '5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e', slug: 'sp', adapter: 'm365', modes: ['link', 'pass_through'], config, ...(credential ? { credential } : {}) };
}

function googleRepository(config = googleConfig({ oauthClientId: OAUTH_CLIENT_ID }), credential?: { ref: string; sealedBlob: string; kind: string }) {
  return { id: '6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e1f', slug: 'gd', adapter: 'google_drive', modes: ['link', 'pass_through'], config, ...(credential ? { credential } : {}) };
}

async function seal(repository: Record<string, unknown>, kind: string, secret: Record<string, unknown>): Promise<string> {
  const response = await gatewayCall(gateway.url, '/v1/credentials/seal', { tenant, repository, kind, secret });
  expect(response.status, response.body.toString()).toBe(200);
  return response.json<{ sealedBlob: string }>().sealedBlob;
}

async function m365Sealed(): Promise<ReturnType<typeof m365Repository>> {
  const cert = testCertificate();
  const sealedBlob = await seal(m365Repository(), 'm365_certificate', { tenantId: TENANT_ID, clientId: CLIENT_ID, certificatePem: cert.certificatePem, privateKeyPem: cert.privateKeyPem });
  return m365Repository(m365Config(), { ref: 'cred-sp', sealedBlob, kind: 'm365_certificate' });
}

async function googleSealed(): Promise<ReturnType<typeof googleRepository>> {
  const sealedBlob = await seal(googleRepository(), 'google_service_account', { clientEmail: SA_EMAIL, privateKeyPem: testCertificate().privateKeyPem });
  return googleRepository(undefined, { ref: 'cred-gd', sealedBlob, kind: 'google_service_account' });
}

beforeAll(async () => {
  mock = await startMock();
  const config = gatewayConfig({
    MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL: `${mock.url}/v1.0`,
    MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL: mock.url,
    MSCD__GATEWAY__PROVIDERS__GOOGLE__API_BASE_URL: mock.url,
    MSCD__GATEWAY__PROVIDERS__GOOGLE__TOKEN_URL: `${mock.url}/token`,
  });
  gateway = await startGateway(config, { factories: [m365AdapterFactory, googleDriveAdapterFactory] });
  const issued = await gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG_ID });
  tenant = { orgId: ORG_ID, wrappedDek: issued.json<{ wrappedDek: string }>().wrappedDek };
});

afterAll(async () => {
  await gateway?.close();
  await mock?.close();
});

beforeEach(async () => {
  await resetMock(mock);
});

describe('Microsoft 365 through the gateway', () => {
  it('registers both provider adapters from the factories', () => {
    expect(gateway.runtime.adapters.names().sort()).toEqual(['google_drive', 'm365']);
  });

  it('tests the connection, links, stats and uploads with a sealed certificate credential', async () => {
    const repository = await m365Sealed();
    const tested = await gatewayCall(gateway.url, '/v1/test-connection', { tenant, repository });
    expect(tested.json()).toMatchObject({ status: 'ok', ownership: 'organizational', latencyMs: expect.any(Number) });

    const linked = await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: ISMS, externalItemId: SP.backup });
    expect(linked.status).toBe(200);
    const metadata = linked.json<Record<string, unknown>>();
    expect(metadata).toMatchObject({ externalVersionId: '3.0', hashAlgorithm: 'quickxor', hashValue: quickXorHash(BACKUP_V3) });

    const object = { externalItemId: SP.backup, externalVersionId: '3.0', hashAlgorithm: 'quickxor', hashValue: metadata.hashValue, hashSource: 'provider', folderPath: metadata.folderPath };
    expect((await gatewayCall(gateway.url, '/v1/stat', { tenant, repository, object })).json()).toMatchObject({ outcome: 'found', pinnedVersionAvailable: true });
    expect((await gatewayCall(gateway.url, '/v1/pin-version', { tenant, repository, object })).json()).toEqual({ result: 'unsupported' });

    const header = { tenant, repository, scopeRoot: ISMS, folderPath: 'Evidence/2026/Q4', fileName: 'EV-0313-5.pdf', maxBytes: 1024 * 1024, metadataMinimization: true };
    const put = await putObject(gateway.url, header, PDF_BYTES);
    expect(put.status, put.body.toString()).toBe(200);
    expect(put.json()).toMatchObject({ hashAlgorithm: 'sha256', hashValue: sha256(PDF_BYTES), hashSource: 'computed', detectedMimeType: 'application/pdf', folderPath: 'Compliance/ISMS/Evidence/2026/Q4' });

    const streamed = await gatewayCall(gateway.url, '/v1/stream', { tenant, repository, object: { ...object, externalItemId: put.json<{ externalItemId: string }>().externalItemId, externalVersionId: null } });
    expect(streamed.status).toBe(200);
    expect(streamed.headers['x-mscd-detected-type']).toBe('application/pdf');
    expect(streamed.body).toEqual(PDF_BYTES);
  });

  it('refuses the sealed credential with another drive or root folder (credential binding)', async () => {
    const repository = await m365Sealed();
    for (const config of [m365Config({ driveId: SP.personalDrive }), m365Config({ rootFolderId: SP.other })]) {
      const response = await gatewayCall(gateway.url, '/v1/link', { tenant, repository: { ...repository, config }, scopeRoot: ISMS, externalItemId: SP.backup });
      expect(response.status).toBe(403);
      expect(response.json()).toMatchObject({ reason: 'credential-binding' });
    }
  });

  it('answers adapter problems with their status, and throttling with Retry-After', async () => {
    const repository = await m365Sealed();
    const outside = await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: ISMS, externalItemId: SP.qmsManual });
    expect(outside.status).toBe(403);
    expect(outside.json<{ type: string }>().type).toContain('outside-root');
    expect((await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: ISMS, externalItemId: 'x..y' })).status).toBe(400);
    expect((await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: ISMS, externalItemId: 'ITEM-NONE' })).status).toBe(404);

    await admin(mock, 'POST', '/_admin/throttle', { count: 20, retryAfterSeconds: 90 });
    const throttled = await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: ISMS, externalItemId: SP.backup });
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBe('90');
    await admin(mock, 'POST', '/_admin/throttle', { count: 0 });

    await admin(mock, 'POST', '/_admin/tokens/revoke', {});
    const revoked = await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: ISMS, externalItemId: SP.backup });
    expect(revoked.status).toBe(502);
    const stat = await gatewayCall(gateway.url, '/v1/stat', {
      tenant,
      repository,
      object: { externalItemId: SP.backup, externalVersionId: '3.0', hashAlgorithm: 'quickxor', hashValue: null, hashSource: 'provider', folderPath: null },
    });
    expect(stat.json()).toEqual({ outcome: 'unreachable', detail: 'credential_invalid', pinnedVersionAvailable: false });
  });
});

describe('Google Drive through the gateway', () => {
  it('links and pins a revision with a sealed service account credential', async () => {
    const repository = await googleSealed();
    const linked = await gatewayCall(gateway.url, '/v1/link', { tenant, repository, scopeRoot: BCMS, externalItemId: GD.plan });
    expect(linked.status, linked.body.toString()).toBe(200);
    const metadata = linked.json<Record<string, unknown>>();
    expect(metadata).toMatchObject({ externalVersionId: 'rev-c', versionLabel: 'rev 3', hashAlgorithm: 'sha256' });
    const object = { externalItemId: GD.plan, externalVersionId: 'rev-c', hashAlgorithm: 'sha256', hashValue: metadata.hashValue, hashSource: 'provider', folderPath: metadata.folderPath };
    expect((await gatewayCall(gateway.url, '/v1/pin-version', { tenant, repository, object })).json()).toEqual({ result: 'ok' });
    expect((await gatewayCall(gateway.url, '/v1/open-url', { tenant, repository, object })).json()).toEqual({ url: `https://drive.google.com/file/d/${GD.plan}/view?usp=drivesdk` });
  });

  it('exchanges a consent code, seals the refresh token and connects with it', async () => {
    const clientBlob = await seal(googleRepository(), 'oauth_refresh_token', { clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET });
    const verifier = `${randomUUID()}-${randomUUID()}`.replace(/-/g, '').slice(0, 64);
    const { code } = await admin<{ code: string }>(mock, 'POST', '/_admin/oauth/codes', {
      clientId: OAUTH_CLIENT_ID,
      redirectUri: REDIRECT_URI,
      account: { email: TONO.email, displayName: TONO.displayName },
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
    });
    const exchanged = await gatewayCall(gateway.url, '/v1/credentials/oauth-exchange', {
      tenant,
      repository: googleRepository(),
      credential: { ref: 'cred-gd-oauth', sealedBlob: clientBlob, kind: 'oauth_refresh_token' },
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
    });
    expect(exchanged.status, exchanged.body.toString()).toBe(200);
    const sealed = exchanged.json<{ sealedBlob: string; externalAccount: string }>();
    expect(sealed.externalAccount).toBe(TONO.email);
    expect(exchanged.body.toString()).not.toContain('1//');

    const repository = googleRepository(undefined, { ref: 'cred-gd-oauth', sealedBlob: sealed.sealedBlob, kind: 'oauth_refresh_token' });
    expect((await gatewayCall(gateway.url, '/v1/test-connection', { tenant, repository })).json()).toMatchObject({ status: 'ok', ownership: 'organizational' });

    const reused = await gatewayCall(gateway.url, '/v1/credentials/oauth-exchange', {
      tenant,
      repository: googleRepository(),
      credential: { ref: 'cred-gd-oauth', sealedBlob: clientBlob, kind: 'oauth_refresh_token' },
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
    });
    expect(reused.status).toBe(400);
  });
});
