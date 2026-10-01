// Google Drive adapter against the mock providers (build plan J.7, WP-15): every D.5 operation, the metadata
// mapping and checksums, every fault switch mapped to its E.4 link status (including a file inside a trashed
// folder), throttling, root and system-folder enforcement by parent walk, id validation before any request,
// zero-transit checks on a shared drive and a My Drive, keepForever, pass-through uploads (multipart and
// resumable), copies, and the OAuth code exchange of the repository consent flow.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { RunningMockProviders } from '@mscd/mock-providers';
import type { ObjectMetadata } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoogleDriveAdapter } from '../../../src/gateway/adapters/google-drive';
import { DRIVE_CHUNK_MULTIPLE } from '../../../src/gateway/adapters/google-drive';
import { GatewayError } from '../../../src/gateway/problems';
import {
  BAGUS,
  GD,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  PDF_BYTES,
  PLAN_R3,
  REDIRECT_URI,
  REFRESH_TOKEN,
  TONO,
  Waits,
  admin,
  googleAdapter,
  googleConfig,
  googleContext,
  lastSeq,
  linkStatus,
  refreshTokenCredential,
  requests,
  resetMock,
  scope,
  sha256,
  startMock,
  stored,
} from './helpers';

const BCMS = scope(GD.bcms, 'Compliance/BCMS');
const ROOT = scope(GD.root, 'Compliance');
const MY_DRIVE_CONFIG = googleConfig({ driveId: GD.myDrive, rootFolderId: GD.myFolder, roots: {} });

let mock: RunningMockProviders;
let waits: Waits;
let adapter: GoogleDriveAdapter;

async function expectProblem(promise: Promise<unknown>, slug: string): Promise<GatewayError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).slug).toBe(slug);
  return error as GatewayError;
}

async function linkPlan(): Promise<ObjectMetadata> {
  return adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.plan });
}

function bytes(size: number, seed = 3): Buffer {
  const out = Buffer.alloc(size);
  let state = seed;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state >>> 16;
  }
  return out;
}

function* chunks(content: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < content.length; offset += size) yield content.subarray(offset, offset + size);
}

function putInput(content: Buffer, options: { folderPath?: string; fileName?: string; contentLength?: number | null } = {}) {
  return {
    scopeRoot: BCMS,
    folderPath: options.folderPath ?? 'Evidence/2026/Q4',
    fileName: options.fileName ?? 'EV-0201-1.pdf',
    maxBytes: 100 * 1024 * 1024,
    metadataMinimization: false,
    body: Readable.from(chunks(content, 100_000)),
    contentLength: options.contentLength === undefined ? content.length : options.contentLength,
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
}

async function createFile(fields: Record<string, unknown>): Promise<string> {
  return (await admin<{ id: string }>(mock, 'POST', '/_admin/items', { driveId: GD.driveId, content: 'zero transit', ...fields })).id;
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
  adapter = googleAdapter(mock, waits);
  return async () => adapter.close();
});

