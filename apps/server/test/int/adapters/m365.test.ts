// Microsoft 365 adapter against the mock providers (build plan J.7, WP-15): every D.5 operation, the metadata
// mapping and quickXorHash, every fault switch mapped to its E.4 link status, throttling backoff, token caching,
// root and system-folder enforcement, id validation before any request, zero-transit checks, pass-through uploads
// (simple and upload session) and copies through the asynchronous copy monitor.
import { Readable } from 'node:stream';
import type { RunningMockProviders } from '@mscd/mock-providers';
import type { ObjectMetadata } from '@mscd/shared';
import { createSelfSignedCertificate } from '@mscd/mock-providers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayError } from '../../../src/gateway/problems';
import type { M365Adapter } from '../../../src/gateway/adapters/m365';
import { GRAPH_FRAGMENT_MULTIPLE, QuickXorHash } from '../../../src/gateway/adapters/m365';
import { ProviderError } from '../../../src/gateway/adapters/m365/provider/errors';
import {
  BACKUP_V3,
  BAGUS,
  PDF_BYTES,
  SP,
  TONO,
  Waits,
  admin,
  lastSeq,
  linkStatus,
  m365Adapter,
  m365Config,
  m365Context,
  m365Credential,
  quickXorHash,
  requests,
  resetMock,
  scope,
  sha256,
  startMock,
  stored,
  testCertificate,
} from './helpers';

const ISMS = scope(SP.isms, 'Compliance/ISMS');
const ROOT = scope(SP.root, 'Compliance');

let mock: RunningMockProviders;
let waits: Waits;
let adapter: M365Adapter;

async function expectProblem(promise: Promise<unknown>, slug: string): Promise<GatewayError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).slug).toBe(slug);
  return error as GatewayError;
}

async function linkBackup(): Promise<ObjectMetadata> {
  return adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: SP.backup });
}

function putInput(content: Buffer, options: { folderPath?: string; fileName?: string; contentLength?: number | null; maxBytes?: number; chunked?: boolean } = {}) {
  const body = options.chunked ? Readable.from(chunks(content, 64 * 1024)) : Readable.from([content]);
  return {
    scopeRoot: ISMS,
    folderPath: options.folderPath ?? 'Evidence/2026/Q4',
    fileName: options.fileName ?? 'EV-0313-4.pdf',
    maxBytes: options.maxBytes ?? 100 * 1024 * 1024,
    metadataMinimization: true,
    body,
    contentLength: options.contentLength === undefined ? content.length : options.contentLength,
  };
}

function* chunks(content: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < content.length; offset += size) yield content.subarray(offset, offset + size);
}

function bytes(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let state = seed;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state >>> 16;
  }
  return out;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
}

beforeAll(async () => {
  mock = await startMock();
});

afterAll(async () => {
  await mock?.close();
});

beforeEach(async () => {
  await resetMock(mock);
  waits = new Waits();
  adapter = m365Adapter(mock, waits);
  return async () => adapter.close();
});

