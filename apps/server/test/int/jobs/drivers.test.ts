// Driver suite of the job queue (build plan E.1, J.8) on both drivers: pg-boss in the test database (schema created
// by C.3 step 3) and BullMQ on a Valkey container with the outbox relay. A job sent inside a rolled-back
// transaction never runs; a committed one runs once. Also singleton keys, retries, delays, stats and schedules, and
// `migrate` step 3.
import { randomBytes } from 'node:crypto';
import type { JobName } from '@mscd/shared';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobQueue, JobRun } from '../../../src/common/jobs/job-queue';
import { runMigrate } from '../../../src/cli/migrate';
import type { DB } from '../../../src/db/types';
import { BullMqJobQueue } from '../../../src/modules/jobs/bullmq-job-queue';
import { createJobQueue, jobDriverOf } from '../../../src/modules/jobs/job-queue-factory';
import { PgBossJobQueue } from '../../../src/modules/jobs/pgboss-job-queue';
import { ensurePgBossSchema, PGBOSS_GRANTS } from '../../../src/modules/jobs/pgboss-schema';
import { useTestDatabase } from '../../setup/test-db';
import { startValkey, waitFor, type StartedValkey } from './helpers';

interface Harness {
  queue: JobQueue;
  /** Moves committed outbox rows to the queue (BullMQ); nothing for pg-boss. */
  relay(): Promise<void>;
}

async function sendInTransaction(app: Kysely<DB>, queue: JobQueue, name: JobName, marker: string, commit: boolean): Promise<void> {
  await app
    .transaction()
    .execute(async (trx) => {
      await queue.send(name, { orgId: null, payload: { marker } as never }, { retryLimit: 0 }, trx);
      if (!commit) throw new Error('rollback');
    })
    .catch((error: Error) => {
      if (commit || error.message !== 'rollback') throw error;
    });
}

