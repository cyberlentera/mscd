// Risk treatments and residual acceptance (D.3 "Registers and workflows: risk side", C.13 `risk_treatment.status`,
// BR-04, WP-36): new treatments of a risk aimed at a catalogue item or requirement of the active edition, their
// changes, their status moves through the C.13 table, and the residual acceptance by the risk's owner (never the
// implementer; the `residual_acceptance` row keeps a snapshot of the implementer and its CHECK constraint is the
// database backstop). The chain records (C.10) stay meaningful for the read model: each treatment status carries
// its own pending action, an implemented treatment hands the risk the residual acceptance action, and a treatment
// that no longer waits for anyone has none.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  rejectionFor,
  transitionsVia,
  type CommandResult,
  type ResidualAcceptanceRequest,
  type TreatmentCreate,
  type TreatmentPatch,
  type TreatmentStatus,
  type TreatmentTransition,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, type AuditWriter, type AuthzState, type MembershipService, type MsRef, type Principal,
  type RecordResolver, type Trx,
} from '../../common/tokens';
import { ruleMessageKey, ruleMessages, RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { RISK_NEEDS_TREATMENT } from './registers.service';
import type { Br04Input } from './rules';
import { bump, commandResult, duplicateCode, editionOf, grantedInFull, linksOf, orgOf, pickTransition, refOf, targetOf, todayOf } from './support';

const ENTITY = 'risk_treatment';
const MACHINE = 'risk_treatment.status' as const;
const RESIDUAL_VIA = 'risks.residual-acceptance';

/** Chain record text of a treatment per status (null: the treatment waits for nobody). */
export const TREATMENT_ACTIONS: Readonly<Record<TreatmentStatus, string | null>> = {
  proposed: 'Approve the treatment',
  approved: 'Start the implementation',
  in_progress: 'Report implementation progress',
  delayed: 'Report implementation progress: the target date has passed',
  implemented: null,
  residual_accepted: null,
  closed: null,
};

/** Chain record text of a risk whose treatment is implemented (the sample's wording, UI 1.8). */
export const RISK_NEEDS_ACCEPTANCE = 'Residual risk acceptance by Risk Owner';

interface TreatmentRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  code: string;
  title: string;
  owner_user_id: string | null;
  pending_action: string | null;
  risk_id: string | null;
  target_type: 'catalogue_item' | 'requirement' | null;
  catalogue_item_id: string | null;
  requirement_id: string | null;
  status: TreatmentStatus;
  target_date: string | null;
  implemented_at: string | null;
  implemented_by_user_id: string | null;
  closed_at: string | null;
}

interface RiskRow {
  id: string;
  code: string;
  updated_at: Date;
  owner_user_id: string | null;
  pending_action: string | null;
  residual_likelihood: number | null;
  residual_consequence: number | null;
  residual_accepted_at: string | null;
}

