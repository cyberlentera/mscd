import type { FastifyInstance, InjectOptions, LightMyRequestResponse as Response } from 'fastify';
import {
  type FixtureDocument,
  type MockProvidersOptions,
  type SelfSignedCertificate,
  buildMockProviders,
  createGoogleServiceAccountAssertion,
  createM365ClientAssertion,
  createSelfSignedCertificate,
} from '../src/index.js';

// Shared fixtures and request helpers. Tests use Fastify's inject (no sockets); its default authority is
// localhost:80, so generated links start with http://localhost:80.

export const ORIGIN = 'http://localhost:80';
export const TENANT = '11111111-2222-4333-8444-555555555555';
export const TENANT_ALIAS = 'nusantaradigital.onmicrosoft.com';
export const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const SA_EMAIL = 'mscd-gateway@mscd-test.iam.gserviceaccount.com';
export const SA_KEY_ID = 'key-1';
export const OAUTH_CLIENT = 'oauth-client.apps.googleusercontent.com';
export const OAUTH_SECRET = 'oauth-secret';
export const REDIRECT_URI = 'https://mscd.test/api/v1/admin/storage/repositories/oauth/callback';
export const TONO = { displayName: 'Tono Hartono', email: 'tono.hartono@nusantaradigital.co.id' };
export const BAGUS = { displayName: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id' };
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

let cached: SelfSignedCertificate | undefined;
let other: SelfSignedCertificate | undefined;

/** The certificate (and key) every fixture credential uses; created once per test file. */
export function certificate(): SelfSignedCertificate {
  cached ??= createSelfSignedCertificate({ commonName: 'mscd-mock-providers-test' });
  return cached;
}

/** A second key pair that no fixture trusts. */
export function otherCertificate(): SelfSignedCertificate {
  other ??= createSelfSignedCertificate({ commonName: 'untrusted' });
  return other;
}

export function standardFixtures(): FixtureDocument {
  const cert = certificate();
  return {
    version: 1,
    credentials: [
      { kind: 'm365_certificate', tenantId: TENANT, clientId: CLIENT_ID, certificatePem: cert.certificatePem, displayName: 'MSCD Storage Gateway', tenantAliases: [TENANT_ALIAS] },
      { kind: 'google_service_account', clientEmail: SA_EMAIL, publicKeyPem: cert.publicKeyPem, privateKeyId: SA_KEY_ID, displayName: 'MSCD Gateway' },
      { kind: 'google_oauth_client', clientId: OAUTH_CLIENT, clientSecret: OAUTH_SECRET, redirectUris: [REDIRECT_URI], defaultAccount: TONO },
      { kind: 'google_refresh_token', clientId: OAUTH_CLIENT, refreshToken: '1//refresh-valid', account: TONO, scope: 'https://www.googleapis.com/auth/drive.file' },
      { kind: 'google_refresh_token', clientId: OAUTH_CLIENT, refreshToken: '1//refresh-expired', account: TONO, revoked: true },
    ],
    m365: {
      drives: [
        {
          id: 'drive-sp-compliance',
          name: 'Compliance',
          tenantId: TENANT,
          webUrl: 'https://nusantaradigital.sharepoint.com/sites/compliance/Shared%20Documents',
          folders: [
            { id: 'FOLDER-COMPLIANCE', path: 'Compliance' },
            { id: 'FOLDER-ISMS', path: 'Compliance/ISMS' },
            { id: 'FOLDER-Q3', path: 'Compliance/ISMS/Evidence/2026/Q3' },
          ],
          items: [
            {
              id: 'ITEM-BACKUP',
              path: 'Compliance/ISMS/Evidence/2026/Q3',
              name: 'Backup-Job-Log-Sep-2026.xlsx',
              description: 'Backup job log MSCD-7Q2X9',
              createdAt: '2026-09-20T01:00:00Z',
              createdBy: BAGUS,
              versions: [
                { id: '1.0', content: 'backup log v1', modifiedAt: '2026-09-20T01:00:00Z', modifiedBy: BAGUS },
                { id: '2.0', content: 'backup log v2', modifiedAt: '2026-09-24T01:00:00Z', modifiedBy: BAGUS },
                { id: '3.0', content: 'backup log v3', modifiedAt: '2026-09-28T02:00:00Z', modifiedBy: BAGUS },
              ],
            },
            { id: 'ITEM-POLICY', path: 'Compliance/ISMS', name: 'Access-Control-Policy.pdf', content: '%PDF-1.7 policy', createdBy: BAGUS, createdAt: '2026-02-01T00:00:00Z' },
          ],
        },
        {
          id: 'drive-od-fnugroho',
          driveType: 'personal',
          tenantId: TENANT,
          owner: { displayName: 'F. Nugroho', email: 'f.nugroho@nusantaradigital.co.id' },
          forbidden: true,
          items: [{ id: 'ITEM-OD-NOTES', name: 'Notes.docx', content: 'personal notes' }],
        },
      ],
    },
    google: {
      drives: [
        {
          id: 'drive-gd-bcms',
          name: 'Compliance BCMS',
          folders: [{ id: 'folder-bcms-2026', path: 'Compliance BCMS/Evidence/2026' }],
          items: [
            {
              id: 'file-bia-notes',
              path: 'Compliance BCMS/Evidence/2026',
              name: 'BIA-Workshop-Notes-Sep',
              mimeType: 'application/vnd.google-apps.document',
              createdBy: TONO,
              versions: [{ id: '6', modifiedBy: TONO }, { id: '7', modifiedBy: TONO, modifiedAt: '2026-09-25T03:00:00Z' }],
            },
            {
              id: 'file-prioritised',
              path: 'Compliance BCMS/Evidence/2026',
              name: 'Prioritised-Activities-v1.xlsx',
              createdBy: TONO,
              createdAt: '2026-09-10T00:00:00Z',
              versions: [
                { id: 'rev-a', content: 'activities r1', modifiedAt: '2026-09-10T00:00:00Z' },
                { id: 'rev-b', content: 'activities r2', modifiedAt: '2026-09-12T00:00:00Z' },
                { id: 'rev-c', content: 'activities r3', modifiedAt: '2026-09-15T00:00:00Z' },
              ],
            },
          ],
        },
        {
          id: 'drive-my-tono',
          kind: 'my_drive',
          rootId: 'mydrive-root-tono',
          owner: TONO,
          items: [{ id: 'file-my-note', name: 'My-Note.txt', content: 'my note', createdBy: TONO }],
        },
      ],
    },
  };
}

export function build(options: MockProvidersOptions = {}): FastifyInstance {
  return buildMockProviders({ fixtures: standardFixtures(), ...options });
}

export interface CallOptions {
  token?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string | Buffer;
}

export async function call(app: FastifyInstance, method: InjectOptions['method'], url: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let payload: string | Buffer | undefined = options.body;
  if (options.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    payload = JSON.stringify(options.json);
  }
  return app.inject({ method, url: url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url, headers, payload });
}

export function form(params: Record<string, string>): CallOptions {
  return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() };
}

