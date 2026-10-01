// Activity and phase commands of D.3 (WP-20): status transitions of an implementation activity through the C.13
// table (start, complete, verify, reject, block, unblock) and the verification of a phase. Rules: BR-12 (critical
// gates, D-13), BR-39 (blocker names a current gate item), BR-40 (controlled-document output linked before
// completion), BR-47 (warning when the output document contradicts the activity), VERIFY-SELF (A.4 5.4, A-48) and
// the BR-46 flag for the implementation summary.
import { Inject, Injectable } from '@nestjs/common';
import type { ActivityTransitionRequest, CommandResult, Pair, Warning } from '@mscd/shared';
import { sql, type Updateable } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { BusinessRuleError, NotFoundError } from '../../common/problems';
import {
  AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type AuthzState, type MsRef, type Principal, type RecordResolver, type TenantInfo, type Trx,
} from '../../common/tokens';
import type { DB } from '../../db/types';
import { ReadModelService } from '../read-model';
import { mergeWarnings, RuleEngine, ruleMessageKey, ruleMessages, type RuleFinding } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { assertRequires, commandResult, orgOf, pickTransition, refOf, todayOf } from './command-support';
import type { Br12Input, Br39Input, Br40Input, Br46Input, Br47Input, VerifySelfInput } from './rules';

const ENTITY = 'implementation_activity_progress';
const MACHINE = 'implementation_activity_progress.status' as const;

type ActivityStatus = 'not_started' | 'in_progress' | 'complete' | 'verified' | 'blocked';

interface ActivityRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  phase_no: number;
  activity_no: number;
  title: string;
  output_document_code: string | null;
  output_document_id: string | null;
  is_gate_phase: boolean;
  owner_user_id: string | null;
  status: ActivityStatus;
  blocker_gate_item_ref: string | null;
  blocker_reason: string | null;
  completed_at: string | null;
  completed_by_user_id: string | null;
  verified_at: string | null;
  verified_by_user_id: string | null;
}

/** G.5 business id of an activity: `<phase>.<activity>`. */
export function activityBusinessId(row: Pick<ActivityRow, 'phase_no' | 'activity_no'>): string {
  return `${row.phase_no}.${row.activity_no}`;
}

/** Result of the BR-46 check of one system (the implementation summary shows it to the MS Manager). */
export interface GateConsistency {
  /** Phase numbers of the system's critical gate phases. */
  gatePhases: number[];
  blockedActivities: number;
  openGateItems: number;
  /** The BR-46 finding when the counts differ and the rule is active, else null. */
  finding: RuleFinding | null;
}

