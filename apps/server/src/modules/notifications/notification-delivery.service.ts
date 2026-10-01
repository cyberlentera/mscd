// Email delivery of in-app notifications (build plan E.6, E.2 `notifications.dispatch` and `notifications.digest`).
//
// - `dispatch`: pending notifications that are not digest-only, one email each, in the recipient's language
//   (`lang` preference, default English). A sent row becomes `email_status = 'sent'`; a failed send increments
//   `email_attempts` and keeps `last_error`; the fifth failure makes it `failed`. Rows of recipients who are no longer
//   active members (or have no address) become `skipped`. Each row is locked (`FOR UPDATE SKIP LOCKED`) while it is
//   sent, so two dispatch runs never send the same row twice.
// - `digest`: per recipient, one email with every pending digest notification created before the start of the
//   current local day of the organisation (the previous day's, and any older one a failed digest left behind).
//
// Both run per organisation inside `withTenant(org, SYSTEM_USER)`; the in-app delivery is the row itself.
import { Injectable, Logger } from '@nestjs/common';
import { RecordRef, type NotificationKind } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { localDate, startOfLocalDay } from '../../common/dates';
import type { TenantInfo, Trx } from '../../common/tokens';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { renderDigestMail, renderNotificationMail, type MailLanguage, type MailNotification } from './notification-mail';
import { NotificationMailer } from './notification-mailer';

/** Attempts before a notification email is given up (E.6). */
export const MAX_EMAIL_ATTEMPTS = 5;
/** Rows one dispatch run reads per organisation; the 5 minute sweep picks up the rest. */
const DISPATCH_BATCH = 500;

export interface DeliveryCounts {
  sent: number;
  failed: number;
  skipped: number;
  /** Rows whose send failed but that stay pending for another attempt. */
  retrying: number;
}

export interface Recipient {
  userId: string;
  email: string | null;
  language: MailLanguage;
  /** Active account with an active membership in the organisation and an address. */
  deliverable: boolean;
}

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  recipient_user_id: string;
  title_en: string;
  title_id: string;
  body_en: string;
  body_id: string;
  entity_ref: unknown;
  email_attempts: number;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function emptyCounts(): DeliveryCounts {
  return { sent: 0, failed: 0, skipped: 0, retrying: 0 };
}

function addCounts(into: DeliveryCounts, more: DeliveryCounts): void {
  into.sent += more.sent;
  into.failed += more.failed;
  into.skipped += more.skipped;
  into.retrying += more.retrying;
}

