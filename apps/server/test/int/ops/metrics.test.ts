// ARCHITECTURE 12 metrics on `/metrics` (WP-34): every name is listed by the metrics listener of an api
// application on the demo data, and the values come from their sources: HTTP requests by route and status, the
// authorisation guard, the queue, storage objects by link status, licences, MFA lockouts from the platform audit
// log, and the derived job, freshness and gateway metrics.
import { Counter, Histogram } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/jobs/job-queue';
import { AUDIT_WRITER, type AuditWriter } from '../../../src/common/tokens';
import { ARCHITECTURE_METRIC_NAMES, METRICS, SOURCE_METRICS } from '../../../src/modules/observability/metric-catalogue';
import { OpsMetricsCollector } from '../../../src/modules/ops/ops-metrics.collector';
import { MetricsService } from '../../../src/modules/platform/metrics';
import type { IntApp } from '../platform/helpers';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { as, createOpsApp, freePort, opsIdentities, tenantInfo } from './helpers';

/** The value of one sample line `name{labels} value` (labels given in the order the registry writes them). */
function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (.+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const found = Object.fromEntries([...(match[2] ?? '').matchAll(/([a-zA-Z_]+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
    if (Object.entries(labels).every(([k, v]) => found[k] === v)) return Number(match[3]);
  }
  return undefined;
}

describe('ARCHITECTURE 12 metrics on /metrics (WP-34)', () => {
  const db = useTestDatabase('demo');
  let ctx: IntApp;
  let port: number;
  let opsUserId: string;

  beforeAll(async () => {
    const users = await db.migrator.selectFrom('platform.app_user').select(['id', 'handle']).where('handle', 'in', ['ops', 'tenant.admin']).execute();
    const byHandle = new Map(users.map((u) => [u.handle, u.id]));
    opsUserId = byHandle.get('ops')!;
    const tst = await tenantInfo(db.migrator, 'tst');
    port = await freePort();
    ctx = await createOpsApp(db, opsIdentities({ id: opsUserId, handle: 'ops' }, { id: byHandle.get('tenant.admin')!, handle: 'tenant.admin', org: tst }), {
      env: { MSCD__OBSERVABILITY__METRICS_PORT: String(port) },
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function scrape(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    return res.text();
  }

  it('lists every metric name of ARCHITECTURE 12 and the outbox gauge', async () => {
    const text = await scrape();
    expect(ARCHITECTURE_METRIC_NAMES).toHaveLength(12);
    for (const name of [...ARCHITECTURE_METRIC_NAMES, METRICS.outboxStuckRows.name]) {
      expect(text, name).toMatch(new RegExp(`^# TYPE ${name} (counter|gauge|histogram)$`, 'm'));
    }
  });

  it('measures HTTP requests by route pattern and status, and counts denials', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/ops/queues', headers: as('ops') })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/ops/queues', headers: as('ta') })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/ops/jobs/cleanup.expired/run?code=abc', headers: as('ops'), payload: {} })).statusCode).toBe(202);
    const text = await scrape();
    expect(sample(text, 'mscd_http_request_duration_seconds_count', { route: '/api/v1/ops/queues', method: 'GET', status: '200' })).toBe(1);
    expect(sample(text, 'mscd_http_request_duration_seconds_count', { route: '/api/v1/ops/queues', method: 'GET', status: '403' })).toBe(1);
    // The route pattern, never the path with values or the query string.
    expect(sample(text, 'mscd_http_request_duration_seconds_count', { route: '/api/v1/ops/jobs/:name/run', method: 'POST', status: '202' })).toBe(1);
    expect(text).not.toContain('code=abc');
    expect(sample(text, 'mscd_authz_denied_total', { route: 'ops.queues' })).toBe(1);
  });

  it('collects queue, link status, licence, MFA lock and outbox values from the queue and the database', async () => {
    const queue = ctx.moduleRef.get<JobQueue>(JOB_QUEUE);
    const writer = ctx.moduleRef.get<AuditWriter>(AUDIT_WRITER);
    const collector = ctx.moduleRef.get(OpsMetricsCollector);
    await writer.recordDetached({ action: 'auth.mfa_locked', actor: { userId: opsUserId, kind: 'system' }, organizationId: null, entityType: 'user', entityId: opsUserId });
    const mfaLocks = await inScope(db.migrator, { platformScope: true }, async (trx) =>
      Number((await trx.selectFrom('platform.audit_log').select((eb) => eb.fn.countAll<string>().as('n')).where('action', '=', 'auth.mfa_locked').executeTakeFirstOrThrow()).n),
    );
    const linkStatus = new Map<string, number>();
    const orgs = await db.migrator.selectFrom('platform.organization').select(['id', 'schema_name']).where('status', '=', 'active').where('deleted_at', 'is', null).execute();
    for (const org of orgs) {
      const rows = await inScope(db.migrator, { orgId: org.id, schema: org.schema_name }, (trx) =>
        trx
          .selectFrom('storage_object')
          .select((eb) => ['link_status', eb.fn.countAll<string>().as('n')])
          .where('deleted_at', 'is', null)
          .groupBy('link_status')
          .execute(),
      );
      for (const row of rows) linkStatus.set(row.link_status, (linkStatus.get(row.link_status) ?? 0) + Number(row.n));
    }
    await db.app.insertInto('platform.job_outbox').values({ queue: 'from.newer.build', payload: JSON.stringify({ env: { orgId: null, payload: {} } }), attempts: 12 }).execute();
    const waiting = (await queue.stats()).find((q) => q.name === 'cleanup.expired')?.waiting ?? 0;

    await collector.refresh();
    const text = await scrape();
    expect(sample(text, 'mscd_queue_waiting', { queue: 'cleanup.expired' })).toBe(waiting);
    expect(waiting).toBeGreaterThan(0);
    expect(sample(text, 'mscd_queue_oldest_age_seconds', { queue: 'cleanup.expired' })).toBeGreaterThanOrEqual(0);
    expect(sample(text, 'mscd_link_status_objects', { status: 'missing' })).toBe(linkStatus.get('missing') ?? 0);
    expect(sample(text, 'mscd_link_status_objects', { status: 'intact' })).toBe(linkStatus.get('intact') ?? 0);
    expect(linkStatus.get('intact') ?? 0).toBeGreaterThan(0);
    for (const org of ['ndt', 'bsd', 'rmn', 'tst']) expect(sample(text, 'mscd_licence_days_left', { org }), org).toBeGreaterThan(0);
    expect(sample(text, 'mscd_mfa_locks_total')).toBe(mfaLocks);
    expect(mfaLocks).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'mscd_job_outbox_stuck_rows')).toBe(1);
    expect(text).toMatch(/mscd_job_outbox_stuck_rows\{mode="api"\} 1/);
  });

  it('derives job failures, freshness recompute time and gateway latency and throttling from their sources', async () => {
    const registry = ctx.moduleRef.get(MetricsService).registry;
    // The metrics as the worker runtime and the storage gateway create them (src/worker, src/gateway).
    const runs = new Counter({ name: SOURCE_METRICS.jobRuns, help: 'runs', labelNames: ['job', 'outcome'], registers: [registry] });
    const duration = new Histogram({ name: SOURCE_METRICS.jobDuration, help: 'run time', labelNames: ['job'], buckets: [1, 5], registers: [registry] });
    const calls = new Counter({ name: SOURCE_METRICS.gatewayCalls, help: 'calls', labelNames: ['operation', 'adapter', 'outcome'], registers: [registry] });
    const latency = new Histogram({ name: SOURCE_METRICS.gatewayCallDuration, help: 'latency', labelNames: ['operation', 'adapter'], buckets: [0.1, 1], registers: [registry] });
    runs.inc({ job: 'freshness.recompute', outcome: 'failed' });
    runs.inc({ job: 'freshness.recompute', outcome: 'failed' });
    runs.inc({ job: 'tasks.overdue', outcome: 'succeeded' });
    duration.observe({ job: 'freshness.recompute' }, 0.4);
    duration.observe({ job: 'tasks.overdue' }, 2);
    calls.inc({ operation: 'link-check', adapter: 'm365', outcome: 'rate-limited' });
    calls.inc({ operation: 'link-check', adapter: 'm365', outcome: 'ok' });
    latency.observe({ operation: 'link-check', adapter: 'm365' }, 0.05);

    const text = await scrape();
    expect(sample(text, 'mscd_job_failures_total', { job: 'freshness.recompute' })).toBe(2);
    expect(sample(text, 'mscd_job_failures_total', { job: 'tasks.overdue' })).toBeUndefined();
    expect(sample(text, 'mscd_freshness_recompute_seconds_count', { job: 'freshness.recompute' })).toBe(1);
    expect(sample(text, 'mscd_freshness_recompute_seconds_bucket', { job: 'freshness.recompute', le: '1' })).toBe(1);
    expect(sample(text, 'mscd_freshness_recompute_seconds_count', { job: 'tasks.overdue' })).toBeUndefined();
    expect(sample(text, 'mscd_gateway_request_duration_seconds_count', { adapter: 'm365', operation: 'link-check' })).toBe(1);
    expect(sample(text, 'mscd_adapter_throttled_total', { adapter: 'm365', operation: 'link-check' })).toBe(1);
    expect(text).toMatch(/^# TYPE mscd_gateway_request_duration_seconds histogram$/m);
  });
});
