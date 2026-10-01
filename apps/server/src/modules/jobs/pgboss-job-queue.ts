// pg-boss driver of the job queue (build plan E.1, the default `jobs.driver`). Jobs live in the `pgboss` schema of
// the application database, which `migrate` creates (C.3 step 3). A send inside a business transaction runs the
// pg-boss insert through that transaction (`fromKysely(trx)`), so the job exists only when the transaction commits.
//
// Every queue uses the `exclusive` policy: at most one created, retrying or active job per singleton key, which is
// the E.1 contract ("at most one waiting or active job per key"). A send without a singleton key gets a unique key,
// because the policy would otherwise treat every key-less job as one.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { JOB_NAMES, type JobName } from '@mscd/shared';
import { PgBoss, fromKysely, type Job } from 'pg-boss';
import type { Transaction } from 'kysely';
import type { DB } from '../../db/types';
import { cronRetryLimit } from './schedules';
import type { JobEnvelope, JobHandlerFn, JobPayloads, JobQueue, QueueStats, SendOptions } from '../../common/jobs/job-queue';

/** Schema of the pg-boss tables (C.3 step 3). */
export const PGBOSS_SCHEMA = 'pgboss';

const KNOWN_JOBS: ReadonlySet<string> = new Set(JOB_NAMES);

export interface PgBossJobQueueOptions {
  /** URL of role mscd_app. */
  connectionString: string;
  /** Run pg-boss maintenance (expiry, retention) in this process; the worker does, the api does not. */
  supervise?: boolean;
  /** Fire cron schedules in this process (the worker with `jobs.schedules_enabled`). */
  schedule?: boolean;
  /** Pool size of pg-boss's own connections (default 4). */
  poolMax?: number;
  /** Seconds between polls of a worker (default 2). */
  pollingIntervalSeconds?: number;
  applicationName?: string;
}

/** The data a pg-boss job carries: the envelope of E.1. */
type StoredEnvelope = JobEnvelope<unknown>;

export class PgBossJobQueue implements JobQueue {
  private readonly logger = new Logger('PgBossJobQueue');
  private readonly boss: PgBoss;
  private starting?: Promise<void>;
  private started = false;
  private stopped = false;
  private readonly queuesCreated = new Set<string>();
  private readonly pollingIntervalSeconds: number;

  constructor(options: PgBossJobQueueOptions) {
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: PGBOSS_SCHEMA,
      application_name: options.applicationName ?? 'mscd-jobs',
      max: options.poolMax ?? 4,
      // The schema belongs to mscd_migrator (C.3 step 3); the application role only checks its version.
      migrate: false,
      createSchema: false,
      supervise: options.supervise ?? false,
      schedule: options.schedule ?? false,
      // REINDEX needs the owner of the indexes, which mscd_app is not.
      reindex: false,
    });
    this.boss.on('error', (error: Error) => this.logger.error(`pg-boss: ${error.message}`));
  }

  /** The pg-boss instance (tests and diagnostics). */
  get instance(): PgBoss {
    return this.boss;
  }

  async send<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts: SendOptions = {}, trx?: Transaction<DB>): Promise<string | null> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.stopped) throw new Error('The job queue is stopped');
    await this.ready();
    await this.ensureQueue(name);
    const id = randomUUID();
    const result = await this.boss.send(name, env as unknown as object, {
      id,
      singletonKey: opts.singletonKey ?? `u:${id}`,
      ...(opts.startAfterSeconds && opts.startAfterSeconds > 0 ? { startAfter: Math.ceil(opts.startAfterSeconds) } : {}),
      retryLimit: Math.max(0, opts.retryLimit ?? 0),
      retryBackoff: true,
      retryDelay: 1,
      priority: opts.priority ?? 0,
      ...(trx ? { db: fromKysely(trx) } : {}),
    });
    return result ?? null;
  }

  async schedule(name: JobName, cron: string, env: JobEnvelope<unknown>, tz?: string): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    await this.ready();
    await this.ensureQueue(name);
    await this.boss.schedule(name, cron, env as unknown as object, {
      ...(tz ? { tz } : {}),
      singletonKey: `cron:${name}`,
      retryLimit: cronRetryLimit(name),
      retryBackoff: true,
      retryDelay: 1,
    });
  }

  async work<N extends JobName>(name: N, opts: { concurrency: number }, handler: JobHandlerFn<N>): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    await this.ready();
    await this.ensureQueue(name);
    await this.boss.work<StoredEnvelope>(
      name,
      {
        batchSize: 1,
        localConcurrency: Math.max(1, Math.trunc(opts.concurrency)),
        pollingIntervalSeconds: this.pollingIntervalSeconds,
      },
      async (jobs: Job<StoredEnvelope>[]) => {
        for (const job of jobs) {
          await handler({ id: job.id, name, env: job.data as JobEnvelope<JobPayloads[N]>, attempt: job.retryCount + 1 });
        }
      },
    );
  }

  async stats(): Promise<QueueStats[]> {
    await this.ready();
    // Counted from the job table: pg-boss's queue counters are refreshed by its monitor only.
    const { rows } = await this.boss.getDb().executeSql(
      `SELECT name,
              count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS waiting,
              count(*) FILTER (WHERE state = 'active')::int AS active,
              count(*) FILTER (WHERE state = 'failed')::int AS failed,
              coalesce(extract(epoch FROM (now() - min(created_on) FILTER (WHERE state IN ('created', 'retry'))))::bigint, 0) AS age
         FROM ${PGBOSS_SCHEMA}.job
        GROUP BY name`,
    );
    const byName = new Map<string, { waiting: number; active: number; failed: number; age: number }>(
      rows.map((r: { name: string; waiting: number; active: number; failed: number; age: string | number }) => [
        r.name,
        { waiting: Number(r.waiting), active: Number(r.active), failed: Number(r.failed), age: Number(r.age) },
      ]),
    );
    return [...byName.entries()]
      .filter(([name]) => KNOWN_JOBS.has(name))
      .map(([name, c]) => ({ name, waiting: c.waiting, active: c.active, failed: c.failed, oldestAgeSeconds: Math.max(0, c.age) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.starting) await this.starting.catch(() => undefined);
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: 20_000 });
  }

  /** Starts pg-boss once (lazily: processes that never use the queue never connect). */
  async ready(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error('The job queue is stopped');
    this.starting ??= (async () => {
      await this.boss.start();
      this.started = true;
    })();
    try {
      await this.starting;
    } catch (error) {
      this.starting = undefined;
      throw new Error(`The pg-boss job queue could not start (has migrate created the ${PGBOSS_SCHEMA} schema?): ${(error as Error).message}`);
    }
  }

  /** Creates the queue of a job (idempotent; `exclusive` policy, see the file comment). */
  private async ensureQueue(name: string): Promise<void> {
    if (this.queuesCreated.has(name)) return;
    await this.boss.createQueue(name, { policy: 'exclusive' });
    this.queuesCreated.add(name);
  }

  /** Creates every queue of E.2 (the worker at start, E.1). */
  async createAllQueues(): Promise<void> {
    await this.ready();
    for (const name of JOB_NAMES) await this.ensureQueue(name);
  }
}
