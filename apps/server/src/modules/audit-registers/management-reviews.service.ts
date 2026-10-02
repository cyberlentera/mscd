// Management reviews (D.3 "Registers and workflows: audit side", C.13 `management_review.status`, BR-13, BR-14,
// PRD 8.1, WP-37): reviews are shared through `entity_ms_link` (a joint review of an integrated system needs the
// `integrated_mode` feature, D-15), each linked system has its own inputs (`management_review_input`, one row per
// `review_input_def` of that system's edition; the mandatory ones are created with the review), and a review moves
// from planned to held to closed. Closing checks BR-13 for every linked system and BR-14, and queues `cycle.derive`
// for every linked system in the same transaction (E.2).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CommandResult, ManagementReviewCreate, ManagementReviewInputRequest, ManagementReviewItem, ManagementReviewTransition,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import {
  AUDIT_WRITER, LICENCE_GATE, MEMBERSHIP_SERVICE, PERMISSION_EVALUATOR, RECORD_RESOLVER, SCOPE_POLICY, type AuditWriter, type AuthzState,
  type LicenceGate, type MembershipService, type MsRef, type PermissionEvaluator, type Principal, type RecordResolver, type ScopePolicy, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { cycleDeriveKey } from './cycle-derive.service';
import type { Br13Input, Br14Input } from './rules';
import { bump, commandResult, duplicateCode, linksOf, orgOf, pickTransition, refOf, todayOf, unprocessable } from './support';

const ENTITY = 'management_review';
const MACHINE = 'management_review.status' as const;

interface ReviewRow {
  id: string;
  updated_at: Date;
  code: string;
  title: string;
  owner_user_id: string | null;
  planned_at: string | null;
  held_at: string | null;
  status: ManagementReviewItem['status'];
  decisions_recorded: boolean;
  decisions_text: string | null;
  closed_at: string | null;
}

interface InputRow {
  review_id: string;
  ms_slug: string;
  def_code: string;
  title: string;
  mandatory: boolean;
  content: string | null;
  link_primary: boolean;
  sort_order: number;
}

