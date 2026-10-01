// Reminders of D.3 and E.5 (WP-35): one reminder about one record to one member, and reminders to every holder of
// an open chain item of a system. Records are resolved through `RecordResolver` in the body's system (F.7: a record
// of another system is 404), recipients through `MembershipService`; BR-50 holds a second reminder to the same
// person about the same record key within 72 hours. Each reminder writes a `reminder` row, an in-app `notification`
// (kind `reminder`) whose email `notifications.dispatch` sends after commit, and an audit entry, in one transaction.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { BulkReminderRequest, BulkReminderResult, CommandResult, Pair, RecordRef, ReminderRequest, UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fmtDay } from '../../common/dates';
import { NotFoundError, NotAMemberError, ProblemError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, NOTIFICATION_WRITER, RECORD_RESOLVER, type AuditWriter, type MembershipService, type NotificationWriter,
  type Principal, type RecordResolver, type TenantInfo, type Trx,
} from '../../common/tokens';
import { ReadModelService } from '../read-model';
import { businessCodeOf, refOf } from '../registers';
import { RuleEngine, ruleMessageKey } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { REMINDER_THROTTLE_MS, type Br50Input } from './reminder.rules';

/** What a reminder says about its record: the chain item's action and title, and its due date. */
interface ItemInfo {
  key: string;
  ref: RecordRef;
  title: Pair;
  act: Pair;
  due: string | null;
}

const FOLLOW_UP: Pair = ['Follow up', 'Tindak lanjut'];

/** Record key kind of an entity type when the snapshot has no ref for the record. */
const KIND_OF: Readonly<Record<string, string>> = {
  applicability_entry: 'req',
  document: 'doc',
  evidence: 'ev',
  implementation_activity_progress: 'act',
  audit_prep_task: 'prep',
  cycle_requirement_status: 'cycle',
  drift_result: 'drift',
};

/** "Reminder: <action> for <title>, due <date>" (E.5) in both languages. */
function reminderText(item: Pick<ItemInfo, 'title' | 'act' | 'due'>): { en: string; id: string } {
  const due = (lang: 'en' | 'id') => (item.due ? (lang === 'en' ? `, due ${fmtDay(item.due, 'en')}` : `, tenggat ${fmtDay(item.due, 'id')}`) : '');
  return {
    en: `Reminder: ${item.act[0]} for ${item.title[0]}${due('en')}`,
    id: `Pengingat: ${item.act[1]} untuk ${item.title[1]}${due('id')}`,
  };
}

