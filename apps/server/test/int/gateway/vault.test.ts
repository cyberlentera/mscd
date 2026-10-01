// Storage gateway with the Managed Vault on a SeaweedFS container (D.5, D-08, D-10, F.11, F.13): data keys, put, stat,
// stream, copy-within and rehash; ciphertext at rest; changed and truncated objects detected; detected types;
// size limits; root and tenant enforcement; credential sealing and binding; OAuth exchange through an adapter;
// anchors; problems, the per-call log line and the metrics.
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { ObjectMetadata, PutResult, StatResult } from '@mscd/shared';
import { request } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managedVaultAdapterFactory } from '../../../src/gateway/adapters/managed-vault/vault-adapter';
import { CHUNK_SIZE, TAG_SIZE, ciphertextLength, parseHeader } from '../../../src/gateway/crypto/chunked';
import { kekIdOf } from '../../../src/modules/keys/file-key-provider';
import { MetricsService } from '../../../src/modules/platform/metrics';
import {
  SECRETS_DIR,
  VAULT_BUCKET,
  fakeDriveAdapter,
  gatewayCall,
  gatewayConfig,
  putObject,
  startGateway,
  startSeaweed,
  vaultEnv,
  type RunningGateway,
  type Seaweed,
} from './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ORG = '00000000-0000-4000-8000-00000000b001';
const OTHER_ORG = '00000000-0000-4000-8000-00000000b002';
const VAULT_ID = '11111111-1111-4111-8111-111111111111';
const GD_ID = '22222222-2222-4222-8222-222222222222';
const STORAGE_KEK_ID = kekIdOf(Buffer.from(readFileSync(path.join(SECRETS_DIR, 'storage.key'), 'utf8').trim(), 'base64'));

const drive = fakeDriveAdapter();
const driveCalls = drive.calls;