describe('configuration and connection test', () => {
  it('validates the repository config with the D.2 schema', () => {
    expect(() => adapter.validateConfig('org', googleConfig())).not.toThrow();
    expect(() => adapter.validateConfig('org', googleConfig({ rootFolderId: 'folder!x' }))).toThrow(GatewayError);
  });

  it('connects to a shared drive as a member service account', async () => {
    const result = await adapter.testConnection(googleContext());
    expect(result).toMatchObject({ status: 'ok', ownership: 'organizational', permissions: ['read'] });
    expect(result.message.en).toBe('Connected to Compliance BCMS, Compliance');
    expect(result.credentialExpiresAt).toBeUndefined();
  });

  it('reports a My Drive as personal, for the service account it was shared with and for the delegated owner', async () => {
    expect(await adapter.testConnection(googleContext({ config: MY_DRIVE_CONFIG }))).toMatchObject({ status: 'ok', ownership: 'personal' });
    expect(await adapter.testConnection(googleContext({ config: MY_DRIVE_CONFIG, credential: refreshTokenCredential() }))).toMatchObject({
      status: 'ok',
      ownership: 'personal',
    });
  });

  it('reports a revoked refresh token as revoked, a root in another drive and a forbidden drive as failed', async () => {
    await admin(mock, 'POST', '/_admin/tokens/revoke', { refreshToken: REFRESH_TOKEN });
    const revoked = await adapter.testConnection(googleContext({ credential: refreshTokenCredential() }));
    expect(revoked.status).toBe('revoked');
    expect(revoked.message.en).toContain('invalid_grant');

    expect((await adapter.testConnection(googleContext({ config: googleConfig({ driveId: 'drive-somewhere-else' }) }))).status).toBe('failed');
    const beforeConsent = { ref: 'cred-gd-oauth', kind: 'oauth_refresh_token' as const, secret: { clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET } };
    expect(await adapter.testConnection(googleContext({ credential: beforeConsent }))).toMatchObject({ status: 'failed', message: { en: expect.stringContaining('complete the Google consent') } });
    await admin(mock, 'POST', `/_admin/drives/${GD.driveId}/forbid`, {});
    expect((await adapter.testConnection(googleContext())).status).toBe('failed');
  });

  it('is degraded when a system folder is missing or outside the root folder', async () => {
    const config = googleConfig({ roots: { bcms: { folderId: GD.bcms, path: 'Compliance/BCMS' }, gone: { folderId: 'folder-gone', path: 'Compliance/Gone' }, rogue: { folderId: GD.other, path: 'Other' } } });
    const result = await adapter.testConnection(googleContext({ config }));
    expect(result.status).toBe('degraded');
    expect(result.message.en).toContain('gone');
    expect(result.message.en).toContain('rogue');
  });
});

describe('list and ensure-folder', () => {
  it('lists the files of a folder below the system folder with checksums and head revisions', async () => {
    const page = await adapter.list(googleContext(), { scopeRoot: BCMS, folderPath: 'Evidence/2026' });
    expect(page.path).toBe('Compliance/BCMS/Evidence/2026');
    const byId = Object.fromEntries(page.items.map((item) => [item.externalItemId, item]));
    expect(Object.keys(byId).sort()).toEqual([GD.notes, GD.plan].sort());
    expect(byId[GD.plan]).toMatchObject({
      externalVersionId: 'rev-c',
      versionLabel: null,
      hashAlgorithm: 'sha256',
      hashValue: sha256(PLAN_R3),
      hashSource: 'provider',
      folderPath: 'Compliance/BCMS/Evidence/2026',
      folderId: GD.evidence,
      modifiedBy: TONO.displayName,
    });
    expect(byId[GD.notes]).toMatchObject({ mimeType: 'application/vnd.google-apps.document', hashAlgorithm: 'none', hashValue: null, hashSource: 'none' });
    expect((await adapter.list(googleContext(), { scopeRoot: BCMS })).items).toEqual([]);
  });

  it('refuses scope roots outside the repository, missing folders and paths with ..', async () => {
    await expectProblem(adapter.list(googleContext(), { scopeRoot: scope(GD.other, 'Other') }), 'outside-root');
    await expectProblem(adapter.list(googleContext(), { scopeRoot: BCMS, folderPath: 'Evidence/1999' }), 'not-found');
    const config = googleConfig({ roots: { rogue: { folderId: GD.other, path: 'Other' } } });
    await expectProblem(adapter.list(googleContext({ config }), { scopeRoot: scope(GD.other, 'Other') }), 'outside-root');
    const before = await lastSeq(mock);
    await expectProblem(adapter.list(googleContext(), { scopeRoot: BCMS, folderPath: '../ISMS' }), 'bad-request');
    expect(await requests(mock, 'drive', before)).toEqual([]);
  });

  it('creates a folder path below the root once and refuses one outside it', async () => {
    const created = await adapter.ensureFolder(googleContext(), 'Compliance/_packs/BCMS/Exercise 2026');
    expect(created.path).toBe('Compliance/_packs/BCMS/Exercise 2026');
    expect(await adapter.ensureFolder(googleContext(), '/Compliance/_packs/BCMS/Exercise 2026/')).toEqual(created);
    const view = await admin<{ kind: string; folderPath: string }>(mock, 'GET', `/_admin/items/${created.folderId}`);
    expect(view).toMatchObject({ kind: 'folder', folderPath: '/Compliance/_packs/BCMS' });
    await expectProblem(adapter.ensureFolder(googleContext(), 'Other/_packs'), 'outside-root');
    await expectProblem(adapter.ensureFolder(googleContext(), "Compliance/O'Brien/../x"), 'bad-request');
    // Names with quotes are escaped in the Drive query.
    const quoted = await adapter.ensureFolder(googleContext(), "Compliance/_packs/O'Brien Co");
    expect(await adapter.ensureFolder(googleContext(), "Compliance/_packs/O'Brien Co")).toEqual(quoted);
    expect(quoted.path).toBe("Compliance/_packs/O'Brien Co");
  });
});

