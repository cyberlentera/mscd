// Self-Assessment Workbench (D.3 "Registers and workflows: audit side", C.13 `self_assessment.status`, PRD 8.1,
// WP-37): one row per finding condition (`ref.finding_condition`) of the system's edition with its stored
// assessment (`not_assessed` when there is none), recording an assessment with its evidence (a gap needs an owner
// and a target date), and raising a finding (source `self_assessment`) from a gap.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, Page, RaiseFindingRequest, SelfAssessmentItem, SelfAssessmentListQuery, SelfAssessmentUpdate } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { ConflictError, NotFoundError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, SCOPE_POLICY, type AuditWriter, type AuthzState, type MembershipService, type Principal,
  type RecordResolver, type ScopePolicy, type Trx,
} from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { FindingsService } from './findings.service';
import { bump, commandResult, editionOf, orgOf, pickTransition, refOf, todayOf, unprocessable } from './support';

const ENTITY = 'self_assessment';
const MACHINE = 'self_assessment.status' as const;

interface ConditionRow {
  condition_id: string;
  code: string;
  classification: SelfAssessmentItem['classification'];
  requirement_code: string | null;
  text: string;
  id: string | null;
  updated_at: Date | null;
  status: SelfAssessmentItem['status'] | null;
  owner_user_id: string | null;
  owner_handle: string | null;
  owner_name: string | null;
  target_fix_at: string | null;
  note: string | null;
  assessed_at: string | null;
  finding_code: string | null;
  evidence: string[] | null;
}

interface AssessmentRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  finding_condition_id: string;
  status: SelfAssessmentItem['status'];
  owner_user_id: string | null;
  target_fix_at: string | null;
  note: string | null;
  assessed_at: string | null;
  finding_id: string | null;
}

