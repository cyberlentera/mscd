// `edition.withdrawn-alerts` (E.2, BR-33): queued by `packs.lifecycle` for every active organisation
// (singleton `ewa:<org>:<date>`).
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { PackLifecycleService } from './pack-lifecycle.service';

@Injectable()
@JobHandler('edition.withdrawn-alerts', { concurrency: 2, scope: 'tenant' })
export class EditionWithdrawnAlertsJob implements JobHandlerInstance<'edition.withdrawn-alerts'> {
  private readonly logger = new Logger('edition.withdrawn-alerts');

  constructor(private readonly lifecycle: PackLifecycleService) {}

  async handle(job: JobRun<'edition.withdrawn-alerts'>): Promise<void> {
    const orgId = job.env.orgId;
    if (!orgId) throw new Error('edition.withdrawn-alerts needs the organisation of the job envelope');
    const result = await this.lifecycle.raiseWithdrawnAlerts(orgId);
    this.logger.log({ jobId: job.id, orgId, attempt: job.attempt, ...(result ?? {}) }, 'edition.withdrawn-alerts done');
  }
}