describe('configuration and connection test', () => {
  it('validates the repository config with the D.2 schema', () => {
    expect(() => adapter.validateConfig('org', m365Config())).not.toThrow();
    expect(() => adapter.validateConfig('org', m365Config({ driveId: 'drive/../x' }))).toThrow(GatewayError);
    expect(() => adapter.validateConfig('org', m365Config({ rootFolderId: undefined }))).toThrow(/rootFolderId/);
  });

  it('reports a working connection with the certificate expiry and organisational ownership', async () => {
    const result = await adapter.testConnection(m365Context());
    expect(result).toMatchObject({ status: 'ok', ownership: 'organizational', permissions: ['read'] });
    expect(result.credentialExpiresAt).toBe(testCertificate().notAfter.toISOString());
    expect(result.message.en).toContain('Compliance');
    expect(result.message.id).toContain('Terhubung');
  });

  it('reports personal ownership for OneDrive drives, personal and for Business (BR-30)', async () => {
    for (const [driveId, rootFolderId] of [[SP.personalDrive, SP.personalRoot], [SP.businessDrive, SP.businessRoot]] as const) {
      const config = m365Config({ driveId, rootFolderId, roots: {} });
      const result = await adapter.testConnection(m365Context({ config }));
      expect(result).toMatchObject({ status: 'ok', ownership: 'personal' });
      expect(result.message.en).toContain('files belong to one account');
    }
  });

  it('is degraded when a system folder lies outside the root folder', async () => {
    const config = m365Config({ roots: { isms: { folderId: SP.isms, path: 'Compliance/ISMS' }, rogue: { folderId: SP.other, path: 'Other' } } });
    const result = await adapter.testConnection(m365Context({ config }));
    expect(result.status).toBe('degraded');
    expect(result.message.en).toContain('rogue');
  });

  it('reports a revoked credential, an expired certificate and a key of another certificate as revoked', async () => {
    await admin(mock, 'POST', '/_admin/tokens/revoke', {});
    expect((await adapter.testConnection(m365Context())).status).toBe('revoked');

    const expired = createSelfSignedCertificate({ notBefore: new Date(Date.now() - 3 * 86_400_000), days: 1 });
    const old = await adapter.testConnection(m365Context({ credential: m365Credential({ certificatePem: expired.certificatePem, privateKeyPem: expired.privateKeyPem }) }));
    expect(old.status).toBe('revoked');
    expect(old.credentialExpiresAt).toBe(expired.notAfter.toISOString());

    const other = createSelfSignedCertificate();
    const mismatch = await adapter.testConnection(m365Context({ credential: m365Credential({ privateKeyPem: other.privateKeyPem }) }));
    expect(mismatch.status).toBe('revoked');
    expect(mismatch.message.en).toContain('does not belong');
  });

  it('fails when the drive is forbidden and when no credential is set', async () => {
    await admin(mock, 'POST', `/_admin/drives/${SP.driveId}/forbid`, {});
    expect(await adapter.testConnection(m365Context())).toMatchObject({ status: 'failed', permissions: [] });
    expect(await adapter.testConnection(m365Context({ credential: null }))).toMatchObject({
      status: 'failed',
      message: { en: 'The repository has no credential; add the certificate credential first', id: 'Kredensial repositori belum diatur atau belum lengkap' },
    });
  });
});

