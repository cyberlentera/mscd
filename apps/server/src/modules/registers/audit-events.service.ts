// Audit event, preparation task and cycle item commands of D.3 (WP-35, TS 6.7 and 6.8, C.13, A-23, A-26): plan and
// change an audit event (moving its date recomputes the After audit flags and the BR-43 flags of its preparation
// tasks and notifies the holders whose items now fall after the audit, BR-42), add and update preparation tasks
// (due before the audit, BR-43; status per C.13, blocked needs a note) and update cycle items (status per C.13).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditEventCreateRequest, type AuditEventPatch, type CommandResult, type CycleItemPatch, type MachineEntity, type Permission,
  type PrepTaskCreate, type PrepTaskPatch, type RecordRef, type UiMsSnapshot,
} from '@mscd/shared';
import { sql } from 'kysely';
import { assertIfMatch } from '../../common/etag';
import { NotFoundError, ProblemError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, NOTIFICATION_WRITER, RECORD_RESOLVER, type AuditWriter, type AuthzState, type MembershipService, type MsRef,
  type NotificationWriter, type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import { ReadModelService } from '../read-model';
import { RuleEngine, ruleMessages } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  assertOwnScope, assertRequires, commandResult, isBr43TriggerError, orgOf, personOf, pickTransition, refOf, writeRow,
} from './command-support';
import type { Br42Input, Br43Input } from './register.rules';

const EVENT = 'audit_event';
const PREP = 'audit_prep_task';
const CYCLE = 'cycle_requirement_status';

interface EventRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  event_type: string;
  name_en: string;
  name_id: string;
  short_label: string;
  scheduled_at: string;
  audit_days: number | null;
  lead_auditor_name: string | null;
  expected_focus: string | null;
  prep_window_days: number;
  outcome: string | null;
  outcome_summary: string | null;
}

/** Request members of `AuditEventPatch` and their columns. */
const EVENT_FIELDS: readonly [keyof AuditEventPatch, keyof EventRow][] = [
  ['eventType', 'event_type'],
  ['nameEn', 'name_en'],
  ['nameId', 'name_id'],
  ['shortLabel', 'short_label'],
  ['scheduledAt', 'scheduled_at'],
  ['auditDays', 'audit_days'],
  ['leadAuditorName', 'lead_auditor_name'],
  ['expectedFocus', 'expected_focus'],
  ['prepWindowDays', 'prep_window_days'],
  ['outcome', 'outcome'],
  ['outcomeSummary', 'outcome_summary'],
];

/** A preparation task or cycle item as the progress commands read it. */
interface ProgressRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  title: string;
  owner_user_id: string | null;
  due_at: string;
  status: string;
  note?: string | null;
  condition_note?: string | null;
  audit_event_id?: string;
  requirement_code?: string;
}

/** How one progress table is patched (preparation tasks and cycle items share the C.13 machine shape). */
interface ProgressKind {
  table: typeof PREP | typeof CYCLE;
  machine: MachineEntity;
  permission: Permission;
  noteColumn: 'note' | 'condition_note';
  action: 'prep_task.updated' | 'cycle_item.updated';
}

const PROGRESS: Readonly<Record<'prep' | 'cycle', ProgressKind>> = {
  prep: { table: PREP, machine: 'audit_prep_task.status', permission: 'prep_task.update', noteColumn: 'note', action: 'prep_task.updated' },
  cycle: { table: CYCLE, machine: 'cycle_requirement_status.status', permission: 'cycle_item.update', noteColumn: 'condition_note', action: 'cycle_item.updated' },
};

function br43Problem(): ProblemError {
  const messages = ruleMessages('BR-43');
  return new ProblemError('business-rule', { rule: 'BR-43', messages, detail: messages.en, messageKey: 'rule.BR-43' });
}

