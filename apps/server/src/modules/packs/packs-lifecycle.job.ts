// `packs.lifecycle` (E.2): installation-wide, daily at 00:10 UTC (`PACKS_LIFECYCLE_CRON`, singleton `pl:<utc date>`).
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { PackLifecycleService } from './pack-lifecycle.service';

@Injectable()
@JobHandler('packs.lifecycle', { concurrency: 1, scope: 'installation' })
export class PacksLifecycleJob implements JobHandlerInstance<'packs.lifecycle'> {
  private readonly logger = new Logger('packs.lifecycle');

  constructor(private readonly lifecycle: PackLifecycleService) {}

  async handle(job: JobRun<'packs.lifecycle'>): Promise<void> {
    const result = await this.lifecycle.runLifecycle(job.env.requestId);
    this.logger.log({ jobId: job.id, attempt: job.attempt, ...result }, 'packs.lifecycle done');
  }
}