@Injectable()
export class ActivityService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    private readonly readModel: ReadModelService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/activities/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    id: string,
    body: ActivityTransitionRequest,
    ifMatch: string | undefined,
  ): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as ActivityRow;
      const code = activityBusinessId(row);
      assertIfMatch(ifMatch, row.updated_at, refOf(ENTITY, row.id, code, row.updated_at));
      const from = row.status;
      const to = body.to;
      const transition = pickTransition(MACHINE, from, to, authz, row.owner_user_id === actor);
      assertRequires(transition, body as Record<string, unknown>);
      const ref = refOf(ENTITY, row.id, code, row.updated_at);
      const scope = { msIds: [row.management_system_id], ref };
      const today = todayOf(this.clock, org);

      if (transition.rules.includes('BR-12')) {
        await this.rules.enforce<Br12Input>(trx, 'BR-12', { kind: 'start', phaseNo: row.phase_no }, scope);
      }
      const set: Updateable<DB['implementation_activity_progress']> = { status: to, updated_by: actor };
      let outputDocumentId = row.output_document_id;
      if (to === 'complete') {
        outputDocumentId = await this.outputDocument(trx, record.ms, row, body.outputDocumentCode);
        await this.rules.enforce<Br40Input>(trx, 'BR-40', { outputDocumentCode: row.output_document_code, outputDocumentId }, scope);
        Object.assign(set, { output_document_id: outputDocumentId, completed_by_user_id: actor, completed_at: today, verified_by_user_id: null, verified_at: null });
      } else if (to === 'verified') {
        await this.rules.enforce<VerifySelfInput>(trx, 'VERIFY-SELF', { actorId: actor, excluded: [row.completed_by_user_id, row.owner_user_id] }, scope);
        Object.assign(set, { verified_by_user_id: actor, verified_at: today });
      } else if (to === 'blocked') {
        const gateItems = await this.gateItemIds(trx, org, record.ms.slug);
        await this.rules.enforce<Br39Input>(trx, 'BR-39', { gateItemRef: body.blockerGateItemRef!, gateItems }, scope);
        Object.assign(set, { blocker_gate_item_ref: body.blockerGateItemRef!.trim(), blocker_reason: body.blockerReason! });
      } else if (to === 'in_progress') {
        if (from === 'complete') Object.assign(set, { completed_by_user_id: null, completed_at: null });
        if (from === 'blocked') Object.assign(set, { blocker_gate_item_ref: null, blocker_reason: null });
      }

      const updated = await trx
        .updateTable('implementation_activity_progress')
        .set({ ...set, updated_at: sql<Date>`greatest(clock_timestamp(), updated_at + interval '1 millisecond')` })
        .where('id', '=', row.id)
        .returning(['updated_at'])
        .executeTakeFirstOrThrow();

      // Audit: one entry per C.13 step; from not_started to complete is two steps (A.4 5.12).
      const steps: [ActivityStatus, ActivityStatus][] = from === 'not_started' && to === 'complete' ? [['not_started', 'in_progress'], ['in_progress', 'complete']] : [[from, to]];
      for (const [stepFrom, stepTo] of steps) {
        const before: Record<string, unknown> = { status: stepFrom };
        const after: Record<string, unknown> = { status: stepTo };
        if (stepTo === to) {
          for (const key of Object.keys(set) as (keyof typeof set)[]) {
            if (key === 'status' || key === 'updated_by') continue;
            before[key] = row[key as keyof ActivityRow] ?? null;
            after[key] = set[key] ?? null;
          }
          if (body.rejectReason) after.reject_reason = body.rejectReason;
        }
        await this.audit.record(trx, {
          action: 'activity.transition',
          msId: row.management_system_id,
          entityType: ENTITY,
          entityId: row.id,
          entityCode: code,
          before,
          after,
        });
      }

      let warnings: Warning[] = [];
      if (outputDocumentId) {
        const document = await trx.selectFrom('document').select(['doc_code', 'status']).where('id', '=', outputDocumentId).executeTakeFirst();
        if (document) {
          warnings = mergeWarnings(
            warnings,
            await this.rules.enforce<Br47Input>(trx, 'BR-47', { activityStatus: to, documentCode: document.doc_code, documentStatus: document.status }, scope),
          );
        }
      }
      return commandResult([record.ms.slug], { ref: refOf(ENTITY, row.id, code, new Date(updated.updated_at)), warnings });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/phases/{n}/verify
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Confirms that phase `n` is verified (BR-12: every activity `verified`). The first confirmation after the last
   * change of the phase's activities writes `phase.verified`; a repeat changes nothing and answers "Phase n is
   * already verified". Nothing in the bundles changes either way (the phase state is derived, D-13).
   */
  async verifyPhase(principal: Principal, ms: string, phaseNo: number): Promise<CommandResult> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const { rows } = await sql<{ total: number; verified: number; last_change: Date | null; gate: boolean }>`
        select count(*)::int as total, count(*) filter (where status = 'verified')::int as verified,
               max(updated_at) as last_change, coalesce(bool_or(is_gate_phase), false) as gate
          from implementation_activity_progress
         where management_system_id = ${system.id} and phase_no = ${phaseNo} and deleted_at is null`.execute(trx);
      const counts = rows[0]!;
      if (counts.total === 0) throw new NotFoundError(`Phase ${phaseNo} has no activities`);
      await this.rules.enforce<Br12Input>(trx, 'BR-12', { kind: 'phase', phaseNo, total: counts.total, verified: counts.verified }, { msIds: [system.id] });

      const earlier = await sql<{ id: string }>`
        select id from audit_trail
         where action = 'phase.verified' and management_system_id = ${system.id} and entity_type = 'phase'
           and entity_code = ${String(phaseNo)} and occurred_at >= ${counts.last_change}
         limit 1`.execute(trx);
      if (earlier.rows.length > 0) {
        return commandResult([], { message: [`Phase ${phaseNo} is already verified`, `Fase ${phaseNo} sudah terverifikasi`] as Pair });
      }
      await this.audit.record(trx, {
        action: 'phase.verified',
        msId: system.id,
        entityType: 'phase',
        entityCode: String(phaseNo),
        after: { phase_no: phaseNo, activities: counts.total, gate: counts.gate },
      });
      return commandResult([], { message: [`Phase ${phaseNo} verified`, `Fase ${phaseNo} terverifikasi`] as Pair });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // BR-46
  // -------------------------------------------------------------------------------------------------------------

  /** BR-46 for one system in the caller's transaction: blocked activities of the gate phase against open gate items. */
  async gateConsistencyIn(trx: Trx, org: TenantInfo, ms: string): Promise<GateConsistency> {
    const system = await this.records.resolveMs(trx, ms);
    const snapshot = await this.readModel.systemSnapshotIn(trx, org, ms);
    const gatePhases = snapshot.bundle.phases.filter((p) => p.gate);
    const blockedActivities = gatePhases.reduce((n, p) => n + p.c.blocked, 0);
    const openGateItems = snapshot.bundle.gates.length;
    const findings = gatePhases.length > 0
      ? await this.rules.evaluate<Br46Input>(trx, 'BR-46', { blockedActivities, openGateItems }, { msIds: [system.id] })
      : [];
    return { gatePhases: gatePhases.map((p) => p.no), blockedActivities, openGateItems, finding: findings[0] ?? null };
  }

  /** BR-46 for one system of the caller's organisation. */
  gateConsistency(principal: Principal, ms: string): Promise<GateConsistency> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), (trx) => this.gateConsistencyIn(trx, org, ms));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Business ids of the system's current gate items (A-27, the read model's `bundle.gates`). */
  private async gateItemIds(trx: Trx, org: TenantInfo, ms: string): Promise<string[]> {
    const snapshot = await this.readModel.systemSnapshotIn(trx, org, ms);
    return snapshot.bundle.gates.map((g) => g.id);
  }

  /**
   * The register document an activity's output is linked to on completion: the code of the request, else the stored
   * link, else the document whose code the template names (when the register holds it). A requested code the
   * system's register does not hold is a BR-40 violation.
   */
  private async outputDocument(trx: Trx, system: MsRef, row: ActivityRow, requested: string | undefined): Promise<string | null> {
    if (requested) {
      const id = await this.documentOf(trx, system, requested);
      if (!id) {
        throw new BusinessRuleError('BR-40', ruleMessages('BR-40'), refOf(ENTITY, row.id, activityBusinessId(row), row.updated_at), {
          messageKey: ruleMessageKey('BR-40'),
        });
      }
      return id;
    }
    if (row.output_document_id) return row.output_document_id;
    return row.output_document_code ? this.documentOf(trx, system, row.output_document_code) : null;
  }

  /** A live document of the system (linked to it, or organisation-wide) by its code. */
  private async documentOf(trx: Trx, system: MsRef, code: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      select d.id from document d
       where d.deleted_at is null and d.doc_code = ${code}
         and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                         and l.management_system_id = ${system.id} and l.deleted_at is null))
       limit 1`.execute(trx);
    return rows[0]?.id ?? null;
  }
}
