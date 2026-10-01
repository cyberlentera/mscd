// BullMQ outbox relay limits (WP-22 verifier finding, fixed in WP-34): a row that keeps failing waits longer
// between attempts, never blocks newer rows and never moves a delayed job earlier. A permanent failure (unknown job
// name) parks the row at once with an error log line; a transient one (Valkey error) keeps being retried at the
// backoff cap and is logged once as stuck after OUTBOX_STUCK_ATTEMPTS. Both are reported by the
// `mscd_job_outbox_stuck_rows` metric and the `job-outbox` component of GET /ops/health. Rows with job names this
// build does not know fail before Valkey is contacted, and the other cases stub the BullMQ queue, so no Valkey
// server is needed.
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BullMqJobQueue,
  OUTBOX_MAX_BACKOFF_SECONDS,
  OUTBOX_PARKED_ATTEMPTS,
  OUTBOX_STUCK_ATTEMPTS,
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

  // Stands in for a Valkey that answers every write with an error (READONLY after a failover) until `failing` is false.
  const stubValkey = () => {
    const state = { failing: true, added: [] as string[] };
    vi.spyOn(queue, 'queue').mockImplementation(
      () =>
        ({
          add: async (name: string) => {
            if (state.failing) throw new Error("READONLY You can't write against a read only replica.");
            state.added.push(name);
            return {};
          },
        }) as never,
    );
    return state;
  };

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
    expect(OUTBOX_STUCK_ATTEMPTS).toBeGreaterThan(1);
    expect(OUTBOX_PARKED_ATTEMPTS).toBeGreaterThan(OUTBOX_STUCK_ATTEMPTS);
  });

  it('parks a row with an unknown job name at once with one error log line and never takes it again', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error');
    const id = await insert('from.newer.build');

    expect(await relay()).toBe(0);
    let state = await row(id);
    expect(state.attempts).toBe(OUTBOX_PARKED_ATTEMPTS);
    expect(state.last_error).toMatch(/Unknown job from\.newer\.build/);
    const parked = errors.mock.calls.filter((call) => JSON.stringify(call).includes('job_outbox.stuck'));
    expect(parked).toHaveLength(1);
    expect(JSON.stringify(parked[0])).toContain('parked after a permanent relay failure');

    // Parked rows are never taken again, even when due.
    await due(id);
    await relay();
    state = await row(id);
    expect(state.attempts).toBe(OUTBOX_PARKED_ATTEMPTS);
    expect(state.dispatched_at).toBeNull();
    expect(errors.mock.calls.filter((call) => JSON.stringify(call).includes('job_outbox.stuck'))).toHaveLength(1);
    expect((await db.app.transaction().execute((trx) => countStuckOutboxRows(trx))).rows).toBe(1);

    // The documented reset relays it again at once (here it fails and parks again, as the job is still unknown).
    await db.app.updateTable('platform.job_outbox').set({ attempts: 0, run_at: sql<Date>`now()` }).where('id', '=', id).execute();
    await relay();
    expect(errors.mock.calls.filter((call) => JSON.stringify(call).includes('job_outbox.stuck'))).toHaveLength(2);
  });

  it('keeps retrying a row with a transient Valkey error, backing off up to the cap and reporting it once as stuck', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error');
    const valkey = stubValkey();
    const id = await insert('notifications.dispatch');

    expect(await relay()).toBe(0);
    let state = await row(id);
    expect(state.attempts).toBe(1);
    expect(state.last_error).toMatch(/READONLY/);
    expect(Number(state.wait)).toBeGreaterThan(outboxBackoffSeconds(1) - 1.5);

    // Not due yet: the next pass leaves it alone.
    await relay();
    expect((await row(id)).attempts).toBe(1);

    await due(id);
    await relay();
    state = await row(id);
    expect(state.attempts).toBe(2);
    expect(Number(state.wait)).toBeGreaterThan(outboxBackoffSeconds(2) - 1.5);

    // Reaching the stuck threshold logs once at error level but does not park the row.
    await db.app.updateTable('platform.job_outbox').set({ attempts: OUTBOX_STUCK_ATTEMPTS - 1 }).where('id', '=', id).execute();
    await due(id);
    await relay();
    state = await row(id);
    expect(state.attempts).toBe(OUTBOX_STUCK_ATTEMPTS);
    expect(Number(state.wait)).toBeGreaterThan(OUTBOX_MAX_BACKOFF_SECONDS - 1.5);
    const stuck = errors.mock.calls.filter((call) => JSON.stringify(call).includes('job_outbox.stuck'));
    expect(stuck).toHaveLength(1);
    expect(JSON.stringify(stuck[0])).toContain(`stuck after ${OUTBOX_STUCK_ATTEMPTS} failed relay attempts`);
    expect((await db.app.transaction().execute((trx) => countStuckOutboxRows(trx))).rows).toBe(1);

    // Still retried after the threshold (no second error line), and relayed once Valkey recovers.
    await due(id);
    await relay();
    expect((await row(id)).attempts).toBe(OUTBOX_STUCK_ATTEMPTS + 1);
    expect(errors.mock.calls.filter((call) => JSON.stringify(call).includes('job_outbox.stuck'))).toHaveLength(1);
    valkey.failing = false;
    await due(id);
    expect(await relay()).toBe(1);
    expect((await row(id)).dispatched_at).not.toBeNull();
    expect(valkey.added).toEqual(['notifications.dispatch']);
    expect((await db.app.transaction().execute((trx) => countStuckOutboxRows(trx))).rows).toBe(0);
  });

  it('takes newer rows first while older rows wait for their next attempt', async () => {
    stubValkey();
    const older = await Promise.all(Array.from({ length: 5 }, () => insert('notifications.dispatch')));
    await relay();
    const newer = await insert('notifications.dispatch');
    await relay();
    expect((await row(newer)).attempts).toBe(1);
    for (const id of older) expect((await row(id)).attempts).toBe(1);
  });

  it('never moves a delayed job earlier when its relay fails', async () => {
    stubValkey();
    const id = await insert('notifications.dispatch', { runAt: '1 hour' });
    await relay();
    const state = await row(id);
    expect(state.attempts).toBe(1);
    expect(Number(state.wait)).toBeGreaterThan(3500);
  });

  it('reports stuck and parked rows in the metric and as a degraded job-outbox component', async () => {
    await insert('parked.one', { attempts: OUTBOX_PARKED_ATTEMPTS });
    await insert('stuck.retrying', { attempts: OUTBOX_STUCK_ATTEMPTS + 3 });
    await insert('still.trying', { attempts: 2 });
    await ctx.moduleRef.get(OpsMetricsCollector).refresh();
    const text = await ctx.moduleRef.get(MetricsService).registry.metrics();
    expect(text).toMatch(/^mscd_job_outbox_stuck_rows\{mode="api"\} 2$/m);

    const health = await ctx.app.inject({ method: 'GET', url: '/api/v1/ops/health', headers: as('ops') });
    expect(health.statusCode).toBe(200);
    const outbox = (health.json() as { components: { name: string; status: string; detail: string }[] }).components.find((c) => c.name === 'job-outbox');
    expect(outbox?.status).toBe('degraded');
    expect(outbox?.detail).toMatch(/^2 row\(s\) stuck or parked/);
  });
});