@Injectable()
export class ManagementReviewsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(SCOPE_POLICY) private readonly scope: ScopePolicy,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/management-reviews
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, authz: AuthzState | null, ms: string): Promise<ManagementReviewItem[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const readScope = await this.scope.readScope(trx, principal, ms, authz ?? { ms, granted: new Map(), ownOnly: false });
      const { rows } = await sql<ReviewRow & { owner_handle: string | null; linked: string[] }>`
        select r.*, o.handle as owner_handle,
               (select array_agg(m.slug order by l2.is_primary desc, m.slug) from entity_ms_link l2
                  join management_system m on m.id = l2.management_system_id and m.deleted_at is null
                 where l2.entity_type = 'management_review' and l2.entity_id = r.id and l2.deleted_at is null) as linked
          from management_review r
          left join platform.app_user o on o.id = r.owner_user_id
         where r.deleted_at is null
           and exists (select 1 from entity_ms_link l where l.entity_type = 'management_review' and l.entity_id = r.id
                         and l.management_system_id = ${system.id} and l.deleted_at is null)
         order by r.planned_at desc nulls last, r.code`.execute(trx);
      const inputs = await this.inputsOf(trx, rows.map((r) => r.id));
      const items = rows.map((row) => ({ ownerUserId: row.owner_user_id, item: itemOf(row, row.owner_handle, row.linked ?? [], inputs.get(row.id) ?? []) }));
      return this.scope.filter(readScope, items).map((v) => v.item);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/management-reviews
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: ManagementReviewCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const slugs = [...new Set(body.linkedMs)];
      if (!slugs.includes(ms)) {
        throw unprocessable(
          'audit.path_system_not_linked',
          `The review must be linked to ${ms}, the system it is created in`,
          `Tinjauan harus ditautkan ke ${ms}, sistem tempat tinjauan dibuat`,
        );
      }
      // The path system is the primary link; every other system must exist and the caller must manage reviews there.
      const systems: MsRef[] = [system];
      for (const slug of slugs.filter((s) => s !== ms)) {
        const other = await this.records.resolveMs(trx, slug);
        if ((await this.evaluator.evaluate(principal, 'management_review.manage', { scope: 'ms', ms: other.slug })) !== 'full') {
          throw new ForbiddenError(`Linking a management review to ${other.slug} needs management_review.manage there`);
        }
        systems.push(other);
      }
      if (systems.length > 1) await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const id = randomUUID();
      let updatedAt: Date;
      try {
        const inserted = await trx
          .insertInto('management_review')
          .values({ id, code: body.code, title: body.title, owner_user_id: owner, planned_at: body.plannedAt, status: 'planned', created_by: actor, updated_by: actor })
          .returning(['updated_at'])
          .executeTakeFirstOrThrow();
        updatedAt = new Date(inserted.updated_at);
      } catch (error) {
        duplicateCode(error, body.code);
      }
      for (const [index, linked] of systems.entries()) {
        await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
                  values ('management_review', ${id}, ${linked.id}, ${index === 0}, ${actor}, ${actor})`.execute(trx);
      }
      // One empty input per mandatory input definition of each linked system's edition.
      const { rows: created } = await sql<{ n: number }>`
        with inserted as (
          insert into management_review_input (management_review_id, review_input_def_id, management_system_id, created_by, updated_by)
          select ${id}, d.id, m.id, ${actor}, ${actor}
            from management_system m join ref.review_input_def d on d.framework_version_id = m.framework_version_id and d.mandatory
           where m.id = any(${systems.map((s) => s.id)}::uuid[])
          returning 1)
        select count(*)::int as n from inserted`.execute(trx);
      await this.audit.record(trx, {
        action: 'management_review.created',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: body.code,
        after: {
          review_code: body.code, title: body.title, owner: body.ownerHandle, planned_at: body.plannedAt, linked_ms: systems.map((s) => s.slug),
          inputs: created[0]?.n ?? 0,
        },
      });
      return commandResult(systems.map((s) => s.slug), { ref: refOf(ENTITY, id, body.code, updatedAt!), count: created[0]?.n ?? 0 });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PUT /ms/{ms}/management-reviews/{id}/inputs/{defCode}
  // -------------------------------------------------------------------------------------------------------------

  async putInput(principal: Principal, ms: string, id: string, defCode: string, body: ManagementReviewInputRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as ReviewRow;
      const ref = refOf(ENTITY, row.id, row.code, row.updated_at);
      if (row.status === 'closed') throw new ConflictError(`${row.code} is closed; its inputs no longer change`, { messageKey: 'audit.review_closed', ref });
      const { rows: defs } = await sql<{ id: string; title: string }>`
        select d.id, d.title from ref.review_input_def d join management_system m on m.framework_version_id = d.framework_version_id
         where m.id = ${record.ms.id} and d.code = ${defCode}`.execute(trx);
      const def = defs[0];
      if (!def) throw new NotFoundError(`${defCode} is not a review input of the edition in use`);
      const { rows: existing } = await sql<{ id: string; content: string | null }>`
        select id, content from management_review_input
         where management_review_id = ${row.id} and review_input_def_id = ${def.id} and management_system_id = ${record.ms.id} and deleted_at is null
         for update`.execute(trx);
      const sourceRefs = body.sourceRefs ? JSON.stringify(body.sourceRefs) : null;
      if (existing[0]) {
        await sql`update management_review_input
                     set content = ${body.content}, source_refs = ${sourceRefs}::jsonb, updated_by = ${actor},
                         updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
                   where id = ${existing[0].id}`.execute(trx);
      } else {
        await sql`insert into management_review_input (management_review_id, review_input_def_id, management_system_id, content, source_refs, created_by, updated_by)
                  values (${row.id}, ${def.id}, ${record.ms.id}, ${body.content}, ${sourceRefs}::jsonb, ${actor}, ${actor})`.execute(trx);
      }
      // The review's version changes with its inputs, so a client holding the review's ETag sees the change.
      const updatedAt = await bump(trx, ENTITY, row.id, { updated_by: actor });
      await this.audit.record(trx, {
        action: 'management_review.input_updated',
        msId: record.ms.id,
        entityType: ENTITY,
        entityId: row.id,
        entityCode: row.code,
        before: { input: defCode, ms: record.ms.slug, content: existing[0]?.content ?? null },
        after: { input: defCode, ms: record.ms.slug, content: body.content, ...(body.sourceRefs ? { source_refs: body.sourceRefs.map((r) => r.code) } : {}) },
      });
      return commandResult([record.ms.slug], { ref: refOf(ENTITY, row.id, row.code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/management-reviews/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: ManagementReviewTransition): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as ReviewRow;
      const ref = refOf(ENTITY, row.id, row.code, row.updated_at);
      const from = row.status;
      const to = body.to;
      pickTransition(MACHINE, from, to, authz, false);
      const today = todayOf(this.clock, org);
      const links = await linksOf(trx, ENTITY, row.id);
      // A joint review changes every linked system (decisions, cycle items), so the caller must manage reviews in each, as on create.
      for (const link of links) {
        if (link.msId === record.ms.id) continue;
        if ((await this.evaluator.evaluate(principal, 'management_review.manage', { scope: 'ms', ms: link.slug })) !== 'full') {
          throw new ForbiddenError(`Changing a management review linked to ${link.slug} needs management_review.manage there`);
        }
      }
      const set: Record<string, unknown> = { status: to, updated_by: actor };
      const before: Record<string, unknown> = { status: from };
      const after: Record<string, unknown> = { status: to };
      if (to === 'held') {
        const heldAt = body.heldAt ?? today;
        set.held_at = heldAt;
        after.held_at = heldAt;
      } else {
        // BR-13 for every linked system (TS 3.5), BR-14 with the decisions of the request or those already stored.
        const decisions = body.decisionsText ?? row.decisions_text;
        const msIds = links.map((l) => l.msId);
        await this.rules.enforce<Br13Input>(trx, 'BR-13', { reviewId: row.id }, { msIds, ref });
        await this.rules.enforce<Br14Input>(trx, 'BR-14', { decisionsText: decisions }, { msIds, ref });
        Object.assign(set, { closed_at: today, closed_by_user_id: actor, decisions_recorded: true, decisions_text: decisions });
        Object.assign(after, { closed_at: today, closed_by: principal.user.handle, decisions_text: decisions });
      }
      const updatedAt = await bump(trx, ENTITY, row.id, set);
      await this.audit.record(trx, { action: 'management_review.transition', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after });
      if (to === 'closed') {
        // E.2: closing a review derives the cycle items of every linked system (committed with the closure).
        for (const link of links) {
          await this.jobs.send(
            'cycle.derive',
            { orgId: org.id, requestId: currentRequestId(), requestedBy: actor, payload: { msId: link.msId } },
            { singletonKey: cycleDeriveKey(org.id, link.msId), retryLimit: 3 },
            trx,
          );
        }
      }
      return commandResult(links.map((l) => l.slug), { ref: refOf(ENTITY, row.id, row.code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Inputs of the reviews per linked system: every input definition of each system's edition with its content. */
  private async inputsOf(trx: Trx, reviewIds: readonly string[]): Promise<Map<string, InputRow[]>> {
    const out = new Map<string, InputRow[]>();
    if (reviewIds.length === 0) return out;
    const { rows } = await sql<InputRow>`
      select l.entity_id as review_id, m.slug as ms_slug, d.code as def_code, d.title, d.mandatory, i.content, l.is_primary as link_primary, d.sort_order
        from entity_ms_link l
        join management_system m on m.id = l.management_system_id and m.deleted_at is null
        join ref.review_input_def d on d.framework_version_id = m.framework_version_id
        left join management_review_input i on i.management_review_id = l.entity_id and i.review_input_def_id = d.id
                                           and i.management_system_id = m.id and i.deleted_at is null
       where l.entity_type = 'management_review' and l.entity_id = any(${[...reviewIds]}::uuid[]) and l.deleted_at is null
         and (d.mandatory or i.id is not null)
       order by l.entity_id, l.is_primary desc, m.slug, d.sort_order, d.code`.execute(trx);
    for (const row of rows) {
      const list = out.get(row.review_id) ?? [];
      list.push(row);
      out.set(row.review_id, list);
    }
    return out;
  }
}

function itemOf(row: ReviewRow, ownerHandle: string | null, linked: readonly string[], inputs: readonly InputRow[]): ManagementReviewItem {
  return {
    ref: refOf(ENTITY, row.id, row.code, row.updated_at),
    code: row.code,
    title: row.title,
    owner: ownerHandle ?? 'none',
    plannedAt: row.planned_at,
    heldAt: row.held_at,
    status: row.status,
    decisionsRecorded: row.decisions_recorded,
    decisionsText: row.decisions_text,
    linkedMs: [...linked],
    inputs: inputs.map((i) => ({
      defCode: i.def_code, title: i.title, mandatory: i.mandatory, ms: i.ms_slug, complete: typeof i.content === 'string' && i.content.trim() !== '', content: i.content,
    })),
  };
}