describe('link and zero-transit registration', () => {
  it('links a binary file with its head revision, revision label and SHA-256', async () => {
    const metadata = await linkPlan();
    expect(metadata).toMatchObject({
      externalItemId: GD.plan,
      externalVersionId: 'rev-c',
      versionLabel: 'rev 3',
      name: 'BC-Plan-2026.pdf',
      mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength(PLAN_R3),
      hashAlgorithm: 'sha256',
      hashValue: sha256(PLAN_R3),
      hashSource: 'provider',
      providerCreatedAt: '2026-09-10T00:00:00.000Z',
      providerModifiedAt: '2026-09-15T00:00:00.000Z',
      modifiedBy: TONO.displayName,
      folderPath: 'Compliance/BCMS/Evidence/2026',
      folderId: GD.evidence,
      webUrl: `https://drive.google.com/file/d/${GD.plan}/view?usp=drivesdk`,
    });
  });

  it('links a Google Docs file without a checksum', async () => {
    const metadata = await adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.notes });
    expect(metadata).toMatchObject({ externalVersionId: '7', versionLabel: 'rev 2', hashAlgorithm: 'none', hashValue: null, hashSource: 'none' });
  });

  it('refuses folders, files of another system or outside the root, and bad ids before any request', async () => {
    await expectProblem(adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.evidence }), 'bad-request');
    await expectProblem(adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.ismsFile }), 'outside-root');
    await expectProblem(adapter.link(googleContext(), { scopeRoot: ROOT, externalItemId: GD.outside }), 'outside-root');
    await expectProblem(adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: 'file-does-not-exist' }), 'not-found');
    const before = await lastSeq(mock);
    for (const id of ['file/../x', 'file?alt=media', '..', 'file!bang', 'file%2F']) {
      await expectProblem(adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: id }), 'bad-request');
      await expectProblem(adapter.stat(googleContext(), { externalItemId: id, externalVersionId: null, hashAlgorithm: 'none', hashValue: null, hashSource: 'none', folderPath: null }), 'bad-request');
    }
    await expectProblem(adapter.list(googleContext(), { scopeRoot: scope('folder/..', 'x') }), 'bad-request');
    await expectProblem(adapter.copyWithin(googleContext(), [{ externalItemId: 'x?y', externalVersionId: null, hashAlgorithm: 'none', hashValue: null, hashSource: 'none', folderPath: null }], 'Compliance/x'), 'bad-request');
    // A revision id of pin-version is checked before the file is read, not only before it is used in a path.
    const pinRef = { externalItemId: GD.plan, hashAlgorithm: 'none' as const, hashValue: null, hashSource: 'none' as const, folderPath: null };
    for (const revisionId of ['rev/../x', '../x?y', 'rev%2F']) {
      await expectProblem(adapter.pinVersion(googleContext(), { ...pinRef, externalVersionId: revisionId }), 'bad-request');
    }
    await expectProblem(adapter.pinVersion(googleContext(), { ...pinRef, externalItemId: 'file?x', externalVersionId: 'rev-c' }), 'bad-request');
    expect(await requests(mock, undefined, before)).toEqual([]);
  });

  it('reads the root folder once per call, sharing it with the parent walk', async () => {
    await linkPlan(); // the token is cached from here on
    const rootPath = `/drive/v3/files/${GD.root}`;
    const rootReads = (logged: Awaited<ReturnType<typeof requests>>) =>
      logged.filter((request) => request.method === 'GET' && new URL(request.url, 'http://mock').pathname === rootPath).length;

    let before = await lastSeq(mock);
    await linkPlan();
    expect(rootReads(await requests(mock, undefined, before))).toBe(1);

    before = await lastSeq(mock);
    expect(await adapter.stat(googleContext(), stored(await linkPlan()))).toMatchObject({ outcome: 'found' });
    // Two calls (link, then stat): one root read each.
    expect(rootReads(await requests(mock, undefined, before))).toBe(2);

    before = await lastSeq(mock);
    expect(await adapter.pinVersion(googleContext(), stored(await linkPlan()))).toEqual({ result: 'ok' });
    expect(rootReads(await requests(mock, undefined, before))).toBe(2);
    // The system folder of the call is read once too.
    before = await lastSeq(mock);
    await linkPlan();
    const bcmsReads = (await requests(mock, undefined, before)).filter((request) => new URL(request.url, 'http://mock').pathname === `/drive/v3/files/${GD.bcms}`);
    expect(bcmsReads).toHaveLength(1);
  });

  it('registers a shared drive upload only for the intent folder, time, creator and correlation code', async () => {
    const intent = { folderPath: 'Compliance/BCMS/Uploads', notBefore: new Date(Date.now() - 60_000).toISOString(), correlationCode: 'MSCD-EB-0201-9K2Q', creatorEmail: TONO.email };
    const create = (fields: Record<string, unknown>) =>
      createFile({ path: 'Compliance/BCMS/Uploads', createdAt: new Date().toISOString(), createdBy: TONO, modifiedBy: TONO, ...fields });

    const good = await create({ name: 'EV-0201 MSCD-EB-0201-9K2Q.pdf' });
    expect(await adapter.registerClientUpload(googleContext(), { scopeRoot: BCMS, externalItemId: good, intent })).toMatchObject({
      externalItemId: good,
      createdByEmail: TONO.email,
      folderPath: 'Compliance/BCMS/Uploads',
      versionLabel: 'rev 1',
      hashAlgorithm: 'sha256',
      hashSource: 'provider',
    });
    const inDescription = await create({ name: 'EV-0201.pdf', description: 'MSCD-EB-0201-9K2Q' });
    await expect(adapter.registerClientUpload(googleContext(), { scopeRoot: BCMS, externalItemId: inDescription, intent })).resolves.toMatchObject({ externalItemId: inDescription });

    const otherAccount = await create({ name: 'EV-0202 MSCD-EB-0201-9K2Q.pdf', createdBy: BAGUS, modifiedBy: BAGUS });
    await expectProblem(adapter.registerClientUpload(googleContext(), { scopeRoot: BCMS, externalItemId: otherAccount, intent }), 'forbidden');
    const noCode = await create({ name: 'EV-0203.pdf' });
    await expectProblem(adapter.registerClientUpload(googleContext(), { scopeRoot: BCMS, externalItemId: noCode, intent }), 'forbidden');
    const early = await create({ name: 'EV-0204 MSCD-EB-0201-9K2Q.pdf', createdAt: '2026-01-01T00:00:00Z' });
    await expectProblem(adapter.registerClientUpload(googleContext(), { scopeRoot: BCMS, externalItemId: early, intent }), 'forbidden');
    const elsewhere = await create({ name: 'EV-0205 MSCD-EB-0201-9K2Q.pdf', path: 'Compliance/BCMS/Evidence/2026' });
    await expectProblem(adapter.registerClientUpload(googleContext(), { scopeRoot: BCMS, externalItemId: elsewhere, intent }), 'outside-root');
  });

  it('registers a My Drive upload by its owner', async () => {
    const intent = { folderPath: 'Compliance', notBefore: new Date(Date.now() - 60_000).toISOString(), correlationCode: 'MSCD-EB-0301-1A2B', creatorEmail: TONO.email };
    const id = (await admin<{ id: string }>(mock, 'POST', '/_admin/items', {
      driveId: GD.myDrive,
      path: 'Compliance',
      name: 'Exercise MSCD-EB-0301-1A2B.txt',
      createdAt: new Date().toISOString(),
      createdBy: TONO,
      content: 'exercise',
    })).id;
    const context = googleContext({ config: MY_DRIVE_CONFIG });
    const scopeRoot = scope(GD.myFolder, 'Compliance');
    expect(await adapter.registerClientUpload(context, { scopeRoot, externalItemId: id, intent })).toMatchObject({ createdByEmail: TONO.email, folderPath: 'Compliance' });
    await expectProblem(adapter.registerClientUpload(context, { scopeRoot, externalItemId: id, intent: { ...intent, creatorEmail: BAGUS.email } }), 'forbidden');
  });
});

