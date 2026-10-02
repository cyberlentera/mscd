// Audit Activity Planner (D.3 "Registers and workflows: audit side", PRD 8.1, WP-37): the activities of an audit
// event in the path system, generating them from the edition's `ref.audit_activity_template` rows of the event's
// type (codes the event already has are skipped), and planning one (auditee, date, status, note).
import { Inject, Injectable } from '@nestjs/common';
import type { AuditActivityItem, AuditActivityPatch, CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, SCOPE_POLICY, type AuditWriter, type AuthzState, type MembershipService, type Principal,
  type RecordResolver, type ScopePolicy,
} from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { auditEventOf, bump, commandResult, editionOf, nextPosition, refOf } from './support';

const ENTITY = 'audit_activity';

interface ActivityRow {
  id: string;
  audit_event_id: string;
  management_system_id: string;
  updated_at: Date;
  template_code: string | null;
  title: string;
  clause_ref: string | null;
  key_questions: string | null;
  evidence_to_request: string | null;
  auditee_user_id: string | null;
  scheduled_at: string | null;
  status: AuditActivityItem['status'];
  note: string | null;
}

@Injectable()
export class AuditActivitiesService {
  constructor(
    private readonly tenancy: TenantScope,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(SCOPE_POLICY) private readonly scope: ScopePolicy,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/audit-events/{id}/activities
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, authz: AuthzState | null, ms: string, eventId: string): Promise<AuditActivityItem[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const event = await auditEventOf(trx, system, eventId);
      const readScope = await this.scope.readScope(trx, principal, ms, authz ?? { ms, granted: new Map(), ownOnly: false });
      const { rows } = await sql<ActivityRow & { auditee: string | null }>`
        select a.*, u.handle as auditee from audit_activity a left join platform.app_user u on u.id = a.auditee_user_id
         where a.audit_event_id = ${event.id} and a.management_system_id = ${system.id} and a.deleted_at is null
         order by a.position, a.template_code nulls last, a.title`.execute(trx);
      const items = rows.map((row) => ({ holderUserId: row.auditee_user_id, item: itemOf(row, row.auditee) }));
      return this.scope.filter(readScope, items).map((v) => v.item);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/audit-events/{id}/activities/generate
  // -------------------------------------------------------------------------------------------------------------

  async generate(principal: Principal, ms: string, eventId: string): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const event = await auditEventOf(trx, system, eventId, true);
      const edition = await editionOf(trx, system.id);
      const { rows: templates } = await sql<{
        code: string; clause_ref: string | null; title: string; key_questions: string | null; evidence_to_request: string | null;
      }>`
        select t.code, t.clause_ref, t.title, t.key_questions, t.evidence_to_request
          from ref.audit_activity_template t
         where t.framework_version_id = ${edition} and t.event_type = ${event.event_type}
           and not exists (select 1 from audit_activity a where a.audit_event_id = ${event.id} and a.management_system_id = ${system.id}
                             and a.template_code = t.code and a.deleted_at is null)
         order by t.sort_order, t.code`.execute(trx);
      let position = await nextPosition(trx, 'audit_activity', system.id);
      const created: string[] = [];
      for (const t of templates) {
        const inserted = await trx
          .insertInto('audit_activity')
          .values({
            audit_event_id: event.id, management_system_id: system.id, template_code: t.code, title: t.title, clause_ref: t.clause_ref,
            key_questions: t.key_questions, evidence_to_request: t.evidence_to_request, status: 'planned', position, created_by: actor, updated_by: actor,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        position += 1;
        created.push(t.code);
        await this.audit.record(trx, {
          action: 'audit_activity.updated', msId: system.id, entityType: ENTITY, entityId: inserted.id, entityCode: t.code,
          after: { created: true, template_code: t.code, title: t.title, audit_event: event.short_label, status: 'planned' },
        });
      }
      const message: [string, string] = created.length > 0
        ? [`${created.length} audit activities created from the templates`, `${created.length} aktivitas audit dibuat dari templat`]
        : ['Every template activity of this event already exists', 'Semua aktivitas templat untuk audit ini sudah ada'];
      return commandResult([system.slug], { count: created.length, message, data: { created } });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/audit-activities/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, ms: string, id: string, patch: AuditActivityPatch): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as ActivityRow;
      const code = row.template_code ?? row.title;
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof ActivityRow, value: unknown, shown: unknown = value) => {
        if ((row[column] ?? null) === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = row[column] ?? null;
        after[column] = shown ?? null;
      };
      // The auditee is a member of the organisation (422 NOT-A-MEMBER otherwise); `none` clears it.
      if (patch.auditeeHandle !== undefined) change('auditee_user_id', await this.members.resolveHandle(trx, patch.auditeeHandle), patch.auditeeHandle);
      if (patch.scheduledAt !== undefined) change('scheduled_at', patch.scheduledAt);
      if (patch.status !== undefined) change('status', patch.status);
      if (patch.note !== undefined) change('note', patch.note);
      const changed = Object.keys(after).length > 0;
      let updatedAt = new Date(row.updated_at);
      if (changed) {
        updatedAt = await bump(trx, ENTITY, row.id, { ...set, updated_by: actor });
        await this.audit.record(trx, { action: 'audit_activity.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: code, before, after });
      }
      return commandResult([record.ms.slug], {
        ref: refOf(ENTITY, row.id, code, updatedAt),
        ...(changed ? {} : { message: ['Nothing to change', 'Tidak ada yang diubah'] }),
      });
    });
  }
}

function itemOf(row: ActivityRow, auditee: string | null): AuditActivityItem {
  return {
    ref: refOf(ENTITY, row.id, row.template_code ?? row.title, row.updated_at),
    templateCode: row.template_code,
    title: row.title,
    clauseRef: row.clause_ref,
    keyQuestions: row.key_questions,
    evidenceToRequest: row.evidence_to_request,
    auditee,
    scheduledAt: row.scheduled_at,
    status: row.status,
    note: row.note,
  };
}