describe('list and ensure-folder', () => {
  it('lists the files of a system folder and of a folder below it', async () => {
    const top = await adapter.list(m365Context(), { scopeRoot: ISMS });
    expect(top.path).toBe('Compliance/ISMS');
    expect(top.items.map((item) => item.name)).toEqual(['Access-Control-Policy.pdf']);
    expect(top.items[0]).toMatchObject({ folderPath: 'Compliance/ISMS', hashAlgorithm: 'quickxor', hashSource: 'provider', externalVersionId: null });

    const q3 = await adapter.list(m365Context(), { scopeRoot: ISMS, folderPath: 'Evidence/2026/Q3' });
    expect(q3.path).toBe('Compliance/ISMS/Evidence/2026/Q3');
    expect(q3.items).toHaveLength(1);
    expect(q3.items[0]).toMatchObject({ externalItemId: SP.backup, hashValue: quickXorHash(BACKUP_V3), createdByEmail: BAGUS.email, modifiedBy: BAGUS.displayName });
  });

  it('pages with an opaque token', async () => {
    for (let i = 0; i < 3; i += 1) {
      await admin(mock, 'POST', '/_admin/items', { driveId: SP.driveId, path: 'Compliance/ISMS', name: `Paged-${i}.txt`, content: `page ${i}` });
    }
    await admin(mock, 'POST', '/_admin/settings', { graphPageSize: 2 });
    const names: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await adapter.list(m365Context(), { scopeRoot: ISMS, ...(pageToken ? { pageToken } : {}) });
      names.push(...result.items.map((item) => item.name));
      pageToken = result.nextPageToken;
      if (!pageToken) break;
      expect(pageToken).toMatch(/^g1\./);
    }
    expect(names.sort()).toEqual(['Access-Control-Policy.pdf', 'Paged-0.txt', 'Paged-1.txt', 'Paged-2.txt']);
    await expectProblem(adapter.list(m365Context(), { scopeRoot: ISMS, pageToken: 'https://evil.example/next' }), 'bad-request');
  });

  it('refuses a scope root that is not a root of the repository, a missing folder and a path with ..', async () => {
    await expectProblem(adapter.list(m365Context(), { scopeRoot: scope(SP.other, 'Other') }), 'outside-root');
    await expectProblem(adapter.list(m365Context(), { scopeRoot: scope(null as unknown as string, 'ISMS') }), 'outside-root');
    await expectProblem(adapter.list(m365Context(), { scopeRoot: ISMS, folderPath: 'Evidence/1999' }), 'not-found');
    const before = await lastSeq(mock);
    await expectProblem(adapter.list(m365Context(), { scopeRoot: ISMS, folderPath: 'Evidence/../../Other' }), 'bad-request');
    expect(await requests(mock, 'graph', before)).toEqual([]);
  });

  it('refuses a configured system folder that lies outside the repository root', async () => {
    const config = m365Config({ roots: { rogue: { folderId: SP.other, path: 'Other' } } });
    await expectProblem(adapter.list(m365Context({ config }), { scopeRoot: scope(SP.other, 'Other') }), 'outside-root');
  });

  it('creates a folder path below the root once and refuses one outside it', async () => {
    const created = await adapter.ensureFolder(m365Context(), '/Compliance/_packs/ISMS/Surveillance 1/');
    expect(created.path).toBe('Compliance/_packs/ISMS/Surveillance 1');
    const again = await adapter.ensureFolder(m365Context(), 'Compliance/_packs/ISMS/Surveillance 1');
    expect(again).toEqual(created);
    const view = await admin<{ kind: string; name: string; folderPath: string }>(mock, 'GET', `/_admin/items/${created.folderId}`);
    expect(view).toMatchObject({ kind: 'folder', name: 'Surveillance 1', folderPath: '/Compliance/_packs/ISMS' });
    await expectProblem(adapter.ensureFolder(m365Context(), 'Other/_packs'), 'outside-root');
    await expectProblem(adapter.ensureFolder(m365Context(), 'Compliance/../Other'), 'bad-request');
    await expectProblem(adapter.ensureFolder(m365Context(), 'Compliance/ISMS/Access-Control-Policy.pdf/x'), 'bad-request');
  });
});

