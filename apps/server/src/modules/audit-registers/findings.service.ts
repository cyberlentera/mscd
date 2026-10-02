// Findings (D.3 "Registers and workflows: audit side", C.13 `finding.status`, BR-06, BR-07, BR-08, PRD 8.1 and 8.2,
// WP-37): the finding register of a system with its linked corrective actions, raising a finding, changing it
// (including its RCA and systemic check texts), and its status moves. Closing checks BR-06 and BR-07 for major
// findings and BR-08 for major and minor findings (a linked corrective action closed and effective); OFI, signal and
// "not a finding" close with a close note. A reopen needs a reason, which becomes the status note.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CommandResult, FindingCreate, FindingItem, FindingListQuery, FindingPatch, FindingTransition, Page, RecordRef,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, SCOPE_POLICY, type AuditWriter, type AuthzState, type MembershipService, type MsRef,
  type Principal, type RecordResolver, type ScopePolicy, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import type { Br06Input, Br07Input, Br08Input } from './rules';
import {
  assertRequires, auditEventOf, bump, commandResult, constraintOf, duplicateCode, editionOf, filled, isPgError, nextPosition, orgOf, pickTransition, refOf, ruleError,
  todayOf,
} from './support';

const ENTITY = 'finding';
const MACHINE = 'finding.status' as const;

/** Classifications that close only through a closed and effective corrective action (BR-08). */
const NEEDS_CORRECTIVE_ACTION: ReadonlySet<string> = new Set(['major', 'minor']);

export interface FindingRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  audit_event_id: string | null;
  code: string;
  title: string;
  classification: FindingItem['classification'];
  clause_ref: string | null;
  source: FindingItem['source'];
  status: FindingItem['status'];
  status_note: string | null;
  owner_user_id: string | null;
  raised_at: string | null;
  due_at: string | null;
  rca_text: string | null;
  systemic_check_text: string | null;
  closed_at: string | null;
  closed_by_user_id: string | null;
  close_note: string | null;
}

/** What a new finding row holds (the create route and raising a finding from a self-assessment gap). */
export interface NewFinding {
  code: string;
  title: string;
  classification: FindingItem['classification'];
  clauseRef: string | null;
  source: FindingItem['source'];
  auditEventId: string | null;
  ownerUserId: string | null;
  ownerHandle: string;
  dueAt: string | null;
}

