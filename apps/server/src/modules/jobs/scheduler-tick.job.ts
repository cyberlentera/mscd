// `scheduler.tick` (E.2): hourly at minute 5 UTC. Advances the clock high-water mark of the licence rollback rule
// (D-15) and enqueues, for every active organisation, the daily jobs whose local time falls in the organisation's
// current local hour (D-07). Only jobs that have a handler in this build are enqueued, so a job of a later work
// package starts being scheduled when its handler exists.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobName } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JobHandler, JobHandlerRegistry, type JobHandlerInstance } from '../../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../../common/jobs/job-queue';
import { TenantScope } from '../tenancy/tenant-scope';
import { DAILY_JOBS, dueDailyJobs, type DailyJob } from './schedules';

export interface TickResult {
  highWater: string;
  organisations: number;
  enqueued: { orgId: string; name: JobName; singletonKey: string; startAfterSeconds: number }[];
}

@Injectable()
@JobHandler('scheduler.tick', { concurrency: 1, scope: 'installation' })
export class SchedulerTickJob implements JobHandlerInstance<'scheduler.tick'> {
  private readonly logger = new Logger('scheduler.tick');

  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly registry: JobHandlerRegistry,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {}

  async handle(job: JobRun<'scheduler.tick'>): Promise<void> {
    const result = await this.tick(job.env.requestId);
    this.logger.log(
      { jobId: job.id, attempt: job.attempt, organisations: result.organisations, enqueued: result.enqueued.length, highWater: result.highWater },
      'scheduler.tick done',
    );
  }

  /** One tick at the clock's current instant. */
  async tick(requestId?: string): Promise<TickResult> {
    const now = this.clock.now();
    const handled = new Set(this.registry.discover().map((h) => h.metadata.name));
    const daily: DailyJob[] = DAILY_JOBS.filter((d) => handled.has(d.name));
    return this.scope.withPlatform(
      async (trx) => {
        // The mark only moves forward (D-15): a clock set back never lowers it.
        const mark = await trx
          .updateTable('platform.clock_mark')
          .set({ high_water: sql<Date>`greatest(high_water, ${now})` })
          .returning('high_water')
          .executeTakeFirst();
        const orgs = await trx
          .selectFrom('platform.organization')
          .select(['id', 'time_zone'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .orderBy('slug')
          .execute();
        const enqueued: TickResult['enqueued'] = [];
        for (const org of orgs) {
          for (const due of dueDailyJobs(org.id, now, org.time_zone, daily)) {
            await this.jobs.send(
              due.job.name,
              { orgId: org.id, requestId, payload: {} },
              { singletonKey: due.singletonKey, retryLimit: due.job.retryLimit, ...(due.startAfterSeconds > 0 ? { startAfterSeconds: due.startAfterSeconds } : {}) },
              trx,
            );
            enqueued.push({ orgId: org.id, name: due.job.name, singletonKey: due.singletonKey, startAfterSeconds: due.startAfterSeconds });
          }
        }
        return { highWater: (mark?.high_water ?? now).toISOString(), organisations: orgs.length, enqueued };
      },
      { scope: 'job', requestId },
    );
  }
}
