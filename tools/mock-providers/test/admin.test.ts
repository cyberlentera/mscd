import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMockProviders, quickXorHash, startMockProviders } from '../src/index.js';
import { BAGUS, CLIENT_ID, build, call, graphToken, googleToken, standardFixtures } from './helpers.js';

let app: FastifyInstance;

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.close();
});

describe('admin API', () => {
  it('answers health and summarises the state', async () => {
    expect((await call(app, 'GET', '/_admin/health')).json()).toEqual({ status: 'ok' });
    const state = (await call(app, 'GET', '/_admin/state')).json();
    expect(state.drives.map((d: { id: string }) => d.id)).toEqual(['drive-sp-compliance', 'drive-od-fnugroho', 'drive-gd-bcms', 'drive-my-tono']);
    expect(state.credentials).toEqual({ m365Apps: 1, serviceAccounts: 1, oauthClients: 1, refreshTokens: 2 });
    expect(state.settings).toEqual({ tokenLifetimeSeconds: 3599, graphSimpleUploadMaxBytes: 4194304, copyPendingPolls: 1, graphPageSize: 200, drivePageSize: 100 });
  });

  it('reset restores the fixtures and drops runtime changes, tokens and the request log', async () => {
    const token = await graphToken(app);
    await call(app, 'POST', '/_admin/items/ITEM-POLICY/delete', { json: {} });
    await call(app, 'POST', '/_admin/throttle', { json: { count: 5 } });
    const reset = await call(app, 'POST', '/_admin/reset');
    expect(reset.json()).toMatchObject({ ok: true, fixtures: 'loaded', drives: 4 });
    expect((await call(app, 'GET', '/v1.0/drives/drive-sp-compliance/items/ITEM-POLICY', { token })).statusCode).toBe(401);
    const fresh = await graphToken(app);
    expect((await call(app, 'GET', '/v1.0/drives/drive-sp-compliance/items/ITEM-POLICY', { token: fresh })).statusCode).toBe(200);
    const log = (await call(app, 'GET', '/_admin/requests')).json().requests;
    expect(log.map((r: { api: string; status: number }) => `${r.api} ${r.status}`)).toEqual(['graph 401', 'identity 200', 'graph 200']);
  });

  it('reset with a document replaces the base fixtures; folder ids stay stable', async () => {
    const empty = buildMockProviders();
    try {
      expect((await call(empty, 'POST', '/_admin/reset')).json()).toMatchObject({ ok: true, fixtures: 'none', drives: 0 });
      const loaded = await call(empty, 'POST', '/_admin/reset', { json: standardFixtures() });
      expect(loaded.json()).toMatchObject({ fixtures: 'loaded', drives: 4, credentials: 5 });
      const before = (await call(empty, 'GET', '/_admin/items/ITEM-BACKUP')).json();
      await call(empty, 'POST', '/_admin/reset');
      const after = (await call(empty, 'GET', '/_admin/items/ITEM-BACKUP')).json();
      expect(after.parentId).toBe(before.parentId);
      expect(after.versions).toEqual(before.versions);
      const invalid = await call(empty, 'POST', '/_admin/reset', { json: { m365: { drives: [{ id: 'bad id' }] } } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.details[0]).toContain('fixtures.m365.drives[0].id');
      expect((await call(empty, 'GET', '/_admin/state')).json().drives).toHaveLength(4);
    } finally {
      await empty.close();
    }
  });

  it('merges fixture documents and refuses conflicting ids without changing anything', async () => {
    const merged = await call(app, 'POST', '/_admin/fixtures', {
      json: { m365: { drives: [{ id: 'drive-sp-compliance', items: [{ id: 'ITEM-NEW', path: 'Compliance/QMS', name: 'Manual.docx', content: 'manual' }] }] } },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ ok: true, drives: 0, folders: 1, items: 1 });
    const conflict = await call(app, 'POST', '/_admin/fixtures', {
      json: { m365: { drives: [{ id: 'drive-new', items: [{ id: 'ITEM-POLICY', name: 'x.txt' }, { id: 'ITEM-X', name: 'y.txt' }] }] } },
    });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json().error.details.join(' ')).toContain('ITEM-POLICY');
    expect((await call(app, 'GET', '/_admin/items/ITEM-X')).statusCode).toBe(404);
    expect((await call(app, 'GET', '/_admin/state')).json().drives).toHaveLength(4);
  });

  it('creates items for zero-transit tests and shows their versions', async () => {
    const created = await call(app, 'POST', '/_admin/items', {
      json: { driveId: 'drive-sp-compliance', path: 'Compliance/ISMS', name: 'Uploaded by Bagus MSCD-ZT42.pdf', content: 'zero transit', createdBy: BAGUS, createdAt: '2026-09-29T08:00:00Z' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      provider: 'm365',
      folderPath: '/Compliance/ISMS',
      kind: 'file',
      createdBy: BAGUS,
      currentVersionId: '1.0',
      versions: [{ id: '1.0', quickXorHash: quickXorHash('zero transit'), size: 12 }],
    });
    const token = await graphToken(app);
    const item = (await call(app, 'GET', `/v1.0/drives/drive-sp-compliance/items/${created.json().id}`, { token })).json();
    expect(item.createdBy.user.email).toBe(BAGUS.email);
    expect(item.createdDateTime).toBe('2026-09-29T08:00:00.000Z');
    const duplicate = await call(app, 'POST', '/_admin/items', { json: { driveId: 'drive-sp-compliance', path: 'Compliance/ISMS', name: 'Uploaded by Bagus MSCD-ZT42.pdf' } });
    expect(duplicate.statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/items', { json: { driveId: 'nope', name: 'x' } })).statusCode).toBe(404);
  });

  it('registers credentials and lists them without secrets', async () => {
    const registered = await call(app, 'POST', '/_admin/credentials', {
      json: { credentials: [{ kind: 'google_oauth_client', clientId: 'second-client', clientSecret: 'secret-2' }] },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().registered).toEqual([{ kind: 'google_oauth_client', id: 'second-client' }]);
    const listed = await call(app, 'GET', '/_admin/credentials');
    expect(listed.body).not.toContain('secret-2');
    expect(listed.body).not.toContain('PRIVATE KEY');
    expect(listed.json().m365Apps[0]).toMatchObject({ clientId: CLIENT_ID, revoked: false });
    const invalid = await call(app, 'POST', '/_admin/credentials', { json: [{ kind: 'm365_certificate', tenantId: 't', clientId: 'c', certificatePem: 'not a certificate' }] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.details[0]).toContain('certificatePem');
  });

  it('records provider requests with the principal and clears the log', async () => {
    const token = await googleToken(app);
    await call(app, 'GET', '/drive/v3/files/file-my-note', { token });
    await call(app, 'GET', '/_admin/state');
    const log = (await call(app, 'GET', '/_admin/requests?api=drive')).json().requests;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ api: 'drive', method: 'GET', url: '/drive/v3/files/file-my-note', status: 200, authorization: true, principal: 'mscd-gateway@mscd-test.iam.gserviceaccount.com' });
    const since = (await call(app, 'GET', `/_admin/requests?since=${log[0].seq}`)).json().requests;
    expect(since).toHaveLength(0);
    expect((await call(app, 'DELETE', '/_admin/requests')).statusCode).toBe(204);
    expect((await call(app, 'GET', '/_admin/requests')).json().requests).toEqual([]);
  });

  it('validates settings, throttle and latency bodies', async () => {
    expect((await call(app, 'POST', '/_admin/settings', { json: { graphPageSize: 2 } })).json().graphPageSize).toBe(2);
    expect((await call(app, 'POST', '/_admin/settings', { json: { graphPageSize: 0 } })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/settings', { json: { unknown: 1 } })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/throttle', { json: {} })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/throttle', { json: { count: 1, apis: ['admin'] } })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/throttle', { json: { count: 1, status: 500 } })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/throttle', { json: { count: 0 } })).json()).toEqual({ throttle: null });
    expect((await call(app, 'POST', '/_admin/latency', { json: { ms: -1 } })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/throttle', { body: 'not json', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/items/a%2Fb/move', { json: {} })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/_admin/drives/nope/forbid', { json: {} })).statusCode).toBe(404);
  });

  it('never throttles or delays the admin API', async () => {
    await call(app, 'POST', '/_admin/throttle', { json: { count: 3, apis: ['graph', 'drive', 'identity'] } });
    expect((await call(app, 'GET', '/_admin/health')).statusCode).toBe(200);
    expect((await call(app, 'GET', '/_admin/state')).json().throttle.remaining).toBe(3);
  });

  it('answers unknown routes in the envelope of their API', async () => {
    expect((await call(app, 'GET', '/v1.0/me/drive')).json().error.code).toBe('InvalidAuthenticationToken');
    expect((await call(app, 'GET', '/v1.0/me/drive', { token: await graphToken(app) })).json().error.code).toBe('invalidRequest');
    expect((await call(app, 'GET', '/drive/v3/unknown')).json().error.code).toBe(404);
    expect((await call(app, 'GET', '/nothing-here')).statusCode).toBe(404);
  });
});

describe('startMockProviders', () => {
  it('listens on a free port and serves real HTTP', async () => {
    const running = await startMockProviders({ port: 0, fixtures: standardFixtures() });
    try {
      expect(running.port).toBeGreaterThan(0);
      const response = await fetch(`${running.url}/_admin/state`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { drives: unknown[] }).drives).toHaveLength(4);
    } finally {
      await running.close();
    }
  });
});