@Injectable()
export class FindingsService {
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
  // GET /ms/{ms}/findings
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, authz: AuthzState | null, ms: string, query: FindingListQuery): Promise<Page<FindingItem>> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const readScope = await this.scope.readScope(trx, principal, ms, authz ?? { ms, granted: new Map(), ownOnly: false });
      const { rows } = await sql<FindingRow & { owner_handle: string | null; owner_name: string | null; event_label: string | null; actions: CaLink[] | null }>`
        select f.*, o.handle as owner_handle, o.display_name as owner_name, e.short_label as event_label,
               (select json_agg(json_build_object('id', c.id, 'code', c.code, 'status', c.status, 'updated_at', c.updated_at) order by c.code)
                  from corrective_action_finding l join corrective_action c on c.id = l.corrective_action_id and c.deleted_at is null
                 where l.finding_id = f.id and l.deleted_at is null) as actions
          from finding f
          left join platform.app_user o on o.id = f.owner_user_id
          left join audit_event e on e.id = f.audit_event_id and e.deleted_at is null
         where f.management_system_id = ${system.id} and f.deleted_at is null
           and (${query.status ?? null}::text is null or f.status = ${query.status ?? null})
           and (${query.classification ?? null}::text is null or f.classification = ${query.classification ?? null})
           and (${query.source ?? null}::text is null or f.source = ${query.source ?? null})
         order by f.position, f.code`.execute(trx);
      const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const items = rows
        .filter((row) => {
          if (words.length === 0) return true;
          const haystack = [row.code, row.title, row.clause_ref, row.owner_name, row.owner_handle, row.status_note].filter(Boolean).join(' ').toLowerCase();
          return words.every((w) => haystack.includes(w));
        })
        .map((row) => ({ ownerUserId: row.owner_user_id, item: itemOf(row, row.owner_handle, row.event_label, row.actions ?? []) }));
      const visible = this.scope.filter(readScope, items);
      const start = (query.page - 1) * query.pageSize;
      return { items: visible.slice(start, start + query.pageSize).map((v) => v.item), page: query.page, pageSize: query.pageSize, total: visible.length };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/findings
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: FindingCreate): Promise<CommandResult> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      // An audit event named by the finding must be linked to the path system (404 otherwise, F.7).
      const auditEventId = body.auditEventId ? (await auditEventOf(trx, system, body.auditEventId)).id : null;
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const created = await this.insert(trx, principal, system, {
        code: body.code, title: body.title, classification: body.classification, clauseRef: body.clauseRef ?? null, source: body.source,
        auditEventId, ownerUserId: owner, ownerHandle: body.ownerHandle, dueAt: body.dueAt ?? null,
      });
      return commandResult([system.slug], { ref: created });
    });
  }

  /** Inserts a finding of the system (status `open`, raised today) and writes `finding.created`; returns its ref. */
  async insert(trx: Trx, principal: Principal, system: MsRef, finding: NewFinding, extraAudit: Record<string, unknown> = {}): Promise<RecordRef> {
    const actor = principal.user.id;
    const today = todayOf(this.clock, orgOf(principal));
    const id = randomUUID();
    const position = await nextPosition(trx, 'finding', system.id);
    const edition = await editionOf(trx, system.id);
    let updatedAt: Date;
    try {
      const inserted = await trx
        .insertInto('finding')
        .values({
          id,
          management_system_id: system.id,
          framework_version_id: edition,
          audit_event_id: finding.auditEventId,
          code: finding.code,
          title: finding.title,
          classification: finding.classification,
          clause_ref: finding.clauseRef,
          source: finding.source,
          status: 'open',
          owner_user_id: finding.ownerUserId,
          raised_at: today,
          due_at: finding.dueAt,
          position,
          created_by: actor,
          updated_by: actor,
        })
        .returning(['updated_at'])
        .executeTakeFirstOrThrow();
      updatedAt = new Date(inserted.updated_at);
    } catch (error) {
      duplicateCode(error, finding.code);
    }
    await this.audit.record(trx, {
      action: 'finding.created',
      msId: system.id,
      entityType: ENTITY,
      entityId: id,
      entityCode: finding.code,
      after: {
        finding_code: finding.code, title: finding.title, classification: finding.classification, clause_ref: finding.clauseRef, source: finding.source,
        owner: finding.ownerHandle, raised_at: today, due_at: finding.dueAt, ...(finding.auditEventId ? { audit_event_id: finding.auditEventId } : {}), ...extraAudit,
      },
    });
    return refOf(ENTITY, id, finding.code, updatedAt!);
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/findings/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, ms: string, id: string, patch: FindingPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as FindingRow;
      assertIfMatch(ifMatch, row.updated_at, refOf(ENTITY, row.id, row.code, row.updated_at));
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof FindingRow, value: unknown, shown: unknown = value) => {
        if ((row[column] ?? null) === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = row[column] ?? null;
        after[column] = shown ?? null;
      };
      if (patch.title !== undefined) change('title', patch.title);
      if (patch.classification !== undefined) change('classification', patch.classification);
      if (patch.clauseRef !== undefined) change('clause_ref', patch.clauseRef);
      if (patch.ownerHandle !== undefined) change('owner_user_id', await this.members.resolveHandle(trx, patch.ownerHandle), patch.ownerHandle);
      if (patch.dueAt !== undefined) change('due_at', patch.dueAt);
      if (patch.rcaText !== undefined) change('rca_text', patch.rcaText);
      if (patch.systemicCheckText !== undefined) change('systemic_check_text', patch.systemicCheckText);
      if (patch.statusNote !== undefined) change('status_note', patch.statusNote);

      // A closed major finding keeps its RCA and systemic check (BR-06, BR-07; the CHECK constraint is the backstop).
      if (row.status === 'closed') {
        const classification = (set.classification ?? row.classification) as string;
        const rca = 'rca_text' in set ? (set.rca_text as string | null) : row.rca_text;
        const systemic = 'systemic_check_text' in set ? (set.systemic_check_text as string | null) : row.systemic_check_text;
        if (classification === 'major' && !filled(rca)) throw ruleError('BR-06', refOf(ENTITY, row.id, row.code, row.updated_at));
        if (classification === 'major' && !filled(systemic)) throw ruleError('BR-07', refOf(ENTITY, row.id, row.code, row.updated_at));
      }

      const changed = Object.keys(after).length > 0;
      let updatedAt = new Date(row.updated_at);
      if (changed) {
        try {
          updatedAt = await bump(trx, ENTITY, row.id, { ...set, updated_by: actor });
        } catch (error) {
          throw mapFindingCheck(error, refOf(ENTITY, row.id, row.code, row.updated_at));
        }
        await this.audit.record(trx, { action: 'finding.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after });
      }
      return commandResult([record.ms.slug], {
        ref: refOf(ENTITY, row.id, row.code, updatedAt),
        ...(changed ? {} : { message: ['Nothing to change', 'Tidak ada yang diubah'] }),
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/findings/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: FindingTransition, ifMatch: string | undefined): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as FindingRow;
      const ref = refOf(ENTITY, row.id, row.code, row.updated_at);
      assertIfMatch(ifMatch, row.updated_at, ref);
      const from = row.status;
      const to = body.to;
      const transition = pickTransition(MACHINE, from, to, authz, false);
      assertRequires(transition, body);
      const today = todayOf(this.clock, orgOf(principal));
      const set: Record<string, unknown> = { status: to, updated_by: actor };
      const before: Record<string, unknown> = { status: from };
      const after: Record<string, unknown> = { status: to };

      if (to === 'closed') {
        const msIds = [record.ms.id];
        await this.rules.enforce<Br06Input>(trx, 'BR-06', { classification: row.classification, rcaText: row.rca_text }, { msIds, ref });
        await this.rules.enforce<Br07Input>(trx, 'BR-07', { classification: row.classification, systemicCheckText: row.systemic_check_text }, { msIds, ref });
        await this.rules.enforce<Br08Input>(trx, 'BR-08', { kind: 'finding', findingId: row.id, classification: row.classification }, { msIds, ref });
        // C.13: OFI, signal and "not a finding" close with a close note (no corrective action is required).
        if (!NEEDS_CORRECTIVE_ACTION.has(row.classification) && !filled(body.note)) {
          throw new ValidationError([{ path: 'body.note', message: `A ${row.classification} finding closes with a close note` }], 'The close note is missing');
        }
        Object.assign(set, { closed_at: today, closed_by_user_id: actor, close_note: body.note ?? null });
        Object.assign(after, { closed_at: today, closed_by: principal.user.handle, ...(body.note ? { close_note: body.note } : {}) });
      } else if (from === 'closed') {
        // Reopen (C.13: note required): the reason becomes the status note; the closure is cleared.
        Object.assign(set, { closed_at: null, closed_by_user_id: null, close_note: null, status_note: body.note });
        Object.assign(before, { closed_at: row.closed_at, close_note: row.close_note });
        Object.assign(after, { reason: body.note });
      } else if (body.note) {
        set.status_note = body.note;
        after.note = body.note;
      }
      let updatedAt: Date;
      try {
        updatedAt = await bump(trx, ENTITY, row.id, set);
      } catch (error) {
        throw mapFindingCheck(error, ref);
      }
      await this.audit.record(trx, { action: 'finding.transition', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after });
      return commandResult([record.ms.slug], { ref: refOf(ENTITY, row.id, row.code, updatedAt) });
    });
  }
}

