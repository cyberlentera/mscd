// D.3 "Operations" (WP-34) on the demo data: every route needs the platform operator, the job allow-list and the
// strict body, the organisation rules of tenant and installation jobs, the `ops.job_run` and
// `ops.diagnostics_exported` audit entries, and the diagnostics archive (files, redacted log lines from the ring
// buffer, and a scan for every secret value the process knows of).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import { readTar } from '@mscd/pack-tools';
import { JobRunResponse, OpsHealth, QueueStats } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/jobs/job-queue';
import { MIGRATIONS_BY_FOLDER } from '../../../src/generated/build-info';
import { LOG_RING } from '../../../src/modules/observability/log-ring';
import { manualRunKey } from '../../../src/modules/ops/ops.service';
import type { IntApp } from '../platform/helpers';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { TEST_ROLE_PASSWORDS } from '../../setup/test-db-server';
import { as, createOpsApp, opsIdentities, tenantInfo } from './helpers';

const SECRETS_DIR = path.resolve(__dirname, '../../fixtures/secrets');
const DEMO_PASSWORD = 'Mscd-Demo-2026!';
const TOKEN_VALUE = 'tok-SECRET-9f8e7d6c5b4a';
const OIDC_CODE = 'oidc-code-2c0ffee2c0ffee';
const OIDC_STATE = 'state-7d1e0c9b8a7f6e5d';