describe('link and zero-transit registration', () => {
  it('links a file with its current version, quickXorHash and folder', async () => {
    const metadata = await linkBackup();
    expect(metadata).toEqual({
      externalItemId: SP.backup,
      externalVersionId: '3.0',
      versionLabel: 'v3.0',
      name: 'Backup-Job-Log-Sep-2026.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: Buffer.byteLength(BACKUP_V3),
      hashAlgorithm: 'quickxor',
      hashValue: quickXorHash(BACKUP_V3),
      hashSource: 'provider',
      providerCreatedAt: '2026-09-20T01:00:00.000Z',
      providerModifiedAt: '2026-09-28T02:00:00.000Z',
      modifiedBy: BAGUS.displayName,
      createdByEmail: BAGUS.email,
      folderPath: 'Compliance/ISMS/Evidence/2026/Q3',
      folderId: SP.ismsEvidence,
      webUrl: 'https://nusantaradigital.sharepoint.com/sites/compliance/Shared%20Documents/Compliance/ISMS/Evidence/2026/Q3/Backup-Job-Log-Sep-2026.xlsx',
    });
  });

  it('refuses folders, items of another system and items outside the root', async () => {
    await expectProblem(adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: SP.ismsEvidence }), 'bad-request');
    await expectProblem(adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: SP.qmsManual }), 'outside-root');
    await expectProblem(adapter.link(m365Context(), { scopeRoot: ROOT, externalItemId: SP.outside }), 'outside-root');
    await expectProblem(adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: 'ITEM-DOES-NOT-EXIST' }), 'not-found');
  });

  it('refuses ids with /, ? or .. before any request', async () => {
    const before = await lastSeq(mock);
    for (const id of ['ITEM/../ITEM-OUTSIDE', 'ITEM?select=x', '..', 'a b', 'ITEM%2F..']) {
      await expectProblem(adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: id }), 'bad-request');
      await expectProblem(adapter.stat(m365Context(), { externalItemId: id, externalVersionId: null, hashAlgorithm: 'none', hashValue: null, hashSource: 'none', folderPath: null }), 'bad-request');
    }
    await expectProblem(adapter.list(m365Context(), { scopeRoot: scope('FOLDER/..', 'x') }), 'bad-request');
    expect(await requests(mock, undefined, before)).toEqual([]);
  });

  it('registers a zero-transit upload only for the intent folder, time, creator and correlation code', async () => {
    const notBefore = new Date(Date.now() - 60_000).toISOString();
    const create = async (fields: Record<string, unknown>) =>
      (await admin<{ id: string }>(mock, 'POST', '/_admin/items', { driveId: SP.driveId, path: 'Compliance/ISMS/Uploads', createdAt: new Date().toISOString(), createdBy: TONO, content: 'zero transit', ...fields })).id;
    const intent = { folderPath: 'Compliance/ISMS/Uploads', notBefore, correlationCode: 'MSCD-EB-0101-7F3A', creatorEmail: TONO.email };

    const good = await create({ name: 'EV-0101 MSCD-EB-0101-7F3A.txt' });
    const registered = await adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: good, intent });
    expect(registered).toMatchObject({ externalItemId: good, createdByEmail: TONO.email, folderPath: 'Compliance/ISMS/Uploads', hashAlgorithm: 'quickxor', versionLabel: 'v1.0' });

    const inDescription = await create({ name: 'EV-0101.txt', description: 'upload MSCD-EB-0101-7F3A' });
    await expect(adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: inDescription, intent })).resolves.toMatchObject({ externalItemId: inDescription });

    const otherAccount = await create({ name: 'EV-0102 MSCD-EB-0101-7F3A.txt', createdBy: BAGUS });
    await expectProblem(adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: otherAccount, intent }), 'forbidden');

    const noCode = await create({ name: 'EV-0103.txt' });
    await expectProblem(adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: noCode, intent }), 'forbidden');

    const tooEarly = await create({ name: 'EV-0104 MSCD-EB-0101-7F3A.txt', createdAt: '2026-01-01T00:00:00Z' });
    await expectProblem(adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: tooEarly, intent }), 'forbidden');

    const elsewhere = (await admin<{ id: string }>(mock, 'POST', '/_admin/items', { driveId: SP.driveId, path: 'Compliance/ISMS/Other', name: 'EV-0105 MSCD-EB-0101-7F3A.txt', createdAt: new Date().toISOString(), createdBy: TONO, content: 'x' })).id;
    await expectProblem(adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: elsewhere, intent }), 'outside-root');

    const otherSystem = (await admin<{ id: string }>(mock, 'POST', '/_admin/items', { driveId: SP.driveId, path: 'Compliance/QMS/Uploads', name: 'EV-0106 MSCD-EB-0101-7F3A.txt', createdAt: new Date().toISOString(), createdBy: TONO, content: 'x' })).id;
    await expectProblem(
      adapter.registerClientUpload(m365Context(), { scopeRoot: ISMS, externalItemId: otherSystem, intent: { ...intent, folderPath: 'Compliance/QMS/Uploads' } }),
      'outside-root',
    );
  });
});

