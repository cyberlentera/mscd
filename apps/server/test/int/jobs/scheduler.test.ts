// `scheduler.tick` (E.2): the clock high-water mark and the per-organisation local-time dispatch of the daily jobs,
// for two organisations in different time zones with a mocked clock (J.8). Also the cron schedules the worker
// registers.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulerTickJob } from '../../../src/modules/jobs/scheduler-tick.job';
import { CRON_SCHEDULES, DAILY_JOBS, dueDailyJobs, localTimeOf } from '../../../src/modules/jobs/schedules';
import { WorkerRuntime } from '../../../src/worker/worker-runtime';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { createJobsApp, type JobsApp } from './helpers';

describe('scheduler.tick (E.2)', () => {
  const db = useTestDatabase('empty');
  let app: JobsApp;
  let jakarta: string;
  let newYork: string;

  beforeAll(async () => {
    jakarta = (await createTenant(db, 'tz_jkt', { timeZone: 'Asia/Jakarta' })).id;
    newYork = (await createTenant(db, 'tz_nyc', { timeZone: 'America/New_York' })).id;
    // Only the tick has a worker, so the jobs it enqueues stay waiting for inspection.
    app = await createJobsApp(db, { queues: ['scheduler.tick'] });
  });
  afterAll(async () => {
    await app?.close();
  });

  const waiting = () =>
    app.queue
      .waitingJobs()
      .filter((j) => j.name !== 'scheduler.tick')
      .map((j) => ({ name: j.name, orgId: j.env.orgId }))
      .sort((a, b) => `${a.orgId}${a.name}`.localeCompare(`${b.orgId}${b.name}`));

  it('dispatches the daily jobs of the local hour of each organisation, once per local date', async () => {
    // 2030-01-15 17:05 UTC: 00:05 on 16 January in Jakarta (UTC+7), 12:05 on 15 January in New York (UTC-5).
    app.setNow('2030-01-15T17:05:00Z');
    await app.run('scheduler.tick', { orgId: null, payload: {} });
    expect(waiting()).toEqual([
      { name: 'audit-prep.generate', orgId: jakarta },
      { name: 'license.check', orgId: jakarta },
      { name: 'tasks.overdue', orgId: jakarta },
    ]);
    const keys = app.queue.waitingJobs().map((j) => j.name);
    expect(keys).not.toContain('freshness.sweep');

    // A second tick in the same hour adds nothing (singleton keys with the local date).
    await app.run('scheduler.tick', { orgId: null, payload: {} });
    expect(waiting()).toHaveLength(3);

    // 2030-01-16 05:05 UTC: 00:05 in New York, 12:05 in Jakarta.
    app.setNow('2030-01-16T05:05:00Z');
    await app.run('scheduler.tick', { orgId: null, payload: {} });
    expect(waiting().filter((j) => j.orgId === newYork).map((j) => j.name)).toEqual(['audit-prep.generate', 'license.check', 'tasks.overdue']);
    expect(waiting()).toHaveLength(6);
  });

  it('uses keys with the local date and delays a job to its local minute', async () => {
    const due = dueDailyJobs(jakarta, new Date('2030-01-15T17:05:00Z'), 'Asia/Jakarta');
    expect(due.map((d) => [d.job.name, d.singletonKey, d.startAfterSeconds])).toEqual([
      ['license.check', `lc:${jakarta}:2030-01-16`, 0],
      ['tasks.overdue', `to:${jakarta}:2030-01-16`, 600],
      ['audit-prep.generate', `ap:${jakarta}:2030-01-16`, 1500],
    ]);
    // Half-hour zone: 17:05 UTC is 22:35 in Kolkata; nothing is due at that hour.
    expect(dueDailyJobs(jakarta, new Date('2030-01-15T17:05:00Z'), 'Asia/Kolkata')).toEqual([]);
    // 01:05 local: the sweep; Sunday 03:05 local: the weekly rehash, on other days not.
    expect(dueDailyJobs(jakarta, new Date('2030-01-15T18:05:00Z'), 'Asia/Jakarta').map((d) => d.job.name)).toEqual(['freshness.sweep']);
    const sunday = new Date('2030-01-19T20:05:00Z'); // Sunday 03:05 in Jakarta
    expect(localTimeOf(sunday, 'Asia/Jakarta')).toMatchObject({ date: '2030-01-20', hour: 3, weekday: 0 });
    expect(dueDailyJobs(jakarta, sunday, 'Asia/Jakarta').map((d) => [d.job.name, d.singletonKey])).toEqual([
      ['integrity.rehash', `ir:${jakarta}:2030-01-20`],
      ['cycle.derive', `cd:${jakarta}:all`],
    ]);
    expect(dueDailyJobs(jakarta, new Date('2030-01-20T20:05:00Z'), 'Asia/Jakarta').map((d) => d.job.name)).toEqual(['cycle.derive']);
    expect(DAILY_JOBS.map((d) => d.at)).toEqual(['00:05', '00:15', '00:30', '01:00', '02:00', '02:30', '02:45', '03:00', '03:15', '06:30', '07:00']);
  });

  it('advances the clock high-water mark and never moves it back', async () => {
    const mark = async () => (await sql<{ high_water: Date }>`SELECT high_water FROM platform.clock_mark`.execute(db.migrator)).rows[0]!.high_water;
    app.setNow('2030-02-01T10:05:00Z');
    const result = await app.moduleRef.get(SchedulerTickJob).tick();
    expect(result.highWater).toBe('2030-02-01T10:05:00.000Z');
    expect((await mark()).toISOString()).toBe('2030-02-01T10:05:00.000Z');
    app.setNow('2029-12-31T10:05:00Z');
    await app.moduleRef.get(SchedulerTickJob).tick();
    expect((await mark()).toISOString()).toBe('2030-02-01T10:05:00.000Z');
  });

  it('skips organisations that are not active', async () => {
    await sql`UPDATE platform.organization SET status = 'suspended' WHERE id = ${newYork}`.execute(db.migrator);
    try {
      app.setNow('2030-03-01T05:05:00Z'); // 00:05 in New York (UTC-5)
      const result = await app.moduleRef.get(SchedulerTickJob).tick();
      expect(result.organisations).toBe(1);
      expect(result.enqueued).toEqual([]);
    } finally {
      await sql`UPDATE platform.organization SET status = 'active' WHERE id = ${newYork}`.execute(db.migrator);
    }
  });

  it('lists the E.2 cron schedules; the test profile registers none', () => {
    expect(CRON_SCHEDULES.map((s) => [s.name, s.cron])).toEqual([
      ['scheduler.tick', '5 * * * *'],
      ['packs.lifecycle', '10 0 * * *'],
      ['audit.verify-chain', '0 4 * * *'],
      ['cleanup.expired', '20 * * * *'],
      ['notifications.dispatch', '*/5 * * * *'],
    ]);
    expect(app.moduleRef.get(WorkerRuntime).state).toEqual({ queues: ['scheduler.tick'], schedules: [] });
    expect(app.queue.schedules).toEqual([]);
  });

  it('registers the cron schedules of the jobs it handles when schedules are enabled', async () => {
    const withSchedules = await createJobsApp(db, { env: { MSCD__JOBS__SCHEDULES_ENABLED: 'true' } });
    try {
      expect(withSchedules.queue.schedules.map((s) => [s.name, s.cron, s.tz])).toEqual([
        ['scheduler.tick', '5 * * * *', 'UTC'],
        ['audit.verify-chain', '0 4 * * *', 'UTC'],
        ['cleanup.expired', '20 * * * *', 'UTC'],
      ]);
      const state = withSchedules.moduleRef.get(WorkerRuntime).state!;
      expect(state.queues).toEqual(expect.arrayContaining(['scheduler.tick', 'cleanup.expired', 'audit.verify-chain', 'tasks.overdue', 'audit-prep.generate', 'license.check']));
    } finally {
      await withSchedules.close();
    }
  });
});