export async function graphTokenResponse(
  app: FastifyInstance,
  overrides: { tenant?: string; clientId?: string; audience?: string; cert?: SelfSignedCertificate; scope?: string; algorithm?: 'RS256' | 'PS256' } = {},
): Promise<Response> {
  const tenant = overrides.tenant ?? TENANT;
  const clientId = overrides.clientId ?? CLIENT_ID;
  const cert = overrides.cert ?? certificate();
  const assertion = await createM365ClientAssertion({
    clientId,
    certificatePem: cert.certificatePem,
    privateKeyPem: cert.privateKeyPem,
    audience: overrides.audience ?? `${ORIGIN}/${tenant}/oauth2/v2.0/token`,
    algorithm: overrides.algorithm,
  });
  return call(
    app,
    'POST',
    `/${tenant}/oauth2/v2.0/token`,
    form({
      grant_type: 'client_credentials',
      client_id: clientId,
      scope: overrides.scope ?? 'https://graph.microsoft.com/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }),
  );
}

export async function graphToken(app: FastifyInstance): Promise<string> {
  const response = await graphTokenResponse(app);
  if (response.statusCode !== 200) throw new Error(`token request failed: ${response.body}`);
  return response.json().access_token as string;
}

export async function googleTokenResponse(
  app: FastifyInstance,
  overrides: { clientEmail?: string; keyId?: string; audience?: string; scope?: string; subject?: string; cert?: SelfSignedCertificate; lifetimeSeconds?: number } = {},
): Promise<Response> {
  const cert = overrides.cert ?? certificate();
  const assertion = await createGoogleServiceAccountAssertion({
    clientEmail: overrides.clientEmail ?? SA_EMAIL,
    privateKeyPem: cert.privateKeyPem,
    keyId: overrides.keyId ?? SA_KEY_ID,
    audience: overrides.audience ?? `${ORIGIN}/token`,
    scope: overrides.scope ?? DRIVE_SCOPE,
    subject: overrides.subject,
    lifetimeSeconds: overrides.lifetimeSeconds,
  });
  return call(app, 'POST', '/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }));
}

export async function googleToken(app: FastifyInstance, overrides: { scope?: string; subject?: string } = {}): Promise<string> {
  const response = await googleTokenResponse(app, overrides);
  if (response.statusCode !== 200) throw new Error(`token request failed: ${response.body}`);
  return response.json().access_token as string;
}

/** Path and query of an absolute URL produced by the mock. */
export function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}
