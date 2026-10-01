// `documents.review-alerts` (build plan E.2, E.6, PRD 9.1): tiered alerts before the review date of a document.
// Every approved document whose `next_review_at` is 60, 30, 14 or 7 days after today (the organisation's local date,
// D-07) gets a `document_review_due` notification to its owner: digest for 60 and 30 days, sent at once for 14 and
// 7. Idempotent: the notification of one document, tier and review date is written once (a second run on the same
// day, or a retry, finds it). Owners who are no longer active members get nothing (E.6).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays, fmtDay } from '../../common/dates';
import { NOTIFICATION_WRITER, SYSTEM_USER_ID, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';

/** Days before the review date that raise an alert, and whether that tier goes to the digest (E.6). */
export const REVIEW_ALERT_TIERS: readonly { days: number; digest: boolean }[] = [
  { days: 60, digest: true },
  { days: 30, digest: true },
  { days: 14, digest: false },
  { days: 7, digest: false },
];

export interface ReviewAlertResult {
  today: string;
  /** Documents due in one of the tiers. */
  due: number;
  /** Notifications written by this run. */
  notified: number;
}

/** The English title of an alert: names the tier and the review date, so one alert exists per tier and date. */
export function reviewAlertTitle(code: string, days: number, reviewAt: string): { en: string; id: string } {
  return {
    en: `Review of ${code} due in ${days} days (${fmtDay(reviewAt, 'en')})`,
    id: `Tinjauan ${code} jatuh tempo dalam ${days} hari (${fmtDay(reviewAt, 'id')})`,
  };
}

@Injectable()
export class DocumentReviewAlertsService {
  private readonly logger = new Logger('documents.review-alerts');

  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async run(org: TenantInfo, requestId?: string): Promise<ReviewAlertResult> {
    const today = await this.clock.today(org.id);
    const result = await this.scope.withTenant(systemContextOf(org, requestId), (trx) => this.alert(trx, today));
    this.logger.log({ orgId: org.id, ...result }, 'documents.review-alerts done');
    return result;
  }

  private async alert(trx: Trx, today: string): Promise<ReviewAlertResult> {
    const dates = REVIEW_ALERT_TIERS.map((t) => addDays(today, t.days));
    const docs = await trx
      .selectFrom('document as d')
      .select([
        'd.id',
        'd.doc_code',
        'd.title',
        'd.owner_user_id',
        'd.next_review_at',
        sql<string[]>`coalesce((select array_agg(l.management_system_id order by l.is_primary desc, l.created_at)
                                  from entity_ms_link l
                                 where l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null), '{}')`.as('ms_ids'),
      ])
      .where('d.deleted_at', 'is', null)
      .where('d.status', '=', 'approved')
      .where('d.next_review_at', 'in', dates)
      .orderBy('d.next_review_at')
      .orderBy('d.doc_code')
      .execute();
    let notified = 0;
    for (const doc of docs) {
      const reviewAt = doc.next_review_at;
      if (!reviewAt || !doc.owner_user_id) continue;
      const tier = REVIEW_ALERT_TIERS.find((t) => addDays(today, t.days) === reviewAt);
      if (!tier) continue;
      const title = reviewAlertTitle(doc.doc_code, tier.days, reviewAt);
      const existing = await trx
        .selectFrom('notification')
        .select('id')
        .where('kind', '=', 'document_review_due')
        .where('recipient_user_id', '=', doc.owner_user_id)
        .where(sql<string>`entity_ref->>'id'`, '=', doc.id)
        .where('title_en', '=', title.en)
        .limit(1)
        .executeTakeFirst();
      if (existing) continue;
      const created = await this.notifications.create(trx, {
        recipientUserId: doc.owner_user_id,
        kind: 'document_review_due',
        msId: doc.ms_ids[0] ?? null,
        title,
        body: {
          en: `${doc.title} (${doc.doc_code}) is due for review on ${fmtDay(reviewAt, 'en')}, in ${tier.days} days. Start the review so the document stays approved.`,
          id: `${doc.title} (${doc.doc_code}) harus ditinjau pada ${fmtDay(reviewAt, 'id')}, dalam ${tier.days} hari. Mulai tinjauan agar dokumen tetap disetujui.`,
        },
        ref: { module: 'implementation', entityType: 'document', id: doc.id, code: doc.doc_code },
        digest: tier.digest,
        createdBy: SYSTEM_USER_ID,
      });
      if (created) notified += 1;
    }
    return { today, due: docs.length, notified };
  }
}
