// In-memory driver of the job queue (build plan E.1), for tests and for processes without a queue backend. Jobs live
// in this process only: they are lost on restart and never reach another process, so production runs use the
// pg-boss or BullMQ driver (WP-22). The driver honours the E.1 contract: transactional send (after commit only),
// singleton keys, delays, retries and per-queue concurrency.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { JOB_NAMES, type JobName } from '@mscd/shared';
import type { Transaction } from 'kysely';
import type { DB } from '../../db/types';
import { acceptsAfterCommit, afterCommit } from '../transaction-hooks';
import type { JobPayloads } from './job-payloads';
import type { JobEnvelope, JobHandlerFn, JobQueue, JobRun, QueueStats, SendOptions } from './job-queue';

interface StoredJob {
  id: string;
  name: JobName;
  env: JobEnvelope<unknown>;
  singletonKey?: string;
  runAfter: number;
  createdAt: number;
  retryLimit: number;
  priority: number;
  attempt: number;
  lastError?: string;
}

interface Worker {
  concurrency: number;
  handler: JobHandlerFn<JobName>;
  active: number;
}

export interface InMemoryJobQueueOptions {
  /** Run jobs as soon as a worker exists for their queue (default true). With false only `drain()` runs them. */
  autoRun?: boolean;
  /** Most waiting jobs kept; the oldest is dropped with a warning beyond it (default 10,000). */
  maxWaiting?: number;
  /** Default retry limit when `send` gives none (E.2 uses 3 for most jobs). */
  defaultRetryLimit?: number;
}

export interface ScheduledJob {
  name: JobName;
  cron: string;
  env: JobEnvelope<unknown>;
  tz?: string;
}

const KNOWN_JOBS: ReadonlySet<string> = new Set(JOB_NAMES);

export class InMemoryJobQueue implements JobQueue {
  private readonly logger = new Logger('InMemoryJobQueue');
  private readonly waiting: StoredJob[] = [];
  private readonly activeJobs = new Map<string, { job: StoredJob; done: Promise<void> }>();
  private readonly workers = new Map<JobName, Worker>();
  private readonly failedJobs: StoredJob[] = [];
  private readonly completedJobs: StoredJob[] = [];
  readonly schedules: ScheduledJob[] = [];
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly autoRun: boolean;
  private readonly maxWaiting: number;
  private readonly defaultRetryLimit: number;

  constructor(options: InMemoryJobQueueOptions = {}) {
    this.autoRun = options.autoRun ?? true;
    this.maxWaiting = options.maxWaiting ?? 10_000;
    this.defaultRetryLimit = options.defaultRetryLimit ?? 0;
  }

