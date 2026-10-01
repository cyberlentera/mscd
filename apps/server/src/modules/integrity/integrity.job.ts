// `integrity.rehash` (Sunday 03:00 local, `ir:<org>:<date>`), build plan E.2 and A-08.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { IntegrityService } from './integrity.service';

@Injectable()
@JobHandler('integrity.rehash', { concurrency: 1, scope: 'tenant' })
export class IntegrityRehashJob implements JobHandlerInstance<'integrity.rehash'> {
  private readonly logger = new Logger('integrity.rehash');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly integrity: IntegrityService,
  ) {}

  async handle(job: JobRun<'integrity.rehash'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'integrity.rehash');
    if (!org) return;
    const summary = await this.integrity.rehash(org, job.id, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, ...summary }, 'integrity.rehash done');
  }
}