describe('stat and the E.4 link status of every fault switch', () => {
  it('maps move, corrupt-hash, new-version, purge-version, forbid, throttle, revoke and delete', async () => {
    const object = stored(await linkPlan());
    const statusNow = async () => linkStatus(object, await adapter.stat(googleContext(), object));
    expect(await statusNow()).toBe('intact');
    expect(await adapter.stat(googleContext(), object)).toMatchObject({ pinnedHash: sha256(PLAN_R3), folderPath: 'Compliance/BCMS/Evidence/2026' });

    await admin(mock, 'POST', `/_admin/items/${GD.plan}/move`, {});
    expect(await statusNow()).toBe('moved');
    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/items/${GD.plan}/corrupt-hash`, {});
    expect(await statusNow()).toBe('hash_mismatch');
    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/items/${GD.plan}/new-version`, { versionId: 'rev-d', content: 'plan r4' });
    expect(await statusNow()).toBe('version_changed');
    await admin(mock, 'POST', `/_admin/items/${GD.plan}/purge-version`, {});
    expect(await statusNow()).toBe('pinned_version_lost');
    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/drives/${GD.driveId}/forbid`, {});
    expect(await statusNow()).toBe('access_denied');
    await resetMock(mock);
    await admin(mock, 'POST', '/_admin/throttle', { count: 20, retryAfterSeconds: 60 });
    expect(await adapter.stat(googleContext(), object)).toMatchObject({ outcome: 'rate_limited', retryAfterSeconds: 60 });
    await admin(mock, 'POST', '/_admin/throttle', { count: 0 });
    await admin(mock, 'POST', '/_admin/tokens/revoke', {});
    expect(await statusNow()).toBe('verification_pending (credential_invalid)');
    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/items/${GD.plan}/delete`, {});
    expect(await statusNow()).toBe('missing');
  });

  it('treats a file in the trash, and a file inside a trashed folder, as missing', async () => {
    const object = stored(await linkPlan());
    await admin(mock, 'POST', `/_admin/items/${GD.evidence}/delete`, { mode: 'trash' });
    const view = await admin<{ trashed: boolean; explicitlyTrashed: boolean }>(mock, 'GET', `/_admin/items/${GD.plan}`);
    expect(view).toMatchObject({ trashed: true, explicitlyTrashed: false });

    const result = await adapter.stat(googleContext(), object);
    expect(result).toEqual({ outcome: 'not_found', pinnedVersionAvailable: false });
    expect(linkStatus(object, result)).toBe('missing');
    const linked = await expectProblem(adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.plan }), 'not-found');
    expect(linked.message).toContain('trash');
    await expectProblem(adapter.openUrl(googleContext(), object), 'not-found');
    await expectProblem(adapter.list(googleContext(), { scopeRoot: BCMS, folderPath: 'Evidence/2026' }), 'not-found');

    await resetMock(mock);
    await admin(mock, 'POST', `/_admin/items/${GD.plan}/delete`, { mode: 'trash' });
    expect(linkStatus(object, await adapter.stat(googleContext(), object))).toBe('missing');
  });

  it('follows a new revision of a Google Docs file and reports a file moved outside the root as access denied', async () => {
    const notes = stored(await adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.notes }));
    await admin(mock, 'POST', `/_admin/items/${GD.notes}/new-version`, { versionId: '8' });
    expect(linkStatus(notes, await adapter.stat(googleContext(), notes))).toBe('version_changed');
    const object = stored(await linkPlan());
    await admin(mock, 'POST', `/_admin/items/${GD.plan}/move`, { path: 'Other/Archive' });
    expect(await adapter.stat(googleContext(), object)).toEqual({ outcome: 'forbidden', pinnedVersionAvailable: false });
  });

  it('retries throttled requests after Retry-After and reports a revoked refresh token as credential_invalid', async () => {
    const object = stored(await linkPlan());
    await admin(mock, 'POST', '/_admin/throttle', { count: 2, retryAfterSeconds: 2 });
    expect((await adapter.stat(googleContext(), object)).outcome).toBe('found');
    expect(waits.calls.filter((ms) => ms === 2000)).toHaveLength(2);

    const delegated = googleContext({ credential: refreshTokenCredential() });
    expect((await adapter.stat(delegated, object)).outcome).toBe('found');
    await admin(mock, 'POST', '/_admin/tokens/revoke', { refreshToken: REFRESH_TOKEN });
    expect(await adapter.stat(delegated, object)).toEqual({ outcome: 'unreachable', detail: 'credential_invalid', pinnedVersionAvailable: false });
  });

  it('reuses a token until five minutes before it expires', async () => {
    let now = Date.now();
    const clocked = googleAdapter(mock, waits, { now: () => new Date(now) });
    try {
      const object = stored(await linkPlan());
      const tokenRequests = async (since: number) => (await requests(mock, 'identity', since)).filter((entry) => entry.url === '/token').length;
      const before = await lastSeq(mock);
      await clocked.stat(googleContext(), object);
      now += 54 * 60 * 1000;
      await clocked.stat(googleContext(), object);
      expect(await tokenRequests(before)).toBe(1);
      // The mock issues tokens for 3599 seconds: 55 minutes later less than five minutes are left.
      now += 60 * 1000;
      await clocked.stat(googleContext(), object);
      expect(await tokenRequests(before)).toBe(2);
    } finally {
      await clocked.close();
    }
  });

  it('reuses the access token across calls', async () => {
    const before = await lastSeq(mock);
    const object = stored(await linkPlan());
    await adapter.stat(googleContext(), object);
    await adapter.list(googleContext(), { scopeRoot: BCMS });
    expect((await requests(mock, 'identity', before)).filter((entry) => entry.url === '/token')).toHaveLength(1);
  });
});

