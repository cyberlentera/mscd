import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quickXorHash } from '../src/index.js';
import { BAGUS, CLIENT_ID, ORIGIN, TENANT, build, call, graphToken, graphTokenResponse, pathOf } from './helpers.js';

let app: FastifyInstance;
let token: string;
const DRIVE = '/v1.0/drives/drive-sp-compliance';

beforeEach(async () => {
  app = build();
  token = await graphToken(app);
});

afterEach(async () => {
  await app.close();
});

const get = (url: string) => call(app, 'GET', url, { token });

describe('Graph drive items', () => {
  it('returns an item with the fields the adapters read (D.5, J.7)', async () => {
    const response = await get(`${DRIVE}/items/ITEM-BACKUP`);
    expect(response.statusCode).toBe(200);
    const item = response.json();
    expect(item).toMatchObject({
      id: 'ITEM-BACKUP',
      name: 'Backup-Job-Log-Sep-2026.xlsx',
      size: Buffer.byteLength('backup log v3'),
      createdDateTime: '2026-09-20T01:00:00.000Z',
      createdBy: { user: { displayName: 'Bagus Prasetyo', email: BAGUS.email } },
      lastModifiedDateTime: '2026-09-28T02:00:00.000Z',
      lastModifiedBy: { user: { displayName: 'Bagus Prasetyo' } },
      parentReference: { driveId: 'drive-sp-compliance', id: 'FOLDER-Q3', path: '/drives/drive-sp-compliance/root:/Compliance/ISMS/Evidence/2026/Q3' },
      file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hashes: { quickXorHash: quickXorHash('backup log v3') } },
      webUrl: 'https://nusantaradigital.sharepoint.com/sites/compliance/Shared%20Documents/Compliance/ISMS/Evidence/2026/Q3/Backup-Job-Log-Sep-2026.xlsx',
      description: 'Backup job log MSCD-7Q2X9',
    });
    expect(item.eTag).toMatch(/^"\{[0-9A-F-]{36}\},\d+"$/);
    expect(item.cTag).toMatch(/^"c:\{[0-9A-F-]{36}\},\d+"$/);
    expect(item['@microsoft.graph.downloadUrl']).toMatch(/^http:\/\/localhost:80\/_download\//);
    const selected = await get(`${DRIVE}/items/ITEM-BACKUP?$select=id,file`);
    expect(Object.keys(selected.json()).sort()).toEqual(['file', 'id']);
  });

  it('returns the drive, the root and items by path', async () => {
    const drive = (await get(DRIVE)).json();
    expect(drive).toMatchObject({ id: 'drive-sp-compliance', driveType: 'documentLibrary', name: 'Compliance' });
    const root = (await get(`${DRIVE}/root`)).json();
    expect(root.root).toEqual({});
    expect(root.parentReference).toEqual({ driveType: 'documentLibrary', driveId: 'drive-sp-compliance' });
    expect((await get(`${DRIVE}/items/root`)).json().id).toBe(root.id);
    const byPath = await get(`${DRIVE}/root:/Compliance/ISMS:`);
    expect(byPath.json().id).toBe('FOLDER-ISMS');
    expect(byPath.json().folder.childCount).toBe(2);
    expect((await get(`${DRIVE}/root:/Compliance/ISMS`)).json().id).toBe('FOLDER-ISMS');
    expect((await get(`${DRIVE}/items/FOLDER-COMPLIANCE:/ISMS/Access-Control-Policy.pdf`)).json().id).toBe('ITEM-POLICY');
    expect((await get(`${DRIVE}/root:/compliance/isms:`)).json().id).toBe('FOLDER-ISMS');
    const missing = await get(`${DRIVE}/root:/Compliance/Nope:`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('itemNotFound');
  });

  it('lists children in pages with @odata.nextLink', async () => {
    for (let i = 0; i < 5; i += 1) {
      await call(app, 'PUT', `${DRIVE}/items/FOLDER-ISMS:/file-${i}.txt:/content`, { token, body: `file ${i}`, headers: { 'content-type': 'text/plain' } });
    }
    const names: string[] = [];
    let url: string | undefined = `${DRIVE}/items/FOLDER-ISMS/children?$top=3`;
    let pages = 0;
    while (url) {
      const page = await get(url);
      expect(page.statusCode).toBe(200);
      names.push(...page.json().value.map((child: { name: string }) => child.name));
      url = page.json()['@odata.nextLink'] ? pathOf(page.json()['@odata.nextLink']) : undefined;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(names).toEqual(['Access-Control-Policy.pdf', 'Evidence', 'file-0.txt', 'file-1.txt', 'file-2.txt', 'file-3.txt', 'file-4.txt']);
    const children = await get(`${DRIVE}/root:/Compliance/ISMS/Evidence/2026/Q3:/children`);
    expect(children.json().value.map((c: { id: string }) => c.id)).toEqual(['ITEM-BACKUP']);
    expect((await get(`${DRIVE}/items/FOLDER-ISMS/children?$skiptoken=forged`)).statusCode).toBe(400);
  });

  it('lists versions newest first and serves version content', async () => {
    const versions = (await get(`${DRIVE}/items/ITEM-BACKUP/versions`)).json().value;
    expect(versions.map((v: { id: string }) => v.id)).toEqual(['3.0', '2.0', '1.0']);
    expect(versions[0]).toEqual({ id: '3.0', lastModifiedBy: { user: { displayName: 'Bagus Prasetyo', email: BAGUS.email, id: expect.any(String) } }, lastModifiedDateTime: '2026-09-28T02:00:00.000Z', size: 13 });
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions/2.0`)).json().id).toBe('2.0');
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions/current`)).json().id).toBe('3.0');
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions/9.0`)).statusCode).toBe(404);
    const redirect = await get(`${DRIVE}/items/ITEM-BACKUP/versions/1.0/content`);
    expect(redirect.statusCode).toBe(302);
    const content = await call(app, 'GET', pathOf(redirect.headers.location as string));
    expect(content.body).toBe('backup log v1');
    const current = await get(`${DRIVE}/items/ITEM-BACKUP/content`);
    expect((await call(app, 'GET', pathOf(current.headers.location as string))).body).toBe('backup log v3');
    const download = await call(app, 'GET', pathOf((await get(`${DRIVE}/items/ITEM-POLICY`)).json()['@microsoft.graph.downloadUrl']));
    expect(download.body).toBe('%PDF-1.7 policy');
    expect(download.headers['content-type']).toBe('application/pdf');
    expect((await call(app, 'GET', '/_download/forged.token')).statusCode).toBe(401);
  });

  it('creates folders with the conflict behaviours', async () => {
    const create = (name: string, behavior?: string) =>
      call(app, 'POST', `${DRIVE}/items/FOLDER-ISMS/children`, { token, json: { name, folder: {}, ...(behavior ? { '@microsoft.graph.conflictBehavior': behavior } : {}) } });
    const created = await create('Audit 2026');
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Audit 2026', folder: { childCount: 0 }, createdBy: { application: { id: CLIENT_ID, displayName: 'MSCD Storage Gateway' } } });
    const conflict = await create('audit 2026');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('nameAlreadyExists');
    expect((await create('Audit 2026', 'rename')).json().name).toBe('Audit 2026 1');
    expect((await call(app, 'POST', `${DRIVE}/root/children`, { token, json: { name: 'Top', folder: {} } })).statusCode).toBe(201);
    expect((await create('bad:name')).statusCode).toBe(400);
  });

  it('uploads small files with PUT content and computes quickXorHash', async () => {
    const content = Buffer.from('evidence bytes for the mock', 'utf8');
    const created = await call(app, 'PUT', `${DRIVE}/items/FOLDER-Q3:/${encodeURIComponent('Restore Test 2026-09-26.pdf')}:/content`, { token, body: content, headers: { 'content-type': 'application/octet-stream' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Restore Test 2026-09-26.pdf', size: content.length, file: { mimeType: 'application/pdf', hashes: { quickXorHash: quickXorHash(content) } } });
    const replaced = await call(app, 'PUT', `${DRIVE}/items/${created.json().id}/content`, { token, body: 'second version', headers: { 'content-type': 'text/plain' } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().file.hashes.quickXorHash).toBe(quickXorHash('second version'));
    const versions = (await get(`${DRIVE}/items/${created.json().id}/versions`)).json().value;
    expect(versions.map((v: { id: string }) => v.id)).toEqual(['2.0', '1.0']);
    const sameName = await call(app, 'PUT', `${DRIVE}/items/FOLDER-Q3:/Restore Test 2026-09-26.pdf:/content?@microsoft.graph.conflictBehavior=fail`, { token, body: 'x', headers: { 'content-type': 'text/plain' } });
    expect(sameName.statusCode).toBe(409);
    const nested = await call(app, 'PUT', `${DRIVE}/root:/Compliance/QMS/New/report.txt:/content`, { token, body: 'nested', headers: { 'content-type': 'text/plain' } });
    expect(nested.statusCode).toBe(201);
    expect(nested.json().parentReference.path).toBe('/drives/drive-sp-compliance/root:/Compliance/QMS/New');
  });

  it('refuses simple uploads above 4 MiB without creating anything', async () => {
    const big = randomBytes(4 * 1024 * 1024 + 1);
    const response = await call(app, 'PUT', `${DRIVE}/root:/Compliance/Big/big.bin:/content`, { token, body: big, headers: { 'content-type': 'application/octet-stream' } });
    expect(response.statusCode).toBe(413);
    expect((await get(`${DRIVE}/root:/Compliance/Big:`)).statusCode).toBe(404);
  });

  it('uploads large files through an upload session in 320 KiB multiples', async () => {
    const content = randomBytes(327_680 * 2 + 1000);
    const session = await call(app, 'POST', `${DRIVE}/items/FOLDER-Q3:/large.bin:/createUploadSession`, {
      token,
      json: { item: { '@microsoft.graph.conflictBehavior': 'rename', description: 'Large file MSCD-ZT001' } },
    });
    expect(session.statusCode).toBe(200);
    expect(Object.keys(session.json()).sort()).toEqual(['expirationDateTime', 'nextExpectedRanges', 'uploadUrl']);
    const uploadUrl = pathOf(session.json().uploadUrl);
    const put = (start: number, end: number, extra: Record<string, string> = {}) =>
      call(app, 'PUT', uploadUrl, {
        body: content.subarray(start, end + 1),
        headers: { 'content-range': `bytes ${start}-${end}/${content.length}`, 'content-type': 'application/octet-stream', ...extra },
      });
    expect((await put(0, 327_680 - 1, { authorization: `Bearer ${token}` })).statusCode).toBe(401);
    const badSize = await put(0, 1000);
    expect(badSize.statusCode).toBe(400);
    const first = await put(0, 327_680 - 1);
    expect(first.statusCode).toBe(202);
    expect(first.json().nextExpectedRanges).toEqual(['327680-']);
    const overlap = await put(0, 327_680 - 1);
    expect(overlap.statusCode).toBe(416);
    const status = await call(app, 'GET', uploadUrl);
    expect(status.json().nextExpectedRanges).toEqual(['327680-']);
    expect((await put(327_680, 327_680 * 2 - 1)).statusCode).toBe(202);
    const done = await put(327_680 * 2, content.length - 1);
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ name: 'large.bin', size: content.length, description: 'Large file MSCD-ZT001', file: { hashes: { quickXorHash: quickXorHash(content) } } });
    expect((await call(app, 'GET', uploadUrl)).statusCode).toBe(404);

    const cancelled = await call(app, 'POST', `${DRIVE}/items/FOLDER-Q3:/cancelled.bin:/createUploadSession`, { token, json: {} });
    const cancelUrl = pathOf(cancelled.json().uploadUrl);
    expect((await call(app, 'DELETE', cancelUrl)).statusCode).toBe(204);
    expect((await call(app, 'GET', cancelUrl)).statusCode).toBe(404);
    const exists = await call(app, 'POST', `${DRIVE}/items/FOLDER-Q3:/large.bin:/createUploadSession`, { token, json: {} });
    expect(exists.statusCode).toBe(409);
  });

  it('copies asynchronously with a monitor URL', async () => {
    const accepted = await call(app, 'POST', `${DRIVE}/items/ITEM-BACKUP/copy`, {
      token,
      json: { parentReference: { driveId: 'drive-sp-compliance', id: 'FOLDER-ISMS' }, name: 'Backup copy.xlsx' },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.body).toBe('');
    const monitor = pathOf(accepted.headers.location as string);
    const first = await call(app, 'GET', monitor);
    expect(first.json().status).toBe('inProgress');
    const second = await call(app, 'GET', monitor);
    expect(second.json()).toMatchObject({ status: 'completed', percentageComplete: 100, resourceId: expect.any(String) });
    const copy = (await get(`${DRIVE}/items/${second.json().resourceId}`)).json();
    expect(copy).toMatchObject({ name: 'Backup copy.xlsx', file: { hashes: { quickXorHash: quickXorHash('backup log v3') } }, parentReference: { id: 'FOLDER-ISMS' } });
    expect((await get(`${DRIVE}/items/${copy.id}/versions`)).json().value).toHaveLength(1);

    const conflict = await call(app, 'POST', `${DRIVE}/items/ITEM-BACKUP/copy`, { token, json: { parentReference: { id: 'FOLDER-ISMS' }, name: 'Backup copy.xlsx' } });
    const monitorUrl = pathOf(conflict.headers.location as string);
    await call(app, 'GET', monitorUrl);
    expect((await call(app, 'GET', monitorUrl)).json()).toMatchObject({ status: 'failed', error: { code: 'nameAlreadyExists' } });
    const renamed = await call(app, 'POST', `${DRIVE}/items/ITEM-BACKUP/copy?@microsoft.graph.conflictBehavior=rename`, { token, json: { parentReference: { id: 'FOLDER-ISMS' }, name: 'Backup copy.xlsx' } });
    const renamedMonitor = pathOf(renamed.headers.location as string);
    await call(app, 'GET', renamedMonitor);
    const result = (await call(app, 'GET', renamedMonitor)).json();
    expect((await get(`${DRIVE}/items/${result.resourceId}`)).json().name).toBe('Backup copy 1.xlsx');
  });

  it('completes copies at once when copyPendingPolls is 0', async () => {
    await call(app, 'POST', '/_admin/settings', { json: { copyPendingPolls: 0 } });
    const accepted = await call(app, 'POST', `${DRIVE}/items/FOLDER-ISMS/copy`, { token, json: { parentReference: { id: 'FOLDER-COMPLIANCE' }, name: 'ISMS copy' } });
    const status = (await call(app, 'GET', pathOf(accepted.headers.location as string))).json();
    expect(status.status).toBe('completed');
    const children = (await get(`${DRIVE}/items/${status.resourceId}/children`)).json().value;
    expect(children.map((c: { name: string }) => c.name)).toEqual(['Access-Control-Policy.pdf', 'Evidence']);
  });

  it('renames, moves and deletes items', async () => {
    const moved = await call(app, 'PATCH', `${DRIVE}/items/ITEM-POLICY`, { token, json: { name: 'Policy.pdf', parentReference: { id: 'FOLDER-COMPLIANCE' }, description: 'moved' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ name: 'Policy.pdf', description: 'moved', parentReference: { id: 'FOLDER-COMPLIANCE', path: '/drives/drive-sp-compliance/root:/Compliance' } });
    expect((await call(app, 'PATCH', `${DRIVE}/items/FOLDER-COMPLIANCE`, { token, json: { parentReference: { id: 'FOLDER-ISMS' } } })).statusCode).toBe(400);
    expect((await call(app, 'DELETE', `${DRIVE}/items/ITEM-POLICY`, { token })).statusCode).toBe(204);
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(404);
  });

  it('answers 400 for ids that fail the D.5 pattern, before any lookup', async () => {
    // A ".." segment, plain or percent-encoded, never reaches a server: URL parsers resolve it first, which is why
    // the adapters must validate ids themselves (D.5). Everything else that fails the pattern arrives and is refused.
    for (const bad of ['a%2Fb', 'a..b', 'item%3Fx', 'with%20space', 'semi%3Bcolon', 'dot.ted']) {
      const response = await get(`${DRIVE}/items/${bad}`);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json().error.code, bad).toBe('invalidRequest');
    }
    expect((await get('/v1.0/drives/bad%2Fdrive/items/ITEM-POLICY')).statusCode).toBe(400);
    expect((await get(`${DRIVE}/items/ITEM-POLICY/versions/1.0%2F..`)).statusCode).toBe(400);
    expect((await get(`${DRIVE}/root:/Compliance/a%2Fb:`)).statusCode).toBe(404);
    expect((await get(`${DRIVE}/unknown`)).statusCode).toBe(400);
    expect((await get('/v1.0/drives/unknown-drive')).statusCode).toBe(404);
  });

  it('requires a valid bearer token', async () => {
    const missing = await call(app, 'GET', `${DRIVE}/items/ITEM-POLICY`);
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toMatchObject({ code: 'InvalidAuthenticationToken', message: 'Access token is empty.' });
    expect((await call(app, 'GET', `${DRIVE}/items/ITEM-POLICY`, { token: 'forged' })).statusCode).toBe(401);
  });

  it('refuses tokens of another tenant and apps outside the allow-list', async () => {
    await call(app, 'POST', '/_admin/fixtures', { json: { m365: { drives: [{ id: 'drive-restricted', tenantId: TENANT, allowedPrincipals: ['some-other-app'] }] } } });
    const restricted = await get('/v1.0/drives/drive-restricted/root');
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json().error.code).toBe('accessDenied');
    await call(app, 'POST', '/_admin/fixtures', { json: { m365: { drives: [{ id: 'drive-other-tenant', tenantId: 'ffffffff-2222-4333-8444-555555555555' }] } } });
    expect((await get('/v1.0/drives/drive-other-tenant/root')).statusCode).toBe(403);
  });
});

describe('Graph fault switches', () => {
  it('move changes the folder of an item and keeps its version', async () => {
    const response = await call(app, 'POST', '/_admin/items/ITEM-BACKUP/move', { json: {} });
    expect(response.json().folderPath).toBe('/Compliance/ISMS/Evidence/2026/Q3/Moved');
    const item = (await get(`${DRIVE}/items/ITEM-BACKUP`)).json();
    expect(item.parentReference.path).toBe('/drives/drive-sp-compliance/root:/Compliance/ISMS/Evidence/2026/Q3/Moved');
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions`)).json().value[0].id).toBe('3.0');
    await call(app, 'POST', '/_admin/items/ITEM-BACKUP/move', { json: { path: 'Archive/2026' } });
    expect((await get(`${DRIVE}/items/ITEM-BACKUP`)).json().parentReference.path).toBe('/drives/drive-sp-compliance/root:/Archive/2026');
  });

  it('new-version adds a current version and keeps the pinned one listed', async () => {
    const before = (await get(`${DRIVE}/items/ITEM-BACKUP`)).json();
    await call(app, 'POST', '/_admin/items/ITEM-BACKUP/new-version', { json: { content: 'backup log v4' } });
    const after = (await get(`${DRIVE}/items/ITEM-BACKUP`)).json();
    expect(after.file.hashes.quickXorHash).toBe(quickXorHash('backup log v4'));
    expect(after.cTag).not.toBe(before.cTag);
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions`)).json().value.map((v: { id: string }) => v.id)).toEqual(['4.0', '3.0', '2.0', '1.0']);
  });

  it('purge-version removes old versions, delete removes the item', async () => {
    await call(app, 'POST', '/_admin/items/ITEM-BACKUP/purge-version', { json: { versionId: '2.0' } });
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions`)).json().value.map((v: { id: string }) => v.id)).toEqual(['3.0', '1.0']);
    await call(app, 'POST', '/_admin/items/ITEM-BACKUP/purge-version', { json: {} });
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions`)).json().value.map((v: { id: string }) => v.id)).toEqual(['3.0']);
    expect((await call(app, 'POST', '/_admin/items/ITEM-BACKUP/purge-version', { json: { versionId: '3.0' } })).statusCode).toBe(400);
    await call(app, 'POST', '/_admin/items/ITEM-BACKUP/delete', { json: {} });
    const gone = await get(`${DRIVE}/items/ITEM-BACKUP`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('itemNotFound');
  });

  it('corrupt-hash changes the hash but not the version', async () => {
    const before = (await get(`${DRIVE}/items/ITEM-BACKUP`)).json();
    const corrupted = await call(app, 'POST', '/_admin/items/ITEM-BACKUP/corrupt-hash', { json: {} });
    expect(corrupted.json().previousHashes.quickXorHash).toBe(before.file.hashes.quickXorHash);
    const after = (await get(`${DRIVE}/items/ITEM-BACKUP`)).json();
    expect(after.file.hashes.quickXorHash).not.toBe(before.file.hashes.quickXorHash);
    expect((await get(`${DRIVE}/items/ITEM-BACKUP/versions`)).json().value[0].id).toBe('3.0');
  });

  it('forbid answers 403 on every request to the drive', async () => {
    const personal = await get('/v1.0/drives/drive-od-fnugroho/items/ITEM-OD-NOTES');
    expect(personal.statusCode).toBe(403);
    expect(personal.json().error.code).toBe('accessDenied');
    await call(app, 'POST', '/_admin/drives/drive-sp-compliance/forbid', { json: {} });
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(403);
    await call(app, 'POST', '/_admin/drives/drive-sp-compliance/forbid', { json: { forbidden: false } });
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(200);
  });

  it('token revocation fails API calls and further token requests', async () => {
    const revoked = await call(app, 'POST', '/_admin/tokens/revoke', { json: {} });
    expect(revoked.json().revokedAccessTokens).toBe(1);
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(401);
    const again = await graphTokenResponse(app);
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe('invalid_client');
  });

  it('revoking access tokens only lets the client fetch a new token', async () => {
    await call(app, 'POST', '/_admin/tokens/revoke', { json: { clientId: CLIENT_ID, accessTokensOnly: true } });
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(401);
    const fresh = await graphToken(app);
    expect((await call(app, 'GET', `${DRIVE}/items/ITEM-POLICY`, { token: fresh })).statusCode).toBe(200);
  });

  it('throttle answers the next N requests with 429 and Retry-After', async () => {
    await call(app, 'POST', '/_admin/throttle', { json: { count: 2, retryAfterSeconds: 7 } });
    for (let i = 0; i < 2; i += 1) {
      const throttled = await get(`${DRIVE}/items/ITEM-POLICY`);
      expect(throttled.statusCode).toBe(429);
      expect(throttled.headers['retry-after']).toBe('7');
      expect(throttled.json().error.code).toBe('TooManyRequests');
    }
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(200);
    await call(app, 'POST', '/_admin/throttle', { json: { count: 1, status: 503, apis: ['identity'] } });
    expect((await get(`${DRIVE}/items/ITEM-POLICY`)).statusCode).toBe(200);
    const token503 = await graphTokenResponse(app);
    expect(token503.statusCode).toBe(503);
    expect(token503.headers['retry-after']).toBe('1');
  });

  it('latency delays provider responses', async () => {
    await call(app, 'POST', '/_admin/latency', { json: { ms: 150 } });
    const started = Date.now();
    await get(`${DRIVE}/items/ITEM-POLICY`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    await call(app, 'POST', '/_admin/latency', { json: { ms: 0 } });
    const fast = Date.now();
    await get(`${DRIVE}/items/ITEM-POLICY`);
    expect(Date.now() - fast).toBeLessThan(140);
  });

  it('links in responses use the configured public URL', async () => {
    const proxied = build({ publicUrl: 'http://mock-providers:4310' });
    try {
      const proxiedToken = (await graphTokenResponse(proxied, { audience: `http://mock-providers:4310/${TENANT}/oauth2/v2.0/token` })).json().access_token as string;
      const item = (await call(proxied, 'GET', `${DRIVE}/items/ITEM-POLICY`, { token: proxiedToken })).json();
      expect(item['@microsoft.graph.downloadUrl'].startsWith('http://mock-providers:4310/_download/')).toBe(true);
    } finally {
      await proxied.close();
    }
    expect(ORIGIN).toBe('http://localhost:80');
  });
});