/** A corrective action as the finding register lists it. */
interface CaLink {
  id: string;
  code: string;
  status: FindingItem['correctiveActions'][number]['status'];
  updated_at: string;
}

function itemOf(row: FindingRow, ownerHandle: string | null, eventLabel: string | null, actions: readonly CaLink[]): FindingItem {
  return {
    ref: refOf(ENTITY, row.id, row.code, row.updated_at),
    code: row.code,
    title: row.title,
    classification: row.classification,
    source: row.source,
    clauseRef: row.clause_ref,
    status: row.status,
    owner: ownerHandle ?? 'none',
    raisedAt: row.raised_at,
    dueAt: row.due_at,
    auditEvent: row.audit_event_id && eventLabel !== null ? { id: row.audit_event_id, shortLabel: eventLabel } : null,
    correctiveActions: actions.map((a) => ({ ref: refOf('corrective_action', a.id, a.code, a.updated_at), code: a.code, status: a.status })),
  };
}

/** The `finding` CHECK constraint on closed major findings, answered as the rule it backs (BR-06). */
function mapFindingCheck(error: unknown, ref: RecordRef): unknown {
  if (isPgError(error, '23514') && (constraintOf(error) ?? '').startsWith('finding_')) return ruleError('BR-06', ref);
  return error;
}
