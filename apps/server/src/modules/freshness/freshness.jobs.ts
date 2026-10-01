// `freshness.recompute` (debounced 5 seconds by its producers, singleton `fr:<org>:<ms or all>`) and
// `freshness.sweep` (daily at 01:00 local time, `fs:<org>:<date>`), build plan E.2 and E.3.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { FreshnessService, type RecomputeResult } from './freshness.service';

function summary(result: RecomputeResult) {
  return {
    evidenceUpdated: result.evidenceUpdated,
    entriesUpdated: result.entriesUpdated,
    downgraded: result.downgraded.length,
    tasksOpened: result.tasksOpened,
    tasksClosed: result.tasksClosed,
    notifications: result.notifications,
  };
}

@Injectable()
@JobHandler('freshness.recompute', { concurrency: 2, scope: 'tenant' })
export class FreshnessRecomputeJob implements JobHandlerInstance<'freshness.recompute'> {
  private readonly logger = new Logger('freshness.recompute');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly freshness: FreshnessService,
  ) {}

  async handle(job: JobRun<'freshness.recompute'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'freshness.recompute');
    if (!org) return;
    const result = await this.freshness.recompute(org, job.env.payload, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, ...summary(result) }, 'freshness.recompute done');
  }
}

@Injectable()
@JobHandler('freshness.sweep', { concurrency: 1, scope: 'tenant' })
export class FreshnessSweepJob implements JobHandlerInstance<'freshness.sweep'> {
  private readonly logger = new Logger('freshness.sweep');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly freshness: FreshnessService,
  ) {}

  async handle(job: JobRun<'freshness.sweep'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'freshness.sweep');
    if (!org) return;
    const result = await this.freshness.sweep(org, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, ...summary(result) }, 'freshness.sweep done');
  }
}

/** Singleton key of `freshness.recompute` (E.2) for producers: `fr:<org>:<ms or all>`. */
export function freshnessRecomputeKey(orgId: string, msId?: string | null): string {
  return `fr:${orgId}:${msId ?? 'all'}`;
}

/** E.2: producers debounce `freshness.recompute` by 5 seconds. */
export const FRESHNESS_RECOMPUTE_DELAY_SECONDS = 5;
