// Corrective actions (D.3 "Registers and workflows: audit side", C.13 `corrective_action.status`, BR-08, BR-09,
// PRD 8.1 and 8.2, WP-37): the corrective actions of a system with their findings, creating one for one or more
// findings of the system (one action may close similar findings of a joint audit, `corrective_action_finding`),
// changing it, and its step machine: correction, root cause analysis, systemic check and action, one step at a time
// with the step's text; entering the effectiveness verification records the implementer and the date; the
// verification (by someone other than the implementer and the owner, BR-09, on another day than the
// implementation, BR-08) closes it when effective and returns it to the action step when not. The CHECK
// constraints of `corrective_action` are the database backstop of BR-08 and BR-09.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CommandResult, CorrectiveActionCreate, CorrectiveActionItem, CorrectiveActionListQuery, CorrectiveActionPatch, CorrectiveActionStatus,
  CorrectiveActionTransition, Page, RecordRef,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, SCOPE_POLICY, type AuditWriter, type AuthzState, type MembershipService, type Principal,
  type RecordResolver, type ScopePolicy, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import type { Br08Input, Br09Input } from './rules';
import {
  assertRequires, bump, commandResult, duplicateCode, isPgError, orgOf, pickTransition, refOf, ruleError, todayOf, unprocessable,
} from './support';

const ENTITY = 'corrective_action';
const MACHINE = 'corrective_action.status' as const;

/** The text column each step writes when it is left (C.13). */
const STEP_TEXT: Readonly<Partial<Record<CorrectiveActionStatus, 'correction_text' | 'rca_text' | 'systemic_check_text' | 'action_text'>>> = {
  correction: 'correction_text',
  rca: 'rca_text',
  systemic_check: 'systemic_check_text',
  action: 'action_text',
};

/** States from which the action is finished (no further step, no change of its findings). */
const FINISHED: ReadonlySet<CorrectiveActionStatus> = new Set(['closed', 'cancelled']);

export interface CorrectiveActionRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  code: string;
  title: string;
  owner_user_id: string | null;
  status: CorrectiveActionStatus;
  correction_text: string | null;
  rca_text: string | null;
  systemic_check_text: string | null;
  action_text: string | null;
  due_at: string | null;
  implemented_at: string | null;
  implemented_by_user_id: string | null;
  verified_by_user_id: string | null;
  verified_at: string | null;
  effective: boolean | null;
  verification_note: string | null;
}

interface ListRow extends CorrectiveActionRow {
  owner_handle: string | null;
  implemented_by_handle: string | null;
  verified_by_handle: string | null;
  findings: { id: string; code: string; updated_at: string }[] | null;
}

