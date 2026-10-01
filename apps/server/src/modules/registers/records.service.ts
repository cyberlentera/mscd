// Generic record commands of D.3 (WP-35): reassignment of the holder and due date of any item (the assignment
// table of K.2 WP-35, by `AssignmentRequest.kind`), completion of the pending action of a chain record or drift row,
// soft delete with a reason (BR-19, BR-22 confirmation, open dependants rejected) and completion of a stored task
// (D-29). Every command resolves its record through `RecordResolver` (F.7) inside the tenant transaction, checks
// people through `MembershipService`, honours `If-Match` where the route accepts it, and writes its audit entry in
// the same transaction.
import { Inject, Injectable } from '@nestjs/common';
import {
  ASSIGNMENT_KIND_ENTITY_TYPES,
  STAGE_RECORD_ENTITY_TYPES,
  type AssignmentRequest,
  type CommandResult,
  type CompleteActionRequest,
  type RecordRef,
  type SoftDeleteRequest,
  type Warning,
} from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, NotFoundError, ProblemError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, NOTIFICATION_WRITER, RECORD_RESOLVER, type AuditWriter, type AuthzState, type MembershipService,
  type NotificationWriter, type Principal, type RecordResolver, type ResolvedRecord, type Trx,
} from '../../common/tokens';
import { entryBusinessId } from '../implementation';
import { mergeWarnings, RuleEngine, ruleMessages } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  assertOwnScope, commandResult, enqueueFreshness, isBr43TriggerError, nextAuditDate, orgOf, personOf, refOf, todayOf, unprocessable,
  writeRow,
} from './command-support';
import type { Br41Input, Br43Input } from './register.rules';
import { SharedChangeGuard } from './shared-change';

/** Columns an assignment sets per kind: the holder column and the due date column (K.2 WP-35 table). */
const ASSIGNMENT_COLUMNS: Readonly<Record<AssignmentRequest['kind'], { holder: string; due: string; dueRequired?: boolean }>> = {
  req: { holder: 'owner_user_id', due: 'action_due_at' },
  soa: { holder: 'justification_holder_user_id', due: 'justification_due_at' },
  doc: { holder: 'pending_holder_user_id', due: 'pending_due_at' },
  ev: { holder: 'owner_user_id', due: 'next_due_override' },
  act: { holder: 'owner_user_id', due: 'due_at' },
  x: { holder: 'owner_user_id', due: 'action_due_at' },
  prep: { holder: 'owner_user_id', due: 'due_at', dueRequired: true },
  cycle: { holder: 'owner_user_id', due: 'due_at', dueRequired: true },
  drift: { holder: 'holder_user_id', due: 'due_at' },
};

/** Tables whose open action is `pending_action` (C.10 chain records). */
const PENDING_ACTION_TABLES: ReadonlySet<string> = new Set(STAGE_RECORD_ENTITY_TYPES);

/** The holder column of a record for own-scope checks. */
function holdersOf(entityType: string, row: Record<string, unknown>): (string | null)[] {
  const pick = (c: string) => (typeof row[c] === 'string' ? (row[c] as string) : null);
  if (entityType === 'drift_result') return [pick('holder_user_id')];
  if (entityType === 'document') return [pick('owner_user_id'), pick('pending_holder_user_id')];
  if (entityType === 'applicability_entry') return [pick('owner_user_id'), pick('justification_holder_user_id')];
  return [pick('owner_user_id')];
}

/**
 * Open dependants that block a soft delete (D.3: 422 "the record still has open dependants"): records that still
 * rely on this one and are not finished themselves.
 */
const DEPENDANTS: Readonly<Record<string, (id: string) => RawBuilder<{ code: string }>>> = {
  risk: (id) => sql<{ code: string }>`select code from risk_treatment where risk_id = ${id} and deleted_at is null and status <> 'closed' order by code`,
  metric: (id) => sql<{ code: string }>`select code from quality_objective where metric_id = ${id} and deleted_at is null order by code`,
  prioritized_activity: (id) =>
    sql<{ code: string }>`select code from business_impact_analysis where prioritized_activity_id = ${id} and deleted_at is null order by code`,
  bc_plan: (id) => sql<{ code: string }>`select code from exercise where bc_plan_id = ${id} and deleted_at is null and performed_at is null order by code`,
  finding: (id) => sql<{ code: string }>`
    select ca.code from corrective_action_finding cf join corrective_action ca on ca.id = cf.corrective_action_id
     where cf.finding_id = ${id} and cf.deleted_at is null and ca.deleted_at is null and ca.status not in ('closed', 'cancelled') order by ca.code`,
  document: (id) => sql<{ code: string }>`
    select code from (
      select b.code from bc_plan b where b.document_id = ${id} and b.deleted_at is null
      union all
      select a.phase_no || '.' || a.activity_no from implementation_activity_progress a
       where a.output_document_id = ${id} and a.deleted_at is null and a.status = 'complete'
    ) d order by code`,
};