describe('stat and the E.4 link status of every fault switch', () => {
  it('is intact while nothing changed, and reports the pinned hash', async () => {
    const object = stored(await linkBackup());
    const result = await adapter.stat(m365Context(), object);
    expect(result).toMatchObject({ outcome: 'found', pinnedVersionAvailable: true, pinnedHash: quickXorHash(BACKUP_V3), folderPath: 'Compliance/ISMS/Evidence/2026/Q3' });
    expect(linkStatus(object, result)).toBe('intact');
  });

  it('maps move, new-version, purge-version, delete, corrupt-hash, forbid, revoke and throttle', async () => {
    const object = stored(await linkBackup());
    const statusNow = async () => linkStatus(object, await adapter.stat(m365Context(), object));

    await admin(mock, 'POST', `/_admin/items/${SP.backup}/move`, {});
    expect(await statusNow()).toBe('moved');
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/move`, { parentId: SP.ismsEvidence });
    expect(await statusNow()).toBe('intact');

    await admin(mock, 'POST', `/_admin/items/${SP.backup}/corrupt-hash`, {});
    expect(await statusNow()).toBe('hash_mismatch');

    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/new-version`, { content: 'backup log v4' });
    expect(await statusNow()).toBe('version_changed');
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/purge-version`, {});
    expect(await statusNow()).toBe('pinned_version_lost');

    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/drives/${SP.driveId}/forbid`, {});
    expect(await statusNow()).toBe('access_denied');

    await resetMock(mock);
    await admin(mock, 'POST', '/_admin/throttle', { count: 50, retryAfterSeconds: 120 });
    const throttled = await adapter.stat(m365Context(), object);
    expect(throttled).toMatchObject({ outcome: 'rate_limited', retryAfterSeconds: 120 });
    expect(linkStatus(object, throttled)).toBe('unchanged (rate limited)');
    await admin(mock, 'POST', '/_admin/throttle', { count: 0 });

    await admin(mock, 'POST', '/_admin/tokens/revoke', {});
    const revoked = await adapter.stat(m365Context(), object);
    expect(revoked).toEqual({ outcome: 'unreachable', detail: 'credential_invalid', pinnedVersionAvailable: false });
    expect(linkStatus(object, revoked)).toBe('verification_pending (credential_invalid)');

    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/delete`, {});
    expect(await statusNow()).toBe('missing');
  });

  it('reports an item moved outside the root as access denied, and a missing credential as credential_invalid', async () => {
    const object = stored(await linkBackup());
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/move`, { path: 'Other/Archive' });
    const outside = await adapter.stat(m365Context(), object);
    expect(outside).toEqual({ outcome: 'forbidden', pinnedVersionAvailable: false });
    expect(await adapter.stat(m365Context({ credential: null }), object)).toMatchObject({ outcome: 'unreachable', detail: 'credential_invalid' });
  });

  it('reports an unreachable provider without a credential detail', async () => {
    const object = stored(await linkBackup());
    const unreachable = m365Adapter(mock, waits, { requestTimeoutMs: 200 });
    await admin(mock, 'POST', '/_admin/latency', { ms: 1000, apis: ['graph'] });
    try {
      // The token request is not delayed; the Graph calls time out on every attempt.
      expect(await unreachable.stat(m365Context(), object)).toEqual({ outcome: 'unreachable', pinnedVersionAvailable: false });
    } finally {
      await admin(mock, 'POST', '/_admin/latency', { ms: 0 });
      await unreachable.close();
    }
  });
});

describe('throttling, retries and tokens', () => {
  it('waits for Retry-After and retries throttled requests (429 and 503)', async () => {
    const object = stored(await linkBackup());
    await admin(mock, 'POST', '/_admin/throttle', { count: 2, retryAfterSeconds: 1 });
    expect((await adapter.stat(m365Context(), object)).outcome).toBe('found');
    expect(waits.calls.filter((ms) => ms === 1000)).toHaveLength(2);

    waits.calls.length = 0;
    await admin(mock, 'POST', '/_admin/throttle', { count: 1, retryAfterSeconds: 2, status: 503 });
    expect((await adapter.stat(m365Context(), object)).outcome).toBe('found');
    expect(waits.calls).toContain(2000);
  });

  it('answers rate-limited with Retry-After when the provider keeps throttling', async () => {
    await admin(mock, 'POST', '/_admin/throttle', { count: 50, retryAfterSeconds: 3 });
    const problem = await expectProblem(linkBackup(), 'rate-limited');
    expect(problem.extras.retryAfter).toBe(3);
    // Four attempts: three waits of the announced three seconds.
    expect(waits.calls.filter((ms) => ms === 3000)).toHaveLength(3);
  });

  it('caches the token across calls and gets a new one when the API refuses it', async () => {
    const before = await lastSeq(mock);
    await linkBackup();
    await adapter.list(m365Context(), { scopeRoot: ISMS });
    await adapter.stat(m365Context(), stored(await linkBackup()));
    const tokenRequests = (await requests(mock, 'identity', before)).filter((entry) => entry.url.includes('/oauth2/v2.0/token'));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.url).toBe(`/${'11111111-2222-4333-8444-555555555555'}/oauth2/v2.0/token`);

    await admin(mock, 'POST', '/_admin/tokens/revoke', { accessTokensOnly: true });
    await linkBackup();
    expect((await requests(mock, 'identity', before)).filter((entry) => entry.url.includes('/oauth2/v2.0/token'))).toHaveLength(2);
  });

  it('reports a refused credential as unreachable with credentialInvalid', async () => {
    await admin(mock, 'POST', '/_admin/tokens/revoke', {});
    const problem = await expectProblem(linkBackup(), 'unreachable');
    expect(problem).toBeInstanceOf(ProviderError);
    expect((problem as ProviderError).credentialInvalid).toBe(true);
    await expectProblem(adapter.link(m365Context({ credential: null }), { scopeRoot: ISMS, externalItemId: SP.backup }), 'forbidden');
  });
});

