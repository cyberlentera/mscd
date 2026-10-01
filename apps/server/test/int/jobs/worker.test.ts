// Run mode `worker` (D.4, E.1): the worker runtime on the pg-boss driver with `--queues`, its run wrapper (request
// id, tenant scope check, metrics), and the WP-12 handlers (`license.check`, `packs.lifecycle`,
// `edition.withdrawn-alerts`, `pack.install`) scheduled and run by the worker on the demo template.
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/jobs/job-queue';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { PgBossJobQueue } from '../../../src/modules/jobs/pgboss-job-queue';
import { ensurePgBossSchema } from '../../../src/modules/jobs/pgboss-schema';
import { SchedulerTickJob } from '../../../src/modules/jobs/scheduler-tick.job';
import { MetricsService } from '../../../src/modules/platform/metrics';
import { PacksModule } from '../../../src/modules/packs/packs.module';
import { parseQueues, WorkerRuntime } from '../../../src/worker/worker-runtime';
import { WorkerRuntimeModule } from '../../../src/worker/worker-runtime.module';
import { CORE_MODULES } from '../platform/helpers';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, JOB_TEST_ENV, waitFor, type AdminClient, type JobsApp } from './helpers';

describe('worker runtime on pg-boss (D.4)', () => {
  const db = useTestDatabase('empty');
  let moduleRef: TestingModule;
  let queue: JobQueue;

  beforeAll(async () => {
    await ensurePgBossSchema(db.urls.migrator);
    moduleRef = await db
      .createTestingModule({ imports: [...CORE_MODULES, JobsModule, WorkerRuntimeModule] }, { ...JOB_TEST_ENV, MSCD_TEST_JOBS_DRIVER: 'profile' })
      .compile();
    moduleRef.useLogger(moduleRef.get(Logger));
    await moduleRef.init();
    queue = moduleRef.get<JobQueue>(JOB_QUEUE);
  }, 120_000);
  afterAll(async () => {
    await moduleRef?.close();
  });

  const states = async (name: string) =>
    (await sql<{ state: string }>`SELECT state FROM pgboss.job WHERE name = ${name} ORDER BY created_on`.execute(db.migrator)).rows.map((r) => r.state);

  it('works only on the queues of --queues and runs their jobs with the run wrapper', async () => {
    expect(queue).toBeInstanceOf(PgBossJobQueue);
    const runtime = moduleRef.get(WorkerRuntime);
    const started = await runtime.start({ queues: parseQueues('cleanup.expired, scheduler.tick') });
    expect(started).toEqual({ queues: ['cleanup.expired', 'scheduler.tick'], schedules: [] });
    expect(await runtime.start()).toBe(started); // once per process

    await queue.send('cleanup.expired', { orgId: null, payload: {} }, { singletonKey: 'ce:test', retryLimit: 3 });
    await queue.send('tasks.overdue', { orgId: '00000000-0000-4000-8000-000000000999', payload: {} }, { singletonKey: 'to:test' });
    await waitFor(async () => (await states('cleanup.expired')).includes('completed'), 30_000);
    expect(await states('tasks.overdue')).toEqual(['created']);
    const metrics = await moduleRef.get(MetricsService).registry.getSingleMetricAsString('mscd_job_runs_total');
    expect(metrics).toMatch(/mscd_job_runs_total\{job="cleanup\.expired",outcome="succeeded"[^}]*\} 1/);
    const stats = await queue.stats();
    expect(stats.find((s) => s.name === 'tasks.overdue')).toMatchObject({ waiting: 1, active: 0 });
  });

  it('sends the jobs of a tick through pg-boss in the tick transaction', async () => {
    await sql`UPDATE platform.organization SET status = 'active'`.execute(db.migrator);
    const result = await moduleRef.get(SchedulerTickJob).tick();
    expect(result.enqueued).toEqual([]); // no organisation in this database
    expect(await states('scheduler.tick')).toEqual([]);
  });

  it('refuses unknown queue names', () => {
    expect(() => parseQueues('cleanup.expired,nope')).toThrow(/Unknown queue\(s\) nope/);
    expect(parseQueues(' , ')).toBeUndefined();
    expect(parseQueues(undefined)).toBeUndefined();
  });
});

describe('WP-12 handlers on the worker (demo template)', () => {
  const db = useTestDatabase('demo');
  let app: JobsApp;
  let admin: AdminClient;

  beforeAll(async () => {
    admin = await adminClient(db);
    app = await createJobsApp(db, { imports: [PacksModule] });
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('dispatches license.check at 00:05 local time and runs it for every organisation', async () => {
    app.setNow('2030-01-15T17:05:00Z'); // 00:05 in Jakarta, the time zone of the four demo organisations
    await app.run('scheduler.tick', { orgId: null, payload: {} });
    const ran = app.queue.completed('license.check').map((j) => j.env.orgId).sort();
    expect(ran).toEqual([
      '00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000a002',
      '00000000-0000-4000-8000-00000000a003',
      '00000000-0000-4000-8000-00000000a004',
    ]);
    expect(app.queue.failed()).toEqual([]);
    expect(app.queue.completed('tasks.overdue')).toHaveLength(4);
    expect(app.queue.completed('audit-prep.generate')).toHaveLength(4);
  });

  it('runs packs.lifecycle, which queues edition.withdrawn-alerts for every active organisation', async () => {
    await app.run('packs.lifecycle', { orgId: null, payload: {} }, { singletonKey: 'pl:test' });
    expect(app.queue.failed()).toEqual([]);
    expect(app.queue.completed('edition.withdrawn-alerts')).toHaveLength(4);
  });

  it('runs pack.install and records a bundle it cannot read as rejected', async () => {
    await app.run('pack.install', { orgId: null, payload: { installId: '00000000-0000-4000-8000-0000000000aa', objectKey: 'local:missing.pack', requestedBy: '00000000-0000-0000-0000-000000000001' } });
    expect(app.queue.failed()).toEqual([]);
    const { rows } = await admin.query<{ action: string }>(`SELECT action FROM platform.audit_log WHERE action = 'pack.rejected'`);
    expect(rows).toHaveLength(1);
  });

  it('fails a tenant job sent without an organisation', async () => {
    await app.run('tasks.overdue', { orgId: null, payload: {} });
    expect(app.queue.failed('tasks.overdue').map((f) => f.error)).toEqual(['tasks.overdue is a tenant job and needs the organisation of the job envelope']);
  });
});

