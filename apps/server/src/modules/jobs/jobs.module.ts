import { Module } from '@nestjs/common';
import { AuditPrepGenerateJob } from './audit-prep-generate.job';
import { AuditVerifyChainJob } from './audit-verify-chain.job';
import { CleanupExpiredJob } from './cleanup-expired.job';
import { OutboxRelay } from './outbox-relay';
import { RuleTaskService } from './rule-tasks';
import { SchedulerTickJob } from './scheduler-tick.job';
import { TasksOverdueJob } from './tasks-overdue.job';
import { TenantJobRunner } from './tenant-job';

/**
 * Job queue infrastructure and the core jobs of WP-22 (E.1, E.2). The `JOB_QUEUE` provider itself is in the global
 * `CommonModule` and built by `createJobQueue` (`job-queue-factory.ts`): pg-boss by default, BullMQ on Valkey with
 * `jobs.driver: bullmq`, in memory with the test profile. This module adds the BullMQ outbox relay (api and
 * worker), the installation jobs `scheduler.tick`, `cleanup.expired` and `audit.verify-chain`, the tenant jobs
 * `tasks.overdue` and `audit-prep.generate`, and the services other job modules use (`RuleTaskService`,
 * `TenantJobRunner`).
 */
@Module({
  providers: [
    OutboxRelay,
    RuleTaskService,
    TenantJobRunner,
    SchedulerTickJob,
    CleanupExpiredJob,
    AuditVerifyChainJob,
    TasksOverdueJob,
    AuditPrepGenerateJob,
  ],
  exports: [OutboxRelay, RuleTaskService, TenantJobRunner],
})
export class JobsModule {}