function driverSuite(label: string, make: () => Promise<Harness>, appDb: () => Kysely<DB>): void {
  describe(`${label} driver`, () => {
    let h: Harness;
    const runs: Record<string, JobRun<JobName>[]> = {};
    const record = (name: JobName) => async (job: JobRun<JobName>) => {
      (runs[name] ??= []).push(job);
    };

    beforeAll(async () => {
      h = await make();
    });
    afterAll(async () => {
      await h?.queue.stop();
    });

    it('runs a job sent in a committed transaction once and never one of a rolled-back transaction', async () => {
      await h.queue.work('export.build', { concurrency: 2 }, record('export.build'));
      await sendInTransaction(appDb(), h.queue, 'export.build', 'rolled-back', false);
      await sendInTransaction(appDb(), h.queue, 'export.build', 'committed', true);
      await h.relay();
      await waitFor(() => (runs['export.build'] ?? []).length >= 1, 20_000);
      // Give a duplicate or the rolled-back job time to show up.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await h.relay();
      const markers = (runs['export.build'] ?? []).map((r) => (r.env.payload as { marker: string }).marker);
      expect(markers).toEqual(['committed']);
      expect(runs['export.build']![0]!.attempt).toBe(1);
      expect(runs['export.build']![0]!.env.orgId).toBeNull();
    });

    it('keeps one waiting job per singleton key', async () => {
      const first = await h.queue.send('evidence-pack.build', { orgId: null, payload: { packId: 'a' } }, { singletonKey: 'ep:same' });
      const second = await h.queue.send('evidence-pack.build', { orgId: null, payload: { packId: 'b' } }, { singletonKey: 'ep:same' });
      const other = await h.queue.send('evidence-pack.build', { orgId: null, payload: { packId: 'c' } }, { singletonKey: 'ep:other' });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(other).not.toBeNull();
      const stats = await h.queue.stats();
      expect(stats.find((s) => s.name === 'evidence-pack.build')).toMatchObject({ waiting: 2, active: 0, failed: 0 });
      await h.queue.work('evidence-pack.build', { concurrency: 1 }, record('evidence-pack.build'));
      await waitFor(() => (runs['evidence-pack.build'] ?? []).length >= 2, 20_000);
      expect((runs['evidence-pack.build'] ?? []).map((r) => (r.env.payload as { packId: string }).packId).sort()).toEqual(['a', 'c']);
      // Once the job is done the key is free again.
      expect(await h.queue.send('evidence-pack.build', { orgId: null, payload: { packId: 'd' } }, { singletonKey: 'ep:same' })).not.toBeNull();
      await waitFor(() => (runs['evidence-pack.build'] ?? []).length >= 3, 20_000);
    });

    it('applies singleton keys to transactional sends when they reach the queue', async () => {
      await sendInTransaction(appDb(), h.queue, 'link-health.check', 'x', true);
      await appDb()
        .transaction()
        .execute(async (trx) => {
          await h.queue.send('link-health.check', { orgId: null, payload: { repositoryId: 'r', storageObjectIds: ['1'] } }, { singletonKey: 'lhc:k' }, trx);
          await h.queue.send('link-health.check', { orgId: null, payload: { repositoryId: 'r', storageObjectIds: ['2'] } }, { singletonKey: 'lhc:k' }, trx);
        });
      await h.relay();
      const stat = (await h.queue.stats()).find((s) => s.name === 'link-health.check');
      expect(stat?.waiting).toBe(2);
    });

    it('retries a failing job up to its retry limit with the attempt number', async () => {
      const attempts: number[] = [];
      await h.queue.work('integrity.rehash', { concurrency: 1 }, async (job) => {
        attempts.push(job.attempt);
        if (job.attempt < 2) throw new Error('first attempt fails');
      });
      await h.queue.send('integrity.rehash', { orgId: null, payload: {} }, { retryLimit: 2 });
      await waitFor(() => attempts.length >= 2, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(attempts).toEqual([1, 2]);
    });

    it('delays a job by startAfterSeconds', async () => {
      const at: number[] = [];
      await h.queue.work('cycle.derive', { concurrency: 1 }, async () => {
        at.push(Date.now());
      });
      const sent = Date.now();
      await h.queue.send('cycle.derive', { orgId: null, payload: {} }, { startAfterSeconds: 3 });
      await waitFor(() => at.length >= 1, 30_000);
      expect(at[0]! - sent).toBeGreaterThanOrEqual(2500);
    });

    it('stores cron schedules', async () => {
      await h.queue.schedule('cleanup.expired', '20 * * * *', { orgId: null, payload: {} }, 'UTC');
      await h.queue.schedule('cleanup.expired', '20 * * * *', { orgId: null, payload: {} }, 'UTC');
      if (h.queue instanceof PgBossJobQueue) {
        const schedules = await h.queue.instance.getSchedules('cleanup.expired');
        expect(schedules.map((s) => [s.name, s.cron, s.timezone])).toEqual([['cleanup.expired', '20 * * * *', 'UTC']]);
      } else if (h.queue instanceof BullMqJobQueue) {
        const schedulers = await h.queue.queue('cleanup.expired').getJobSchedulers();
        expect(schedulers.map((s) => [s.key ?? s.id, s.pattern, s.tz])).toEqual([['cron:cleanup.expired', '20 * * * *', 'UTC']]);
      }
    });
  });
}

describe('job queue drivers (E.1)', () => {
  const db = useTestDatabase('empty');
  let valkey: StartedValkey | undefined;

  beforeAll(async () => {
    await ensurePgBossSchema(db.urls.migrator);
    valkey = await startValkey();
  }, 180_000);
  afterAll(async () => {
    await valkey?.stop();
  });

  it('C.3 step 3 creates the pgboss schema once, with one queue per job and the mscd_app grants', async () => {
    const again = await ensurePgBossSchema(db.urls.migrator);
    expect(again.before).not.toBeNull();
    expect(again.after).toBe(again.before);
    expect(again.queuesCreated).toBe(0);
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM pgboss.queue`.execute(db.migrator);
    expect(Number(rows[0]!.n)).toBe(22);
    const owner = await sql<{ owner: string }>`SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'pgboss'`.execute(db.migrator);
    expect(owner.rows[0]!.owner).toBe('mscd_migrator');
    const rights = await sql<{ usage: boolean; job: boolean; create: boolean }>`
      SELECT has_schema_privilege('mscd_app', 'pgboss', 'USAGE') AS usage,
             has_table_privilege('mscd_app', 'pgboss.job', 'INSERT, UPDATE, DELETE, SELECT') AS job,
             has_schema_privilege('mscd_app', 'pgboss', 'CREATE') AS create`.execute(db.migrator);
    expect(rights.rows[0]).toEqual({ usage: true, job: true, create: false });
    expect(PGBOSS_GRANTS).toHaveLength(4);
  });

  it('migrate runs step 3 when the job driver is pg-boss and lists it in --dry-run', async () => {
    const name = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE mscd_tpl_empty`);
      await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${name} TO mscd_migrator`);
      await admin.query(`GRANT CONNECT ON DATABASE ${name} TO mscd_app, mscd_pack_installer`);
    } finally {
      await admin.end();
    }
    const url = (u: string) => u.replace(`/${db.name}`, `/${name}`);
    const env = {
      MSCD_TEST_JOBS_DRIVER: 'profile',
      MSCD_DATABASE_MIGRATOR_URL: url(db.urls.migrator),
      MSCD_DATABASE_URL: url(db.urls.app),
      MSCD__PACKS__DIR: '/nonexistent/packs',
    };
    try {
      const config = db.config(env, 'migrate');
      expect(jobDriverOf(config)).toBe('pgboss');
      const dry: string[] = [];
      expect(await runMigrate(config, { dryRun: true, out: (t) => dry.push(t) })).toBe(0);
      expect(dry.join('')).toContain('-- schema pgboss: pg-boss schema, job queues and grants to mscd_app');
      const out: string[] = [];
      expect(await runMigrate(config, { out: (t) => out.push(t) })).toBe(0);
      expect(out.join('')).toMatch(/migrate: pgboss created \(schema version \d+\), 22 queue\(s\) created\n/);
      const again: string[] = [];
      expect(await runMigrate(config, { out: (t) => again.push(t) })).toBe(0);
      expect(again.join('')).toMatch(/migrate: pgboss up to date \(schema version \d+\)\n/);
      // Without MSCD_TEST_JOBS_DRIVER the test profile keeps jobs in memory and has no step 3.
      expect(jobDriverOf(db.config({}, 'migrate'))).toBe('memory');
    } finally {
      const cleanup = new pg.Client({ connectionString: db.urls.admin });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    }
  });

  it('chooses the driver of the profile, and keeps jobs in memory for the test profile', () => {
    expect(createJobQueue(db.config()).constructor.name).toBe('InMemoryJobQueue');
    const pgboss = createJobQueue(db.config({ MSCD_TEST_JOBS_DRIVER: 'profile' }));
    expect(pgboss).toBeInstanceOf(PgBossJobQueue);
    const bull = createJobQueue(db.config({ MSCD_TEST_JOBS_DRIVER: 'profile', MSCD__JOBS__DRIVER: 'bullmq', MSCD__JOBS__BULLMQ__URL: 'redis://localhost:1' }));
    expect(bull).toBeInstanceOf(BullMqJobQueue);
    return Promise.all([pgboss.stop(), bull.stop()]);
  });

  driverSuite(
    'pg-boss',
    async () => ({ queue: new PgBossJobQueue({ connectionString: db.urls.app, supervise: true, pollingIntervalSeconds: 0.5 }), relay: async () => undefined }),
    () => db.app,
  );

  driverSuite(
    'BullMQ',
    async () => {
      const queue = new BullMqJobQueue({ url: valkey!.url, prefix: `t${randomBytes(4).toString('hex')}` });
      return {
        queue,
        relay: async () => {
          await db.app.transaction().execute((trx) => queue.relayOutbox(trx));
        },
      };
    },
    () => db.app,
  );

  it('BullMQ relays an outbox row once even when the relay sees it twice', async () => {
    const queue = new BullMqJobQueue({ url: valkey!.url, prefix: `t${randomBytes(4).toString('hex')}` });
    try {
      await db.app.transaction().execute((trx) => queue.send('drift.evaluate', { orgId: null, payload: {} }, {}, trx));
      const row = await db.app.selectFrom('platform.job_outbox').select('id').where('queue', '=', 'drift.evaluate').orderBy('id', 'desc').executeTakeFirstOrThrow();
      expect(await db.app.transaction().execute((trx) => queue.relayOutbox(trx))).toBeGreaterThanOrEqual(1);
      // Simulate a relay whose commit was lost after BullMQ accepted the job.
      await db.app.updateTable('platform.job_outbox').set({ dispatched_at: null }).where('id', '=', row.id).execute();
      await db.app.transaction().execute((trx) => queue.relayOutbox(trx));
      const counts = await queue.queue('drift.evaluate').getJobCounts('waiting', 'delayed');
      expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
      const dispatched = await db.app.selectFrom('platform.job_outbox').select(['dispatched_at', 'attempts']).where('id', '=', row.id).executeTakeFirstOrThrow();
      expect(dispatched.dispatched_at).not.toBeNull();
      expect(dispatched.attempts).toBe(2);
    } finally {
      await queue.stop();
    }
  });
});