@Injectable()
export class TreatmentsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/risks/{id}/treatments
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, authz: AuthzState | null, ms: string, riskId: string, body: TreatmentCreate): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, 'risk', riskId, { forUpdate: true });
      // F.6: the Risk Owner holds risk.manage only for the assessment fields of own risks, which a treatment is not.
      if (!grantedInFull(authz, 'risk.manage')) throw new ForbiddenError('Adding a treatment needs risk.manage');
      const risk = record.row as unknown as RiskRow;
      if (body.riskCode !== risk.code) {
        throw new ValidationError([{ path: 'body.riskCode', message: `The path names risk ${risk.code}` }], 'riskCode does not match the risk of the path');
      }
      const target = await targetOf(trx, await editionOf(trx, record.ms.id), body.targetType, body.targetCode);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      await this.assertCodeFree(trx, record.ms, body.code, null);

      const id = randomUUID();
      const position = await sql<{ next: number }>`
        select coalesce(max(position), -1)::int + 1 as next from risk_treatment where management_system_id = ${record.ms.id}`.execute(trx);
      let updatedAt: Date;
      try {
        const inserted = await trx
          .insertInto('risk_treatment')
          .values({
            id,
            management_system_id: record.ms.id,
            code: body.code,
            title: body.title,
            owner_user_id: owner,
            pending_action: TREATMENT_ACTIONS.proposed,
            risk_id: risk.id,
            target_type: body.targetType,
            catalogue_item_id: body.targetType === 'catalogue_item' ? target : null,
            requirement_id: body.targetType === 'requirement' ? target : null,
            status: 'proposed',
            target_date: body.targetDate,
            position: position.rows[0]?.next ?? 0,
            created_by: actor,
            updated_by: actor,
          })
          .returning(['updated_at'])
          .executeTakeFirstOrThrow();
        updatedAt = new Date(inserted.updated_at);
      } catch (error) {
        duplicateCode(error, body.code);
      }
      // Up and down references of the chain (D-11): treatment up to its risk and down to its target, risk down to it.
      await sql`insert into record_reference (management_system_id, entity_type, entity_id, direction, target_code, position, created_by, updated_by)
                values (${record.ms.id}, 'risk_treatment', ${id}, 'up', ${risk.code}, 0, ${actor}, ${actor}),
                       (${record.ms.id}, 'risk_treatment', ${id}, 'down', ${body.targetCode}, 0, ${actor}, ${actor}),
                       (${record.ms.id}, 'risk', ${risk.id}, 'down', ${body.code},
                        (select coalesce(max(position), -1) + 1 from record_reference
                          where entity_type = 'risk' and entity_id = ${risk.id} and direction = 'down' and deleted_at is null),
                        ${actor}, ${actor})`.execute(trx);
      // A risk that waited for a treatment no longer does.
      let riskUpdatedAt = new Date(risk.updated_at);
      if (risk.pending_action === RISK_NEEDS_TREATMENT) {
        riskUpdatedAt = await bump(trx, 'risk', risk.id, { pending_action: null, action_completed_at: sql`now()`, action_completed_by: actor, updated_by: actor });
      }
      await this.audit.record(trx, {
        action: 'register.created',
        msId: record.ms.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: body.code,
        after: {
          treatment_code: body.code, title: body.title, risk: risk.code, owner: body.ownerHandle, target_type: body.targetType, target_code: body.targetCode,
          target_date: body.targetDate, status: 'proposed', pending_action: TREATMENT_ACTIONS.proposed,
        },
      });
      return commandResult([record.ms.slug], {
        ref: refOf('audit', ENTITY, id, body.code, updatedAt!),
        data: { risk: refOf('audit', 'risk', risk.id, risk.code, riskUpdatedAt) },
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/treatments/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, authz: AuthzState | null, ms: string, id: string, patch: TreatmentPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      // F.6: the Risk Owner holds risk.manage only for the assessment fields of own risks, which a treatment is not.
      if (!grantedInFull(authz, 'risk.manage')) throw new ForbiddenError('Changing a treatment needs risk.manage');
      const row = record.row as unknown as TreatmentRow;
      assertIfMatch(ifMatch, row.updated_at, refOf('audit', ENTITY, row.id, row.code, row.updated_at));
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof TreatmentRow, value: unknown, shown: unknown = value) => {
        if ((row[column] ?? null) === (value ?? null)) return;
        set[column] = value;
        before[column] = row[column] ?? null;
        after[column] = shown ?? null;
      };
      if (patch.title !== undefined) change('title', patch.title);
      if (patch.ownerHandle !== undefined) change('owner_user_id', await this.members.resolveHandle(trx, patch.ownerHandle), patch.ownerHandle);
      if (patch.targetDate !== undefined) change('target_date', patch.targetDate);
      if (patch.targetType !== undefined && patch.targetCode !== undefined) {
        const target = await targetOf(trx, await editionOf(trx, record.ms.id), patch.targetType, patch.targetCode);
        change('target_type', patch.targetType);
        change('catalogue_item_id', patch.targetType === 'catalogue_item' ? target : null, patch.targetType === 'catalogue_item' ? patch.targetCode : null);
        change('requirement_id', patch.targetType === 'requirement' ? target : null, patch.targetType === 'requirement' ? patch.targetCode : null);
        if (Object.keys(after).some((k) => k === 'catalogue_item_id' || k === 'requirement_id')) {
          await sql`update record_reference set target_code = ${patch.targetCode}, updated_at = now(), updated_by = ${actor}
                     where entity_type = 'risk_treatment' and entity_id = ${row.id} and direction = 'down' and deleted_at is null`.execute(trx);
        }
      }
      const changed = Object.keys(after).length > 0;
      const updatedAt = changed ? await bump(trx, ENTITY, row.id, { ...set, updated_by: actor }) : new Date(row.updated_at);
      if (changed) {
        await this.audit.record(trx, { action: 'register.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after });
      }
      return commandResult([record.ms.slug], {
        ref: refOf('audit', ENTITY, row.id, row.code, updatedAt),
        ...(changed ? {} : { message: ['Nothing to change', 'Tidak ada yang diubah'] }),
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/treatments/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: TreatmentTransition, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as TreatmentRow;
      assertIfMatch(ifMatch, row.updated_at, refOf('audit', ENTITY, row.id, row.code, row.updated_at));
      const from = row.status;
      const to = body.to;
      pickTransition(MACHINE, from, to, authz, row.owner_user_id === actor);
      const today = todayOf(this.clock, org);

      const set: Record<string, unknown> = { status: to, pending_action: TREATMENT_ACTIONS[to], updated_by: actor };
      if (to === 'implemented') Object.assign(set, { implemented_by_user_id: actor, implemented_at: today });
      if (to === 'closed') set.closed_at = today;
      if (TREATMENT_ACTIONS[to] === null && row.pending_action) Object.assign(set, { action_completed_at: sql`now()`, action_completed_by: actor });
      if (TREATMENT_ACTIONS[to] !== null && TREATMENT_ACTIONS[from] === null) Object.assign(set, { action_completed_at: null, action_completed_by: null });
      const updatedAt = await bump(trx, ENTITY, row.id, set);

      const before: Record<string, unknown> = { status: from, pending_action: row.pending_action };
      const after: Record<string, unknown> = { status: to, pending_action: TREATMENT_ACTIONS[to] };
      if (to === 'implemented') Object.assign(after, { implemented_by: principal.user.handle, implemented_at: today });
      if (to === 'closed') after.closed_at = today;
      if (body.note) after.note = body.note;
      await this.audit.record(trx, { action: 'risk.treatment_transition', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.code, before, after });

      // The risk waits for its owner's residual acceptance once a treatment is implemented.
      const changed = [record.ms.slug];
      if (to === 'implemented' && row.risk_id) {
        changed.push(...(await this.setRiskAction(trx, row.risk_id, RISK_NEEDS_ACCEPTANCE, actor, record.ms.id)));
      }
      return commandResult(changed, { ref: refOf('audit', ENTITY, row.id, row.code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/risks/{id}/residual-acceptance
  // -------------------------------------------------------------------------------------------------------------

  async acceptResidual(principal: Principal, ms: string, riskId: string, body: ResidualAcceptanceRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, 'risk', riskId, { forUpdate: true });
      const risk = record.row as unknown as RiskRow;
      // F.6 `risk.residual.accept` is own-scoped for every role: the risk's owner accepts.
      if (risk.owner_user_id !== actor) throw new ForbiddenError("Only the risk's owner can accept its residual risk");
      const treatment = await this.treatmentToAccept(trx, record.ms, risk, body.treatmentId);
      if (transitionsVia(MACHINE, treatment.status, 'residual_accepted', RESIDUAL_VIA).length === 0) {
        const rejection = rejectionFor(MACHINE, treatment.status, 'residual_accepted', RESIDUAL_VIA);
        const rule = rejection?.rule ?? 'BR-04';
        throw new BusinessRuleError(rule, ruleMessages(rule), refOf('audit', ENTITY, treatment.id, treatment.code, treatment.updated_at), {
          messageKey: ruleMessageKey(rule),
        });
      }
      const ref = refOf('audit', 'risk', risk.id, risk.code, risk.updated_at);
      const links = await linksOf(trx, 'risk', risk.id);
      // BR-04: the implementer of the treatment never accepts its residual risk.
      await this.rules.enforce<Br04Input>(trx, 'BR-04', { actorId: actor, implementerId: treatment.implemented_by_user_id }, { msIds: links.map((l) => l.msId), ref });

      const today = todayOf(this.clock, org);
      const score = body.residualLikelihood * body.residualConsequence;
      await trx
        .insertInto('residual_acceptance')
        .values({
          risk_id: risk.id, risk_treatment_id: treatment.id, accepted_by_user_id: actor, implemented_by_user_id: treatment.implemented_by_user_id,
          accepted_at: today, residual_score: score, note: body.note, created_by: actor, updated_by: actor,
        })
        .execute();
      const treatmentUpdatedAt = await bump(trx, ENTITY, treatment.id, { status: 'residual_accepted', pending_action: null, updated_by: actor });
      await this.audit.record(trx, {
        action: 'risk.treatment_transition', msId: record.ms.id, entityType: ENTITY, entityId: treatment.id, entityCode: treatment.code,
        before: { status: treatment.status }, after: { status: 'residual_accepted', accepted_by: principal.user.handle },
      });

      // The risk stops waiting for acceptance when no other treatment of it is implemented and unaccepted.
      const { rows: waiting } = await sql<{ n: number }>`
        select count(*)::int as n from risk_treatment
         where risk_id = ${risk.id} and deleted_at is null and status = 'implemented' and id <> ${treatment.id}`.execute(trx);
      const riskSet: Record<string, unknown> = {
        residual_likelihood: body.residualLikelihood, residual_consequence: body.residualConsequence, residual_accepted_at: today, updated_by: actor,
      };
      const clears = (waiting[0]?.n ?? 0) === 0 && risk.pending_action !== null;
      if (clears) Object.assign(riskSet, { pending_action: null, action_completed_at: sql`now()`, action_completed_by: actor });
      const riskUpdatedAt = await bump(trx, 'risk', risk.id, riskSet);
      await this.audit.record(trx, {
        action: 'risk.residual_accepted',
        msId: record.ms.id,
        entityType: 'risk',
        entityId: risk.id,
        entityCode: risk.code,
        before: {
          residual_likelihood: risk.residual_likelihood, residual_consequence: risk.residual_consequence, residual_accepted_at: risk.residual_accepted_at,
          ...(clears ? { pending_action: risk.pending_action } : {}),
        },
        after: {
          treatment: treatment.code, residual_likelihood: body.residualLikelihood, residual_consequence: body.residualConsequence, residual_score: score,
          residual_accepted_at: today, note: body.note, implemented_by_snapshot: treatment.implemented_by_user_id, ...(clears ? { pending_action: null } : {}),
        },
      });
      return commandResult([...new Set([record.ms.slug, ...links.map((l) => l.slug)])], {
        ref: refOf('audit', 'risk', risk.id, risk.code, riskUpdatedAt),
        data: { treatment: refOf('audit', ENTITY, treatment.id, treatment.code, treatmentUpdatedAt) },
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** The named treatment of the risk in this system, or its only implemented one. */
  private async treatmentToAccept(trx: Trx, system: MsRef, risk: RiskRow, treatmentId: string | undefined): Promise<TreatmentRow> {
    if (treatmentId) {
      const record = await this.records.resolve(trx, system.slug, ENTITY, treatmentId, { forUpdate: true });
      const row = record.row as unknown as TreatmentRow;
      if (row.risk_id !== risk.id) throw new NotFoundError('The treatment does not belong to this risk');
      return row;
    }
    const { rows } = await sql<TreatmentRow>`
      select * from risk_treatment
       where risk_id = ${risk.id} and management_system_id = ${system.id} and deleted_at is null and status = 'implemented'
       order by position, code for update`.execute(trx);
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) {
      throw new ValidationError([{ path: 'body.treatmentId', message: 'The risk has several implemented treatments; name one' }], 'Name the treatment');
    }
    throw new BusinessRuleError('BR-04', ruleMessages('BR-04'), refOf('audit', 'risk', risk.id, risk.code, risk.updated_at), { messageKey: ruleMessageKey('BR-04') });
  }

  /** Sets the risk's pending action (its owner holds it); returns the systems whose bundles change. */
  private async setRiskAction(trx: Trx, riskId: string, action: string, actor: string, msId: string): Promise<string[]> {
    const { rows } = await sql<{ pending_action: string | null; code: string }>`select pending_action, code from risk where id = ${riskId} for update`.execute(trx);
    const current = rows[0];
    if (!current) return [];
    if (current.pending_action !== action) {
      await bump(trx, 'risk', riskId, { pending_action: action, action_due_at: null, action_completed_at: null, action_completed_by: null, updated_by: actor });
      await this.audit.record(trx, {
        action: 'register.updated', msId, entityType: 'risk', entityId: riskId, entityCode: current.code,
        before: { pending_action: current.pending_action }, after: { pending_action: action },
      });
    }
    return (await linksOf(trx, 'risk', riskId)).map((l) => l.slug);
  }

  private async assertCodeFree(trx: Trx, system: MsRef, code: string, exceptId: string | null): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      select id from risk_treatment where management_system_id = ${system.id} and code = ${code} and deleted_at is null
       ${exceptId ? sql`and id <> ${exceptId}` : sql``} limit 1`.execute(trx);
    if (rows.length > 0) throw new ConflictError(`${code} already exists in this system`, { messageKey: 'register.duplicate_code' });
  }
}
