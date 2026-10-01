import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAUTH_CLIENT, OAUTH_SECRET, REDIRECT_URI, build, call, form, googleToken, googleTokenResponse, graphToken, graphTokenResponse, pathOf } from './helpers.js';

// The mock follows the documented JSON shapes (build plan J.7): responses are compared with example payloads
// copied from the public documentation (test/fixtures, see its README). Every field the mock sends must appear in
// the documented example with the same JSON type, or be a documented property of the resource; every field of
// the example must be sent unless it is listed here as not modelled.

type Kind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

function kindOf(value: unknown): Kind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as Kind;
}

/** Every key path of a JSON value with its type; array elements are merged under "[]". */
function paths(value: unknown, prefix = '', out = new Map<string, Kind>()): Map<string, Kind> {
  if (Array.isArray(value)) {
    for (const element of value) paths(element, `${prefix}[]`, out);
    if (value.length > 0) out.set(`${prefix}[]`, kindOf(value[0]));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.set(path, kindOf(entry));
      paths(entry, path, out);
    }
  }
  return out;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const RESOURCES = fixture('graph/resource-properties.json') as Record<string, string[]>;

/** Paths that are documented properties of Graph resources (from their JSON representations). */
function documentedGraphPath(path: string): boolean {
  // Instance annotations such as @microsoft.graph.downloadUrl contain dots but are one property name.
  if (path.startsWith('@')) return RESOURCES.driveItem.includes(path) || RESOURCES.driveItemVersion.includes(path);
  const segments = path.replace(/\[\]/g, '').split('.');
  const top = segments[0];
  const parentOf: Record<string, string> = {
    file: 'file',
    folder: 'folder',
    fileSystemInfo: 'fileSystemInfo',
    parentReference: 'itemReference',
    createdBy: 'identitySet',
    lastModifiedBy: 'identitySet',
    owner: 'identitySet',
    quota: 'quota',
  };
  if (segments.length === 1) return RESOURCES.driveItem.includes(top) || RESOURCES.drive.includes(top) || RESOURCES.uploadSession.includes(top);
  if (top === 'file' && segments[1] === 'hashes') return segments.length === 2 || RESOURCES.hashes.includes(segments[2]);
  if (['createdBy', 'lastModifiedBy', 'owner'].includes(top)) {
    if (segments.length === 2) return RESOURCES.identitySet.includes(segments[1]);
    // `email` on the user identity: SharePoint returns it and the plan requires it (D.5 zero-transit, J.7).
    return RESOURCES.identity.includes(segments[2]) || segments[2] === 'email';
  }
  const resource = parentOf[top];
  return resource !== undefined && segments.length === 2 && RESOURCES[resource].includes(segments[1]);
}

interface CompareOptions {
  /** Paths of the documented example the mock does not send, with the reason in a comment at the call. */
  notModelled?: string[];
  /** Accept extra mock paths that are documented properties of a Graph resource. */
  graphResource?: boolean;
  /** Further extra mock paths accepted (each justified at the call). */
  extra?: string[];
}

function compare(actual: unknown, documented: unknown, options: CompareOptions = {}): void {
  const mock = paths(actual);
  const doc = paths(documented);
  const problems: string[] = [];
  for (const [path, kind] of mock) {
    const documentedKind = doc.get(path);
    if (documentedKind !== undefined) {
      if (documentedKind !== kind) problems.push(`${path}: mock sends ${kind}, documentation shows ${documentedKind}`);
    } else if (!(options.extra ?? []).includes(path) && !(options.graphResource && documentedGraphPath(path))) {
      problems.push(`${path}: not in the documented example or resource`);
    }
  }
  for (const path of doc.keys()) {
    if (!mock.has(path) && !(options.notModelled ?? []).includes(path)) problems.push(`${path}: documented but not sent`);
  }
  expect(problems).toEqual([]);
}

let app: FastifyInstance;
let graph: string;
let google: string;
const DRIVE = '/v1.0/drives/drive-sp-compliance';

