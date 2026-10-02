// Test support routes (build plan D.3 "Test support", J.6, WP-27): `POST /test/reset` and `POST /test/session` exist
// only with `demo.enabled` and `test.endpoints_enabled` (404 otherwise, and the release flavour refuses every `test.*`
// key); a reset recreates the database from the template, so a changed row comes back and `last_used_step` of every
// second factor is cleared; a minted session is an active session that reads the api.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockProviders, type RunningMockProviders } from '@mscd/mock-providers';
import type { Me, TestResetResponse } from '@mscd/shared';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRules, releaseFlavourIssues } from '../../../src/config/profile.schema';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TestRequestGate } from '../../../src/modules/test-support/request-gate';
import { TestSupportModule } from '../../../src/modules/test-support/test-support.module';
import { UiModule } from '../../../src/modules/ui/ui.module';
import { serverUrl, templateName } from '../../setup/test-db-server';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { Browser } from '../identity/helpers';

const RESET = '/api/v1/test/reset';
const SESSION = '/api/v1/test/session';
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DEMO_FIXTURES = path.join(REPO_ROOT, 'tools/mock-providers/fixtures/demo.json');

interface App {
  app: NestFastifyApplication;
  close(): Promise<void>;
}

async function createApp(db: TestDatabase, env: Record<string, string>): Promise<App> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, UiModule, TestSupportModule] },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, close: () => app.close() };
}