  async send<N extends JobName>(
    name: N,
    env: JobEnvelope<JobPayloads[N]>,
    opts: SendOptions = {},
    trx?: Transaction<DB>,
  ): Promise<string | null> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.stopped) throw new Error('The job queue is stopped');
    const job: StoredJob = {
      id: randomUUID(),
      name,
      env: structuredClone(env) as JobEnvelope<unknown>,
      singletonKey: opts.singletonKey,
      runAfter: Date.now() + Math.max(0, opts.startAfterSeconds ?? 0) * 1000,
      createdAt: Date.now(),
      retryLimit: Math.max(0, opts.retryLimit ?? this.defaultRetryLimit),
      priority: opts.priority ?? 0,
      attempt: 1,
    };
    if (trx) {
      if (!acceptsAfterCommit(trx)) throw new Error('JobQueue.send: pass a transaction opened by withTenant or withPlatform');
      // The id is returned now; a singleton duplicate found at commit time is dropped then.
      afterCommit(trx, () => {
        this.enqueue(job);
      });
      return job.id;
    }
    return this.enqueue(job) ? job.id : null;
  }

  async schedule(name: JobName, cron: string, env: JobEnvelope<unknown>, tz?: string): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    const existing = this.schedules.findIndex((s) => s.name === name);
    const entry: ScheduledJob = { name, cron, env, ...(tz ? { tz } : {}) };
    if (existing >= 0) this.schedules[existing] = entry;
    else this.schedules.push(entry);
  }

  async work<N extends JobName>(name: N, opts: { concurrency: number }, handler: JobHandlerFn<N>): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.workers.has(name)) throw new Error(`A worker for ${name} is already registered`);
    this.workers.set(name, { concurrency: Math.max(1, Math.trunc(opts.concurrency)), handler: handler as JobHandlerFn<JobName>, active: 0 });
    if (this.autoRun) this.pump();
  }

  async stats(): Promise<QueueStats[]> {
    const names = new Set<JobName>([...this.workers.keys(), ...this.waiting.map((j) => j.name), ...this.failedJobs.map((j) => j.name)]);
    const now = Date.now();
    return [...names].sort().map((name) => {
      const waiting = this.waiting.filter((j) => j.name === name);
      const active = [...this.activeJobs.values()].filter((a) => a.job.name === name).length;
      const oldest = waiting.reduce((min, j) => Math.min(min, j.createdAt), Number.POSITIVE_INFINITY);
      return {
        name,
        waiting: waiting.length,
        active,
        failed: this.failedJobs.filter((j) => j.name === name).length,
        oldestAgeSeconds: Number.isFinite(oldest) ? Math.floor((now - oldest) / 1000) : 0,
      };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.activeJobs.values()].map((a) => a.done));
  }

  /**
   * Runs jobs until nothing is ready and nothing is active (tests: "run the worker in-process until idle", J.8).
   * With `includeDelayed` jobs whose delay has not passed run too.
   */
  async drain(options: { includeDelayed?: boolean } = {}): Promise<void> {
    for (let round = 0; round < 10_000; round += 1) {
      this.pump(options.includeDelayed === true);
      const active = [...this.activeJobs.values()].map((a) => a.done);
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
    throw new Error('InMemoryJobQueue.drain: jobs keep queueing more jobs');
  }

  /** Jobs that are waiting (tests). */
  waitingJobs(name?: JobName): readonly JobRun<JobName>[] {
    return this.waiting.filter((j) => !name || j.name === name).map((j) => this.toRun(j));
  }

  /** Jobs that failed after their last retry (tests). */
  failed(name?: JobName): readonly (JobRun<JobName> & { error?: string })[] {
    return this.failedJobs.filter((j) => !name || j.name === name).map((j) => ({ ...this.toRun(j), error: j.lastError }));
  }

  /** Jobs that ran successfully, oldest first (tests). */
  completed(name?: JobName): readonly JobRun<JobName>[] {
    return this.completedJobs.filter((j) => !name || j.name === name).map((j) => this.toRun(j));
  }

  private toRun(j: StoredJob): JobRun<JobName> {
    return { id: j.id, name: j.name, env: j.env as JobEnvelope<never>, attempt: j.attempt };
  }

  /** Adds a job unless its singleton key is taken; returns false for a duplicate. */
  private enqueue(job: StoredJob): boolean {
    if (job.singletonKey !== undefined) {
      const taken =
        this.waiting.some((j) => j.name === job.name && j.singletonKey === job.singletonKey) ||
        [...this.activeJobs.values()].some((a) => a.job.name === job.name && a.job.singletonKey === job.singletonKey);
      if (taken) return false;
    }
    this.waiting.push(job);
    if (this.waiting.length > this.maxWaiting) {
      const dropped = this.waiting.shift()!;
      this.logger.warn(`In-memory job queue is full: dropped ${dropped.name} job ${dropped.id}`);
    }
    if (this.autoRun) this.pump();
    return true;
  }

  /** Starts every ready job a worker has capacity for, then arms a timer for the next delayed job. */
  private pump(includeDelayed = false): void {
    if (this.stopped) return;
    const now = Date.now();
    const ready = this.waiting
      .filter((j) => (includeDelayed || j.runAfter <= now) && this.workers.has(j.name))
      .sort((a, b) => b.priority - a.priority || a.runAfter - b.runAfter || a.createdAt - b.createdAt);
    for (const job of ready) {
      const worker = this.workers.get(job.name)!;
      if (worker.active >= worker.concurrency) continue;
      this.waiting.splice(this.waiting.indexOf(job), 1);
      worker.active += 1;
      const done = this.run(job, worker).finally(() => {
        worker.active -= 1;
        this.activeJobs.delete(job.id);
        if (this.autoRun) this.pump();
      });
      this.activeJobs.set(job.id, { job, done });
    }
    this.armTimer();
  }

  private async run(job: StoredJob, worker: Worker): Promise<void> {
    try {
      await worker.handler({ id: job.id, name: job.name, env: job.env as JobEnvelope<never>, attempt: job.attempt });
      this.completedJobs.push(job);
      if (this.completedJobs.length > 1000) this.completedJobs.shift();
    } catch (error) {
      job.lastError = error instanceof Error ? error.message : String(error);
      if (job.attempt <= job.retryLimit) {
        this.waiting.push({ ...job, attempt: job.attempt + 1, runAfter: Date.now() });
      } else {
        this.failedJobs.push(job);
        this.logger.error(`Job ${job.name} ${job.id} failed after ${job.attempt} attempt(s): ${job.lastError}`);
      }
    }
  }

  private armTimer(): void {
    if (!this.autoRun || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const delayed = this.waiting.filter((j) => this.workers.has(j.name) && j.runAfter > Date.now());
    if (delayed.length === 0) return;
    const next = Math.min(...delayed.map((j) => j.runAfter));
    this.timer = setTimeout(() => this.pump(), Math.max(0, next - Date.now()));
    this.timer.unref();
  }
}