@Injectable()
export class AuditEventCommandsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly rules: RuleEngine,
    private readonly readModel: ReadModelService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/audit-events
  // -------------------------------------------------------------------------------------------------------------

  async createEvent(principal: Principal, ms: string, body: AuditEventCreateRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const cycle = await sql<{ id: string }>`
        select id from certification_cycle where management_system_id = ${system.id} and deleted_at is null
         order by (status in ('active', 'planned', 'certified')) desc, cycle_start desc limit 1`.execute(trx);
      const id = randomUUID();
      const { rows } = await sql<{ updated_at: Date }>`
        insert into audit_event (id, management_system_id, certification_cycle_id, event_type, name_en, name_id, short_label, scheduled_at,
                                 audit_days, lead_auditor_name, expected_focus, prep_window_days, created_by, updated_by)
        values (${id}, ${system.id}, ${cycle.rows[0]?.id ?? null}, ${body.eventType}, ${body.nameEn}, ${body.nameId}, ${body.shortLabel},
                ${body.scheduledAt}::date, ${body.auditDays ?? null}, ${body.leadAuditorName ?? null}, ${body.expectedFocus ?? null},
                ${body.prepWindowDays ?? 60}, ${actor}, ${actor})
        returning updated_at`.execute(trx);
      // Audit events are shareable (C.6): the path system holds the primary link.
      await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
                values ('audit_event', ${id}, ${system.id}, true, ${actor}, ${actor})`.execute(trx);
      await this.audit.record(trx, {
        action: 'audit_event.created',
        msId: system.id,
        entityType: EVENT,
        entityId: id,
        entityCode: body.shortLabel,
        after: {
          event_type: body.eventType,
          name_en: body.nameEn,
          scheduled_at: body.scheduledAt,
          ...(body.auditDays !== undefined ? { audit_days: body.auditDays } : {}),
          prep_window_days: body.prepWindowDays ?? 60,
        },
      });
      return commandResult([system.slug], { ref: refOf(EVENT, id, body.shortLabel, rows[0]!.updated_at) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/audit-events/{id}
  // -------------------------------------------------------------------------------------------------------------

  async updateEvent(principal: Principal, ms: string, id: string, patch: AuditEventPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const event = await this.event(trx, system, id);
      const currentRef = refOf(EVENT, id, event.short_label, event.updated_at);
      assertIfMatch(ifMatch, event.updated_at, currentRef);
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [member, column] of EVENT_FIELDS) {
        const value = patch[member];
        if (value === undefined || (event[column] ?? null) === (value ?? null)) continue;
        set[column] = value;
        before[column] = event[column] ?? null;
        after[column] = value;
      }
      if (set.prep_window_days === null) set.prep_window_days = 60;
      const dateMoved = set.scheduled_at !== undefined;
      // BR-42 needs the After audit flags before the change.
      const flagsBefore = dateMoved ? afterFlags(await this.readModel.systemSnapshotIn(trx, org, ms)) : null;
      const updatedAt = await writeRow(trx, EVENT, id, set, actor);
      let notified = 0;
      if (dateMoved) {
        const newDate = set.scheduled_at as string;
        // A-26: preparation tasks now on or after the audit are flagged, never rejected.
        const { rows: flagged } = await sql<{ owner_user_id: string | null; was: boolean; now: boolean }>`
          update audit_prep_task p set violates_br43 = (p.due_at >= ${newDate}::date)
            from (select id, violates_br43 as was from audit_prep_task where audit_event_id = ${id} and deleted_at is null) old
           where p.id = old.id
          returning p.owner_user_id, old.was, p.violates_br43 as now`.execute(trx);
        const flagsAfter = afterFlags(await this.readModel.systemSnapshotIn(trx, org, ms));
        const counts = new Map<string, number>();
        for (const [key, item] of flagsAfter) {
          if (!item.after || item.holder === 'none' || flagsBefore!.get(key)?.after) continue;
          const userId = await this.userIdOf(trx, item.holder);
          if (userId) counts.set(userId, (counts.get(userId) ?? 0) + 1);
        }
        for (const p of flagged) {
          if (p.now && !p.was && p.owner_user_id) counts.set(p.owner_user_id, (counts.get(p.owner_user_id) ?? 0) + 1);
        }
        for (const [userId, count] of counts) {
          const [finding] = await this.rules.evaluate<Br42Input>(trx, 'BR-42', { count }, { msIds: [system.id], ref: refOf(EVENT, id, event.short_label, updatedAt) });
          if (!finding) continue;
          const created = await this.notifications.create(trx, {
            recipientUserId: userId,
            kind: 'audit_date_changed',
            title: { en: `Audit date changed: ${event.name_en}`, id: `Tanggal audit berubah: ${event.name_id}` },
            body: finding.messages,
            msId: system.id,
            ref: refOf(EVENT, id, event.short_label, updatedAt),
          });
          if (created) notified += 1;
        }
        after.holders_notified = notified;
      }
      if (Object.keys(set).length > 0) {
        await this.audit.record(trx, { action: 'audit_event.updated', msId: system.id, entityType: EVENT, entityId: id, entityCode: event.short_label, before, after });
      }
      return { ...commandResult([system.slug], { ref: refOf(EVENT, id, event.short_label, updatedAt) }), count: notified };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/audit-events/{id}/prep-tasks
  // -------------------------------------------------------------------------------------------------------------

  async createPrepTask(principal: Principal, ms: string, eventId: string, body: PrepTaskCreate): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const event = await this.event(trx, system, eventId);
      const ref: RecordRef = refOf(EVENT, eventId, event.short_label, event.updated_at);
      await this.rules.enforce<Br43Input>(trx, 'BR-43', { due: body.dueAt, auditDate: event.scheduled_at }, { msIds: [system.id], ref });
      const status = body.status ?? 'not_started';
      if (status === 'overdue') throw new TransitionNotAllowedError(null, status);
      if (status === 'blocked' && !body.note) throw new ValidationError([{ path: 'body.note', message: 'A blocked task needs a note' }]);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const id = randomUUID();
      let updatedAt: Date;
      try {
        const { rows } = await sql<{ updated_at: Date }>`
          insert into audit_prep_task (id, audit_event_id, management_system_id, title, owner_user_id, due_at, status, note, position, created_by, updated_by)
          values (${id}, ${eventId}, ${system.id}, ${body.title}, ${owner}, ${body.dueAt}::date, ${status}, ${body.note ?? null},
                  (select coalesce(max(position), -1) + 1 from audit_prep_task where audit_event_id = ${eventId}), ${actor}, ${actor})
          returning updated_at`.execute(trx);
        updatedAt = rows[0]!.updated_at;
      } catch (error) {
        if (isBr43TriggerError(error)) throw br43Problem();
        throw error;
      }
      const taskRef = refOf(PREP, id, body.title, updatedAt);
      await this.audit.record(trx, {
        action: 'prep_task.updated',
        msId: system.id,
        entityType: PREP,
        entityId: id,
        entityCode: body.title,
        after: { created: true, audit_event: event.short_label, title: body.title, owner: body.ownerHandle, due_at: body.dueAt, status, ...(body.note ? { note: body.note } : {}) },
      });
      if (owner) await this.notifyPrepAssigned(trx, owner, system, taskRef, body.dueAt);
      return commandResult([system.slug], { ref: taskRef });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/prep-tasks/{id} and PATCH /ms/{ms}/cycle-items/{id}
  // -------------------------------------------------------------------------------------------------------------

  updatePrepTask(principal: Principal, authz: AuthzState | null, ms: string, id: string, patch: PrepTaskPatch, ifMatch: string | undefined): Promise<CommandResult> {
    return this.updateProgress(PROGRESS.prep, principal, authz, ms, id, patch, ifMatch);
  }

  updateCycleItem(principal: Principal, authz: AuthzState | null, ms: string, id: string, patch: CycleItemPatch, ifMatch: string | undefined): Promise<CommandResult> {
    return this.updateProgress(PROGRESS.cycle, principal, authz, ms, id, patch, ifMatch);
  }

  private updateProgress(
    kind: ProgressKind,
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    id: string,
    patch: PrepTaskPatch | CycleItemPatch,
    ifMatch: string | undefined,
  ): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, kind.table, id, { forUpdate: true });
      const row = record.row as unknown as ProgressRow;
      const code = kind.table === PREP ? row.title : row.requirement_code!;
      const currentRef = refOf(kind.table, id, code, row.updated_at);
      assertIfMatch(ifMatch, row.updated_at, currentRef);
      const owns = row.owner_user_id === actor;
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: string, value: unknown, shown?: { before: unknown; after: unknown }) => {
        const current = (row as unknown as Record<string, unknown>)[column] ?? null;
        if (current === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = shown ? shown.before : current;
        after[column] = shown ? shown.after : (value ?? null);
      };

      const note = patch.note !== undefined ? patch.note : (row[kind.noteColumn] ?? null);
      if (patch.status !== undefined && patch.status !== row.status) {
        const transition = pickTransition(kind.machine, row.status, patch.status, authz, owns);
        assertRequires(transition, { note: note ?? undefined });
        change('status', patch.status);
      } else {
        // Field changes without a status change need the permission too (own grants: only the holder).
        assertOwnScope(authz, kind.permission, [row.owner_user_id], actor);
      }
      const status = (set.status as string | undefined) ?? row.status;
      if (patch.note !== undefined) {
        if (patch.note === null && status === 'blocked') throw new ValidationError([{ path: 'body.note', message: 'A blocked item needs a note' }]);
        change(kind.noteColumn, patch.note);
      }
      if ('title' in patch && patch.title !== undefined) change('title', patch.title);
      let newOwner: string | null | undefined;
      if (patch.ownerHandle !== undefined) {
        newOwner = await this.members.resolveHandle(trx, patch.ownerHandle);
        change('owner_user_id', newOwner, { before: (await personOf(trx, row.owner_user_id))?.handle ?? 'none', after: patch.ownerHandle });
      }
      if (patch.dueAt !== undefined) {
        if (kind.table === PREP) {
          const eventDate = (await sql<{ scheduled_at: string }>`select scheduled_at from audit_event where id = ${row.audit_event_id!}`.execute(trx)).rows[0]?.scheduled_at;
          if (eventDate) await this.rules.enforce<Br43Input>(trx, 'BR-43', { due: patch.dueAt, auditDate: eventDate }, { msIds: [record.ms.id], ref: currentRef });
          if (patch.dueAt !== row.due_at) set.violates_br43 = false;
        }
        change('due_at', patch.dueAt);
      }

      let updatedAt: Date;
      try {
        updatedAt = await writeRow(trx, kind.table, id, set, actor);
      } catch (error) {
        if (isBr43TriggerError(error)) throw br43Problem();
        throw error;
      }
      const ref = refOf(kind.table, id, (set.title as string | undefined) ?? code, updatedAt);
      if (Object.keys(after).length > 0) {
        await this.audit.record(trx, { action: kind.action, msId: record.ms.id, entityType: kind.table, entityId: id, entityCode: code, before, after });
      }
      if (kind.table === PREP && newOwner && newOwner !== row.owner_user_id) {
        await this.notifyPrepAssigned(trx, newOwner, record.ms, ref, (set.due_at as string | undefined) ?? row.due_at);
      }
      return commandResult([record.ms.slug], { ref });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** An audit event of the path system (its `management_system_id`, or a link to it); 404 otherwise. */
  private async event(trx: Trx, system: MsRef, id: string): Promise<EventRow> {
    const { rows } = await sql<EventRow>`
      select e.* from audit_event e
       where e.id = ${id} and e.deleted_at is null
         and (e.management_system_id = ${system.id}
              or exists (select 1 from entity_ms_link l where l.entity_type = 'audit_event' and l.entity_id = e.id
                           and l.management_system_id = ${system.id} and l.deleted_at is null))
       for update of e`.execute(trx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Unknown audit event');
    return row;
  }

  private async userIdOf(trx: Trx, handle: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`select id from platform.app_user where handle = ${handle}`.execute(trx);
    return rows[0]?.id ?? null;
  }

  private async notifyPrepAssigned(trx: Trx, owner: string, system: MsRef, ref: RecordRef, due: string): Promise<void> {
    await this.notifications.create(trx, {
      recipientUserId: owner,
      kind: 'prep_task_assigned',
      title: { en: `Preparation task assigned: ${ref.code}`, id: `Tugas persiapan ditugaskan: ${ref.code}` },
      body: { en: `${ref.code}, due ${due}`, id: `${ref.code}, tenggat ${due}` },
      msId: system.id,
      ref,
      digest: true,
    });
  }
}

/** After audit flags of a system's chain items by key, with the holder (BR-42 compares two of these). */
function afterFlags(snapshot: UiMsSnapshot): Map<string, { after: boolean; holder: string }> {
  return new Map(snapshot.bundle.chain.items.map((i) => [i.key, { after: i.after, holder: i.h }]));
}