@Injectable()
export class RemindersService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    private readonly readModel: ReadModelService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /reminders
  // -------------------------------------------------------------------------------------------------------------

  async send(principal: Principal, body: ReminderRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, body.ms);
      const snapshot = await this.readModel.systemSnapshotIn(trx, org, body.ms);
      const item = await this.itemOf(trx, body, snapshot);
      const recipient = await this.members.resolveHandle(trx, body.recipient);
      if (!recipient) throw new NotAMemberError(body.recipient);
      const now = this.clock.now();

      // BR-50: one reminder per person and record key in 72 hours.
      const last = await this.lastSent(trx, recipient, item.key, now);
      const [finding] = await this.rules.evaluate<Br50Input>(trx, 'BR-50', { lastSentAt: last, now, timeZone: org.timeZone }, { msIds: [system.id], ref: item.ref });
      if (finding) {
        const data = finding.data as { retryAfter: number };
        throw new ProblemError('business-rule', {
          rule: 'BR-50',
          messageKey: ruleMessageKey('BR-50'),
          messages: finding.messages,
          detail: finding.messages.en,
          retryAfter: data.retryAfter,
          ref: item.ref,
        });
      }

      // `reminder` is insert-only for the api role (C.4), so the notification is created first and referenced.
      const notificationId = await this.notifications.create(trx, {
        recipientUserId: recipient,
        kind: 'reminder',
        title: { en: `Reminder: ${item.title[0]}`, id: `Pengingat: ${item.title[1]}` },
        body: reminderText(item),
        msId: system.id,
        ref: item.ref,
      });
      await sql`insert into reminder (management_system_id, record_key, entity_type, entity_id, recipient_user_id, sent_by_user_id, sent_at,
                                      notification_id, created_by)
                values (${system.id}, ${item.key}, ${item.ref.entityType}, ${item.ref.id}, ${recipient}, ${actor}, ${now}, ${notificationId}, ${actor})`.execute(trx);
      await this.audit.record(trx, {
        action: 'reminder.sent',
        msId: system.id,
        entityType: item.ref.entityType,
        entityId: item.ref.id,
        entityCode: item.ref.code,
        after: { recipient: body.recipient, record_key: item.key },
      });
      const name = await this.displayName(trx, recipient);
      return { ok: true, changed: [], count: 1, message: [`Reminder sent to ${name}, email + in-app`, `Pengingat dikirim ke ${name}, email + dalam aplikasi`] };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /reminders/bulk
  // -------------------------------------------------------------------------------------------------------------

  async bulk(principal: Principal, body: BulkReminderRequest): Promise<BulkReminderResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, body.ms);
      const snapshot = await this.readModel.systemSnapshotIn(trx, org, body.ms);
      const now = this.clock.now();
      const bulkId = randomUUID();
      // Open chain items by holder (Unassigned items have nobody to remind).
      const byHolder = new Map<string, ItemInfo[]>();
      for (const i of snapshot.bundle.chain.items) {
        if (i.h === 'none') continue;
        const ref = snapshot.refs[i.key];
        if (!ref) continue;
        const list = byHolder.get(i.h) ?? [];
        list.push({ key: i.key, ref, title: i.title, act: i.act, due: i.due });
        byHolder.set(i.h, list);
      }
      const skipped: BulkReminderResult['data']['skipped'] = [];
      let holders = 0;
      let sent = 0;
      for (const [handle, items] of byHolder) {
        let recipient: string | null;
        try {
          recipient = await this.members.resolveHandle(trx, handle);
        } catch (error) {
          if (error instanceof NotAMemberError) continue;
          throw error;
        }
        if (!recipient) continue;
        const reminded: ItemInfo[] = [];
        for (const item of items) {
          const last = await this.lastSent(trx, recipient, item.key, now);
          if (last && now.getTime() - last.getTime() < REMINDER_THROTTLE_MS && (await this.rules.isActive(trx, 'BR-50', system.id))) {
            skipped.push({ recipient: handle, recordKey: item.key, lastSentAt: last.toISOString() });
            continue;
          }
          reminded.push(item);
        }
        if (reminded.length === 0) continue;
        holders += 1;
        sent += reminded.length;
        const lines = reminded.slice(0, 10).map(reminderText);
        const more = reminded.length > 10 ? reminded.length - 10 : 0;
        const notificationId = await this.notifications.create(trx, {
          recipientUserId: recipient,
          kind: 'reminder',
          title: {
            en: `Reminder: ${reminded.length} open item${reminded.length === 1 ? '' : 's'} in ${system.slug.toUpperCase()}`,
            id: `Pengingat: ${reminded.length} item terbuka di ${system.slug.toUpperCase()}`,
          },
          body: {
            en: [...lines.map((l) => l.en), ...(more ? [`and ${more} more`] : [])].join('\n'),
            id: [...lines.map((l) => l.id), ...(more ? [`dan ${more} lainnya`] : [])].join('\n'),
          },
          msId: system.id,
          ...(reminded.length === 1 ? { ref: reminded[0]!.ref } : {}),
        });
        for (const item of reminded) {
          await sql`insert into reminder (management_system_id, record_key, entity_type, entity_id, recipient_user_id, sent_by_user_id, sent_at, bulk_id,
                                          notification_id, created_by)
                    values (${system.id}, ${item.key}, ${item.ref.entityType}, ${item.ref.id}, ${recipient}, ${actor}, ${now}, ${bulkId}, ${notificationId},
                            ${actor})`.execute(trx);
        }
      }
      await this.audit.record(trx, {
        action: 'reminder.sent',
        msId: system.id,
        entityType: 'management_system',
        entityId: system.id,
        entityCode: system.slug,
        after: { bulk: true, scope: body.scope, holders, reminders: sent, skipped: skipped.length },
      });
      return {
        ok: true,
        changed: [],
        count: holders,
        message: [`Reminders sent to ${holders} holders`, `Pengingat dikirim ke ${holders} pemegang`],
        data: { skipped },
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** The record a reminder names, with what the chain says about it; 404 for a record outside the body's system. */
  private async itemOf(trx: Trx, body: ReminderRequest, snapshot: UiMsSnapshot): Promise<ItemInfo> {
    let key: string;
    let ref: RecordRef;
    if ('recordKey' in body) {
      key = body.recordKey;
      const known = key.startsWith(`${body.ms}:`) ? snapshot.refs[key] : undefined;
      if (!known) throw new NotFoundError();
      // The ref of the snapshot is resolved again through the record resolver (F.7).
      await this.records.resolve(trx, body.ms, known.entityType, known.id);
      ref = known;
    } else {
      const record = await this.records.resolve(trx, body.ms, body.ref.entityType, body.ref.id);
      const found = Object.entries(snapshot.refs).find(([, r]) => r.id === record.id && r.entityType === record.entityType);
      if (found) {
        [key, ref] = found;
      } else {
        // A record without a snapshot key (for example a preparation task of a later audit event): the code and the
        // ref come from the resolved row and the BR-50 key from its entity type and id, never from the request.
        const code = await businessCodeOf(trx, record);
        key = `${body.ms}:${KIND_OF[record.entityType] ?? record.entityType}:${record.id}`;
        ref = refOf(record.entityType, record.id, code, record.row.updated_at as Date);
      }
    }
    const chained = snapshot.bundle.chain.items.find((i) => i.key === key);
    if (chained) return { key, ref, title: chained.title, act: chained.act, due: chained.due };
    return { key, ref, ...this.describe(snapshot, key, ref) };
  }

  /** Title, action and due date of a record that has no open chain item (an activity, a task, a closed item). */
  private describe(snapshot: UiMsSnapshot, key: string, ref: RecordRef): { title: Pair; act: Pair; due: string | null } {
    const [, kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const b = snapshot.bundle;
    if (kind === 'req') {
      const r = b.reqs.find((x) => x.id === id);
      if (r) return { title: [r.title, r.title], act: FOLLOW_UP, due: null };
    } else if (kind === 'doc') {
      const d = b.docs.find((x) => x.id === id);
      if (d) return { title: [d.title, d.title], act: ['Review', 'Tinjau'], due: d.rev || null };
    } else if (kind === 'ev') {
      const e = b.evs.find((x) => x.code === id);
      if (e) return { title: [e.title, e.title], act: ['Submit evidence', 'Serahkan bukti'], due: e.next };
    } else if (kind === 'act') {
      const a = b.phases.flatMap((p) => p.acts).find((x) => x.no === id);
      if (a) return { title: [`${a.no} ${a.title}`, `${a.no} ${a.title}`], act: FOLLOW_UP, due: a.date };
    }
    return { title: [ref.code, ref.code], act: FOLLOW_UP, due: null };
  }

  /** The last reminder to the recipient about the record key within the BR-50 window, or null. */
  private async lastSent(trx: Trx, recipient: string, key: string, now: Date): Promise<Date | null> {
    const { rows } = await sql<{ sent_at: Date }>`
      select sent_at from reminder where recipient_user_id = ${recipient} and record_key = ${key}
         and sent_at > ${new Date(now.getTime() - REMINDER_THROTTLE_MS)} order by sent_at desc limit 1`.execute(trx);
    return rows[0] ? new Date(rows[0].sent_at) : null;
  }

  private async displayName(trx: Trx, userId: string): Promise<string> {
    const { rows } = await sql<{ display_name: string }>`select display_name from platform.app_user where id = ${userId}`.execute(trx);
    return rows[0]?.display_name ?? '';
  }
}

function orgOf(principal: Principal): TenantInfo {
  if (!principal.org) throw new NotFoundError('No organisation is selected');
  return principal.org;
}