describe('storage gateway with the Managed Vault (D.5, D-10)', () => {
  let seaweed: Seaweed;
  let gateway: RunningGateway;
  let base: string;
  let tenant: { orgId: string; wrappedDek: string };
  let otherTenant: { orgId: string; wrappedDek: string };
  const vault = () => ({ id: VAULT_ID, slug: 'vault', adapter: 'managed_vault', modes: ['stored'], config: { prefix: `tenants/${ORG}/` } });
  const scopeRoot = { folderId: null, path: 'QMS' };
  const put = (content: Buffer, overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    putObject(base, { tenant, repository: vault(), scopeRoot, folderPath: 'Cl84', fileName: 'Supplier-Evaluation-Q3.pdf', maxBytes: 1024 * 1024, metadataMinimization: false, ...overrides }, content, { headers });
  const objectRef = (result: { externalItemId: string; hashValue?: string | null }) => ({
    externalItemId: result.externalItemId,
    externalVersionId: null,
    hashAlgorithm: 'sha256',
    hashValue: result.hashValue ?? null,
    hashSource: 'computed',
    folderPath: null,
  });
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const pdf = (size: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(size)]);
  const rawObject = async (key: string) => {
    const result = await seaweed.s3.send(new GetObjectCommand({ Bucket: VAULT_BUCKET, Key: key }));
    return { body: Buffer.from(await result.Body!.transformToByteArray()), metadata: result.Metadata ?? {} };
  };
  const countObjects = async (prefix: string) =>
    ((await seaweed.s3.send(new ListObjectsV2Command({ Bucket: VAULT_BUCKET, Prefix: prefix }))).Contents ?? []).length;

  beforeAll(async () => {
    seaweed = await startSeaweed();
    gateway = await startGateway(gatewayConfig(vaultEnv(seaweed)), { factories: [managedVaultAdapterFactory, drive.factory] });
    base = gateway.url;
    const issued = await gatewayCall(base, '/v1/keys/data-key', { orgId: ORG });
    tenant = { orgId: ORG, wrappedDek: issued.json<{ wrappedDek: string }>().wrappedDek };
    otherTenant = { orgId: OTHER_ORG, wrappedDek: (await gatewayCall(base, '/v1/keys/data-key', { orgId: OTHER_ORG })).json<{ wrappedDek: string }>().wrappedDek };
  });
  afterAll(async () => {
    await gateway?.close();
    await seaweed?.stop();
  });

  it('serves health and readiness with the storage key and the vault bucket', async () => {
    const health = await request(`${base}/healthz`);
    expect(health.statusCode).toBe(200);
    await health.body.dump();
    const ready = await request(`${base}/readyz`);
    const report = (await ready.body.json()) as { status: string; checks: { name: string; status: string }[] };
    expect(ready.statusCode).toBe(200);
    expect(report.checks.map((c) => [c.name, c.status])).toEqual(expect.arrayContaining([['storage-key', 'ok'], ['vault-bucket', 'ok']]));
  });

  it('requires the gateway token and answers problems', async () => {
    for (const token of [null, 'x'.repeat(43)]) {
      const response = await gatewayCall(base, '/v1/keys/data-key', { orgId: ORG }, { token });
      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/forbidden', status: 403, reason: 'token' });
    }
    expect((await gatewayCall(base, '/v1/nothing', {})).json()).toMatchObject({ status: 404, type: expect.stringMatching(/not-found$/) });
    expect((await gatewayCall(base, '/v1/keys/data-key', { orgId: 'ndt' })).status).toBe(400);
    const notJson = await gatewayCall(base, '/v1/stat', undefined, { body: '{', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);
  });

  it('issues tenant data keys wrapped with storage.key (C.8 step 4)', async () => {
    const issued = await gatewayCall(base, '/v1/keys/data-key', { orgId: ORG });
    expect(issued.status).toBe(200);
    expect(issued.json()).toEqual({ wrappedDek: expect.stringMatching(new RegExp(`^v1\\.${STORAGE_KEK_ID}\\.`)), kekId: STORAGE_KEK_ID });
  });

  it('stores encrypted objects, hashes while streaming and streams the plaintext back', async () => {
    const content = pdf(200_000);
    const response = await put(content, {}, { 'x-request-id': 'req-wp13-put-0001' });
    expect(response.status).toBe(200);
    const result = PutResult.parse(response.json());
    expect(result).toMatchObject({
      externalItemId: expect.stringMatching(new RegExp(`^tenants/${ORG}/[0-9a-f-]{36}$`)),
      externalVersionId: null,
      hashAlgorithm: 'sha256',
      hashValue: sha256(content),
      hashSource: 'computed',
      sizeBytes: content.length,
      detectedMimeType: 'application/pdf',
      folderPath: 'QMS/Cl84',
      encryption: { v: 1, alg: 'A256GCM-CHUNK64K' },
    });

    // At rest: ciphertext only, with the F.11 header and the metadata the gateway computed.
    const raw = await rawObject(result.externalItemId);
    expect(raw.body.equals(content)).toBe(false);
    expect(raw.body.includes(content.subarray(0, 64))).toBe(false);
    expect(raw.body.length).toBe(ciphertextLength(content.length));
    const header = parseHeader(raw.metadata['mscd-enc']);
    expect(header).toMatchObject({ v: 1, alg: 'A256GCM-CHUNK64K', cid: result.externalItemId.split('/').pop() });
    expect(header!.ck.startsWith('v1.')).toBe(true);
    expect(raw.metadata).toMatchObject({ 'mscd-sha256': sha256(content), 'mscd-size': String(content.length), 'mscd-type': 'application/pdf', 'mscd-name': 'Supplier-Evaluation-Q3.pdf' });

    const stat = StatResult.parse((await gatewayCall(base, '/v1/stat', { tenant, repository: vault(), object: objectRef(result) })).json());
    expect(stat).toMatchObject({ outcome: 'found', pinnedVersionAvailable: true, folderPath: 'QMS/Cl84', pinnedHash: sha256(content) });
    expect(ObjectMetadata.parse(stat.current)).toMatchObject({ hashValue: sha256(content), sizeBytes: content.length, name: 'Supplier-Evaluation-Q3.pdf', webUrl: null });

    const streamed = await gatewayCall(base, '/v1/stream', { tenant, repository: vault(), object: objectRef(result) });
    expect(streamed.status).toBe(200);
    expect(streamed.headers['content-type']).toBe('application/octet-stream');
    expect(streamed.headers['content-length']).toBe(String(content.length));
    expect(streamed.headers['x-mscd-detected-type']).toBe('application/pdf');
    expect(streamed.body.equals(content)).toBe(true);

    const rehash = await gatewayCall(base, '/v1/rehash', { tenant, repository: vault(), object: objectRef(result) });
    expect(rehash.json()).toEqual({ hashValue: sha256(content), matches: true });
    const wrong = await gatewayCall(base, '/v1/rehash', { tenant, repository: vault(), object: { ...objectRef(result), hashValue: '0'.repeat(64) } });
    expect(wrong.json()).toEqual({ hashValue: sha256(content), matches: false });
  });

  it('stores empty files and exact chunk multiples', async () => {
    for (const content of [Buffer.alloc(0), randomBytes(2 * CHUNK_SIZE)]) {
      const result = PutResult.parse((await put(content)).json());
      expect(result.sizeBytes).toBe(content.length);
      expect(result.detectedMimeType).toBe('application/octet-stream');
      const streamed = await gatewayCall(base, '/v1/stream', { tenant, repository: vault(), object: objectRef(result) });
      expect(streamed.body.equals(content)).toBe(true);
    }
  });

  it('keeps no file name with metadata minimisation', async () => {
    const result = PutResult.parse((await put(Buffer.from('plain text evidence\n'), { metadataMinimization: true, fileName: 'EV-0103-4.txt' })).json());
    expect(result.detectedMimeType).toBe('text/plain');
    const raw = await rawObject(result.externalItemId);
    expect(raw.metadata['mscd-name']).toBeUndefined();
  });

  it('detects HTML and SVG as application/octet-stream whatever the file name says (F.13)', async () => {
    for (const [fileName, text] of [
      ['report.pdf', '<!DOCTYPE html><html><body><script>alert(document.cookie)</script></body></html>'],
      ['diagram.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ]) {
      const result = PutResult.parse((await put(Buffer.from(text!), { fileName })).json());
      expect(result.detectedMimeType).toBe('application/octet-stream');
      const streamed = await gatewayCall(base, '/v1/stream', { tenant, repository: vault(), object: objectRef(result) });
      expect(streamed.headers['x-mscd-detected-type']).toBe('application/octet-stream');
    }
  });

  it('refuses files above maxBytes, announced or streamed, and leaves no object behind', async () => {
    const before = await countObjects(`tenants/${ORG}/`);
    const announced = await put(randomBytes(5000), { maxBytes: 1000 });
    expect(announced.status).toBe(413);
    expect(announced.json()).toMatchObject({ type: expect.stringMatching(/too-large$/) });
    const header = Buffer.from(
      JSON.stringify({ tenant, repository: vault(), scopeRoot, folderPath: 'Cl84', fileName: 'big.bin', maxBytes: 100_000, metadataMinimization: false }),
    ).toString('base64');
    // A streamed body without Content-Length is counted while it passes.
    const streamed = await request(`${base}/v1/objects`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${readFileSync(path.join(SECRETS_DIR, 'gateway.token'), 'utf8').trim()}`, 'content-type': 'application/octet-stream', 'x-mscd-put': header },
      body: Readable.from((function* () {
        for (let i = 0; i < 40; i += 1) yield randomBytes(8192);
      })()),
    });
    expect(streamed.statusCode).toBe(413);
    await streamed.body.dump();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await countObjects(`tenants/${ORG}/`)).toBe(before);
  });

  it('copies within the vault server-side with a re-sealed content key', async () => {
    const content = pdf(70_000);
    const original = PutResult.parse((await put(content)).json());
    const response = await gatewayCall(base, '/v1/copy-within', {
      tenant,
      repository: vault(),
      objects: [objectRef(original)],
      targetFolderPath: 'Compliance/_packs/QMS/Surveillance 1',
    });
    expect(response.status).toBe(200);
    const [copy] = response.json<{ items: { externalItemId: string; newItemId: string; location: string }[] }>().items;
    expect(copy).toMatchObject({ externalItemId: original.externalItemId, location: 'Compliance/_packs/QMS/Surveillance 1/Supplier-Evaluation-Q3.pdf' });
    expect(copy!.newItemId).not.toBe(original.externalItemId);
    const [source, target] = [await rawObject(original.externalItemId), await rawObject(copy!.newItemId)];
    expect(target.body.equals(source.body)).toBe(true);
    const [sourceHeader, targetHeader] = [parseHeader(source.metadata['mscd-enc']), parseHeader(target.metadata['mscd-enc'])];
    expect(targetHeader!.cid).toBe(sourceHeader!.cid);
    expect(targetHeader!.ck).not.toBe(sourceHeader!.ck);
    const streamed = await gatewayCall(base, '/v1/stream', { tenant, repository: vault(), object: { ...objectRef(original), externalItemId: copy!.newItemId } });
    expect(streamed.body.equals(content)).toBe(true);
    const stat = StatResult.parse((await gatewayCall(base, '/v1/stat', { tenant, repository: vault(), object: { ...objectRef(original), externalItemId: copy!.newItemId } })).json());
    expect(stat.current?.folderPath).toBe('Compliance/_packs/QMS/Surveillance 1');
  });

  it('detects a changed byte: stream fails with a problem, rehash never matches', async () => {
    const content = pdf(100_000);
    const result = PutResult.parse((await put(content)).json());
    const raw = await rawObject(result.externalItemId);
    const tampered = Buffer.from(raw.body);
    tampered[10] ^= 0x01;
    await seaweed.s3.send(new PutObjectCommand({ Bucket: VAULT_BUCKET, Key: result.externalItemId, Body: tampered, Metadata: raw.metadata }));
    const streamed = await gatewayCall(base, '/v1/stream', { tenant, repository: vault(), object: objectRef(result) });
    expect(streamed.status).toBe(500);
    expect(streamed.json()).toMatchObject({ type: expect.stringMatching(/internal$/) });
    const rehash = await gatewayCall(base, '/v1/rehash', { tenant, repository: vault(), object: objectRef(result) });
    expect(rehash.json()).toEqual({ hashValue: sha256(tampered), matches: false, detail: 'decryption_failed' });
  });

  it('detects a truncated object, also when it is cut at a chunk boundary', async () => {
    const content = randomBytes(3 * CHUNK_SIZE + 100);
    const result = PutResult.parse((await put(content)).json());
    const raw = await rawObject(result.externalItemId);
    const cut = raw.body.subarray(0, 3 * (CHUNK_SIZE + TAG_SIZE));
    await seaweed.s3.send(new PutObjectCommand({ Bucket: VAULT_BUCKET, Key: result.externalItemId, Body: cut, Metadata: raw.metadata }));
    const rehash = await gatewayCall(base, '/v1/rehash', { tenant, repository: vault(), object: objectRef(result) });
    expect(rehash.json()).toMatchObject({ matches: false, detail: 'decryption_failed' });
    // The first chunks decrypt, so the answer has started: the gateway aborts it instead of finishing it.
    let delivered = -1;
    try {
      const response = await request(`${base}/v1/stream`, {
        method: 'POST',
        headers: { authorization: `Bearer ${readFileSync(path.join(SECRETS_DIR, 'gateway.token'), 'utf8').trim()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenant, repository: vault(), object: objectRef(result) }),
      });
      delivered = Buffer.from(await response.body.arrayBuffer()).length;
    } catch {
      delivered = -1;
    }
    expect(delivered).not.toBe(content.length);
  });

  it('keeps every call inside the tenant prefix of the repository (D.5 root enforcement)', async () => {
    const own = PutResult.parse((await put(Buffer.from('x'))).json());
    const foreignKey = own.externalItemId.replace(ORG, OTHER_ORG);
    for (const externalItemId of [foreignKey, `tenants/${ORG}/../${OTHER_ORG}/x`, 'audit-anchors/platform/2026-09-29.json', `tenants/${ORG}/not-a-uuid`]) {
      const response = await gatewayCall(base, '/v1/stat', { tenant, repository: vault(), object: { ...objectRef(own), externalItemId } });
      expect(response.status, externalItemId).toBe(403);
      expect(response.json()).toMatchObject({ type: expect.stringMatching(/outside-root$/) });
    }
    // A config that points into another organisation's prefix is refused before anything is read.
    const foreignRepo = { ...vault(), config: { prefix: `tenants/${OTHER_ORG}/` } };
    const refused = await gatewayCall(base, '/v1/stat', { tenant, repository: foreignRepo, object: objectRef(own) });
    expect(refused.json()).toMatchObject({ status: 403, reason: 'tenant-prefix' });
    // Another organisation's data key cannot be used for this organisation.
    const wrongKey = await gatewayCall(base, '/v1/stat', { tenant: { orgId: ORG, wrappedDek: otherTenant.wrappedDek }, repository: vault(), object: objectRef(own) });
    expect(wrongKey.status).toBe(400);
    // Even with its own key, the other organisation cannot open this organisation's object.
    const otherVault = { ...vault(), config: { prefix: `tenants/${OTHER_ORG}/` } };
    const crossKey = await gatewayCall(base, '/v1/stream', { tenant: otherTenant, repository: otherVault, object: { ...objectRef(own), externalItemId: foreignKey } });
    expect(crossKey.status).toBe(404);
  });

  it('answers unsupported operations of the vault as D.5 says', async () => {
    const own = PutResult.parse((await put(Buffer.from('y'))).json());
    expect((await gatewayCall(base, '/v1/open-url', { tenant, repository: vault(), object: objectRef(own) })).status).toBe(422);
    expect((await gatewayCall(base, '/v1/pin-version', { tenant, repository: vault(), object: objectRef(own) })).json()).toEqual({ result: 'unsupported' });
    expect((await gatewayCall(base, '/v1/link', { tenant, repository: vault(), scopeRoot, externalItemId: own.externalItemId })).status).toBe(422);
    const m365 = { id: GD_ID, slug: 'sp', adapter: 'm365', modes: ['link'], config: { siteId: 's', driveId: 'd', rootFolderId: 'r', roots: {} } };
    const response = await gatewayCall(base, '/v1/test-connection', { tenant, repository: m365 });
    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject({ type: expect.stringMatching(/unsupported$/) });
  });

  it('labels folders and lists the objects of one folder', async () => {
    const folder = await gatewayCall(base, '/v1/ensure-folder', { tenant, repository: vault(), path: '/Compliance//_packs/ISMS/' });
    expect(folder.json()).toMatchObject({ path: 'Compliance/_packs/ISMS', folderId: expect.stringMatching(/^vault:/) });
    expect((await gatewayCall(base, '/v1/ensure-folder', { tenant, repository: vault(), path: 'a/../b' })).status).toBe(400);
    const result = PutResult.parse((await put(Buffer.from('listed'), { folderPath: 'ListMe', fileName: 'listed.txt' })).json());
    const listing = await gatewayCall(base, '/v1/list', { tenant, repository: vault(), scopeRoot, folderPath: 'ListMe' });
    expect(listing.status).toBe(200);
    const body = listing.json<{ path: string; items: { externalItemId: string; name: string }[] }>();
    expect(body.path).toBe('QMS/ListMe');
    expect(body.items.map((i) => [i.externalItemId, i.name])).toEqual([[result.externalItemId, 'listed.txt']]);
  });

  it('seals credentials bound to the repository config and refuses them with another drive or root (D-08)', async () => {
    const config = { driveId: 'drive-gd-bcms', rootFolderId: 'root-compliance', roots: { bcms: { folderId: 'f-bcms', path: 'Compliance/BCMS' } } };
    const repository = { id: GD_ID, slug: 'gd', adapter: 'google_drive', modes: ['zero_transit', 'link'], config };
    const secret = { clientEmail: 'mscd@project.iam.gserviceaccount.com', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n' };
    const sealedResponse = await gatewayCall(base, '/v1/credentials/seal', { tenant, repository, kind: 'google_service_account', secret });
    expect(sealedResponse.status).toBe(200);
    const sealed = sealedResponse.json<{ sealedBlob: string; keyId: string; configSha256: string }>();
    expect(sealed.sealedBlob).not.toContain('MIIE');
    const credential = { ref: 'cred-gd', sealedBlob: sealed.sealedBlob, kind: 'google_service_account' };

    driveCalls.length = 0;
    const ok = await gatewayCall(base, '/v1/test-connection', { tenant, repository: { ...repository, credential } });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', latencyMs: expect.any(Number) });
    expect(driveCalls[0]!.credential).toEqual({ ref: 'cred-gd', kind: 'google_service_account', secret });

    for (const changed of [{ ...config, driveId: 'drive-other' }, { ...config, rootFolderId: 'root-other' }, { ...config, roots: { bcms: { folderId: 'f-x', path: 'Compliance/BCMS' } } }]) {
      const refused = await gatewayCall(base, '/v1/test-connection', { tenant, repository: { ...repository, config: changed, credential } });
      expect(refused.status).toBe(403);
      expect(refused.json()).toMatchObject({ reason: 'credential-binding' });
    }
    const otherRepository = await gatewayCall(base, '/v1/test-connection', { tenant, repository: { ...repository, id: VAULT_ID, credential } });
    expect(otherRepository.json()).toMatchObject({ status: 403, reason: 'credential-binding' });
    const otherOrganisation = await gatewayCall(base, '/v1/test-connection', { tenant: otherTenant, repository: { ...repository, credential } });
    expect(otherOrganisation.json()).toMatchObject({ status: 403, reason: 'credential-binding' });
    const wrongKind = await gatewayCall(base, '/v1/test-connection', { tenant, repository: { ...repository, credential: { ...credential, kind: 'm365_certificate' } } });
    expect(wrongKind.json()).toMatchObject({ status: 403, reason: 'credential-kind' });
    // A root folder outside the configured roots is refused before the adapter runs.
    const outside = await gatewayCall(base, '/v1/list', { tenant, repository: { ...repository, credential }, scopeRoot: { folderId: 'f-elsewhere', path: 'X' } });
    expect(outside.json()).toMatchObject({ type: expect.stringMatching(/outside-root$/) });

    // A refresh token is never accepted for sealing, and the vault takes no credential.
    const withToken = await gatewayCall(base, '/v1/credentials/seal', { tenant, repository, kind: 'oauth_refresh_token', secret: { clientId: 'c', clientSecret: 's', refreshToken: 'r' } });
    expect(withToken.status).toBe(400);
    expect((await gatewayCall(base, '/v1/credentials/seal', { tenant, repository: vault(), kind: 'google_service_account', secret })).status).toBe(422);
  });

  it('exchanges an OAuth code through the adapter and seals the refresh token (F.8)', async () => {
    const config = { driveId: 'drive-gd-bcms', rootFolderId: 'root-compliance', oauthClientId: 'client-1', roots: {} };
    const repository = { id: GD_ID, slug: 'gd', adapter: 'google_drive', modes: ['zero_transit', 'link'], config };
    const client = (await gatewayCall(base, '/v1/credentials/seal', { tenant, repository, kind: 'oauth_refresh_token', secret: { clientId: 'client-1', clientSecret: 'shh-client-secret' } })).json<{ sealedBlob: string }>();
    driveCalls.length = 0;
    const response = await gatewayCall(base, '/v1/credentials/oauth-exchange', {
      tenant,
      repository,
      credential: { ref: 'cred-gd-client', sealedBlob: client.sealedBlob, kind: 'oauth_refresh_token' },
      code: 'code-123',
      redirectUri: 'http://localhost:4174/api/v1/admin/storage/repositories/oauth/callback',
      codeVerifier: 'v'.repeat(43),
    });
    expect(response.status).toBe(200);
    const sealed = response.json<{ sealedBlob: string; externalAccount: string; configSha256: string }>();
    expect(sealed.externalAccount).toBe('tono.hartono@example.test');
    expect(sealed.sealedBlob).not.toContain('refresh-for');
    expect(driveCalls[0]).toMatchObject({ operation: 'oauth', input: { code: 'code-123', codeVerifier: 'v'.repeat(43) } });
    driveCalls.length = 0;
    await gatewayCall(base, '/v1/test-connection', { tenant, repository: { ...repository, credential: { ref: 'cred-gd-2', sealedBlob: sealed.sealedBlob, kind: 'oauth_refresh_token' } } });
    expect(driveCalls[0]!.credential?.secret).toEqual({ clientId: 'client-1', clientSecret: 'shh-client-secret', refreshToken: 'refresh-for-code-123' });
    // The vault has no OAuth consent.
    const vaultExchange = await gatewayCall(base, '/v1/credentials/oauth-exchange', {
      tenant,
      repository: vault(),
      credential: { ref: 'x', sealedBlob: client.sealedBlob, kind: 'oauth_refresh_token' },
      code: 'c',
      redirectUri: 'http://localhost/cb',
      codeVerifier: 'v'.repeat(43),
    });
    expect(vaultExchange.status).toBe(403);
  });

  it('writes audit anchors once under audit-anchors/ and never overwrites one (D-33)', async () => {
    const objectKey = `audit-anchors/platform/2026-09-29-${randomBytes(3).toString('hex')}.json`;
    const body = { chain: 'platform', seq: 120, rowHash: 'ab'.repeat(32), signature: 'ed25519:x' };
    const first = await gatewayCall(base, '/v1/anchors', { tenant: null, objectKey, body });
    expect(first.json()).toEqual({ location: `s3://${VAULT_BUCKET}/${objectKey}` });
    expect((await gatewayCall(base, '/v1/anchors', { tenant: null, objectKey, body })).json()).toEqual({ location: `s3://${VAULT_BUCKET}/${objectKey}` });
    const other = await gatewayCall(base, '/v1/anchors', { tenant: null, objectKey, body: { ...body, seq: 121 } });
    expect(other.json()).toEqual({ location: `s3://${VAULT_BUCKET}/${objectKey.replace(/\.json$/, '-2.json')}` });
    expect(JSON.parse((await rawObject(objectKey)).body.toString('utf8'))).toEqual(body);
    expect((await gatewayCall(base, '/v1/anchors', { tenant: null, objectKey: 'audit-anchors/../tenants/x.json', body })).status).toBe(400);
  });

  it('logs one gateway.call line per call and counts it, without secrets', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      await put(Buffer.from('logged'), {}, { 'x-request-id': 'req-wp13-log-0001' });
      await gatewayCall(base, '/v1/keys/data-key', { orgId: ORG }, { token: null, headers: { 'x-request-id': 'req-wp13-log-0002' } });
      const entries = [...log.mock.calls, ...warn.mock.calls]
        .map((call) => call[0] as Record<string, unknown>)
        .filter((entry) => entry && typeof entry === 'object' && entry.event === 'gateway.call');
      expect(entries).toEqual(
        expect.arrayContaining([
          {
            event: 'gateway.call',
            orgId: ORG,
            repositoryId: VAULT_ID,
            adapter: 'managed_vault',
            operation: 'objects.put',
            callerCn: null,
            outcome: 'ok',
            latencyMs: expect.any(Number),
            requestId: 'req-wp13-log-0001',
          },
          expect.objectContaining({ operation: 'keys.data-key', outcome: 'forbidden', requestId: 'req-wp13-log-0002' }),
        ]),
      );
      expect(JSON.stringify(entries)).not.toContain(tenant.wrappedDek);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    const metrics = await gateway.app.get(MetricsService).registry.metrics();
    expect(metrics).toMatch(/mscd_gateway_calls_total\{[^}]*operation="objects.put"[^}]*outcome="ok"[^}]*\} \d+/);
  });
});