beforeAll(async () => {
  app = build();
  graph = await graphToken(app);
  google = await googleToken(app);
  await call(app, 'POST', '/_admin/fixtures', {
    json: { m365: { drives: [{ id: 'drive-owned', driveType: 'business', owner: { displayName: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id' } }] } },
  });
});

afterAll(async () => {
  await app.close();
});

describe('Microsoft Graph shapes', () => {
  it('root item: driveitem-get', async () => {
    const root = (await call(app, 'GET', `${DRIVE}/root`, { token: graph })).json();
    compare(root, fixture('graph/driveitem-get-root.json'), { graphResource: true });
  });

  it('created folder: driveitem-post-children', async () => {
    const folder = (await call(app, 'POST', `${DRIVE}/items/FOLDER-ISMS/children`, { token: graph, json: { name: 'Shape', folder: {} } })).json();
    // Created with an app-only token: SharePoint names the app under `application` and shows the user as
    // "SharePoint App" without an id.
    compare(folder, fixture('graph/driveitem-post-children.json'), { graphResource: true, notModelled: ['createdBy.user.id', 'lastModifiedBy.user.id'] });
    expect(folder.createdBy.application.id).toBeTruthy();
  });

  it('file item: every field is a documented driveItem property and the J.7 fields are present', async () => {
    const item = (await call(app, 'GET', `${DRIVE}/items/ITEM-BACKUP`, { token: graph })).json();
    const mock = paths(item);
    const undocumented = [...mock.keys()].filter((path) => !documentedGraphPath(path));
    expect(undocumented).toEqual([]);
    for (const required of [
      'id', 'name', 'size', 'eTag', 'cTag', 'createdDateTime', 'createdBy.user.displayName', 'createdBy.user.email', 'lastModifiedDateTime',
      'lastModifiedBy.user.displayName', 'parentReference.driveId', 'parentReference.id', 'parentReference.path', 'file.mimeType',
      'file.hashes.quickXorHash', 'webUrl', 'description',
    ]) {
      expect(mock.has(required), required).toBe(true);
    }
  });

  it('children: driveitem-list-children', async () => {
    await call(app, 'POST', '/_admin/settings', { json: { graphPageSize: 1 } });
    try {
      const page = (await call(app, 'GET', `${DRIVE}/items/FOLDER-ISMS/children`, { token: graph })).json();
      const documented = fixture('graph/driveitem-list-children.json') as { value: unknown[] };
      const mock = paths(page);
      for (const path of paths(documented).keys()) {
        if (path.startsWith('value[].')) continue;
        expect(mock.has(path), path).toBe(true);
      }
      expect([...mock.keys()].filter((path) => path.startsWith('value[].') && !documentedGraphPath(path.slice('value[].'.length)))).toEqual([]);
    } finally {
      await call(app, 'POST', '/_admin/settings', { json: { graphPageSize: 200 } });
    }
  });

  it('versions: driveitem-list-versions and driveitemversion-get', async () => {
    const versions = (await call(app, 'GET', `${DRIVE}/items/ITEM-BACKUP/versions`, { token: graph })).json();
    // `email` on the user identity: SharePoint returns it and the plan requires it.
    compare(versions, fixture('graph/driveitem-list-versions.json'), { extra: ['value[].lastModifiedBy.user.email'] });
    const version = (await call(app, 'GET', `${DRIVE}/items/ITEM-BACKUP/versions/1.0`, { token: graph })).json();
    compare(version, fixture('graph/driveitemversion-get.json'), { extra: ['lastModifiedBy.user.email'] });
  });

  it('drive: drive-get', async () => {
    const drive = (await call(app, 'GET', '/v1.0/drives/drive-owned', { token: graph })).json();
    compare(drive, fixture('graph/drive-get.json'), { graphResource: true });
  });

  it('upload session: create, progress and completion', async () => {
    const created = (await call(app, 'POST', `${DRIVE}/items/FOLDER-Q3:/shape.bin:/createUploadSession`, { token: graph, json: {} })).json();
    compare(created, fixture('graph/uploadsession-create.json'), { graphResource: true });
    const url = pathOf(created.uploadUrl);
    const content = Buffer.alloc(327_680 + 10, 1);
    const progress = await call(app, 'PUT', url, { body: content.subarray(0, 327_680), headers: { 'content-range': `bytes 0-327679/${content.length}`, 'content-type': 'application/octet-stream' } });
    compare(progress.json(), fixture('graph/uploadsession-progress.json'));
    const done = await call(app, 'PUT', url, { body: content.subarray(327_680), headers: { 'content-range': `bytes 327680-${content.length - 1}/${content.length}`, 'content-type': 'application/octet-stream' } });
    expect(done.statusCode).toBe(201);
    compare(done.json(), fixture('graph/uploadsession-complete.json'), { graphResource: true });
  });

  it('copy monitor: completed and failed', async () => {
    await call(app, 'POST', '/_admin/settings', { json: { copyPendingPolls: 0 } });
    try {
      const ok = await call(app, 'POST', `${DRIVE}/items/ITEM-POLICY/copy`, { token: graph, json: { parentReference: { id: 'FOLDER-COMPLIANCE' } } });
      compare((await call(app, 'GET', pathOf(ok.headers.location as string))).json(), fixture('graph/copy-monitor-completed.json'));
      const failed = await call(app, 'POST', `${DRIVE}/items/ITEM-POLICY/copy`, { token: graph, json: { parentReference: { id: 'FOLDER-COMPLIANCE' } } });
      compare((await call(app, 'GET', pathOf(failed.headers.location as string))).json(), fixture('graph/copy-monitor-failed.json'));
    } finally {
      await call(app, 'POST', '/_admin/settings', { json: { copyPendingPolls: 1 } });
    }
  });

  it('errors: error envelope and throttling', async () => {
    const session = (await call(app, 'POST', `${DRIVE}/items/FOLDER-Q3:/range.bin:/createUploadSession`, { token: graph, json: {} })).json();
    const overlap = await call(app, 'PUT', pathOf(session.uploadUrl), { body: Buffer.alloc(10), headers: { 'content-range': 'bytes 5-14/20', 'content-type': 'application/octet-stream' } });
    expect(overlap.statusCode).toBe(416);
    compare(overlap.json(), fixture('graph/error.json'));
    await call(app, 'POST', '/_admin/throttle', { json: { count: 1 } });
    compare((await call(app, 'GET', `${DRIVE}/root`, { token: graph })).json(), fixture('graph/error-throttling.json'));
  });
});

describe('Microsoft identity platform shapes', () => {
  it('token response and error response', async () => {
    compare((await graphTokenResponse(app)).json(), fixture('identity/entra-token-response.json'));
    compare((await graphTokenResponse(app, { scope: 'https://example.invalid/.default' })).json(), fixture('identity/entra-token-error.json'));
  });
});

interface SchemaProperty {
  type?: string;
  format?: string;
  $ref?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
}

const DRIVE_SCHEMAS = (fixture('google/drive-v3-schemas.json') as { schemas: Record<string, { properties: Record<string, SchemaProperty> }> }).schemas;

/** Checks a value against a schema of the Drive discovery document; returns the problems. */
function checkSchema(value: unknown, schema: string | SchemaProperty, path: string, problems: string[]): void {
  const definition: SchemaProperty = typeof schema === 'string' ? { $ref: schema } : schema;
  if (definition.$ref) {
    const properties = DRIVE_SCHEMAS[definition.$ref]?.properties;
    if (!properties) {
      problems.push(`${path}: schema ${definition.$ref} is not recorded`);
      return;
    }
    if (kindOf(value) !== 'object') {
      problems.push(`${path}: expected an object (${definition.$ref})`);
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const property = properties[key];
      if (!property) problems.push(`${path}.${key}: not a property of ${definition.$ref}`);
      else checkSchema(entry, property, `${path}.${key}`, problems);
    }
    return;
  }
  const kind = kindOf(value);
  switch (definition.type) {
    case 'string':
      if (kind !== 'string') problems.push(`${path}: expected a string${definition.format ? ` (${definition.format})` : ''}, got ${kind}`);
      if (definition.format === 'int64' && kind === 'string' && !/^-?\d+$/.test(value as string)) problems.push(`${path}: not an int64 string`);
      if (definition.format === 'date-time' && kind === 'string' && Number.isNaN(Date.parse(value as string))) problems.push(`${path}: not a date-time`);
      break;
    case 'boolean':
      if (kind !== 'boolean') problems.push(`${path}: expected a boolean, got ${kind}`);
      break;
    case 'integer':
    case 'number':
      if (kind !== 'number') problems.push(`${path}: expected a number, got ${kind}`);
      break;
    case 'array':
      if (kind !== 'array') problems.push(`${path}: expected an array, got ${kind}`);
      else (value as unknown[]).forEach((entry, index) => checkSchema(entry, definition.items ?? {}, `${path}[${index}]`, problems));
      break;
    case 'object':
      if (kind !== 'object') problems.push(`${path}: expected an object, got ${kind}`);
      else if (definition.properties) {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          const property = definition.properties[key];
          if (!property) problems.push(`${path}.${key}: not a documented property`);
          else checkSchema(entry, property, `${path}.${key}`, problems);
        }
      }
      break;
    default:
      break;
  }
}

function expectSchema(value: unknown, schema: string): void {
  const problems: string[] = [];
  checkSchema(value, schema, schema, problems);
  expect(problems).toEqual([]);
}

describe('Google Drive shapes (discovery document)', () => {
  it('files, file lists, revisions, drives and about match the v3 schemas', async () => {
    const get = (url: string, token = google) => call(app, 'GET', url, { token });
    for (const id of ['file-prioritised', 'file-bia-notes', 'folder-bcms-2026', 'drive-gd-bcms']) {
      expectSchema((await get(`/drive/v3/files/${id}?supportsAllDrives=true&fields=*`)).json(), 'File');
    }
    const delegated = await googleToken(app, { subject: 'tono.hartono@nusantaradigital.co.id' });
    expectSchema((await get('/drive/v3/files/file-my-note?fields=*', delegated)).json(), 'File');
    const list = (await get('/drive/v3/files?corpora=drive&driveId=drive-gd-bcms&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=1&fields=*')).json();
    expect(list.nextPageToken).toBeTruthy();
    expectSchema(list, 'FileList');
    expectSchema((await get('/drive/v3/files/file-prioritised/revisions?supportsAllDrives=true&fields=*')).json(), 'RevisionList');
    expectSchema((await get('/drive/v3/files/file-bia-notes/revisions/7?supportsAllDrives=true&fields=*')).json(), 'Revision');
    expectSchema((await get('/drive/v3/drives/drive-gd-bcms?fields=*')).json(), 'Drive');
    expectSchema((await get('/drive/v3/about?fields=*')).json(), 'About');
    const upload = await call(app, 'POST', '/upload/drive/v3/files?uploadType=media&supportsAllDrives=true&fields=*', { token: delegated, body: 'media', headers: { 'content-type': 'text/plain' } });
    expect(upload.statusCode).toBe(200);
    expectSchema(upload.json(), 'File');
  });

  it('errors match the documented envelopes', async () => {
    compare((await call(app, 'GET', '/drive/v3/files/missing-file?supportsAllDrives=true', { token: google })).json(), fixture('google/error-not-found.json'));
    compare((await call(app, 'GET', '/drive/v3/files/file-prioritised?supportsAllDrives=true', { token: 'forged' })).json(), fixture('google/error-auth.json'));
    await call(app, 'POST', '/_admin/throttle', { json: { count: 1, apis: ['drive'] } });
    compare((await call(app, 'GET', '/drive/v3/files/file-prioritised?supportsAllDrives=true', { token: google })).json(), fixture('google/error-rate-limit.json'));
  });
});

describe('Google OAuth shapes', () => {
  it('service account, refresh and code exchange responses and the error', async () => {
    compare((await googleTokenResponse(app)).json(), fixture('google/token-service-account.json'));
    const refresh = await call(app, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: '1//refresh-valid', client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    compare(refresh.json(), fixture('google/token-refresh.json'));
    const code = (await call(app, 'POST', '/_admin/oauth/codes', { json: { clientId: OAUTH_CLIENT, redirectUri: REDIRECT_URI, account: { email: 'tono.hartono@nusantaradigital.co.id' } } })).json().code;
    const exchange = await call(app, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    compare(exchange.json(), fixture('google/token-authorization-code.json'));
    const expired = await call(app, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: '1//refresh-expired', client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    compare(expired.json(), fixture('google/token-error.json'));
  });
});