/** The recipient of a notification: address, language preference and whether mail may go out (E.6). */
export async function recipientOf(trx: Trx, orgId: string, userId: string): Promise<Recipient> {
  const { rows } = await sql<{ email: string | null; user_ok: boolean; member_ok: boolean; lang: unknown }>`
    select u.email,
           (u.status = 'active' and u.deleted_at is null) as user_ok,
           exists (select 1 from platform.org_membership m
                    where m.user_id = u.id and m.organization_id = ${orgId}::uuid and m.status = 'active' and m.deleted_at is null) as member_ok,
           (select p.value from platform.user_preference p where p.user_id = u.id and p.key = 'lang') as lang
    from platform.app_user u where u.id = ${userId}::uuid`.execute(trx);
  const row = rows[0];
  const email = row?.email && row.email.includes('@') ? row.email : null;
  return {
    userId,
    email,
    language: row?.lang === 'id' ? 'id' : 'en',
    deliverable: Boolean(row && row.user_ok && row.member_ok && email),
  };
}

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger('notifications');

  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly mailer: NotificationMailer,
  ) {}

  /** The link of a notification email: the download of a ready export, else the app. */
  linkOf(kind: NotificationKind, ref: unknown): string {
    const parsed = RecordRef.safeParse(ref);
    if (kind === 'export_ready' && parsed.success && parsed.data.entityType === 'background_task') {
      return this.mailer.appLink(`/api/v1/exports/${parsed.data.id}/download`);
    }
    return this.mailer.appLink('/');
  }

  /** Active organisations (the sweep without an organisation in the job envelope). */
  async activeOrganisations(): Promise<TenantInfo[]> {
    // Read-only list of organisation ids (`platform.organization` has no RLS) for the installation-wide sweep that
    // WP-22 schedules with `orgId: null`; every row is then handled inside `withTenant`. Follow-up in the WP-24
    // handoff: a `TenantResolver` listing (tenancy module) would remove the need for platform scope here.
    // eslint-disable-next-line no-restricted-syntax
    const rows = await this.scope.withPlatform(
      (trx) => trx.selectFrom('platform.organization').select('id').where('status', '=', 'active').where('deleted_at', 'is', null).orderBy('position').orderBy('slug').execute(),
      { scope: 'job' },
    );
    const out: TenantInfo[] = [];
    for (const row of rows) {
      const org = await this.tenants.resolveById(row.id);
      if (org && org.status === 'active') out.push(org);
    }
    return out;
  }

  /** The organisation of a tenant run, or null when it is gone or not active. */
  async organisation(orgId: string): Promise<TenantInfo | null> {
    const org = await this.tenants.resolveById(orgId);
    return org && org.status === 'active' ? org : null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // notifications.dispatch
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Sends pending non-digest notifications: those named, or every pending one of the organisation, or (without an
   * organisation) of every active organisation.
   */
  async dispatch(orgId: string | null, notificationIds?: readonly string[], requestId?: string): Promise<DeliveryCounts> {
    const orgs = orgId ? [await this.organisation(orgId)].filter((o): o is TenantInfo => o !== null) : await this.activeOrganisations();
    const total = emptyCounts();
    for (const org of orgs) addCounts(total, await this.dispatchOrg(org, notificationIds, requestId));
    return total;
  }

  private async dispatchOrg(org: TenantInfo, notificationIds: readonly string[] | undefined, requestId?: string): Promise<DeliveryCounts> {
    const context = systemContextOf(org, requestId);
    const ids = await this.scope.withTenant(context, async (trx) => {
      let query = trx
        .selectFrom('notification')
        .select('id')
        .where('email_status', '=', 'pending')
        .where('digest', '=', false)
        .where('deleted_at', 'is', null)
        .where('email_attempts', '<', MAX_EMAIL_ATTEMPTS);
      if (notificationIds) {
        if (notificationIds.length === 0) return [];
        query = query.where('id', 'in', [...notificationIds]);
      }
      const rows = await query.orderBy('created_at').orderBy('id').limit(DISPATCH_BATCH).execute();
      return rows.map((r) => r.id);
    });
    const counts = emptyCounts();
    for (const id of ids) {
      const outcome = await this.scope.withTenant(context, (trx) => this.sendOne(trx, org, id));
      if (outcome) counts[outcome] += 1;
    }
    if (ids.length > 0) this.logger.log({ orgId: org.id, ...counts }, 'notifications.dispatch');
    return counts;
  }

  /** Sends one locked pending row; null when another run holds it or it is no longer pending. */
  private async sendOne(trx: Trx, org: TenantInfo, id: string): Promise<keyof DeliveryCounts | null> {
    const row = (await trx
      .selectFrom('notification')
      .select(['id', 'kind', 'recipient_user_id', 'title_en', 'title_id', 'body_en', 'body_id', 'entity_ref', 'email_attempts'])
      .where('id', '=', id)
      .where('email_status', '=', 'pending')
      .where('digest', '=', false)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst()) as NotificationRow | undefined;
    if (!row) return null;
    const recipient = await recipientOf(trx, org.id, row.recipient_user_id);
    if (!recipient.deliverable || !recipient.email) {
      await trx.updateTable('notification').set({ email_status: 'skipped', updated_at: this.clock.now() }).where('id', '=', row.id).execute();
      return 'skipped';
    }
    const mail = renderNotificationMail(this.texts(row), recipient.language, this.linkOf(row.kind, row.entity_ref));
    try {
      await this.mailer.send(recipient.email, mail, row.kind);
      await trx
        .updateTable('notification')
        .set({ email_status: 'sent', email_sent_at: this.clock.now(), email_attempts: row.email_attempts + 1, last_error: null, updated_at: this.clock.now() })
        .where('id', '=', row.id)
        .execute();
      return 'sent';
    } catch (error) {
      const attempts = row.email_attempts + 1;
      const failed = attempts >= MAX_EMAIL_ATTEMPTS;
      await trx
        .updateTable('notification')
        .set({ email_status: failed ? 'failed' : 'pending', email_attempts: attempts, last_error: errorText(error), updated_at: this.clock.now() })
        .where('id', '=', row.id)
        .execute();
      this.logger.warn({ orgId: org.id, notificationId: row.id, attempts }, `Notification email not sent: ${errorText(error)}`);
      return failed ? 'failed' : 'retrying';
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // notifications.digest
  // -------------------------------------------------------------------------------------------------------------

  /** One email per recipient with the pending digest notifications created before today (local time). */
  async digest(orgId: string, requestId?: string): Promise<DeliveryCounts & { recipients: number }> {
    const org = await this.organisation(orgId);
    const counts = { ...emptyCounts(), recipients: 0 };
    if (!org) return counts;
    const context = systemContextOf(org, requestId);
    // created_at is the database time of the insert: the cut-off is the start of the real local day, so a fixed
    // demo date (D-07) does not hold back recent rows.
    const cutoff = startOfLocalDay(localDate(this.clock.now(), org.timeZone), org.timeZone);
    const recipients = await this.scope.withTenant(context, async (trx) => {
      const rows = await trx
        .selectFrom('notification')
        .select('recipient_user_id')
        .distinct()
        .where('email_status', '=', 'pending')
        .where('digest', '=', true)
        .where('deleted_at', 'is', null)
        .where('email_attempts', '<', MAX_EMAIL_ATTEMPTS)
        .where('created_at', '<', cutoff)
        .orderBy('recipient_user_id')
        .execute();
      return rows.map((r) => r.recipient_user_id);
    });
    for (const userId of recipients) {
      const outcome = await this.scope.withTenant(context, (trx) => this.digestOne(trx, org, userId, cutoff));
      if (!outcome) continue;
      counts.recipients += 1;
      counts[outcome.outcome] += outcome.rows;
    }
    if (recipients.length > 0) this.logger.log({ orgId: org.id, ...counts }, 'notifications.digest');
    return counts;
  }

  private async digestOne(trx: Trx, org: TenantInfo, userId: string, cutoff: Date): Promise<{ outcome: keyof DeliveryCounts; rows: number } | null> {
    const rows = (await trx
      .selectFrom('notification')
      .select(['id', 'kind', 'recipient_user_id', 'title_en', 'title_id', 'body_en', 'body_id', 'entity_ref', 'email_attempts'])
      .where('recipient_user_id', '=', userId)
      .where('email_status', '=', 'pending')
      .where('digest', '=', true)
      .where('deleted_at', 'is', null)
      .where('email_attempts', '<', MAX_EMAIL_ATTEMPTS)
      .where('created_at', '<', cutoff)
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .skipLocked()
      .execute()) as NotificationRow[];
    if (rows.length === 0) return null;
    const ids = rows.map((r) => r.id);
    const now = this.clock.now();
    const recipient = await recipientOf(trx, org.id, userId);
    if (!recipient.deliverable || !recipient.email) {
      await trx.updateTable('notification').set({ email_status: 'skipped', updated_at: now }).where('id', 'in', ids).execute();
      return { outcome: 'skipped', rows: rows.length };
    }
    const mail = renderDigestMail(rows.map((r) => this.texts(r)), recipient.language, this.mailer.appLink('/'));
    try {
      await this.mailer.send(recipient.email, mail, 'digest');
      await trx
        .updateTable('notification')
        .set({ email_status: 'sent', email_sent_at: now, email_attempts: sql<number>`email_attempts + 1`, last_error: null, updated_at: now })
        .where('id', 'in', ids)
        .execute();
      return { outcome: 'sent', rows: rows.length };
    } catch (error) {
      const message = errorText(error);
      await trx
        .updateTable('notification')
        .set({
          email_attempts: sql<number>`email_attempts + 1`,
          email_status: sql<'pending' | 'failed'>`case when email_attempts + 1 >= ${MAX_EMAIL_ATTEMPTS} then 'failed' else 'pending' end`,
          last_error: message,
          updated_at: now,
        })
        .where('id', 'in', ids)
        .execute();
      this.logger.warn({ orgId: org.id, userId, rows: rows.length }, `Digest email not sent: ${message}`);
      const exhausted = rows.every((r) => r.email_attempts + 1 >= MAX_EMAIL_ATTEMPTS);
      return { outcome: exhausted ? 'failed' : 'retrying', rows: rows.length };
    }
  }

  private texts(row: NotificationRow): MailNotification {
    return { title: { en: row.title_en, id: row.title_id }, body: { en: row.body_en, id: row.body_id } };
  }
}