describe('pin-version, open-url and stream', () => {
  it('keeps the pinned revision of a binary file forever, and has nothing to pin for Google Docs', async () => {
    const object = stored(await linkPlan());
    expect(await adapter.pinVersion(googleContext(), object)).toEqual({ result: 'ok' });
    const view = await admin<{ versions: { id: string; keepForever: boolean }[] }>(mock, 'GET', `/_admin/items/${GD.plan}`);
    expect(view.versions.find((version) => version.id === 'rev-c')!.keepForever).toBe(true);
    expect(view.versions.find((version) => version.id === 'rev-a')!.keepForever).toBe(false);

    const notes = stored(await adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.notes }));
    expect(await adapter.pinVersion(googleContext(), notes)).toEqual({ result: 'unsupported' });
    await expectProblem(adapter.pinVersion(googleContext(), { ...object, externalVersionId: 'rev-zzz' }), 'not-found');
    await expectProblem(adapter.pinVersion(googleContext(), { ...object, externalItemId: GD.outside }), 'outside-root');
  });

  it('returns the Drive URL of a file below the root only', async () => {
    const object = stored(await linkPlan());
    expect(await adapter.openUrl(googleContext(), object)).toEqual({ url: `https://drive.google.com/file/d/${GD.plan}/view?usp=drivesdk` });
    await expectProblem(adapter.openUrl(googleContext(), { ...object, externalItemId: GD.outside }), 'outside-root');
  });

  it('streams the head revision or the pinned one of a pass-through object', async () => {
    const object = stored(await linkPlan());
    const head = await adapter.stream(googleContext(), object);
    expect(head).toMatchObject({ size: Buffer.byteLength(PLAN_R3), detectedType: 'text/plain' });
    expect((await readAll(head.stream)).toString()).toBe(PLAN_R3);

    await admin(mock, 'POST', `/_admin/items/${GD.plan}/new-version`, { versionId: 'rev-d', contentBase64: PDF_BYTES.toString('base64') });
    const pinned = await adapter.stream(googleContext(), object);
    expect((await readAll(pinned.stream)).toString()).toBe(PLAN_R3);
    const current = await adapter.stream(googleContext(), { ...object, externalVersionId: 'rev-d' });
    expect(current.detectedType).toBe('application/pdf');
    expect(await readAll(current.stream)).toEqual(PDF_BYTES);

    const notes = stored(await adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.notes }));
    await expectProblem(adapter.stream(googleContext(), notes), 'unsupported');
    await expectProblem(adapter.stream(googleContext({ modes: ['zero_transit'] }), object), 'unsupported');
  });
});