/** A query on a short-lived administrator connection to the test database (the reset ends pooled connections). */
async function query<T extends pg.QueryResultRow>(db: TestDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: db.urls.admin });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe('test support routes are refused without the flags', () => {
  const db = useTestDatabase('demo');
  let ctx: App;

  beforeAll(async () => {
    ctx = await createApp(db, {});
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('answers 404 for both routes when test.endpoints_enabled is false', async () => {
    const browser = new Browser(ctx.app);
    expect((await browser.post(RESET, undefined)).statusCode).toBe(404);
    const session = await browser.post(SESSION, { handle: 'rina' });
    expect(session.statusCode).toBe(404);
    expect(browser.session).toBeUndefined();
  });

  it('installs no request gate without the flags', () => {
    expect(ctx.app.get(TestRequestGate).active).toBe(0);
  });

  it('the profile refuses test.endpoints_enabled without demo mode, and a release build refuses every test key', () => {
    const profile = db.config({ MSCD__TEST__ENDPOINTS_ENABLED: 'true' }).profile;
    expect(profileRules({ ...profile, demo: { ...profile.demo, enabled: false } }).map((i) => i.path)).toContain('test.endpoints_enabled');
    const refused = releaseFlavourIssues(profile).map((i) => i.path);
    expect(refused).toEqual(expect.arrayContaining(['test.endpoints_enabled', 'test.template_database', 'test.admin_database_url_file', 'demo.enabled']));
  });
});

describe('test support routes with the flags (J.6)', () => {
  const db = useTestDatabase('demo');
  let ctx: App;
  let mock: RunningMockProviders;
  let secrets: string;
  const mockLog: string[] = [];

  beforeAll(async () => {
    mock = await startMockProviders({ port: 0, onRequestLog: (line) => mockLog.push(line), fixtures: JSON.parse(readFileSync(DEMO_FIXTURES, 'utf8')) as unknown });
    secrets = mkdtempSync(path.join(tmpdir(), 'mscd-test-support-'));
    const adminFile = path.join(secrets, 'db-admin.url');
    writeFileSync(adminFile, serverUrl(db.server, db.server.adminDatabase), { mode: 0o600 });
    ctx = await createApp(db, {
      MSCD__TEST__ENDPOINTS_ENABLED: 'true',
      MSCD__TEST__TEMPLATE_DATABASE: templateName('demo'),
      MSCD__TEST__ADMIN_DATABASE_URL_FILE: adminFile,
      MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL: `${mock.url}/v1.0`,
      MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL: mock.url,
    });
  });
  afterAll(async () => {
    await ctx?.close();
    await mock?.close();
    if (secrets) rmSync(secrets, { recursive: true, force: true });
  });

  it('a minted session is active, uses auth method test and reads the api', async () => {
    const browser = new Browser(ctx.app);
    const minted = await browser.post(SESSION, { handle: 'rina' });
    expect(minted.statusCode).toBe(200);
    const me = minted.json() as Me;
    expect(me.user.handle).toBe('rina');
    expect(me.org?.slug).toBe('ndt');
    expect(me.session.authMethod).toBe('test');
    expect(browser.session).toBeDefined();

    const read = await browser.get('/api/v1/me');
    expect(read.statusCode).toBe(200);
    expect((read.json() as Me).user.handle).toBe('rina');
    expect((await browser.get('/api/v1/ui/org')).statusCode).toBe(200);

    const rows = await query<{ state: string; auth_method: string; mfa_at: Date | null }>(
      db,
      `select s.state, s.auth_method, s.mfa_at from platform.session s join platform.app_user u on u.id = s.user_id
        where u.handle = 'rina' and s.revoked_at is null`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'active', auth_method: 'test' });

    // A second session in the same browser replaces the first.
    const again = await browser.post(SESSION, { handle: 'rina' });
    expect(again.statusCode).toBe(200);
    const open = await query(db, `select 1 from platform.session s join platform.app_user u on u.id = s.user_id where u.handle = 'rina' and s.revoked_at is null`);
    expect(open).toHaveLength(1);
  });

  it('mints a session in another organisation of the user, and refuses unknown users and foreign origins', async () => {
    const browser = new Browser(ctx.app);
    const bsd = await browser.post(SESSION, { handle: 'rina', org: 'bsd' });
    expect(bsd.statusCode).toBe(200);
    expect((bsd.json() as Me).org?.slug).toBe('bsd');

    expect((await new Browser(ctx.app).post(SESSION, { handle: 'nobody' })).statusCode).toBe(404);
    expect((await new Browser(ctx.app).post(SESSION, { handle: 'rina', org: 'zzz' })).statusCode).toBe(404);
    const foreign = new Browser(ctx.app);
    expect((await foreign.post(SESSION, { handle: 'rina' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(foreign.session).toBeUndefined();
    expect((await new Browser(ctx.app).post(RESET, undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('a reset restores a changed row, clears last_used_step and ends the sessions', async () => {
    const browser = new Browser(ctx.app);
    expect((await browser.post(SESSION, { handle: 'rina' })).statusCode).toBe(200);

    const [before] = await query<{ display_name: string }>(db, `select display_name from platform.app_user where handle = 'rina'`);
    await query(db, `update platform.app_user set display_name = 'Changed by the test' where handle = 'rina'`);
    await query(db, `update platform.mfa_factor set last_used_step = '99999999' where user_id in (select id from platform.app_user where handle in ('maya', 'hendra'))`);
    const [tenantBefore] = await query<{ n: string }>(db, `select count(*) as n from org_ndt.audit_trail`);

    const reset = await browser.post(RESET, undefined);
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as TestResetResponse).ok).toBe(true);

    const [after] = await query<{ display_name: string }>(db, `select display_name from platform.app_user where handle = 'rina'`);
    expect(after!.display_name).toBe(before!.display_name);
    const steps = await query<{ last_used_step: string | null }>(db, `select last_used_step from platform.mfa_factor`);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((row) => row.last_used_step === null)).toBe(true);
    const [tenantAfter] = await query<{ n: string }>(db, `select count(*) as n from org_ndt.audit_trail`);
    expect(Number(tenantAfter!.n)).toBeLessThanOrEqual(Number(tenantBefore!.n));
    const sessions = await query(db, `select 1 from platform.session where auth_method = 'test'`);
    expect(sessions).toHaveLength(0);

    // The old cookie no longer works; the api answers at once with a new session on the recreated database.
    expect((await browser.get('/api/v1/me')).statusCode).toBe(401);
    const fresh = new Browser(ctx.app);
    expect((await fresh.post(SESSION, { handle: 'bagus' })).statusCode).toBe(200);
    expect((await fresh.get('/api/v1/ui/org')).statusCode).toBe(200);
  });

  it('a reset asks the mock providers to go back to their fixtures', async () => {
    mockLog.length = 0;
    const reset = await new Browser(ctx.app).post(RESET, undefined);
    expect(reset.statusCode).toBe(200);
    expect(mockLog.some((line) => line.startsWith('POST /_admin/reset 200'))).toBe(true);
  });

  it('requests that arrive during a reset are answered, and the api works after it', async () => {
    const resetting = new Browser(ctx.app).post(RESET, undefined);
    const during = [new Browser(ctx.app).post(SESSION, { handle: 'sari' }), new Browser(ctx.app).get('/api/v1/system/profile')];
    const [reset, ...answers] = await Promise.all([resetting, ...during]);
    expect(reset!.statusCode).toBe(200);
    for (const answer of answers) expect(answer.statusCode).toBe(200);
    const after = new Browser(ctx.app);
    expect((await after.post(SESSION, { handle: 'sari' })).statusCode).toBe(200);
    expect((await after.get('/api/v1/me')).statusCode).toBe(200);
    expect(ctx.app.get(TestRequestGate).active).toBe(0);
  });
});
