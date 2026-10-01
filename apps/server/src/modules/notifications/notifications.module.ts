import { Module } from '@nestjs/common';
import { DocumentReviewAlertsService } from './document-review-alerts.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationMailer } from './notification-mailer';
import { DocumentReviewAlertsJob, NotificationDigestJob, NotificationDispatchJob } from './notification.jobs';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * In-app notifications, email dispatch and digests (E.6, WP-24): `GET /notifications`, `POST /notifications/{id}/read`,
 * and the job handlers `notifications.dispatch`, `notifications.digest` and `documents.review-alerts` (discovered by the
 * worker). Notifications themselves are written by the global `NOTIFICATION_WRITER` of WP-08.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationMailer,
    NotificationDeliveryService,
    DocumentReviewAlertsService,
    NotificationDispatchJob,
    NotificationDigestJob,
    DocumentReviewAlertsJob,
  ],
  exports: [NotificationsService, NotificationDeliveryService, DocumentReviewAlertsService],
})
export class NotificationsModule {}