describe('pass-through uploads', () => {
  it('stores a small file with one request, SHA-256 computed and the type detected', async () => {
    const result = await adapter.put(m365Context(), putInput(PDF_BYTES));
    expect(result).toMatchObject({
      externalVersionId: '1.0',
      versionLabel: 'v1.0',
      hashAlgorithm: 'sha256',
      hashValue: sha256(PDF_BYTES),
      hashSource: 'computed',
      sizeBytes: PDF_BYTES.length,
      detectedMimeType: 'application/pdf',
      folderPath: 'Compliance/ISMS/Evidence/2026/Q4',
    });
    const view = await admin<{ versions: { sha256: string }[]; createdBy: { displayName: string } }>(mock, 'GET', `/_admin/items/${result.externalItemId}`);
    expect(view.versions[0]!.sha256).toBe(sha256(PDF_BYTES));

    const second = await adapter.put(m365Context(), putInput(Buffer.from('<html><script>x</script></html>'), { fileName: 'EV-0313-4.pdf' }));
    expect(second.externalItemId).not.toBe(result.externalItemId);
    expect(second.detectedMimeType).toBe('application/octet-stream');
  });

  it('streams a large file through an upload session in 320 KiB multiples without sending the token to the upload URL', async () => {
    const small = m365Adapter(mock, waits, { uploadChunkBytes: 2 * GRAPH_FRAGMENT_MULTIPLE });
    try {
      const content = bytes(5 * 1024 * 1024 + 12_345);
      const before = await lastSeq(mock);
      const result = await small.put(m365Context(), putInput(content, { chunked: true, fileName: 'Big-Export.bin' }));
      expect(result).toMatchObject({ hashValue: sha256(content), sizeBytes: content.length, detectedMimeType: 'application/octet-stream' });
      const fragments = (await requests(mock, undefined, before)).filter((entry) => entry.url.startsWith('/_upload/graph/'));
      expect(fragments.length).toBe(Math.ceil(content.length / (2 * GRAPH_FRAGMENT_MULTIPLE)));
      expect(fragments.every((entry) => !entry.authorization)).toBe(true);
      const view = await admin<{ versions: { quickXorHash: string }[] }>(mock, 'GET', `/_admin/items/${result.externalItemId}`);
      expect(view.versions[0]!.quickXorHash).toBe(quickXorHash(content));
    } finally {
      await small.close();
    }
  });

  it('refuses a large upload without Content-Length, a body over maxBytes and bad file names', async () => {
    await expectProblem(adapter.put(m365Context(), putInput(bytes(4 * 1024 * 1024 + 1), { contentLength: null })), 'bad-request');
    await expectProblem(adapter.put(m365Context(), putInput(bytes(2048), { contentLength: null, maxBytes: 1024 })), 'too-large');
    await expectProblem(adapter.put(m365Context(), putInput(bytes(2048), { maxBytes: 1024 })), 'too-large');
    for (const fileName of ['a/b.pdf', '..', 'x:y.pdf', 'trailing.', ' lead.pdf']) {
      await expectProblem(adapter.put(m365Context(), putInput(PDF_BYTES, { fileName })), 'bad-request');
    }
    await expectProblem(adapter.put(m365Context(), putInput(PDF_BYTES, { folderPath: '../Other' })), 'bad-request');
    await expectProblem(adapter.put(m365Context(), { ...putInput(PDF_BYTES), scopeRoot: scope(SP.other, 'Other') }), 'outside-root');
  });
});