@Injectable()
export class RecordCommandsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    private readonly shared: SharedChangeGuard,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/records/{entityType}/{id}/assignment
  // -------------------------------------------------------------------------------------------------------------

  async assign(principal: Principal, ms: string, entityType: string, id: string, body: AssignmentRequest, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, entityType, id, { forUpdate: true });
      const row = record.row;
      const code = await businessCodeOf(trx, record);
      const currentRef = refOf(entityType, id, code, row.updated_at as Date);
      assertIfMatch(ifMatch, row.updated_at as Date, currentRef);
      if (!ASSIGNMENT_KIND_ENTITY_TYPES[body.kind].includes(record.entityType)) {
        throw unprocessable(
          'records.kind_mismatch',
          `An assignment of kind ${body.kind} does not apply to a ${entityType} record`,
          `Penugasan jenis ${body.kind} tidak berlaku untuk rekaman ${entityType}`,
        );
      }
      const columns = ASSIGNMENT_COLUMNS[body.kind];
      if (columns.dueRequired && body.dueAt === null) {
        throw new ValidationError([{ path: 'body.dueAt', message: 'This item always has a due date' }]);
      }
      const holder = await this.members.resolveHandle(trx, body.holder);
      const today = todayOf(this.clock, org);
      const scope = { msIds: [record.ms.id], ref: currentRef };
      let warnings: Warning[] = [];

      // BR-43: a preparation task ends before its audit (the trigger is the backstop, A-26).
      if (body.kind === 'prep') {
        const event = await auditEventDate(trx, row.audit_event_id as string);
        if (event) await this.rules.enforce<Br43Input>(trx, 'BR-43', { due: body.dueAt!, auditDate: event }, scope);
      }
      // BR-41: a due date after the next audit is allowed with a warning.
      const next = await nextAuditDate(trx, record.ms.id, today);
      warnings = mergeWarnings(warnings, await this.rules.enforce<Br41Input>(trx, 'BR-41', { due: body.dueAt, auditDate: next?.date ?? null }, scope));
      // BR-17 (on assignment a warning, D.3): a risk set to Unassigned has no owner.
      if (entityType === 'risk' && holder === null && (await this.rules.isActive(trx, 'BR-17', record.ms.id))) {
        warnings = mergeWarnings(warnings, [{ rule: 'BR-17', messages: ruleMessages('BR-17') }]);
      }

      const beforeHolder = (row[columns.holder] as string | null) ?? null;
      const beforeDue = (row[columns.due] as string | null) ?? null;
      let updatedAt: Date;
      try {
        const set: Record<string, unknown> = { [columns.holder]: holder, [columns.due]: body.dueAt };
        // A-26: BR-43 was enforced above, so a new due date of a preparation task is before its audit.
        if (body.kind === 'prep' && body.dueAt !== beforeDue) set.violates_br43 = false;
        updatedAt = await writeRow(trx, entityType, id, set, actor);
      } catch (error) {
        if (isBr43TriggerError(error)) throw new ProblemError('business-rule', { rule: 'BR-43', messages: ruleMessages('BR-43'), detail: ruleMessages('BR-43').en });
        throw error;
      }
      const [beforePerson, afterPerson] = [await personOf(trx, beforeHolder), await personOf(trx, holder)];
      await this.audit.record(trx, {
        action: 'record.assigned',
        msId: record.ms.id,
        entityType,
        entityId: id,
        entityCode: code,
        before: { kind: body.kind, holder: beforePerson?.handle ?? 'none', due_at: beforeDue },
        after: { kind: body.kind, holder: afterPerson?.handle ?? 'none', due_at: body.dueAt },
      });
      if (holder && holder !== beforeHolder && body.kind === 'prep') {
        await this.notifications.create(trx, {
          recipientUserId: holder,
          kind: 'prep_task_assigned',
          title: { en: `Preparation task assigned: ${code}`, id: `Tugas persiapan ditugaskan: ${code}` },
          body: { en: `${code}, due ${body.dueAt}`, id: `${code}, tenggat ${body.dueAt}` },
          msId: record.ms.id,
          ref: refOf(entityType, id, code, updatedAt),
          digest: true,
        });
      }
      if (entityType === 'evidence') await enqueueFreshness(this.queue, trx, org, record.ms.id, { evidenceIds: [id] }, actor);
      const changed = await this.changedSystems(trx, record);
      return commandResult(changed, { ref: refOf(entityType, id, code, updatedAt), warnings });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/records/{entityType}/{id}/complete-action
  // -------------------------------------------------------------------------------------------------------------

  async completeAction(principal: Principal, authz: AuthzState | null, ms: string, entityType: string, id: string, body: CompleteActionRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, entityType, id, { forUpdate: true });
      const row = record.row;
      const code = await businessCodeOf(trx, record);
      assertOwnScope(authz, 'record.complete_action', holdersOf(entityType, row), actor);
      const now = new Date();
      let set: Record<string, unknown>;
      let before: Record<string, unknown>;
      let after: Record<string, unknown>;
      if (PENDING_ACTION_TABLES.has(entityType)) {
        if (row.pending_action === null || row.pending_action === undefined) throw new ConflictError('This record has no open action', { messageKey: 'records.no_open_action' });
        before = { pending_action: row.pending_action };
        after = { pending_action: null, action_completed_at: now.toISOString() };
        set = { pending_action: null, action_completed_at: now, action_completed_by: actor };
      } else if (entityType === 'drift_result') {
        if (row.resolved_at) throw new ConflictError('This drift item is already resolved', { messageKey: 'records.no_open_action' });
        before = { resolved_at: null };
        after = { resolved_at: now.toISOString() };
        set = { resolved_at: now };
      } else {
        throw new ConflictError('This record has no pending action to complete', { messageKey: 'records.no_open_action' });
      }
      const updatedAt = await writeRow(trx, entityType, id, set, actor);
      await this.audit.record(trx, {
        action: 'record.action_completed',
        msId: record.ms.id,
        entityType,
        entityId: id,
        entityCode: code,
        before,
        after: { ...after, ...(body.note ? { note: body.note } : {}) },
      });
      return commandResult(await this.changedSystems(trx, record), { ref: refOf(entityType, id, code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/records/{entityType}/{id}/delete
  // -------------------------------------------------------------------------------------------------------------

  async softDelete(principal: Principal, ms: string, entityType: string, id: string, body: SoftDeleteRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, entityType, id, { forUpdate: true });
      const code = await businessCodeOf(trx, record);
      const ref = refOf(entityType, id, code, record.row.updated_at as Date);
      // BR-22: deleting a shared entity removes it from every linked system.
      const linked = await this.shared.assertConfirmed(trx, { entityType, id, msId: record.ms.id, ref }, body.confirm);
      const dependants = DEPENDANTS[entityType];
      if (dependants) {
        const { rows } = await dependants(id).execute(trx);
        if (rows.length > 0) {
          const codes = rows.map((r) => r.code);
          throw new ProblemError('business-rule', {
            messageKey: 'records.open_dependants',
            messages: {
              en: `${code} still has open dependent records: ${codes.join(', ')}. Close or reassign them first.`,
              id: `${code} masih memiliki rekaman turunan yang terbuka: ${codes.join(', ')}. Tutup atau alihkan terlebih dahulu.`,
            },
            detail: `${code} still has open dependent records: ${codes.join(', ')}`,
            affected: codes,
            ref,
          });
        }
      }
      const updatedAt = await writeRow(trx, entityType, id, { deleted_at: new Date() }, actor);
      await this.audit.record(trx, {
        action: 'record.deleted',
        msId: record.ms.id,
        entityType,
        entityId: id,
        entityCode: code,
        before: { deleted: false },
        after: { deleted: true, reason: body.reason, ...(linked.length > 1 ? { systems: linked.map((s) => s.slug) } : {}) },
      });
      const systems = linked.length > 0 ? linked : [{ id: record.ms.id, slug: record.ms.slug }];
      if (entityType === 'evidence' || entityType === 'applicability_entry') {
        for (const s of systems) await enqueueFreshness(this.queue, trx, org, s.id, {}, actor);
      }
      return commandResult(systems.map((s) => s.slug), { ref: refOf(entityType, id, code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /tasks/{id}/complete
  // -------------------------------------------------------------------------------------------------------------

  async completeTask(principal: Principal, id: string, body: CompleteActionRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const { rows } = await sql<{
        id: string; status: string; owner_user_id: string | null; entity_type: string; entity_code: string | null; management_system_id: string | null;
        ms_slug: string | null; updated_at: Date;
      }>`
        select t.id, t.status, t.owner_user_id, t.entity_type, t.entity_code, t.management_system_id, m.slug as ms_slug, t.updated_at
          from task t left join management_system m on m.id = t.management_system_id
         where t.id = ${id} and t.deleted_at is null for update of t`.execute(trx);
      const task = rows[0];
      // Another person's task is not visible to the caller (D-29: tasks are listed for their owner only).
      if (!task || task.owner_user_id !== actor) throw new NotFoundError();
      if (task.status !== 'open') throw new ConflictError('This task is not open', { messageKey: 'tasks.not_open' });
      const updatedAt = await writeRow(trx, 'task', id, { status: 'done', closed_by: actor, closed_at: new Date() }, actor);
      const code = task.entity_code ?? task.id;
      await this.audit.record(trx, {
        action: 'task.completed',
        msId: task.management_system_id,
        entityType: 'task',
        entityId: id,
        entityCode: code,
        before: { status: 'open' },
        after: { status: 'done', ...(body.note ? { note: body.note } : {}) },
      });
      const ref: RecordRef = { module: 'audit', entityType: 'task', id, code, etag: refOf('task', id, code, updatedAt).etag };
      return commandResult(task.ms_slug ? [task.ms_slug] : [], { ref });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Systems whose bundles reload: every linked system of a shared record, else the record's system. */
  private async changedSystems(trx: Trx, record: ResolvedRecord): Promise<string[]> {
    const { rows } = await sql<{ slug: string }>`
      select m.slug from entity_ms_link l join management_system m on m.id = l.management_system_id and m.deleted_at is null
       where l.entity_type = ${record.entityType} and l.entity_id = ${record.id} and l.deleted_at is null
       order by (m.id = ${record.ms.id}) desc, m.slug`.execute(trx);
    return rows.length > 0 ? rows.map((r) => r.slug) : [record.ms.slug];
  }
}

/** Date of an audit event (BR-43). */
export async function auditEventDate(trx: Trx, eventId: string): Promise<string | null> {
  const { rows } = await sql<{ scheduled_at: string }>`select scheduled_at from audit_event where id = ${eventId} and deleted_at is null`.execute(trx);
  return rows[0]?.scheduled_at ?? null;
}

/** G.5 business id of a resolved record (the `code` of its ref). */
export async function businessCodeOf(trx: Trx, record: Pick<ResolvedRecord, 'entityType' | 'row' | 'id'>): Promise<string> {
  const row = record.row;
  switch (record.entityType) {
    case 'applicability_entry': {
      const { rows } = row.target_type === 'catalogue_item'
        ? await sql<{ code: string }>`select item_code as code from ref.catalogue_item where id = ${row.catalogue_item_id as string}`.execute(trx)
        : await sql<{ code: string }>`select requirement_code as code from ref.requirement where id = ${row.requirement_id as string}`.execute(trx);
      return entryBusinessId(row.target_type as 'catalogue_item' | 'requirement', rows[0]?.code ?? '');
    }
    case 'document':
      return row.doc_code as string;
    case 'evidence':
      return row.evidence_code as string;
    case 'implementation_activity_progress':
      return `${row.phase_no as number}.${row.activity_no as number}`;
    case 'audit_prep_task':
      return row.title as string;
    case 'cycle_requirement_status':
      return row.requirement_code as string;
    case 'drift_result':
      return row.entity_code as string;
    default:
      return typeof row.code === 'string' ? row.code : record.id;
  }
}