describe('pass-through uploads and copies', () => {
  it('uploads a small file in one multipart request', async () => {
    const result = await adapter.put(googleContext(), putInput(PDF_BYTES));
    expect(result).toMatchObject({
      versionLabel: 'rev 1',
      hashAlgorithm: 'sha256',
      hashValue: sha256(PDF_BYTES),
      hashSource: 'computed',
      sizeBytes: PDF_BYTES.length,
      detectedMimeType: 'application/pdf',
      folderPath: 'Compliance/BCMS/Evidence/2026/Q4',
    });
    const view = await admin<{ mimeType: string; currentVersionId: string; versions: { sha256: string }[] }>(mock, 'GET', `/_admin/items/${result.externalItemId}`);
    expect(view.currentVersionId).toBe(result.externalVersionId);
    expect(view.versions[0]!.sha256).toBe(sha256(PDF_BYTES));
    expect(view.mimeType).toBe('application/pdf');
  });

  it('streams a large file in resumable chunks of 256 KiB multiples, with or without a known length', async () => {
    const small = googleAdapter(mock, waits, { uploadChunkBytes: 4 * DRIVE_CHUNK_MULTIPLE });
    try {
      for (const contentLength of [null, undefined]) {
        const content = bytes(4 * 1024 * 1024 + 300_001, contentLength === null ? 5 : 6);
        const before = await lastSeq(mock);
        const result = await small.put(googleContext(), putInput(content, { fileName: 'Large-Export.bin', ...(contentLength === null ? { contentLength: null } : {}) }));
        expect(result).toMatchObject({ hashValue: sha256(content), sizeBytes: content.length, detectedMimeType: 'application/octet-stream' });
        const chunkRequests = (await requests(mock, undefined, before)).filter((entry) => entry.method === 'PUT' && entry.url.includes('upload_id='));
        expect(chunkRequests).toHaveLength(Math.ceil(content.length / (4 * DRIVE_CHUNK_MULTIPLE)));
        expect(chunkRequests.every((entry) => !entry.authorization)).toBe(true);
      }
    } finally {
      await small.close();
    }
  });

  it('copies files into the pack folder and refuses a changed source', async () => {
    const plan = stored(await linkPlan());
    const notes = stored(await adapter.link(googleContext(), { scopeRoot: BCMS, externalItemId: GD.notes }));
    const result = await adapter.copyWithin(googleContext(), [plan, notes], 'Compliance/_packs/BCMS/Exercise 2026');
    expect(result.items.map((item) => item.location)).toEqual([
      'Compliance/_packs/BCMS/Exercise 2026/BC-Plan-2026.pdf',
      'Compliance/_packs/BCMS/Exercise 2026/BIA-Workshop-Notes',
    ]);
    const view = await admin<{ folderPath: string; versions: { sha256: string }[] }>(mock, 'GET', `/_admin/items/${result.items[0]!.newItemId}`);
    expect(view.folderPath).toBe('/Compliance/_packs/BCMS/Exercise 2026');
    expect(view.versions[0]!.sha256).toBe(sha256(PLAN_R3));

    await admin(mock, 'POST', `/_admin/items/${GD.plan}/new-version`, { versionId: 'rev-d', content: 'plan r4' });
    await expectProblem(adapter.copyWithin(googleContext(), [plan], 'Compliance/_packs/BCMS/Exercise 2027'), 'unsupported');
    await expectProblem(adapter.copyWithin(googleContext(), [{ ...plan, externalItemId: GD.outside, externalVersionId: null }], 'Compliance/_packs/x'), 'outside-root');
  });
});