@Injectable()
export class CorrectiveActionsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(SCOPE_POLICY) private readonly scope: ScopePolicy,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/corrective-actions
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, authz: AuthzState | null, ms: string, query: CorrectiveActionListQuery): Promise<Page<CorrectiveActionItem>> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const readScope = await this.scope.readScope(trx, principal, ms, authz ?? { ms, granted: new Map(), ownOnly: false });
      const { rows } = await sql<ListRow>`
        select c.*, o.handle as owner_handle, i.handle as implemented_by_handle, v.handle as verified_by_handle,
               (select json_agg(json_build_object('id', f.id, 'code', f.code, 'updated_at', f.updated_at) order by f.code)
                  from corrective_action_finding l join finding f on f.id = l.finding_id and f.deleted_at is null
                 where l.corrective_action_id = c.id and l.deleted_at is null) as findings
          from corrective_action c
          left join platform.app_user o on o.id = c.owner_user_id
          left join platform.app_user i on i.id = c.implemented_by_user_id
          left join platform.app_user v on v.id = c.verified_by_user_id
         where c.management_system_id = ${system.id} and c.deleted_at is null
           and (${query.status ?? null}::text is null or c.status = ${query.status ?? null})
         order by c.code`.execute(trx);
      const items = rows.map((row) => ({ ownerUserId: row.owner_user_id, holderUserId: row.implemented_by_user_id, item: itemOf(row) }));
      const visible = this.scope.filter(readScope, items);
      const start = (query.page - 1) * query.pageSize;
      return { items: visible.slice(start, start + query.pageSize).map((v) => v.item), page: query.page, pageSize: query.pageSize, total: visible.length };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/corrective-actions
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: CorrectiveActionCreate): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const findings = await this.findingsOf(trx, ms, body.findingIds);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const id = randomUUID();
      let updatedAt: Date;
      try {
        const inserted = await trx
          .insertInto('corrective_action')
          .values({
            id, management_system_id: system.id, code: body.code, title: body.title, owner_user_id: owner, status: 'correction',
            due_at: body.dueAt ?? null, created_by: actor, updated_by: actor,
          })
          .returning(['updated_at'])
          .executeTakeFirstOrThrow();
        updatedAt = new Date(inserted.updated_at);
      } catch (error) {
        duplicateCode(error, body.code);
      }
      await this.linkFindings(trx, id, findings.map((f) => f.id), actor);
      await this.audit.record(trx, {
        action: 'corrective_action.created',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: body.code,
        after: {
          corrective_action_code: body.code, title: body.title, owner: body.ownerHandle, due_at: body.dueAt ?? null, status: 'correction',
          findings: findings.map((f) => f.code),
        },
      });
      return commandResult([system.slug], { ref: refOf(ENTITY, id, body.code, updatedAt!), data: { findings: findings.map((f) => f.ref) } });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/corrective-actions/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, ms: string, id: string, patch: CorrectiveActionPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as CorrectiveActionRow;
      const ref = refOf(ENTITY, row.id, row.code, row.updated_at);
      assertIfMatch(ifMatch, row.updated_at, ref);
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof CorrectiveActionRow, value: unknown, shown: unknown = value) => {
        if ((row[column] ?? null) === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = row[column] ?? null;
        after[column] = shown ?? null;
      };
      if (patch.title !== undefined) change('title', patch.title);
      if (patch.ownerHandle !== undefined) change('owner_user_id', await this.members.resolveHandle(trx, patch.ownerHandle), patch.ownerHandle);
      if (patch.dueAt !== undefined) change('due_at', patch.dueAt);
      // BR-09: a verified action never gets its verifier as owner (the CHECK constraint is the backstop).
      if ('owner_user_id' in set && row.verified_by_user_id !== null && set.owner_user_id === row.verified_by_user_id) throw ruleError('BR-09', ref);

      let findingsChanged = false;
      if (patch.findingIds !== undefined) {
        const current = await this.linkedFindings(trx, row.id);
        const wanted = [...new Set(patch.findingIds)];
        const same = current.length === wanted.length && current.every((f) => wanted.includes(f.id));
        if (!same) {
          if (FINISHED.has(row.status)) {
            throw unprocessable(
              'audit.corrective_action_finished',
              `The findings of a ${row.status} corrective action cannot change`,
              `Temuan dari tindakan korektif berstatus ${row.status} tidak dapat diubah`,
            );
          }
          const findings = await this.findingsOf(trx, ms, wanted);
          await sql`update corrective_action_finding set deleted_at = now(), updated_at = now(), updated_by = ${actor}
                     where corrective_action_id = ${row.id} and deleted_at is null
                       and not (finding_id = any(${wanted}::uuid[]))`.execute(trx);
          await this.linkFindings(trx, row.id, findings.filter((f) => !current.some((c) => c.id === f.id)).map((f) => f.id), actor);
          before.findings = current.map((f) => f.code);
          after.findings = findings.map((f) => f.code);
          findingsChanged = true;
        }
      }

      const changed = Object.keys(after).length > 0;
      let updatedAt = new Date(row.updated_at);
      if (changed) {
        try {
          updatedAt = await bump(trx, ENTITY, row.id, { ...set, updated_by: actor });
        } catch (error) {
          throw mapActionCheck(error, ref, 'BR-09');
        }
        await this.audit.record(trx, { action: 'register.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after });
      }
      return commandResult([record.ms.slug], {
        ref: refOf(ENTITY, row.id, row.code, updatedAt),
        ...(changed ? {} : { message: ['Nothing to change', 'Tidak ada yang diubah'] }),
        ...(findingsChanged ? { data: { findings: after.findings } } : {}),
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/corrective-actions/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    id: string,
    body: CorrectiveActionTransition,
    ifMatch: string | undefined,
  ): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as CorrectiveActionRow;
      const ref = refOf(ENTITY, row.id, row.code, row.updated_at);
      assertIfMatch(ifMatch, row.updated_at, ref);
      const from = row.status;
      let to: CorrectiveActionStatus = body.to;
      // C.13: a verification that finds the action not effective returns it to the action step instead of closing it.
      if (from === 'effectiveness_verification' && to === 'closed' && body.effective === false) to = 'action';
      if (from === 'effectiveness_verification' && to === 'action' && body.effective === true) {
        throw new ValidationError([{ path: 'body.effective', message: 'An effective verification closes the action' }], 'Use to: closed for an effective verification');
      }
      const transition = pickTransition(MACHINE, from, to, authz, row.owner_user_id === actor);
      assertRequires(transition, body);
      const today = todayOf(this.clock, orgOf(principal));
      const msIds = [record.ms.id];
      const set: Record<string, unknown> = { status: to, updated_by: actor };
      const before: Record<string, unknown> = { status: from };
      const after: Record<string, unknown> = { status: to };

      const stepColumn = STEP_TEXT[from];
      if (to === 'cancelled') {
        after.note = body.note;
      } else if (from === 'effectiveness_verification') {
        // BR-09 on both outcomes; BR-08 when the action closes (verified on another day than implemented).
        await this.rules.enforce<Br09Input>(trx, 'BR-09', { verifierId: actor, implementerId: row.implemented_by_user_id, ownerId: row.owner_user_id }, { msIds, ref });
        if (to === 'closed') {
          await this.rules.enforce<Br08Input>(trx, 'BR-08', { kind: 'verification', implementedAt: row.implemented_at, verifiedAt: today }, { msIds, ref });
          Object.assign(set, { verified_by_user_id: actor, verified_at: today, effective: true, verification_note: body.note ?? null });
          Object.assign(after, { verified_by: principal.user.handle, verified_at: today, effective: true, ...(body.note ? { note: body.note } : {}) });
        } else {
          set.verification_note = body.note ?? null;
          Object.assign(after, { effective: false, verified_by: principal.user.handle, ...(body.note ? { note: body.note } : {}) });
        }
      } else if (stepColumn) {
        // One step forward with the text of the step being left.
        set[stepColumn] = body.text;
        before[stepColumn] = row[stepColumn];
        after[stepColumn] = body.text;
        if (to === 'effectiveness_verification') {
          Object.assign(set, { implemented_by_user_id: actor, implemented_at: today });
          Object.assign(after, { implemented_by: principal.user.handle, implemented_at: today });
        }
      }
      let updatedAt: Date;
      try {
        updatedAt = await bump(trx, ENTITY, row.id, set);
      } catch (error) {
        throw mapActionCheck(error, ref, actor === row.implemented_by_user_id || actor === row.owner_user_id ? 'BR-09' : 'BR-08');
      }
      await this.audit.record(trx, {
        action: 'corrective_action.transition', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after,
      });
      const result: { ref: RecordRef; message?: [string, string] } = { ref: refOf(ENTITY, row.id, row.code, updatedAt) };
      if (from === 'effectiveness_verification' && to === 'action') {
        result.message = ['Not effective: the corrective action returns to the action step', 'Tidak efektif: tindakan korektif kembali ke langkah tindakan'];
      }
      return commandResult([record.ms.slug], result);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** The findings by id, each resolved in the path system (404 for a finding of another system, D.3). */
  private async findingsOf(trx: Trx, ms: string, ids: readonly string[]): Promise<{ id: string; code: string; ref: RecordRef }[]> {
    const out: { id: string; code: string; ref: RecordRef }[] = [];
    for (const id of [...new Set(ids)]) {
      const record = await this.records.resolve(trx, ms, 'finding', id);
      const row = record.row as { code: string; updated_at: Date };
      out.push({ id, code: row.code, ref: refOf('finding', id, row.code, row.updated_at) });
    }
    return out;
  }

  private async linkedFindings(trx: Trx, actionId: string): Promise<{ id: string; code: string }[]> {
    const { rows } = await sql<{ id: string; code: string }>`
      select f.id, f.code from corrective_action_finding l join finding f on f.id = l.finding_id
       where l.corrective_action_id = ${actionId} and l.deleted_at is null order by f.code`.execute(trx);
    return rows;
  }

  private async linkFindings(trx: Trx, actionId: string, findingIds: readonly string[], actor: string): Promise<void> {
    for (const findingId of findingIds) {
      await sql`insert into corrective_action_finding (corrective_action_id, finding_id, created_by, updated_by)
                values (${actionId}, ${findingId}, ${actor}, ${actor})`.execute(trx);
    }
  }
}

function itemOf(row: ListRow): CorrectiveActionItem {
  return {
    ref: refOf(ENTITY, row.id, row.code, row.updated_at),
    code: row.code,
    title: row.title,
    status: row.status,
    owner: row.owner_handle ?? 'none',
    dueAt: row.due_at,
    correctionText: row.correction_text,
    rcaText: row.rca_text,
    systemicCheckText: row.systemic_check_text,
    actionText: row.action_text,
    implementedAt: row.implemented_at,
    implementedBy: row.implemented_by_handle,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by_handle,
    effective: row.effective,
    findings: (row.findings ?? []).map((f) => ({ ref: refOf('finding', f.id, f.code, f.updated_at), code: f.code })),
  };
}

/**
 * A CHECK violation of `corrective_action` answered as the rule it backs (the verifier checks are BR-09, the
 * verification date check BR-08); the caller names the rule its change could break.
 */
function mapActionCheck(error: unknown, ref: RecordRef, rule: 'BR-08' | 'BR-09'): unknown {
  return isPgError(error, '23514') ? ruleError(rule, ref) : error;
}

