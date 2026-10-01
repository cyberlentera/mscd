// `link-health.plan` (02:00 local, `lhp:<org>:<date>`), `link-health.check` (per repository batch,
// `lhc:<org>:<repo>:<sha1 of ids>`) and `link-health.repository` (02:30 local, `lhr:<org>:<date>`), build plan E.2.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { LinkHealthService } from './link-health.service';
import { RepositoryHealthService } from './repository-health.service';

@Injectable()
@JobHandler('link-health.plan', { concurrency: 1, scope: 'tenant' })
export class LinkHealthPlanJob implements JobHandlerInstance<'link-health.plan'> {
  private readonly logger = new Logger('link-health.plan');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly linkHealth: LinkHealthService,
  ) {}

  async handle(job: JobRun<'link-health.plan'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'link-health.plan');
    if (!org) return;
    const result = await this.linkHealth.plan(org, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, ...result }, result.licensed ? 'link-health.plan done' : 'link-health.plan skipped: no link_health_monitor feature');
  }
}

@Injectable()
@JobHandler('link-health.check', { concurrency: 2, scope: 'tenant' })
export class LinkHealthCheckJob implements JobHandlerInstance<'link-health.check'> {
  private readonly logger = new Logger('link-health.check');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly linkHealth: LinkHealthService,
  ) {}

  async handle(job: JobRun<'link-health.check'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'link-health.check');
    if (!org) return;
    const summary = await this.linkHealth.check(org, job);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, repositoryId: job.env.payload.repositoryId, ...summary }, 'link-health.check done');
  }
}

@Injectable()
@JobHandler('link-health.repository', { concurrency: 1, scope: 'tenant' })
export class LinkHealthRepositoryJob implements JobHandlerInstance<'link-health.repository'> {
  private readonly logger = new Logger('link-health.repository');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly repositories: RepositoryHealthService,
  ) {}

  async handle(job: JobRun<'link-health.repository'>): Promise<void> {
    const org = await this.runner.organisation(job.env.orgId, 'link-health.repository');
    if (!org) return;
    const results = await this.repositories.checkAll(org, job.env.requestId);
    this.logger.log(
      { jobId: job.id, orgId: org.id, attempt: job.attempt, repositories: results.map((r) => `${r.slug}:${r.before}->${r.after}`) },
      'link-health.repository done',
    );
  }
}
