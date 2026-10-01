// `drift.evaluate` (02:45 local and after `freshness.recompute`, `de:<org>:<ms or all>`), build plan E.2.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { DriftService } from './drift.service';

/** Singleton key of `drift.evaluate` (E.2) for producers: `de:<org>:<ms or all>`. */
export function driftEvaluateKey(orgId: string, msId?: string | null): string {
  return `de:${orgId}:${msId ?? 'all'}`;
}

@Injectable()
@JobHandler('drift.evaluate', { concurrency: 1, scope: 'tenant' })
export class DriftEvaluateJob implements JobHandlerInstance<'drift.evaluate'> {
  private readonly logger = new Logger('drift.evaluate');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly drift: DriftService,
  ) {}

  async handle(job: JobRun<'drift.evaluate'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'drift.evaluate');
    if (!org) return;
    const summary = await this.drift.evaluate(org, { msId: job.env.payload.msId }, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, ...summary }, 'drift.evaluate done');
  }
}