describe('operations routes (D.3, WP-34)', () => {
  const db = useTestDatabase('demo');
  let ctx: IntApp;
  let opsUserId: string;
  let ndtId: string;

  beforeAll(async () => {
    const users = await db.migrator.selectFrom('platform.app_user').select(['id', 'handle']).where('handle', 'in', ['ops', 'tenant.admin']).execute();
    const byHandle = new Map(users.map((u) => [u.handle, u.id]));
    opsUserId = byHandle.get('ops')!;
    const tst = await tenantInfo(db.migrator, 'tst');
    ndtId = (await tenantInfo(db.migrator, 'ndt')).id;
    ctx = await createOpsApp(db, opsIdentities({ id: opsUserId, handle: 'ops' }, { id: byHandle.get('tenant.admin')!, handle: 'tenant.admin', org: tst }), {
      // Warn level: 4xx request lines and warnings reach the ring buffer (the test profile default is silent here).
      env: { MSCD__OBSERVABILITY__LOG_LEVEL: 'warn' },
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const inject = (method: 'GET' | 'POST', url: string, who: string | null, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: who ? as(who) : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('answers 401 without a session and 403 for a Tenant Admin on every route', async () => {
    const routes: ['GET' | 'POST', string, unknown?][] = [
      ['GET', '/api/v1/ops/health'],
      ['GET', '/api/v1/ops/queues'],
      ['POST', '/api/v1/ops/jobs/cleanup.expired/run', {}],
      ['POST', '/api/v1/ops/diagnostics'],
    ];
    for (const [method, url, body] of routes) {
      expect((await inject(method, url, null, body)).statusCode, `${method} ${url} anonymous`).toBe(401);
      const denied = await inject(method, url, 'ta', body);
      expect(denied.statusCode, `${method} ${url} tenant admin`).toBe(403);
      expect(denied.headers['content-type']).toMatch(/application\/problem\+json/);
    }
  });

  it('reports installation health and queues to the platform operator', async () => {
    const res = await inject('GET', '/api/v1/ops/health', 'ops');
    expect(res.statusCode).toBe(200);
    const health = OpsHealth.parse(res.json());
    const byName = new Map(health.components.map((c) => [c.name, c]));
    expect(byName.get('database')?.status).toBe('ok');
    expect(byName.get('migrations')?.status).toBe('ok');
    expect(byName.get('job-queue')?.status).toBe('ok');
    expect(byName.get('job-outbox')).toEqual({ name: 'job-outbox', status: 'ok', detail: 'no stuck rows' });
    expect(byName.get('telemetry')?.detail).toBe('off');
    expect(health.migrations).toContainEqual({ schema: 'platform', latest: MIGRATIONS_BY_FOLDER.platform.at(-1), expected: MIGRATIONS_BY_FOLDER.platform.at(-1) });
    expect(health.migrations).toContainEqual({ schema: 'ref', latest: MIGRATIONS_BY_FOLDER.ref.at(-1), expected: MIGRATIONS_BY_FOLDER.ref.at(-1) });
    expect(health.licences.map((l) => l.org).sort()).toEqual(['bsd', 'ndt', 'rmn', 'tst']);
    expect(health.licences.every((l) => l.state === 'valid')).toBe(true);

    const queues = await inject('GET', '/api/v1/ops/queues', 'ops');
    expect(queues.statusCode).toBe(200);
    z.array(QueueStats).parse(queues.json());
  });

  it('rejects job names outside the allow-list and bodies with any member besides org', async () => {
    for (const name of ['pack.install', 'scheduler.tick', 'freshness.recompute', 'rm%20-rf', 'no.such.job']) {
      const res = await inject('POST', `/api/v1/ops/jobs/${name}/run`, 'ops', {});
      expect(res.statusCode, name).toBe(400);
      expect(res.json()).toMatchObject({ type: expect.stringMatching(/validation$/) });
    }
    for (const body of [{ payload: { evidenceIds: ['x'] } }, { org: 'ndt', payload: {} }, { org: 'ndt', msId: 'x' }, { org: 'NDT' }]) {
      const res = await inject('POST', '/api/v1/ops/jobs/freshness.sweep/run', 'ops', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const queued = await ctx.moduleRef.get<JobQueue>(JOB_QUEUE).stats();
    expect(queued.find((q) => q.name === 'freshness.sweep')?.waiting ?? 0).toBe(0);
  });

  it('applies the organisation rules of tenant and installation jobs', async () => {
    expect((await inject('POST', '/api/v1/ops/jobs/freshness.sweep/run', 'ops', {})).statusCode).toBe(422);
    expect((await inject('POST', '/api/v1/ops/jobs/freshness.sweep/run', 'ops', { org: 'zzz' })).statusCode).toBe(404);
    expect((await inject('POST', '/api/v1/ops/jobs/cleanup.expired/run', 'ops', { org: 'ndt' })).statusCode).toBe(422);
    // No handler of drift.evaluate in this application: the run is refused instead of queuing a job nobody works on.
    const unavailable = await inject('POST', '/api/v1/ops/jobs/drift.evaluate/run', 'ops', { org: 'ndt' });
    expect(unavailable.statusCode).toBe(422);
    expect(unavailable.json().detail).toMatch(/no handler/);
  });

  it('queues an allow-listed job with an empty payload and audits ops.job_run in the same transaction', async () => {
    const queue = ctx.moduleRef.get<JobQueue>(JOB_QUEUE);
    const tenantRun = await inject('POST', '/api/v1/ops/jobs/freshness.sweep/run', 'ops', { org: 'ndt' });
    expect(tenantRun.statusCode).toBe(202);
    const { jobId } = JobRunResponse.parse(tenantRun.json());
    const installRun = await inject('POST', '/api/v1/ops/jobs/cleanup.expired/run', 'ops', {});
    expect(installRun.statusCode).toBe(202);

    const stats = await queue.stats();
    expect(stats.find((q) => q.name === 'freshness.sweep')?.waiting).toBe(1);
    expect(stats.find((q) => q.name === 'cleanup.expired')?.waiting).toBe(1);

    const entries = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .selectFrom('platform.audit_log')
        .select(['action', 'organization_id', 'actor_user_id', 'actor_kind', 'entity_type', 'entity_code', 'after_data'])
        .where('action', '=', 'ops.job_run')
        .orderBy('seq')
        .execute(),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ organization_id: ndtId, actor_user_id: opsUserId, actor_kind: 'operator', entity_type: 'job', entity_code: 'freshness.sweep' });
    expect(entries[0]!.after_data).toMatchObject({ job: 'freshness.sweep', jobId, org: 'ndt' });
    expect(entries[1]).toMatchObject({ organization_id: null, entity_code: 'cleanup.expired' });
    expect(manualRunKey('freshness.sweep', ndtId)).toBe(`ops:freshness.sweep:${ndtId}`);
  });

  it('exports a diagnostics archive without any secret value, with redacted log lines from the ring buffer', async () => {
    // Traffic and log lines that carry secrets: query tokens, an OIDC callback code and state, a database URL with
    // its password, secret file contents and a password member.
    const gatewayToken = readFileSync(path.join(SECRETS_DIR, 'gateway.token'), 'utf8').trim();
    expect((await inject('GET', `/api/v1/ops/health?token=${TOKEN_VALUE}&code=${OIDC_CODE}`, null)).statusCode).toBe(401);
    expect((await inject('GET', `/api/v1/auth/oidc/callback?code=${OIDC_CODE}&state=${OIDC_STATE}`, null)).statusCode).toBeGreaterThanOrEqual(300);
    expect((await inject('GET', `/api/v1/no-such-route?invitation=${TOKEN_VALUE}&t=${TOKEN_VALUE}`, null)).statusCode).toBe(404);
    const logger = new Logger('ops-test');
    logger.warn(`connecting with ${db.urls.app}`);
    logger.warn(`gateway token is ${gatewayToken}`);
    logger.warn({ password: DEMO_PASSWORD, clientSecret: 'kc-client-secret-value', code: OIDC_CODE }, 'credentials of a sign-in');
    logger.warn(`callback https://app.example/api/v1/auth/oidc/callback?state=${OIDC_STATE}&code=${OIDC_CODE}`);

    // pino already redacted the request URLs before the lines reached the ring buffer.
    const raw = LOG_RING.lines().join('\n');
    expect(raw).toContain('/api/v1/ops/health?token=[redacted]&code=[redacted]');
    expect(raw).not.toContain(TOKEN_VALUE);
    expect(raw.match(/\/auth\/oidc\/callback\?code=\[redacted\]&state=\[redacted\]/)).not.toBeNull();

    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/ops/diagnostics', headers: as('ops') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="mscd-diagnostics-\d{8}T\d{6}Z\.tar\.gz"/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

    const entries = readTar(gunzipSync(res.rawPayload), { maxEntries: 50 });
    const files = new Map(entries.filter((e) => e.type === 'file').map((e) => [e.path.split('/').slice(1).join('/'), e.data.toString('utf8')]));
    expect([...files.keys()].sort()).toEqual(['README.txt', 'health.json', 'logs.ndjson', 'metrics.txt', 'migrations.json', 'profile.json', 'queues.json', 'versions.json']);
    OpsHealth.parse(JSON.parse(files.get('health.json')!));
    expect(JSON.parse(files.get('profile.json')!).profile.database.pool_max).toBe(10);
    expect(files.get('metrics.txt')).toContain('# TYPE mscd_http_request_duration_seconds histogram');
    const logLines = files.get('logs.ndjson')!.trim().split('\n');
    expect(logLines.length).toBeGreaterThan(3);
    expect(logLines.length).toBeLessThanOrEqual(1000);
    for (const line of logLines) JSON.parse(line);
    expect(files.get('logs.ndjson')).toContain('[redacted]');

    // Every secret value this process can know of.
    const secrets = new Set<string>([DEMO_PASSWORD, TOKEN_VALUE, OIDC_CODE, OIDC_STATE, 'kc-client-secret-value', ...Object.values(TEST_ROLE_PASSWORDS)]);
    for (const name of readdirSync(SECRETS_DIR)) {
      if (name === 'README.md') continue;
      const text = readFileSync(path.join(SECRETS_DIR, name), 'utf8').trim();
      secrets.add(text);
      for (const line of text.split('\n')) if (line.trim().length >= 8 && !line.startsWith('-----')) secrets.add(line.trim());
      const urlPassword = /:\/\/[^:/@]+:([^@]+)@/.exec(text)?.[1];
      if (urlPassword) secrets.add(decodeURIComponent(urlPassword));
    }
    for (const url of Object.values(db.urls)) {
      const password = new URL(url).password;
      if (password) secrets.add(decodeURIComponent(password));
    }
    for (const [file, text] of files) {
      for (const secret of secrets) {
        expect(text.includes(secret), `${file} contains a secret value (${secret.slice(0, 4)}...)`).toBe(false);
      }
    }

    const audit = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .selectFrom('platform.audit_log')
        .select(['actor_user_id', 'actor_kind', 'entity_type', 'after_data'])
        .where('action', '=', 'ops.diagnostics_exported')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: opsUserId, actor_kind: 'operator', entity_type: 'diagnostics' });
    expect((audit[0]!.after_data as { files: number }).files).toBe(8);
  });
});
