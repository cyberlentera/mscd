import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFields, parseFields } from '../src/fields.js';
import { BAGUS, DRIVE_SCOPE, SA_EMAIL, TONO, build, call, googleToken, googleTokenResponse, pathOf } from './helpers.js';

let app: FastifyInstance;
let token: string;
const ALL = 'supportsAllDrives=true';
const FILE_FIELDS = 'id,name,description,mimeType,size,sha256Checksum,md5Checksum,headRevisionId,parents,owners,createdTime,modifiedTime,lastModifyingUser,webViewLink,driveId,version,trashed';
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const md5 = (data: string | Buffer) => createHash('md5').update(data).digest('hex');

beforeEach(async () => {
  app = build();
  token = await googleToken(app);
});

afterEach(async () => {
  await app.close();
});

const get = (url: string, as = token) => call(app, 'GET', url, { token: as });

function multipart(metadata: unknown, content: Buffer | string, contentType = 'text/plain') {
  const boundary = 'mscd-boundary';
  return {
    token,
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe('Drive files', () => {
  it('returns only the default fields unless fields asks for more', async () => {
    const response = await get(`/drive/v3/files/file-prioritised?${ALL}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'drive#file',
      id: 'file-prioritised',
      name: 'Prioritised-Activities-v1.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('returns the fields the adapters read (D.5, J.7)', async () => {
    const file = (await get(`/drive/v3/files/file-prioritised?${ALL}&fields=${FILE_FIELDS}`)).json();
    expect(file).toEqual({
      id: 'file-prioritised',
      name: 'Prioritised-Activities-v1.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: String(Buffer.byteLength('activities r3')),
      sha256Checksum: sha256('activities r3'),
      md5Checksum: md5('activities r3'),
      headRevisionId: 'rev-c',
      parents: ['folder-bcms-2026'],
      createdTime: '2026-09-10T00:00:00.000Z',
      modifiedTime: '2026-09-15T00:00:00.000Z',
      lastModifyingUser: { kind: 'drive#user', displayName: TONO.displayName, emailAddress: TONO.email, me: false, permissionId: expect.stringMatching(/^\d+$/) },
      webViewLink: 'https://drive.google.com/file/d/file-prioritised/view?usp=drivesdk',
      driveId: 'drive-gd-bcms',
      version: '3',
      trashed: false,
    });
    const nested = (await get(`/drive/v3/files/file-prioritised?${ALL}&fields=lastModifyingUser/emailAddress,parents`)).json();
    expect(nested).toEqual({ lastModifyingUser: { emailAddress: TONO.email }, parents: ['folder-bcms-2026'] });
    expect((await get(`/drive/v3/files/file-prioritised?${ALL}&fields=id,(`)).statusCode).toBe(400);
  });

  it('reports no checksums or head revision for Google Workspace files and refuses to download them', async () => {
    const doc = (await get(`/drive/v3/files/file-bia-notes?${ALL}&fields=*`)).json();
    expect(doc.mimeType).toBe('application/vnd.google-apps.document');
    expect(doc).not.toHaveProperty('sha256Checksum');
    expect(doc).not.toHaveProperty('md5Checksum');
    expect(doc).not.toHaveProperty('headRevisionId');
    expect(doc.version).toBe('2');
    expect(doc.webViewLink).toBe('https://docs.google.com/document/d/file-bia-notes/edit?usp=drivesdk');
    const media = await get(`/drive/v3/files/file-bia-notes?${ALL}&alt=media`);
    expect(media.statusCode).toBe(403);
    expect(media.json().error.errors[0].reason).toBe('fileNotDownloadable');
    const binary = await get(`/drive/v3/files/file-prioritised?${ALL}&alt=media`);
    expect(binary.body).toBe('activities r3');
  });

  it('hides shared drive items without supportsAllDrives and lists owners only outside shared drives', async () => {
    const hidden = await get('/drive/v3/files/file-prioritised');
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.errors[0]).toMatchObject({ reason: 'notFound', location: 'fileId', locationType: 'parameter' });
    const delegated = await googleToken(app, { subject: TONO.email });
    const mine = (await get('/drive/v3/files/file-my-note?fields=owners,driveId,parents', delegated)).json();
    expect(mine.owners).toEqual([{ kind: 'drive#user', displayName: TONO.displayName, emailAddress: TONO.email, me: true, permissionId: expect.any(String) }]);
    expect(mine).not.toHaveProperty('driveId');
    expect(mine.parents).toEqual(['mydrive-root-tono']);
    expect((await get('/drive/v3/files/root?fields=id,name', delegated)).json()).toEqual({ id: 'mydrive-root-tono', name: 'My Drive' });
    expect((await get(`/drive/v3/files/drive-gd-bcms?${ALL}&fields=id,mimeType,driveId`)).json()).toEqual({ id: 'drive-gd-bcms', mimeType: 'application/vnd.google-apps.folder', driveId: 'drive-gd-bcms' });
  });

  it('names the account that created a My Drive file in owners', async () => {
    const delegated = await googleToken(app, { subject: TONO.email });
    const created = await call(app, 'POST', '/_admin/items', {
      json: { driveId: 'drive-my-tono', name: 'Uploaded by Bagus MSCD-ZT77.pdf', content: 'zero transit', createdBy: BAGUS, modifiedBy: BAGUS },
    });
    expect(created.statusCode).toBe(201);
    const fields = 'fields=owners,lastModifyingUser(emailAddress)';
    const upload = (await get(`/drive/v3/files/${created.json().id}?${fields}`, delegated)).json();
    expect(upload.owners).toEqual([{ kind: 'drive#user', displayName: BAGUS.displayName, emailAddress: BAGUS.email, me: false, permissionId: expect.any(String) }]);
    expect(upload.owners[0].emailAddress).toBe(BAGUS.email);
    expect(upload.lastModifyingUser).toEqual({ emailAddress: BAGUS.email });
    const own = (await get(`/drive/v3/files/file-my-note?${fields}`, delegated)).json();
    expect(own.owners.map((o: { emailAddress: string }) => o.emailAddress)).toEqual([TONO.email]);
    const anonymous = await call(app, 'POST', '/_admin/items', { json: { driveId: 'drive-my-tono', name: 'No-Creator.txt', content: 'x' } });
    const fallback = (await get(`/drive/v3/files/${anonymous.json().id}?fields=owners(emailAddress)`, delegated)).json();
    expect(fallback.owners).toEqual([{ emailAddress: TONO.email }]);
    const uploaded = await call(app, 'POST', '/upload/drive/v3/files?uploadType=multipart&fields=owners(emailAddress,me)', { ...multipart({ name: 'Mine.txt' }, 'mine'), token: delegated });
    expect(uploaded.json().owners).toEqual([{ emailAddress: TONO.email, me: true }]);
  });

  it('shows a My Drive only to its owner and the accounts in allowedPrincipals', async () => {
    const notFound = (response: { statusCode: number; json(): { error: { errors: { reason: string }[] } } }) => {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.errors[0].reason).toBe('notFound');
    };
    notFound(await get('/drive/v3/files/file-my-note?fields=id,name,owners'));
    notFound(await get('/drive/v3/files/file-my-note?alt=media'));
    notFound(await get('/drive/v3/files/file-my-note/revisions'));
    notFound(await get('/drive/v3/files/mydrive-root-tono'));
    notFound(await call(app, 'PATCH', '/drive/v3/files/file-my-note', { token, json: { name: 'taken.txt' } }));
    notFound(await call(app, 'DELETE', '/drive/v3/files/file-my-note', { token }));
    notFound(await call(app, 'POST', '/upload/drive/v3/files?uploadType=multipart', multipart({ name: 'x.txt', parents: ['mydrive-root-tono'] }, 'x')));
    expect((await get('/drive/v3/files?fields=files(id)')).json()).toEqual({ files: [] });

    const shared = await call(app, 'POST', '/_admin/fixtures', { json: { google: { drives: [{ id: 'drive-my-tono', allowedPrincipals: [SA_EMAIL] }] } } });
    expect(shared.statusCode).toBe(200);
    expect((await get('/drive/v3/files/file-my-note?fields=id,owners(emailAddress)')).json()).toEqual({ id: 'file-my-note', owners: [{ emailAddress: TONO.email }] });
    expect((await get('/drive/v3/files/file-my-note?alt=media')).body).toBe('my note');
    expect((await get('/drive/v3/files?fields=files(id)')).json()).toEqual({ files: [{ id: 'file-my-note' }] });
  });

  it('lists a folder of a shared drive with q, paging and nextPageToken', async () => {
    for (let i = 0; i < 3; i += 1) {
      await call(app, 'POST', `/upload/drive/v3/files?uploadType=multipart&${ALL}`, multipart({ name: `extra-${i}.txt`, parents: ['folder-bcms-2026'] }, `extra ${i}`));
    }
    const base = new URLSearchParams({
      q: "'folder-bcms-2026' in parents and trashed = false",
      corpora: 'drive',
      driveId: 'drive-gd-bcms',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      pageSize: '2',
      fields: 'nextPageToken,files(id,name)',
    });
    const names: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams(base);
      if (pageToken) query.set('pageToken', pageToken);
      const page = (await get(`/drive/v3/files?${query}`)).json();
      names.push(...page.files.map((f: { name: string }) => f.name));
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken);
    expect(pages).toBe(3);
    expect(names).toEqual(['BIA-Workshop-Notes-Sep', 'extra-0.txt', 'extra-1.txt', 'extra-2.txt', 'Prioritised-Activities-v1.xlsx']);
    const byName = (await get(`/drive/v3/files?${new URLSearchParams({ q: "name = 'extra-1.txt' and mimeType != 'application/vnd.google-apps.folder'", corpora: 'drive', driveId: 'drive-gd-bcms', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' })}`)).json();
    expect(byName).toEqual({ kind: 'drive#fileList', incompleteSearch: false, files: [{ kind: 'drive#file', id: expect.any(String), name: 'extra-1.txt', mimeType: 'text/plain' }] });
  });

  it('validates list parameters and ids in q', async () => {
    const without = await get(`/drive/v3/files?corpora=drive&driveId=drive-gd-bcms&${ALL}`);
    expect(without.statusCode).toBe(403);
    const notDrive = await get('/drive/v3/files?driveId=drive-gd-bcms&includeItemsFromAllDrives=true&supportsAllDrives=true');
    expect(notDrive.statusCode).toBe(400);
    const badId = await get(`/drive/v3/files?q=${encodeURIComponent("'a/b' in parents")}`);
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.errors[0]).toMatchObject({ reason: 'invalid', location: 'q' });
    expect((await get(`/drive/v3/files?q=${encodeURIComponent("name = 'a' or name = 'b'")}`)).statusCode).toBe(400);
    expect((await get(`/drive/v3/files?q=${encodeURIComponent('modifiedTime > 1')}`)).statusCode).toBe(400);
    expect((await get('/drive/v3/files?pageToken=forged')).statusCode).toBe(400);
    expect((await get('/drive/v3/files?corpora=drive&driveId=unknown&includeItemsFromAllDrives=true&supportsAllDrives=true')).statusCode).toBe(404);
  });

  it('answers 400 for ids that fail the D.5 pattern', async () => {
    for (const bad of ['a%2Fb', 'a.b', 'x%3Fy', 'sp%20ace']) {
      const response = await get(`/drive/v3/files/${bad}?${ALL}`);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json().error.errors[0].location, bad).toBe('fileId');
    }
    expect((await get(`/drive/v3/files/file-prioritised/revisions/a.b?${ALL}`)).statusCode).toBe(400);
    expect((await get('/drive/v3/drives/a.b')).statusCode).toBe(400);
    const location = async (response: Promise<{ statusCode: number; json(): { error: { errors: { location: string }[] } } }>) => {
      const answered = await response;
      expect(answered.statusCode).toBe(400);
      return answered.json().error.errors[0].location;
    };
    const patch = (query: string) => call(app, 'PATCH', `/drive/v3/files/file-prioritised?${ALL}&${query}`, { token, json: {} });
    expect(await location(patch('addParents=drive-gd-bcms&removeParents=bad.id'))).toBe('removeParents');
    expect(await location(patch('removeParents=bad.id'))).toBe('removeParents');
    expect(await location(patch('addParents=a.b&removeParents=folder-bcms-2026'))).toBe('addParents');
    expect(await location(call(app, 'PUT', '/upload/drive/v3/files/a.b?uploadType=resumable&upload_id=zzz', { body: 'x' }))).toBe('fileId');
    expect(await location(call(app, 'DELETE', '/upload/drive/v3/files/a.b?uploadType=resumable&upload_id=zzz'))).toBe('fileId');
    expect((await call(app, 'PUT', '/upload/drive/v3/files/file-prioritised?uploadType=resumable&upload_id=zzz', { body: 'x' })).statusCode).toBe(404);
  });

  it('creates folders and uploads with multipart, media and resumable uploads', async () => {
    const folder = await call(app, 'POST', `/drive/v3/files?${ALL}&fields=id,mimeType,parents`, {
      token,
      json: { name: 'Q4', mimeType: 'application/vnd.google-apps.folder', parents: ['folder-bcms-2026'] },
    });
    expect(folder.statusCode).toBe(200);
    expect(folder.json()).toMatchObject({ mimeType: 'application/vnd.google-apps.folder', parents: ['folder-bcms-2026'] });
    const folderId = folder.json().id as string;

    const created = await call(app, 'POST', `/upload/drive/v3/files?uploadType=multipart&${ALL}&fields=${FILE_FIELDS}`, multipart({ name: 'Utility-Feed-Assessment.pdf', parents: [folderId], description: 'MSCD-ZT9' }, '%PDF-1.7 utility', 'application/pdf'));
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      name: 'Utility-Feed-Assessment.pdf',
      mimeType: 'application/pdf',
      description: 'MSCD-ZT9',
      sha256Checksum: sha256('%PDF-1.7 utility'),
      lastModifyingUser: { emailAddress: SA_EMAIL },
      driveId: 'drive-gd-bcms',
    });

    const outside = await call(app, 'POST', '/upload/drive/v3/files?uploadType=multipart', multipart({ name: 'x.txt', parents: [folderId] }, 'x'));
    expect(outside.statusCode).toBe(404);

    const media = await call(app, 'PATCH', `/upload/drive/v3/files/${created.json().id}?uploadType=media&${ALL}&fields=headRevisionId,sha256Checksum,version`, {
      token,
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF-1.7 utility v2',
    });
    expect(media.statusCode).toBe(200);
    expect(media.json().sha256Checksum).toBe(sha256('%PDF-1.7 utility v2'));
    expect(media.json().headRevisionId).not.toBe(created.json().headRevisionId);
  });

  it('runs resumable uploads in 256 KiB chunks with 308 responses', async () => {
    const content = randomBytes(262_144 * 2 + 500);
    const start = await call(app, 'POST', `/upload/drive/v3/files?uploadType=resumable&${ALL}&fields=id,size,sha256Checksum,name`, {
      token,
      headers: { 'x-upload-content-type': 'application/zip', 'x-upload-content-length': String(content.length) },
      json: { name: 'archive.zip', parents: ['folder-bcms-2026'] },
    });
    expect(start.statusCode).toBe(200);
    const session = pathOf(start.headers.location as string);
    expect(session).toContain('upload_id=');
    const put = (from: number, to: number) =>
      call(app, 'PUT', session, { body: content.subarray(from, to + 1), headers: { 'content-range': `bytes ${from}-${to}/${content.length}`, 'content-type': 'application/octet-stream' } });
    expect((await put(0, 1000)).statusCode).toBe(400);
    const first = await put(0, 262_143);
    expect(first.statusCode).toBe(308);
    expect(first.headers.range).toBe('bytes=0-262143');
    const status = await call(app, 'PUT', session, { headers: { 'content-range': `bytes */${content.length}` } });
    expect(status.statusCode).toBe(308);
    expect(status.headers.range).toBe('bytes=0-262143');
    expect((await put(0, 262_143)).statusCode).toBe(400);
    expect((await put(262_144, 524_287)).statusCode).toBe(308);
    const done = await put(524_288, content.length - 1);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ id: expect.any(String), name: 'archive.zip', size: String(content.length), sha256Checksum: sha256(content) });
    expect((await call(app, 'PUT', session, { body: 'x' })).statusCode).toBe(404);

    const single = await call(app, 'POST', `/upload/drive/v3/files?uploadType=resumable&${ALL}`, { token, json: { name: 'one-shot.txt', parents: ['folder-bcms-2026'] } });
    const once = await call(app, 'PUT', pathOf(single.headers.location as string), { body: 'one shot', headers: { 'content-type': 'text/plain' } });
    expect(once.statusCode).toBe(200);
    expect(once.json().name).toBe('one-shot.txt');

    const cancel = await call(app, 'POST', `/upload/drive/v3/files?uploadType=resumable&${ALL}`, { token, json: { name: 'cancel.txt', parents: ['folder-bcms-2026'] } });
    expect((await call(app, 'DELETE', pathOf(cancel.headers.location as string))).statusCode).toBe(499);
  });

  it('copies files and keeps the content hash', async () => {
    const copy = await call(app, 'POST', `/drive/v3/files/file-prioritised/copy?${ALL}&fields=id,name,sha256Checksum,parents,headRevisionId`, {
      token,
      json: { name: 'Prioritised copy.xlsx', parents: ['drive-gd-bcms'] },
    });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({ name: 'Prioritised copy.xlsx', sha256Checksum: sha256('activities r3'), parents: ['drive-gd-bcms'] });
    expect(copy.json().id).not.toBe('file-prioritised');
    expect((await call(app, 'POST', `/drive/v3/files/folder-bcms-2026/copy?${ALL}`, { token, json: {} })).statusCode).toBe(403);
  });

  it('gets and pins revisions', async () => {
    const revision = await get(`/drive/v3/files/file-prioritised/revisions/rev-a?${ALL}`);
    expect(revision.json()).toEqual({ kind: 'drive#revision', id: 'rev-a', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-09-10T00:00:00.000Z' });
    const full = (await get(`/drive/v3/files/file-prioritised/revisions/rev-a?${ALL}&fields=*`)).json();
    expect(full).toMatchObject({ keepForever: false, md5Checksum: md5('activities r1'), size: String(Buffer.byteLength('activities r1')) });
    const pinned = await call(app, 'PATCH', `/drive/v3/files/file-prioritised/revisions/rev-a?${ALL}&fields=id,keepForever`, { token, json: { keepForever: true } });
    expect(pinned.json()).toEqual({ id: 'rev-a', keepForever: true });
    expect((await get(`/drive/v3/files/file-prioritised/revisions/rev-a?${ALL}&alt=media`)).body).toBe('activities r1');
    const list = (await get(`/drive/v3/files/file-prioritised/revisions?${ALL}&fields=revisions(id,keepForever)`)).json();
    expect(list.revisions).toEqual([{ id: 'rev-a', keepForever: true }, { id: 'rev-b', keepForever: false }, { id: 'rev-c', keepForever: false }]);
    const missing = await get(`/drive/v3/files/file-prioritised/revisions/rev-zz?${ALL}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.errors[0].location).toBe('revisionId');
    const native = await call(app, 'PATCH', `/drive/v3/files/file-bia-notes/revisions/7?${ALL}`, { token, json: { keepForever: true } });
    expect(native.statusCode).toBe(400);
  });

  it('updates metadata, moves with addParents and removeParents, trashes and deletes', async () => {
    const moved = await call(app, 'PATCH', `/drive/v3/files/file-prioritised?${ALL}&addParents=drive-gd-bcms&removeParents=folder-bcms-2026&fields=parents,name`, { token, json: { name: 'Renamed.xlsx' } });
    expect(moved.json()).toEqual({ parents: ['drive-gd-bcms'], name: 'Renamed.xlsx' });
    expect((await call(app, 'PATCH', `/drive/v3/files/file-prioritised?${ALL}&addParents=folder-bcms-2026`, { token, json: {} })).statusCode).toBe(403);
    const trashed = await call(app, 'PATCH', `/drive/v3/files/file-prioritised?${ALL}&fields=trashed`, { token, json: { trashed: true } });
    expect(trashed.json()).toEqual({ trashed: true });
    expect((await call(app, 'DELETE', `/drive/v3/files/file-prioritised?${ALL}`, { token })).statusCode).toBe(204);
    expect((await get(`/drive/v3/files/file-prioritised?${ALL}`)).statusCode).toBe(404);
  });

  it('returns shared drives and the about resource', async () => {
    expect((await get('/drive/v3/drives/drive-gd-bcms')).json()).toEqual({ kind: 'drive#drive', id: 'drive-gd-bcms', name: 'Compliance BCMS' });
    expect((await get('/drive/v3/drives/drive-unknown')).statusCode).toBe(404);
    const about = await get('/drive/v3/about?fields=user');
    expect(about.json()).toEqual({ user: { kind: 'drive#user', displayName: 'MSCD Gateway', emailAddress: SA_EMAIL, me: true, permissionId: expect.any(String) } });
    expect((await get('/drive/v3/about')).statusCode).toBe(400);
  });
});

describe('Drive fault switches', () => {
  const fields = `?${ALL}&fields=headRevisionId,sha256Checksum,parents`;

  it('move changes the parent folder', async () => {
    await call(app, 'POST', '/_admin/items/file-prioritised/move', { json: {} });
    const file = (await get(`/drive/v3/files/file-prioritised${fields}`)).json();
    const parent = (await get(`/drive/v3/files/${file.parents[0]}?${ALL}&fields=name,parents`)).json();
    expect(parent).toEqual({ name: 'Moved', parents: ['folder-bcms-2026'] });
  });

  it('new-version changes the head revision and keeps the pinned revision', async () => {
    await call(app, 'POST', '/_admin/items/file-prioritised/new-version', { json: { content: 'activities r4', versionId: 'rev-d' } });
    expect((await get(`/drive/v3/files/file-prioritised${fields}`)).json()).toMatchObject({ headRevisionId: 'rev-d', sha256Checksum: sha256('activities r4') });
    expect((await get(`/drive/v3/files/file-prioritised/revisions/rev-c?${ALL}`)).statusCode).toBe(200);
  });

  it('purge-version loses the pinned revision; delete removes or trashes the file', async () => {
    await call(app, 'POST', '/_admin/items/file-prioritised/purge-version', { json: { versionId: 'rev-b' } });
    expect((await get(`/drive/v3/files/file-prioritised/revisions/rev-b?${ALL}`)).statusCode).toBe(404);
    await call(app, 'POST', '/_admin/items/file-prioritised/delete', { json: { mode: 'trash' } });
    expect((await get(`/drive/v3/files/file-prioritised?${ALL}&fields=trashed`)).json()).toEqual({ trashed: true });
    await call(app, 'POST', '/_admin/items/file-prioritised/delete', { json: {} });
    expect((await get(`/drive/v3/files/file-prioritised?${ALL}`)).statusCode).toBe(404);
  });

  it('corrupt-hash changes the checksum under the same head revision', async () => {
    const before = (await get(`/drive/v3/files/file-prioritised${fields}`)).json();
    await call(app, 'POST', '/_admin/items/file-prioritised/corrupt-hash', { json: {} });
    const after = (await get(`/drive/v3/files/file-prioritised${fields}`)).json();
    expect(after.headRevisionId).toBe(before.headRevisionId);
    expect(after.sha256Checksum).not.toBe(before.sha256Checksum);
    expect((await call(app, 'POST', '/_admin/items/file-bia-notes/corrupt-hash', { json: {} })).statusCode).toBe(400);
  });

  it('forbid, throttle and token revocation', async () => {
    await call(app, 'POST', '/_admin/drives/drive-gd-bcms/forbid', { json: {} });
    const forbidden = await get(`/drive/v3/files/file-prioritised?${ALL}`);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.errors[0].reason).toBe('insufficientFilePermissions');
    await call(app, 'POST', '/_admin/drives/drive-gd-bcms/forbid', { json: { forbidden: false } });

    await call(app, 'POST', '/_admin/throttle', { json: { count: 1, retryAfterSeconds: 3, apis: ['drive'] } });
    const throttled = await get(`/drive/v3/files/file-prioritised?${ALL}`);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBe('3');
    expect(throttled.json().error.errors[0]).toMatchObject({ domain: 'usageLimits', reason: 'rateLimitExceeded' });
    expect((await get(`/drive/v3/files/file-prioritised?${ALL}`)).statusCode).toBe(200);

    await call(app, 'POST', '/_admin/tokens/revoke', { json: { clientEmail: SA_EMAIL } });
    const revoked = await get(`/drive/v3/files/file-prioritised?${ALL}`);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.errors[0].reason).toBe('authError');
    const again = await googleTokenResponse(app);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
  });
});

describe('fields parameter', () => {
  it('parses nested selections and merges overlapping ones', () => {
    const value = { a: 1, b: { c: 2, d: 3 }, e: [{ f: 4, g: 5 }], h: 6 };
    expect(applyFields(value, parseFields('a,b/c,e(f)'))).toEqual({ a: 1, b: { c: 2 }, e: [{ f: 4 }] });
    expect(applyFields(value, parseFields('b/c,b'))).toEqual({ b: { c: 2, d: 3 } });
    expect(applyFields(value, parseFields('*'))).toEqual(value);
    expect(applyFields(value, parseFields('e(*)'))).toEqual({ e: [{ f: 4, g: 5 }] });
    expect(() => parseFields('a,')).toThrow();
    expect(() => parseFields('a(b')).toThrow();
    expect(DRIVE_SCOPE).toContain('auth/drive');
  });
});