describe('open-url, stream, pin-version and copy-within', () => {
  it('returns the provider URL of an item below the root only', async () => {
    const object = stored(await linkBackup());
    expect((await adapter.openUrl(m365Context(), object)).url).toContain('/Compliance/ISMS/Evidence/2026/Q3/Backup-Job-Log-Sep-2026.xlsx');
    await expectProblem(adapter.openUrl(m365Context(), { ...object, externalItemId: SP.outside }), 'outside-root');
  });

  it('streams the pinned version of a pass-through object with its detected type', async () => {
    const policy = await adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: SP.policy });
    const current = await adapter.stream(m365Context(), stored(policy));
    expect(current.detectedType).toBe('application/pdf');
    expect(current.size).toBe(PDF_BYTES.length);
    expect(await readAll(current.stream)).toEqual(PDF_BYTES);

    const object = stored(await linkBackup());
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/new-version`, { content: 'backup log v4' });
    const pinned = await adapter.stream(m365Context(), object);
    expect((await readAll(pinned.stream)).toString()).toBe(BACKUP_V3);
    expect(pinned.detectedType).toBe('text/plain');

    await expectProblem(adapter.stream(m365Context({ modes: ['link'] }), object), 'unsupported');
    await admin(mock, 'POST', `/_admin/items/${SP.backup}/purge-version`, {});
    await expectProblem(adapter.stream(m365Context(), object), 'not-found');
  });

  it('has no version pinning (the gateway answers unsupported)', () => {
    expect((adapter as { pinVersion?: unknown }).pinVersion).toBeUndefined();
  });

  it('copies into the pack folder through the copy monitor, checking every source first', async () => {
    await admin(mock, 'POST', '/_admin/settings', { copyPendingPolls: 2 });
    const backup = stored(await linkBackup());
    const policy = stored(await adapter.link(m365Context(), { scopeRoot: ISMS, externalItemId: SP.policy }));
    const result = await adapter.copyWithin(m365Context(), [backup, policy], 'Compliance/_packs/ISMS/Surveillance 1');
    expect(result.items.map((item) => item.location)).toEqual([
      'Compliance/_packs/ISMS/Surveillance 1/Backup-Job-Log-Sep-2026.xlsx',
      'Compliance/_packs/ISMS/Surveillance 1/Access-Control-Policy.pdf',
    ]);
    for (const item of result.items) {
      const view = await admin<{ folderPath: string; versions: { quickXorHash: string }[] }>(mock, 'GET', `/_admin/items/${item.newItemId}`);
      expect(view.folderPath).toBe('/Compliance/_packs/ISMS/Surveillance 1');
    }
    expect(waits.calls.length).toBeGreaterThanOrEqual(4);

    // A second build into the same folder keeps both copies (rename on conflict).
    const again = await adapter.copyWithin(m365Context(), [backup], 'Compliance/_packs/ISMS/Surveillance 1');
    expect(again.items[0]!.location).not.toBe(result.items[0]!.location);

    const outside = { ...backup, externalItemId: SP.outside, externalVersionId: null };
    const before = await lastSeq(mock);
    await expectProblem(adapter.copyWithin(m365Context(), [backup, outside], 'Compliance/_packs/ISMS/Surveillance 2'), 'outside-root');
    expect((await requests(mock, 'graph', before)).filter((entry) => entry.method === 'POST')).toEqual([]);

    await admin(mock, 'POST', `/_admin/items/${SP.backup}/new-version`, { content: 'backup log v4' });
    await expectProblem(adapter.copyWithin(m365Context(), [backup], 'Compliance/_packs/ISMS/Surveillance 3'), 'unsupported');
    await expectProblem(adapter.copyWithin(m365Context(), [{ ...backup, externalVersionId: null }], 'Other/_packs'), 'outside-root');
  });
});

describe('quickXorHash', () => {
  it('matches the reference implementation of the mock providers', () => {
    expect(new QuickXorHash().digest()).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    for (const size of [1, 159, 160, 161, 1024, 65_537]) {
      const content = bytes(size, size);
      const split = new QuickXorHash();
      for (const part of chunks(content, 77)) split.update(part);
      expect(split.digest()).toBe(quickXorHash(content));
    }
  });
});