describe('OAuth consent: code exchange', () => {
  const verifier = 'v'.repeat(20) + 'erifier-of-the-pkce-flow-0123456789';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const clientCredential = { ref: 'cred-gd-oauth', kind: 'oauth_refresh_token' as const, secret: { clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET } };

  async function mintCode(account = TONO, offline = true): Promise<string> {
    return (await admin<{ code: string }>(mock, 'POST', '/_admin/oauth/codes', {
      clientId: OAUTH_CLIENT_ID,
      redirectUri: REDIRECT_URI,
      account: { email: account.email, displayName: account.displayName },
      scope: 'https://www.googleapis.com/auth/drive.file',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      offline,
    })).code;
  }

  it('exchanges a code, checks the root folder with the new token and returns the refresh token to seal', async () => {
    const code = await mintCode();
    const output = await adapter.exchangeOAuthCode(googleContext({ credential: clientCredential }), { code, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    expect(output.externalAccount).toBe(TONO.email);
    expect(output.secret).toEqual({ clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET, refreshToken: expect.stringMatching(/^1\/\//) });

    // The access token of the exchange is reused by the first call with the sealed credential.
    const before = await lastSeq(mock);
    const delegated = googleContext({ credential: { ref: 'cred-gd-oauth', kind: 'oauth_refresh_token', secret: output.secret } });
    expect((await adapter.testConnection(delegated)).status).toBe('ok');
    expect((await requests(mock, 'identity', before)).filter((entry) => entry.url === '/token')).toEqual([]);
  });

  it('refuses a reused code, a wrong verifier, a consent without offline access and an account without access to the root', async () => {
    const code = await mintCode();
    const context = googleContext({ credential: clientCredential });
    await expectProblem(adapter.exchangeOAuthCode(context, { code, redirectUri: REDIRECT_URI, codeVerifier: `${verifier}x` }), 'bad-request');
    const used = await mintCode();
    await adapter.exchangeOAuthCode(context, { code: used, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    await expectProblem(adapter.exchangeOAuthCode(context, { code: used, redirectUri: REDIRECT_URI, codeVerifier: verifier }), 'bad-request');
    await expectProblem(adapter.exchangeOAuthCode(context, { code: await mintCode(TONO, false), redirectUri: REDIRECT_URI, codeVerifier: verifier }), 'bad-request');
    const bagusCode = await mintCode(BAGUS);
    await expectProblem(
      adapter.exchangeOAuthCode(googleContext({ credential: clientCredential, config: MY_DRIVE_CONFIG }), { code: bagusCode, redirectUri: REDIRECT_URI, codeVerifier: verifier }),
      'not-found',
    );
    await expectProblem(adapter.exchangeOAuthCode(googleContext(), { code, redirectUri: REDIRECT_URI, codeVerifier: verifier }), 'forbidden');
  });
});
