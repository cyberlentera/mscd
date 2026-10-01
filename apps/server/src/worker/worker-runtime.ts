// Run mode `worker` (D.4, E.1): starts a worker on the job queue for every `@JobHandler` provider of the
// application (or the `--queues` subset), registers the cron schedules of E.2 when `jobs.schedules_enabled`, and
// wraps every handler run with its log lines (`jobId`, `orgId`, `attempt`), the request id of the job and metrics.
// The outbox relay of the BullMQ driver runs in `JobsModule` (`OutboxRelay`) in the api and the worker.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JOB_NAMES, type JobName } from '@mscd/shared';
import { Counter, Histogram } from 'prom-client';
import { MscdConfig } from '../config/mscd-config';
import { JobHandlerRegistry, type DiscoveredJobHandler } from '../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../common/jobs/job-queue';
import { runWithRequestContext } from '../common/request-context';
import { BullMqJobQueue } from '../modules/jobs/bullmq-job-queue';
import { PgBossJobQueue } from '../modules/jobs/pgboss-job-queue';
import { CRON_SCHEDULES } from '../modules/jobs/schedules';
import { MetricsService } from '../modules/platform/metrics';
import { ReadinessService } from '../modules/platform/readiness.service';

export interface WorkerStartOptions {
  /** `mscd-server worker --queues a,b`: only these job names (default: every handler). */
  queues?: readonly string[];
}

export interface WorkerStartResult {
  queues: JobName[];
  schedules: JobName[];
}

const KNOWN_JOBS: ReadonlySet<string> = new Set(JOB_NAMES);

/** Parses `--queues a,b` (blank entries ignored; unknown names are an error). */
export function parseQueues(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = names.filter((n) => !KNOWN_JOBS.has(n));
  if (unknown.length > 0) throw new Error(`Unknown queue(s) ${unknown.join(', ')}; known: ${JOB_NAMES.join(', ')}`);
  return names.length > 0 ? names : undefined;
}

@Injectable()
export class WorkerRuntime implements OnModuleInit {
  private readonly logger = new Logger('worker');
  private readonly runs: Counter<'job' | 'outcome'>;
  private readonly duration: Histogram<'job'>;
  private started?: WorkerStartResult;

  constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly registry: JobHandlerRegistry,
    private readonly config: MscdConfig,
    private readonly readiness: ReadinessService,
    metrics: MetricsService,
  ) {
    this.runs =
      (metrics.registry.getSingleMetric('mscd_job_runs_total') as Counter<'job' | 'outcome'> | undefined) ??
      new Counter({ name: 'mscd_job_runs_total', help: 'Job handler runs by job name and outcome', labelNames: ['job', 'outcome'], registers: [metrics.registry] });
    this.duration =
      (metrics.registry.getSingleMetric('mscd_job_duration_seconds') as Histogram<'job'> | undefined) ??
      new Histogram({
        name: 'mscd_job_duration_seconds',
        help: 'Job handler run time',
        labelNames: ['job'],
        buckets: [0.05, 0.25, 1, 5, 15, 60, 300, 900],
        registers: [metrics.registry],
      });
  }

  onModuleInit(): void {
    if (this.config.runMode !== 'worker') return;
    this.readiness.register({
      name: 'job-queue',
      after: 'database',
      check: async () => {
        if (this.queue instanceof PgBossJobQueue) await this.queue.ready();
        else if (this.queue instanceof BullMqJobQueue) await this.queue.queue('scheduler.tick').getJobCounts('waiting');
      },
    });
  }

  /** What `start` started, or undefined before it ran. */
  get state(): WorkerStartResult | undefined {
    return this.started;
  }

  /** Starts the workers and the schedules (once per process). */
  async start(options: WorkerStartOptions = {}): Promise<WorkerStartResult> {
    if (this.started) return this.started;
    const wanted = options.queues && options.queues.length > 0 ? new Set(options.queues) : null;
    if (wanted) for (const name of wanted) if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown queue ${name}`);
    if (this.queue instanceof PgBossJobQueue) await this.queue.createAllQueues();
    const handlers = this.registry.discover();
    const queues: JobName[] = [];
    for (const handler of handlers) {
      if (wanted && !wanted.has(handler.metadata.name)) continue;
      await this.queue.work(handler.metadata.name, { concurrency: handler.metadata.concurrency }, (job) => this.runHandler(handler, job));
      queues.push(handler.metadata.name);
    }
    const schedules = this.config.profile.jobs.schedules_enabled ? await this.registerSchedules(handlers) : [];
    this.started = { queues, schedules };
    this.logger.log(`Working on ${queues.length} queue(s): ${queues.join(', ') || 'none'}; ${schedules.length} cron schedule(s)`);
    return this.started;
  }

  /** E.2 cron schedules (UTC) of the jobs this build handles. Stored by the driver, so every worker may register them. */
  private async registerSchedules(handlers: readonly DiscoveredJobHandler[]): Promise<JobName[]> {
    const handled = new Set(handlers.map((h) => h.metadata.name));
    const registered: JobName[] = [];
    for (const schedule of CRON_SCHEDULES) {
      if (!handled.has(schedule.name)) continue;
      await this.queue.schedule(schedule.name, schedule.cron, { orgId: null, payload: {} }, 'UTC');
      registered.push(schedule.name);
    }
    return registered;
  }

  /** One handler run with its request context, log lines and metrics (E.1). */
  private async runHandler(handler: DiscoveredJobHandler, job: JobRun<JobName>): Promise<void> {
    const name = handler.metadata.name;
    const requestId = job.env.requestId ?? randomUUID();
    const started = process.hrtime.bigint();
    const log = { jobId: job.id, job: name, orgId: job.env.orgId, attempt: job.attempt, requestId };
    if (handler.metadata.scope === 'tenant' && !job.env.orgId) {
      this.runs.inc({ job: name, outcome: 'failed' });
      this.logger.error(log, 'Tenant job without an organisation');
      throw new Error(`${name} is a tenant job and needs the organisation of the job envelope`);
    }
    try {
      await runWithRequestContext({ requestId, ip: null, userAgent: null, ...(job.env.orgId ? { orgId: job.env.orgId } : {}) }, () =>
        handler.instance.handle({ ...job, env: { ...job.env, requestId } }),
      );
      this.runs.inc({ job: name, outcome: 'succeeded' });
    } catch (error) {
      this.runs.inc({ job: name, outcome: 'failed' });
      this.logger.error({ ...log, error: error instanceof Error ? error.message : String(error) }, 'Job failed');
      throw error;
    } finally {
      this.duration.observe({ job: name }, Number(process.hrtime.bigint() - started) / 1e9);
    }
  }
}
