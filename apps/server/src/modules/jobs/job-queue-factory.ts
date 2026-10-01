// Chooses the job queue driver of a process (build plan E.1): `jobs.driver` of the profile, pg-boss by default and
// BullMQ on Valkey with `jobs.driver: bullmq`. The test profile keeps jobs in memory (tests enqueue and drain jobs in
// the process, J.8) unless MSCD_TEST_JOBS_DRIVER=profile asks for the profile's driver (the API end-to-end stack,
// which runs the api and the worker as separate processes).
import type { MscdConfig } from '../../config/mscd-config';
import { InMemoryJobQueue } from '../../common/jobs/in-memory-job-queue';
import type { JobQueue } from '../../common/jobs/job-queue';
import { BullMqJobQueue } from './bullmq-job-queue';
import { PgBossJobQueue } from './pgboss-job-queue';

export type JobDriverName = 'pgboss' | 'bullmq' | 'memory';

/** The driver a configuration selects. */
export function jobDriverOf(config: MscdConfig): JobDriverName {
  if (config.profile.test !== undefined && config.env.MSCD_TEST_JOBS_DRIVER !== 'profile') return 'memory';
  return config.profile.jobs.driver;
}

/** Creates the job queue of a process. Nothing connects until the queue is first used. */
export function createJobQueue(config: MscdConfig): JobQueue {
  const driver = jobDriverOf(config);
  if (driver === 'memory') return new InMemoryJobQueue({ defaultRetryLimit: 0 });
  if (driver === 'bullmq') {
    const url = config.profile.jobs.bullmq.url;
    if (!url) throw new Error('jobs.bullmq.url is required with jobs.driver bullmq');
    return new BullMqJobQueue({ url });
  }
  const worker = config.runMode === 'worker';
  return new PgBossJobQueue({
    connectionString: config.databaseUrl('app'),
    supervise: worker,
    schedule: worker && config.profile.jobs.schedules_enabled,
    applicationName: `mscd-${config.runMode}-jobs`,
  });
}
