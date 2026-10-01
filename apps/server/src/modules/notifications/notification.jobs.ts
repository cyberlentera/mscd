// Job handlers of the notifications module (build plan E.2, E.6):
//
// - `notifications.dispatch` (retries 5): queued by `NotificationWriter` for each new notification (envelope with the
//   organisation, payload `{notificationIds}`), and swept every 5 minutes by the cron schedule of WP-22 with
//   `orgId: null`. The handler is declared with installation scope so the worker accepts the envelope without an
//   organisation; it does its work per organisation inside `withTenant(org, SYSTEM_USER)`. A run for named rows
//   fails when one of them could not be sent and may be tried again, so the queue retries it with backoff.
// - `notifications.digest` (07:00 local, retries 3): one email per user with the previous day's digest rows.
// - `documents.review-alerts` (06:30 local, retries 3): the tiered review alerts of PRD 9.1.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { DocumentReviewAlertsService } from './document-review-alerts.service';
import { NotificationDeliveryService } from './notification-delivery.service';

@Injectable()
@JobHandler('notifications.dispatch', { concurrency: 2, scope: 'installation' })
export class NotificationDispatchJob implements JobHandlerInstance<'notifications.dispatch'> {
  private readonly logger = new Logger('notifications.dispatch');

  constructor(private readonly delivery: NotificationDeliveryService) {}

  async handle(job: JobRun<'notifications.dispatch'>): Promise<void> {
    const ids = job.env.payload?.notificationIds;
    const counts = await this.delivery.dispatch(job.env.orgId, ids, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...counts }, 'notifications.dispatch done');
    if (ids && ids.length > 0 && counts.retrying > 0) {
      throw new Error(`${counts.retrying} notification email(s) could not be sent; they stay pending for another attempt`);
    }
  }
}

@Injectable()
@JobHandler('notifications.digest', { concurrency: 1, scope: 'tenant' })
export class NotificationDigestJob implements JobHandlerInstance<'notifications.digest'> {
  private readonly logger = new Logger('notifications.digest');

  constructor(private readonly delivery: NotificationDeliveryService) {}

  async handle(job: JobRun<'notifications.digest'>): Promise<void> {
    if (!job.env.orgId) throw new Error('notifications.digest needs the organisation of the job envelope');
    const counts = await this.delivery.digest(job.env.orgId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...counts }, 'notifications.digest done');
    if (counts.retrying > 0) throw new Error(`${counts.retrying} digest notification(s) could not be sent; they stay pending for another attempt`);
  }
}

@Injectable()
@JobHandler('documents.review-alerts', { concurrency: 1, scope: 'tenant' })
export class DocumentReviewAlertsJob implements JobHandlerInstance<'documents.review-alerts'> {
  private readonly logger = new Logger('documents.review-alerts');

  constructor(
    private readonly delivery: NotificationDeliveryService,
    private readonly alerts: DocumentReviewAlertsService,
  ) {}

  async handle(job: JobRun<'documents.review-alerts'>): Promise<void> {
    if (!job.env.orgId) throw new Error('documents.review-alerts needs the organisation of the job envelope');
    const org = await this.delivery.organisation(job.env.orgId);
    if (!org) return;
    const result = await this.alerts.run(org, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: org.id, attempt: job.attempt, ...result }, 'documents.review-alerts done');
  }
}
