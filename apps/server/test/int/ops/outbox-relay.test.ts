// BullMQ outbox relay limits (WP-22 verifier finding, fixed in WP-34): a row that keeps failing waits longer
// between attempts, is parked after OUTBOX_MAX_ATTEMPTS failures with an error log line, never blocks newer rows,
// never moves a delayed job earlier, and is reported by the `mscd_job_outbox_stuck_rows` metric and the
// `job-outbox` component of GET /ops/health. Rows with job names this build does not know fail before Valkey is
// contacted, so no Valkey server is needed.
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BullMqJobQueue,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_BACKOFF_SECONDS,
  countStuckOutboxRows,
  outboxBackoffSeconds,
} from '../../../src/modules/jobs/bullmq-job-queue';
import { OpsMetricsCollector } from '../../../src/modules/ops/ops-metrics.collector';
import { MetricsService } from '../../../src/modules/platform/metrics';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser } from '../db/helpers';
import { infoOf, type IntApp } from '../platform/helpers';
import { as, createOpsApp, opsIdentities } from './helpers';

const PAYLOAD = JSON.stringify({ env: { orgId: null, payload: {} }, retryLimit: 0, priority: 0 });

describe('outbox relay backoff and attempt limit (BullMQ driver)', () => {
  const db = useTestDatabase('empty');
  // Never contacted: every row below names an unknown job, which fails before a BullMQ queue is created.
  const queue = new BullMqJobQueue({ url: 'redis://127.0.0.1:9/0', prefix: 'wp34' });
  let ctx: IntApp;

  const relay = () => db.app.transaction().execute((trx) => queue.relayOutbox(trx));
  const row = (id: string) =>
    db.app
      .selectFrom('platform.job_outbox')
      .select(['attempts', 'last_error', 'dispatched_at', sql<number>`extract(epoch from (run_at - now()))`.as('wait')])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const insert = async (queueName: string, values: { attempts?: number; runAt?: string } = {}) =>
    (
      await db.app
        .insertInto('platform.job_outbox')
        .values({
          queue: queueName,
          payload: PAYLOAD,
          ...(values.attempts !== undefined ? { attempts: values.attempts } : {}),
          ...(values.runAt ? { run_at: sql<Date>`now() + ${values.runAt}::interval` } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const due = (id: string) => db.app.updateTable('platform.job_outbox').set({ run_at: sql<Date>`now() - interval '1 second'` }).where('id', '=', id).execute();

  beforeAll(async () => {
    const tenant = await createTenant(db, 'obx');
    const operator = await addUser(db.migrator, 'ops.obx', []);
    const admin = await addUser(db.migrator, 'ta.obx', [tenant.id]);
    ctx = await createOpsApp(db, opsIdentities({ id: operator, handle: 'ops.obx' }, { id: admin, handle: 'ta.obx', org: infoOf(tenant) }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.app.deleteFrom('platform.job_outbox').execute();
  });

  afterAll(async () => {
    await ctx?.close();
    await queue.stop();
  });

  it('backs off exponentially up to the cap', () => {
    expect([1, 2, 3, 4, 9].map(outboxBackoffSeconds)).toEqual([2, 4, 8, 16, 512]);
    expect(outboxBackoffSeconds(10)).toBe(OUTBOX_MAX_BACKOFF_SECONDS);
    expect(outboxBackoffSeconds(1000)).toBe(OUTBOX_MAX_BACKOFF_SECONDS);
    expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it('waits before the next attempt of a failed row and parks it after the last attempt with an error log line', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error');
    const id = await insert('from.newer.build');

    expect(await relay()).toBe(0);
    let state = await row(id);
    expect(state.attempts).toBe(1);
    expect(state.last_error).toMatch(/Unknown job from\.newer\.build/);
    expect(Number(state.wait)).toBeGreaterThan(outboxBackoffSeconds(1) - 1.5);

    // Not due yet: the next pass leaves it alone.
    await relay();
    expect((await row(id)).attempts).toBe(1);

    await due(id);
    await relay();
    state = await row(id);
    expect(state.attempts).toBe(2);
    expect(Number(state.wait)).toBeGreaterThan(outboxBackoffSeconds(2) - 1.5);

    // The last attempt parks the row and says so once at error level.
    await db.app.updateTable('platform.job_outbox').set({ attempts: OUTBOX_MAX_ATTEMPTS - 1 }).where('id', '=', id).execute();
    await due(id);
    await relay();
    expect((await row(id)).attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    const parked = errors.mock.calls.filter((call) => JSON.stringify(call).includes('job_outbox.stuck'));
    expect(parked).toHaveLength(1);
    expect(JSON.stringify(parked[0])).toContain(`parked after ${OUTBOX_MAX_ATTEMPTS} failed relay attempts`);

    // Parked rows are never taken again, even when due.
    await due(id);
    await relay();
    const final = await row(id);
    expect(final.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(final.dispatched_at).toBeNull();
    expect((await db.app.transaction().execute((trx) => countStuckOutboxRows(trx))).rows).toBe(1);
  });

  it('takes newer rows first while older rows wait for their next attempt', async () => {
    const older = await Promise.all(Array.from({ length: 5 }, () => insert('older.failing')));
    await relay();
    const newer = await insert('newer.failing');
    await relay();
    expect((await row(newer)).attempts).toBe(1);
    for (const id of older) expect((await row(id)).attempts).toBe(1);
  });

  it('never moves a delayed job earlier when its relay fails', async () => {
    const id = await insert('delayed.failing', { runAt: '1 hour' });
    await relay();
    const state = await row(id);
    expect(state.attempts).toBe(1);
    expect(Number(state.wait)).toBeGreaterThan(3500);
  });

  it('reports parked rows in the metric and as a degraded job-outbox component', async () => {
    await insert('parked.one', { attempts: OUTBOX_MAX_ATTEMPTS });
    await insert('parked.two', { attempts: OUTBOX_MAX_ATTEMPTS + 3 });
    await insert('still.trying', { attempts: 2 });
    await ctx.moduleRef.get(OpsMetricsCollector).refresh();
    const text = await ctx.moduleRef.get(MetricsService).registry.metrics();
    expect(text).toMatch(/^mscd_job_outbox_stuck_rows\{mode="api"\} 2$/m);

    const health = await ctx.app.inject({ method: 'GET', url: '/api/v1/ops/health', headers: as('ops') });
    expect(health.statusCode).toBe(200);
    const outbox = (health.json() as { components: { name: string; status: string; detail: string }[] }).components.find((c) => c.name === 'job-outbox');
    expect(outbox?.status).toBe('degraded');
    expect(outbox?.detail).toMatch(/^2 row\(s\) no longer relayed/);
  });
});
