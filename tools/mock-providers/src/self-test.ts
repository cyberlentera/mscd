import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSelfSignedCertificate } from './certs.js';
import { createGoogleServiceAccountAssertion, createM365ClientAssertion } from './client.js';
import { quickXorHash } from './quickxor.js';

// Round trip against a running mock (CLI `--self-test`): registers throwaway credentials and drives, then for
// Microsoft 365 and Google Drive obtains a token, lists a folder, uploads a file, checks the provider hash and
// lists the folder again. Throws on the first failure.

export async function runSelfTest(baseUrl: string, log: (line: string) => void = () => undefined): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = randomBytes(6).toString('hex').toUpperCase();
  const step = (name: string) => log(`self-test: ${name} ok`);

  const call = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string | Buffer } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: init.headers, body: init.body });
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: response.status, json: json as Record<string, unknown> };
  };
  const expect = (condition: boolean, message: string, detail?: unknown) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  };

  const health = await call('GET', '/_admin/health');
  expect(health.status === 200, 'health check failed', health.json);
  step('health');

  const certificate = createSelfSignedCertificate({ commonName: 'mscd-mock-providers-self-test' });
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const clientEmail = `self-test-${suffix.toLowerCase()}@mock-project.iam.gserviceaccount.com`;
  const keyId = `self-test-${suffix.toLowerCase()}`;
  const graphDrive = `b!self-test-${suffix}`;
  const graphFolder = `01SELFTEST${suffix}`;
  const googleDrive = `0AselfTest${suffix}`;
  const googleFolder = `1selfTest${suffix}`;
  const registered = await call('POST', '/_admin/fixtures', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credentials: [
        { kind: 'm365_certificate', tenantId, clientId, certificatePem: certificate.certificatePem, displayName: 'MSCD self-test' },
        { kind: 'google_service_account', clientEmail, publicKeyPem: certificate.publicKeyPem, privateKeyId: keyId },
      ],
      m365: { drives: [{ id: graphDrive, name: 'Self-test library', tenantId, folders: [{ id: graphFolder, path: 'SelfTest' }] }] },
      google: { drives: [{ id: googleDrive, name: 'Self-test shared drive', folders: [{ id: googleFolder, path: 'SelfTest' }] }] },
    }),
  });
  expect(registered.status === 200, 'registering the self-test fixtures failed', registered.json);
  step('fixtures');

  // Microsoft 365
  const tokenUrl = `/${tenantId}/oauth2/v2.0/token`;
  const assertion = await createM365ClientAssertion({
    clientId,
    certificatePem: certificate.certificatePem,
    privateKeyPem: certificate.privateKeyPem,
    audience: `${base}${tokenUrl}`,
  });
  const graphToken = await call('POST', tokenUrl, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      scope: 'https://graph.microsoft.com/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }).toString(),
  });
  expect(graphToken.status === 200 && typeof graphToken.json.access_token === 'string', 'Microsoft token request failed', graphToken.json);
  const graphAuth = { authorization: `Bearer ${graphToken.json.access_token as string}` };
  step('microsoft token');

  const childrenPath = `/v1.0/drives/${encodeURIComponent(graphDrive)}/items/${graphFolder}/children`;
  const before = await call('GET', childrenPath, { headers: graphAuth });
  expect(before.status === 200 && Array.isArray(before.json.value) && before.json.value.length === 0, 'Graph list failed', before.json);
  step('graph list');

  const graphContent = Buffer.from(`MSCD mock providers self-test ${suffix}\n`, 'utf8');
  const upload = await call('PUT', `/v1.0/drives/${encodeURIComponent(graphDrive)}/items/${graphFolder}:/${encodeURIComponent('self-test.txt')}:/content`, {
    headers: { ...graphAuth, 'content-type': 'text/plain' },
    body: graphContent,
  });
  const file = upload.json.file as { hashes?: { quickXorHash?: string } } | undefined;
  expect(upload.status === 201, 'Graph upload failed', upload.json);
  expect(file?.hashes?.quickXorHash === quickXorHash(graphContent), 'Graph quickXorHash differs from the uploaded content', file);
  step('graph upload');

  const after = await call('GET', childrenPath, { headers: graphAuth });
  const names = Array.isArray(after.json.value) ? (after.json.value as { name: string }[]).map((item) => item.name) : [];
  expect(after.status === 200 && names.includes('self-test.txt'), 'the uploaded file is missing from the Graph listing', after.json);
  step('graph list after upload');

  // Google Drive
  const googleAssertion = await createGoogleServiceAccountAssertion({
    clientEmail,
    privateKeyPem: certificate.privateKeyPem,
    keyId,
    audience: `${base}/token`,
    scope: 'https://www.googleapis.com/auth/drive',
  });
  const googleToken = await call('POST', '/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: googleAssertion }).toString(),
  });
  expect(googleToken.status === 200 && typeof googleToken.json.access_token === 'string', 'Google token request failed', googleToken.json);
  const googleAuth = { authorization: `Bearer ${googleToken.json.access_token as string}` };
  step('google token');

  const listQuery = new URLSearchParams({
    q: `'${googleFolder}' in parents and trashed = false`,
    corpora: 'drive',
    driveId: googleDrive,
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    fields: 'files(id,name,sha256Checksum),nextPageToken',
  }).toString();
  const listBefore = await call('GET', `/drive/v3/files?${listQuery}`, { headers: googleAuth });
  expect(listBefore.status === 200 && Array.isArray(listBefore.json.files) && listBefore.json.files.length === 0, 'Drive list failed', listBefore.json);
  step('drive list');

  const driveContent = Buffer.from(`MSCD mock providers self-test ${suffix} (Drive)\n`, 'utf8');
  const boundary = `self-test-${suffix}`;
  const multipart = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'self-test.txt', parents: [googleFolder] })}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    driveContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await call('POST', '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,parents,sha256Checksum', {
    headers: { ...googleAuth, 'content-type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  expect(created.status === 200, 'Drive upload failed', created.json);
  expect(created.json.sha256Checksum === createHash('sha256').update(driveContent).digest('hex'), 'Drive sha256Checksum differs from the uploaded content', created.json);
  step('drive upload');

  const listAfter = await call('GET', `/drive/v3/files?${listQuery}`, { headers: googleAuth });
  const ids = Array.isArray(listAfter.json.files) ? (listAfter.json.files as { id: string }[]).map((f) => f.id) : [];
  expect(listAfter.status === 200 && ids.includes(created.json.id as string), 'the uploaded file is missing from the Drive listing', listAfter.json);
  step('drive list after upload');
}
