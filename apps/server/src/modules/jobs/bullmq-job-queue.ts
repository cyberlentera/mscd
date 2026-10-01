// BullMQ driver of the job queue on Valkey (build plan E.1, `jobs.driver: bullmq`). A send inside a business
// transaction inserts a row into `platform.job_outbox` in that transaction; the outbox relay (running in the api and
// the worker, `OutboxRelay`) moves committed rows to BullMQ every 500 ms with the job id `ob-<row id>`, so a row
// that is relayed twice still makes one job. A send without a transaction goes to BullMQ directly.
//
// Singleton keys use BullMQ deduplication (simple mode): a job with the same key is dropped while one is waiting,
// delayed, active or retrying, which is the E.1 contract.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { JOB_NAMES, type JobName } from '@mscd/shared';
import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../db/types';
import { acceptsAfterCommit, afterCommit } from '../../common/transaction-hooks';
import type { JobEnvelope, JobHandlerFn, JobPayloads, JobQueue, QueueStats, SendOptions } from '../../common/jobs/job-queue';

const KNOWN_JOBS: ReadonlySet<string> = new Set(JOB_NAMES);

/** Key prefix of every BullMQ structure in Valkey. */
export const BULLMQ_PREFIX = 'mscd';

/** Rows the relay moves per pass (E.1). */
export const OUTBOX_BATCH = 100;

/** What an outbox row's `payload` holds. */
export interface OutboxPayload {
  env: JobEnvelope<unknown>;
  retryLimit: number;
  priority: number;
}

export interface BullMqJobQueueOptions {
  /** `jobs.bullmq.url` (redis:// or rediss://). */
  url: string;
  prefix?: string;
}