@Injectable()
export class SelfAssessmentsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly findings: FindingsService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(SCOPE_POLICY) private readonly scope: ScopePolicy,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/self-assessments
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, authz: AuthzState | null, ms: string, query: SelfAssessmentListQuery): Promise<Page<SelfAssessmentItem>> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const readScope = await this.scope.readScope(trx, principal, ms, authz ?? { ms, granted: new Map(), ownOnly: false });
      const rows = await this.conditions(trx, system.id, null);
      const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const items = rows
        .map((row) => ({ row, item: itemOf(row) }))
        .filter(({ row, item }) => {
          if (query.status !== undefined && item.status !== query.status) return false;
          if (words.length === 0) return true;
          const haystack = [row.code, row.text, row.requirement_code, row.owner_name, row.owner_handle, row.note].filter(Boolean).join(' ').toLowerCase();
          return words.every((w) => haystack.includes(w));
        })
        .map(({ row, item }) => ({ ownerUserId: row.owner_user_id, item }));
      const visible = this.scope.filter(readScope, items);
      const start = (query.page - 1) * query.pageSize;
      return { items: visible.slice(start, start + query.pageSize).map((v) => v.item), page: query.page, pageSize: query.pageSize, total: visible.length };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PUT /ms/{ms}/self-assessments/{conditionCode}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, authz: AuthzState | null, ms: string, conditionCode: string, body: SelfAssessmentUpdate): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const [condition] = await this.conditions(trx, system.id, conditionCode);
      if (!condition) throw new NotFoundError(`${conditionCode} is not a finding condition of the edition in use`);
      const stored = condition.id
        ? ((await sql<AssessmentRow>`select * from self_assessment where id = ${condition.id} for update`.execute(trx)).rows[0] ?? null)
        : null;
      const from = stored?.status ?? null;
      // A new status moves through the C.13 table; the same status only changes the assessment's other fields.
      if (from !== body.status) pickTransition(MACHINE, from, body.status, authz, false);
      const owner = body.ownerHandle !== undefined ? await this.members.resolveHandle(trx, body.ownerHandle) : (stored?.owner_user_id ?? null);
      if (body.status === 'gap' && owner === null) {
        throw unprocessable('audit.gap_needs_owner', 'A gap needs an owner and a target date', 'Kesenjangan memerlukan pemilik dan tanggal target');
      }
      const evidence = await this.evidenceOf(trx, system.id, body.evidenceCodes);
      const today = todayOf(this.clock, orgOf(principal));
      const values = {
        status: body.status,
        owner_user_id: owner,
        target_fix_at: body.targetFixAt ?? (body.status === 'gap' ? null : (stored?.target_fix_at ?? null)),
        note: body.note ?? (stored?.note ?? null),
        assessed_at: today,
      };
      let id: string;
      let updatedAt: Date;
      if (stored) {
        id = stored.id;
        updatedAt = await bump(trx, ENTITY, stored.id, { ...values, updated_by: actor });
      } else {
        const inserted = await trx
          .insertInto('self_assessment')
          .values({ management_system_id: system.id, finding_condition_id: condition.condition_id, ...values, created_by: actor, updated_by: actor })
          .returning(['id', 'updated_at'])
          .executeTakeFirstOrThrow();
        id = inserted.id;
        updatedAt = new Date(inserted.updated_at);
      }
      const before = (condition.evidence ?? []).slice().sort();
      const wanted = evidence.map((e) => e.code).sort();
      if (stored) {
        await sql`update self_assessment_evidence set deleted_at = now(), updated_at = now(), updated_by = ${actor}
                   where self_assessment_id = ${id} and deleted_at is null and not (evidence_id = any(${evidence.map((e) => e.id)}::uuid[]))`.execute(trx);
      }
      for (const e of evidence) {
        await sql`insert into self_assessment_evidence (self_assessment_id, evidence_id, created_by, updated_by)
                  select ${id}, ${e.id}, ${actor}, ${actor}
                   where not exists (select 1 from self_assessment_evidence where self_assessment_id = ${id} and evidence_id = ${e.id} and deleted_at is null)`.execute(trx);
      }
      await this.audit.record(trx, {
        action: 'self_assessment.updated',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: condition.code,
        before: { status: from ?? 'not_assessed', owner: condition.owner_handle, target_fix_at: stored?.target_fix_at ?? null, note: stored?.note ?? null, evidence: before },
        after: {
          status: body.status, owner: body.ownerHandle ?? condition.owner_handle, target_fix_at: values.target_fix_at, note: values.note, evidence: wanted,
          assessed_at: today,
        },
      });
      return commandResult([system.slug], { ref: refOf(ENTITY, id, condition.code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/self-assessments/{id}/raise-finding
  // -------------------------------------------------------------------------------------------------------------

  async raiseFinding(principal: Principal, ms: string, id: string, body: RaiseFindingRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as AssessmentRow;
      const { rows: conditions } = await sql<{ code: string; requirement_code: string | null; text: string }>`
        select code, requirement_code, text from ref.finding_condition where id = ${row.finding_condition_id}`.execute(trx);
      const condition = conditions[0]!;
      if (row.finding_id) {
        const { rows: live } = await sql<{ code: string }>`select code from finding where id = ${row.finding_id} and deleted_at is null`.execute(trx);
        if (live[0]) throw new ConflictError(`Finding ${live[0].code} was already raised from ${condition.code}`, { messageKey: 'audit.finding_already_raised' });
      }
      if (row.status !== 'gap') {
        throw unprocessable('audit.raise_needs_gap', 'A finding is raised from a gap only', 'Temuan hanya dapat diajukan dari kesenjangan');
      }
      const code = await this.nextFindingCode(trx, record.ms.id, todayOf(this.clock, orgOf(principal)).slice(0, 4));
      const owner = row.owner_user_id ? ((await sql<{ handle: string }>`select handle from platform.app_user where id = ${row.owner_user_id}`.execute(trx)).rows[0]?.handle ?? 'none') : 'none';
      const finding = await this.findings.insert(
        trx,
        principal,
        record.ms,
        {
          code, title: (body.title ?? condition.text).slice(0, 255), classification: body.classification, clauseRef: condition.requirement_code, source: 'self_assessment',
          auditEventId: null, ownerUserId: row.owner_user_id, ownerHandle: owner, dueAt: row.target_fix_at,
        },
        { condition: condition.code },
      );
      const updatedAt = await bump(trx, ENTITY, row.id, { finding_id: finding.id, updated_by: actor });
      await this.audit.record(trx, {
        action: 'self_assessment.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: condition.code,
        before: { finding: null }, after: { finding: code },
      });
      return commandResult([record.ms.slug], { ref: finding, data: { selfAssessment: refOf(ENTITY, row.id, condition.code, updatedAt) } });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Finding conditions of the system's edition with their stored assessment, in code order (one or all). */
  private async conditions(trx: Trx, msId: string, code: string | null): Promise<ConditionRow[]> {
    const edition = await editionOf(trx, msId);
    const { rows } = await sql<ConditionRow>`
      select c.id as condition_id, c.code, c.classification, c.requirement_code, c.text,
             s.id, s.updated_at, s.status, s.owner_user_id, o.handle as owner_handle, o.display_name as owner_name, s.target_fix_at, s.note, s.assessed_at,
             f.code as finding_code,
             (select array_agg(e.evidence_code order by e.evidence_code)
                from self_assessment_evidence se join evidence e on e.id = se.evidence_id and e.deleted_at is null
               where se.self_assessment_id = s.id and se.deleted_at is null) as evidence
        from ref.finding_condition c
        left join self_assessment s on s.finding_condition_id = c.id and s.management_system_id = ${msId} and s.deleted_at is null
        left join platform.app_user o on o.id = s.owner_user_id
        left join finding f on f.id = s.finding_id and f.deleted_at is null
       where c.framework_version_id = ${edition} and (${code}::text is null or c.code = ${code})
       order by c.code`.execute(trx);
    return rows;
  }

  /** Evidence of the system by code (linked to it); 422 for a code it does not hold. */
  private async evidenceOf(trx: Trx, msId: string, codes: readonly string[]): Promise<{ id: string; code: string }[]> {
    const wanted = [...new Set(codes)];
    if (wanted.length === 0) return [];
    const { rows } = await sql<{ id: string; code: string }>`
      select e.id, e.evidence_code as code from evidence e
       where e.deleted_at is null and e.evidence_code = any(${wanted}::text[])
         and exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = e.id
                        and l.management_system_id = ${msId} and l.deleted_at is null)`.execute(trx);
    const unknown = wanted.filter((c) => !rows.some((r) => r.code === c));
    if (unknown.length > 0) {
      throw unprocessable('audit.unknown_evidence', `Unknown evidence of this system: ${unknown.join(', ')}`, `Bukti tidak dikenal pada sistem ini: ${unknown.join(', ')}`);
    }
    return rows;
  }

  /** `SA-<year>-<nn>`: the next free code of findings raised from the workbench in this system. */
  private async nextFindingCode(trx: Trx, msId: string, year: string): Promise<string> {
    const prefix = `SA-${year}-`;
    const { rows } = await sql<{ code: string }>`
      select code from finding where management_system_id = ${msId} and deleted_at is null and code like ${`${prefix}%`}`.execute(trx);
    const used = rows.map((r) => Number(r.code.slice(prefix.length))).filter((n) => Number.isInteger(n));
    const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
    return `${prefix}${String(next).padStart(2, '0')}`;
  }
}

function itemOf(row: ConditionRow): SelfAssessmentItem {
  return {
    ref: row.id && row.updated_at ? refOf(ENTITY, row.id, row.code, row.updated_at) : null,
    conditionCode: row.code,
    classification: row.classification,
    requirementCode: row.requirement_code,
    text: row.text,
    status: row.status ?? 'not_assessed',
    owner: row.owner_handle,
    targetFixAt: row.target_fix_at,
    note: row.note,
    assessedAt: row.assessed_at,
    evidence: row.evidence ?? [],
    findingCode: row.finding_code,
  };
}
