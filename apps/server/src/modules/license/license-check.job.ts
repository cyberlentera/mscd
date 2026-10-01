// `license.check` (E.2): the daily licence evaluation of one organisation. Scheduled by `scheduler.tick` (WP-22) at
// 00:05 local time with the singleton key `lc:<org>:<date>`, and queued after every licence installation.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { LicenceService } from './licence.service';

@Injectable()
@JobHandler('license.check', { concurrency: 2, scope: 'tenant' })
export class LicenseCheckJob implements JobHandlerInstance<'license.check'> {
  private readonly logger = new Logger('license.check');

  constructor(private readonly licences: LicenceService) {}

  async handle(job: JobRun<'license.check'>): Promise<void> {
    const orgId = job.env.orgId;
    if (!orgId) throw new Error('license.check needs the organisation of the job envelope');
    const result = await this.licences.checkOrganisation(orgId);
    this.logger.log({ jobId: job.id, orgId, attempt: job.attempt, state: result?.state ?? null, changed: result?.changed ?? false }, 'license.check done');
  }
}