/** Connection options for ioredis from a redis URL; workers need `maxRetriesPerRequest: null`. */
export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const dbIndex = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(dbIndex ? { db: Number(dbIndex) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export class BullMqJobQueue implements JobQueue {
  private readonly logger = new Logger('BullMqJobQueue');
  private readonly connection: ConnectionOptions;
  private readonly prefix: string;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private stopped = false;
  private readonly committedListeners = new Set<() => void>();

  constructor(options: BullMqJobQueueOptions) {
    this.connection = redisConnection(options.url);
    this.prefix = options.prefix ?? BULLMQ_PREFIX;
  }

  /** Called after a transaction that wrote outbox rows commits (the relay of this process picks them up at once). */
  onOutboxCommitted(listener: () => void): () => void {
    this.committedListeners.add(listener);
    return () => this.committedListeners.delete(listener);
  }

  async send<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts: SendOptions = {}, trx?: Transaction<DB>): Promise<string | null> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.stopped) throw new Error('The job queue is stopped');
    if (trx) {
      const payload: OutboxPayload = { env: env as JobEnvelope<unknown>, retryLimit: Math.max(0, opts.retryLimit ?? 0), priority: opts.priority ?? 0 };
      const delay = Math.max(0, opts.startAfterSeconds ?? 0);
      const row = await trx
        .insertInto('platform.job_outbox')
        .values({
          queue: name,
          payload: JSON.stringify(payload),
          singleton_key: opts.singletonKey ?? null,
          run_at: sql<Date>`now() + ${delay} * interval '1 second'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (acceptsAfterCommit(trx)) {
        afterCommit(trx, () => {
          for (const listener of this.committedListeners) listener();
        });
      }
      return `ob-${row.id}`;
    }
    const id = randomUUID();
    const job = await this.queue(name).add(name, env, this.jobOptions(id, opts.singletonKey, (opts.startAfterSeconds ?? 0) * 1000, opts.retryLimit ?? 0, opts.priority ?? 0));
    return job.id === id ? id : null;
  }

  async schedule(name: JobName, cron: string, env: JobEnvelope<unknown>, tz?: string): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    await this.queue(name).upsertJobScheduler(
      `cron:${name}`,
      { pattern: cron, ...(tz ? { tz } : {}) },
      { name, data: env, opts: { attempts: 4, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86_400, count: 1000 }, removeOnFail: { age: 7 * 86_400 } } },
    );
  }

  async work<N extends JobName>(name: N, opts: { concurrency: number }, handler: JobHandlerFn<N>): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.workers.has(name)) throw new Error(`A worker for ${name} is already registered`);
    const worker = new Worker(
      name,
      async (job) => {
        await handler({ id: String(job.id), name, env: job.data as JobEnvelope<JobPayloads[N]>, attempt: job.attemptsMade + 1 });
      },
      { connection: this.connection, prefix: this.prefix, concurrency: Math.max(1, Math.trunc(opts.concurrency)) },
    );
    worker.on('error', (error) => this.logger.error(`BullMQ worker ${name}: ${error.message}`));
    this.workers.set(name, worker);
    await worker.waitUntilReady();
  }

  async stats(): Promise<QueueStats[]> {
    const out: QueueStats[] = [];
    for (const name of JOB_NAMES) {
      const queue = this.queue(name);
      const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized', 'active', 'failed');
      const oldest = await queue.getJobs(['waiting', 'prioritized'], 0, 0, true);
      const waiting = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
      const active = counts.active ?? 0;
      const failed = counts.failed ?? 0;
      if (waiting === 0 && active === 0 && failed === 0 && !this.workers.has(name)) continue;
      const first = oldest[0];
      out.push({
        name,
        waiting,
        active,
        failed,
        oldestAgeSeconds: first ? Math.max(0, Math.floor((Date.now() - first.timestamp) / 1000)) : 0,
      });
    }
    return out;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.workers.values()].map((w) => w.close()));
    this.workers.clear();
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }

  /**
   * One relay pass (E.1): moves up to `OUTBOX_BATCH` committed outbox rows to BullMQ inside `trx` (a platform-scope
   * transaction of the caller), locking them with `FOR UPDATE SKIP LOCKED` so relays in other processes take other
   * rows. Returns the number of rows dispatched.
   */
  async relayOutbox(trx: Transaction<DB>): Promise<number> {
    if (this.stopped) return 0;
    const { rows } = await sql<{ id: string; queue: string; payload: OutboxPayload; singleton_key: string | null; delay_ms: string }>`
      SELECT id, queue, payload, singleton_key,
             greatest(0, ceil(extract(epoch FROM (run_at - now())) * 1000))::bigint AS delay_ms
        FROM platform.job_outbox
       WHERE dispatched_at IS NULL
       ORDER BY id
       LIMIT ${OUTBOX_BATCH}
         FOR UPDATE SKIP LOCKED`.execute(trx);
    let dispatched = 0;
    for (const row of rows) {
      try {
        if (!KNOWN_JOBS.has(row.queue)) throw new Error(`Unknown job ${row.queue}`);
        const payload = row.payload;
        await this.queue(row.queue).add(
          row.queue,
          payload.env,
          this.jobOptions(`ob-${row.id}`, row.singleton_key ?? undefined, Number(row.delay_ms), payload.retryLimit, payload.priority),
        );
        await trx.updateTable('platform.job_outbox').set({ dispatched_at: sql<Date>`now()`, attempts: sql<number>`attempts + 1`, last_error: null }).where('id', '=', row.id).execute();
        dispatched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Outbox row ${row.id} (${row.queue}) not relayed: ${message}`);
        await trx.updateTable('platform.job_outbox').set({ attempts: sql<number>`attempts + 1`, last_error: message.slice(0, 2000) }).where('id', '=', row.id).execute();
      }
    }
    return dispatched;
  }

  /** The BullMQ queue of a job name (created on first use). */
  queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
      queue.on('error', (error) => this.logger.error(`BullMQ queue ${name}: ${error.message}`));
      this.queues.set(name, queue);
    }
    return queue;
  }

  private jobOptions(jobId: string, singletonKey: string | undefined, delayMs: number, retryLimit: number, priority: number): JobsOptions {
    return {
      jobId,
      ...(singletonKey ? { deduplication: { id: singletonKey } } : {}),
      ...(delayMs > 0 ? { delay: Math.ceil(delayMs) } : {}),
      attempts: Math.max(0, retryLimit) + 1,
      backoff: { type: 'exponential', delay: 1000 },
      // BullMQ priorities run lowest first; E.1 priorities run highest first. 0 means "no priority".
      ...(priority > 0 ? { priority: Math.max(1, 2_097_152 - priority) } : {}),
      // Kept for a day so a relayed row seen twice finds its job id (no duplicate), then removed.
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 7 * 86_400 },
    };
  }
}
