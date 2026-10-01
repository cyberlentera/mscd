// Applicability commands of D.3 (WP-20): status transitions of an entry through the C.13 table, changes of its
// justifications, gate flag, note, frequency, owner, risks and documents, and new entries for a catalogue item or
// requirement of the active edition. Every command resolves the record through `RecordResolver` inside the tenant
// transaction, checks people through `MembershipService`, honours `If-Match`, runs the active rules (BR-01, BR-02,
// BR-03, VERIFY-SELF), writes its audit entry and, where freshness reads the changed state, queues
// `freshness.recompute` in the same transaction.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  transitionsVia,
  type ApplicabilityCreateRequest,
  type ApplicabilityPatch,
  type ApplicabilityTransitionRequest,
  type CommandResult,
  type ImplementationStatus,
  type Warning,
} from '@mscd/shared';
import { sql, type Updateable } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, ProblemError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, type AuditWriter, type AuthzState, type MembershipService, type MsRef, type Principal,
  type RecordResolver, type Trx,
} from '../../common/tokens';
import type { DB } from '../../db/types';
import { mergeWarnings, RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  assertRequires, commandResult, enqueueFreshness, orgOf, pickTransition, refOf, todayOf, windowNowOf,
} from './command-support';
import type { Br01Input, Br02Input, Br03Input, VerifySelfInput } from './rules';

const ENTITY = 'applicability_entry';
const MACHINE = 'applicability_entry.implementation_status' as const;

/** `gate_reason` written when BR-02 holds the gate of a new entry (A.4 5.2); cleared again when a risk is linked. */
export const BR02_GATE_REASON = 'No risk-based justification';

/** The stored entry as the commands read it. */
interface EntryRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  target_type: 'catalogue_item' | 'requirement';
  catalogue_item_id: string | null;
  requirement_id: string | null;
  is_applicable: boolean | null;
  inclusion_justification: string | null;
  exclusion_justification: string | null;
  implementation_status: ImplementationStatus | null;
  owner_user_id: string | null;
  status_note: string | null;
  holds_gate: boolean;
  gate_reason: string | null;
  completed_by_user_id: string | null;
  completed_at: string | null;
  verified_by_user_id: string | null;
  verified_at: string | null;
}

/** G.5 business id of an entry: the catalogue item code, or `Cl. ` plus the requirement code. */
export function entryBusinessId(targetType: EntryRow['target_type'], code: string): string {
  return targetType === 'catalogue_item' ? code : `Cl. ${code}`;
}

function unprocessable(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages: { en, id }, detail: en });
}

function applies(isApplicable: boolean | null, status: ImplementationStatus | null): boolean {
  return isApplicable !== false && status !== 'not_applicable';
}

@Injectable()
export class ApplicabilityService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/applicability/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    id: string,
    body: ApplicabilityTransitionRequest,
    ifMatch: string | undefined,
  ): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as EntryRow;
      const code = await this.businessIdOf(trx, row);
      assertIfMatch(ifMatch, row.updated_at, refOf(ENTITY, row.id, code, row.updated_at));
      const from = row.implementation_status;
      const to = body.to;
      const transition = pickTransition(MACHINE, from, to, authz, row.owner_user_id === actor);
      assertRequires(transition, body as Record<string, unknown>);
      const ref = refOf(ENTITY, row.id, code, row.updated_at);
      const scope = { msIds: [row.management_system_id], ref };
      const today = todayOf(this.clock, org);
      let warnings: Warning[] = [];

      if (transition.rules.includes('VERIFY-SELF')) {
        await this.rules.enforce<VerifySelfInput>(trx, 'VERIFY-SELF', { actorId: actor, excluded: [row.completed_by_user_id ?? row.owner_user_id] }, scope);
      }
      if (to === 'implemented') {
        // BR-02: an applicable entry is not verified without its risk-based justification (A.4 5.2).
        await this.rules.enforce<Br02Input>(trx, 'BR-02', { applicable: applies(row.is_applicable, to), riskCount: await this.riskCount(trx, row.id) }, scope);
      }
      if (transition.rules.includes('BR-01')) {
        await this.rules.enforce<Br01Input>(trx, 'BR-01', { entryId: row.id, today, now: windowNowOf(this.clock, org) }, scope);
      }
      if (to === 'not_applicable' && body.exclusionJustification) {
        warnings = mergeWarnings(warnings, await this.rules.enforce<Br03Input>(trx, 'BR-03', { justification: body.exclusionJustification }, scope));
      }

      const set: Updateable<DB['applicability_entry']> = { implementation_status: to, updated_by: actor };
      const rejection = from === 'complete' && to === 'partially_implemented';
      if (to === 'complete') {
        Object.assign(set, { completed_by_user_id: actor, completed_at: today, verified_by_user_id: null, verified_at: null });
      } else if (to === 'implemented') {
        Object.assign(set, { verified_by_user_id: actor, verified_at: today });
      } else if (rejection) {
        Object.assign(set, { completed_by_user_id: null, completed_at: null, ...(body.reason ? { status_note: body.reason } : {}) });
      } else if (to === 'not_applicable') {
        Object.assign(set, { is_applicable: false, exclusion_justification: body.exclusionJustification!, verified_by_user_id: null, verified_at: null });
      } else if (to === 'not_started' && from === null) {
        set.is_applicable = true;
      }
      const updatedAt = await this.write(trx, row.id, set);

      const before: Record<string, unknown> = { implementation_status: from };
      const after: Record<string, unknown> = { implementation_status: to };
      for (const key of Object.keys(set) as (keyof typeof set)[]) {
        if (key === 'implementation_status' || key === 'updated_by') continue;
        before[key] = row[key as keyof EntryRow] ?? null;
        after[key] = set[key] ?? null;
      }
      if (body.reason) after.reason = body.reason;
      await this.audit.record(trx, {
        action: 'applicability.transition',
        msId: row.management_system_id,
        entityType: ENTITY,
        entityId: row.id,
        entityCode: code,
        before,
        after,
      });
      await enqueueFreshness(this.queue, trx, org, row.management_system_id, { entryIds: [row.id] }, actor);
      return commandResult([record.ms.slug], { ref: refOf(ENTITY, row.id, code, updatedAt), warnings });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/applicability/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, ms: string, id: string, patch: ApplicabilityPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as EntryRow;
      const code = await this.businessIdOf(trx, row);
      assertIfMatch(ifMatch, row.updated_at, refOf(ENTITY, row.id, code, row.updated_at));
      const ref = refOf(ENTITY, row.id, code, row.updated_at);
      const scope = { msIds: [row.management_system_id], ref };
      const set: Updateable<DB['applicability_entry']> = { updated_by: actor };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof EntryRow & keyof Updateable<DB['applicability_entry']>, value: unknown) => {
        if ((row[column] ?? null) === (value ?? null)) return;
        (set as Record<string, unknown>)[column] = value;
        before[column] = row[column] ?? null;
        after[column] = value ?? null;
      };
      let warnings: Warning[] = [];
      let freshnessChanged = false;

      if (patch.ownerHandle !== undefined) change('owner_user_id', await this.members.resolveHandle(trx, patch.ownerHandle));
      if (patch.inclusionJustification !== undefined) change('inclusion_justification', patch.inclusionJustification);
      if (patch.statusNote !== undefined) change('status_note', patch.statusNote);

      // Applicability and the exclusion justification: an entry that does not apply always carries one (C.6 CHECK).
      const exclusion = patch.exclusionJustification !== undefined ? patch.exclusionJustification : row.exclusion_justification;
      let status = row.implementation_status;
      if (patch.isApplicable === false) {
        if (!exclusion) throw new ValidationError([{ path: 'body.exclusionJustification', message: 'An entry that does not apply needs an exclusion justification' }]);
        change('is_applicable', false);
        if (status !== 'not_applicable') status = 'not_applicable';
      } else if (patch.isApplicable === true) {
        change('is_applicable', true);
        if (status === 'not_applicable' || status === null) status = 'not_started';
      }
      if (patch.exclusionJustification !== undefined) {
        if (patch.exclusionJustification === null && status === 'not_applicable') {
          throw new ValidationError([{ path: 'body.exclusionJustification', message: 'An entry that does not apply needs an exclusion justification' }]);
        }
        change('exclusion_justification', patch.exclusionJustification);
      }
      if (status !== row.implementation_status) {
        // Applicability decides the status through the C.13 rows of `applicability.manage` (any state to not
        // applicable, a new assessment to not started).
        const from = row.implementation_status === 'not_applicable' && status === 'not_started' ? null : row.implementation_status;
        if (transitionsVia(MACHINE, from, status!, null).length === 0) throw new TransitionNotAllowedError(from, status!);
        change('implementation_status', status);
        if (status === 'not_applicable') {
          change('verified_by_user_id', null);
          change('verified_at', null);
        }
        freshnessChanged = true;
      }
      if (patch.gateReason !== undefined) change('gate_reason', patch.gateReason);
      if (patch.holdsGate !== undefined) {
        change('holds_gate', patch.holdsGate);
        if (!patch.holdsGate && patch.gateReason === undefined) change('gate_reason', null);
      }

      if (patch.frequencyCode !== undefined) {
        const changedFrequency = await this.setFrequency(trx, record.ms, row.id, patch.frequencyCode, actor);
        if (changedFrequency) {
          before.frequency_code = changedFrequency.before;
          after.frequency_code = patch.frequencyCode;
          freshnessChanged = true;
        }
      }
      if (patch.riskCodes !== undefined) {
        const links = await this.replaceRisks(trx, record.ms, row.id, patch.riskCodes, actor);
        if (links.changed) {
          before.risk_codes = links.before;
          after.risk_codes = patch.riskCodes;
        }
      }
      if (patch.documentCodes !== undefined) {
        const links = await this.replaceDocuments(trx, record.ms, row.id, patch.documentCodes, actor);
        if (links.changed) {
          before.document_codes = links.before;
          after.document_codes = patch.documentCodes;
        }
      }

      // BR-02 when the patch decides applicability or the linked risks: an applicable entry is saved with a risk.
      if (patch.isApplicable !== undefined || patch.riskCodes !== undefined) {
        const isApplicable = (set.is_applicable as boolean | undefined) ?? row.is_applicable;
        const riskCount = await this.riskCount(trx, row.id);
        await this.rules.enforce<Br02Input>(trx, 'BR-02', { applicable: applies(isApplicable, status), riskCount }, scope);
        // The gate BR-02 raised at creation is lifted once a risk is linked (unless the patch sets the flag itself).
        if (riskCount > 0 && patch.holdsGate === undefined && row.holds_gate && row.gate_reason === BR02_GATE_REASON) {
          change('holds_gate', false);
          change('gate_reason', null);
        }
      }
      if (patch.exclusionJustification) {
        warnings = mergeWarnings(warnings, await this.rules.enforce<Br03Input>(trx, 'BR-03', { justification: patch.exclusionJustification }, scope));
      }

      const updatedAt = await this.write(trx, row.id, set);
      if (Object.keys(after).length > 0) {
        await this.audit.record(trx, {
          action: 'applicability.updated',
          msId: row.management_system_id,
          entityType: ENTITY,
          entityId: row.id,
          entityCode: code,
          before,
          after,
        });
      }
      if (freshnessChanged) await enqueueFreshness(this.queue, trx, org, row.management_system_id, { entryIds: [row.id] }, actor);
      return commandResult([record.ms.slug], { ref: refOf(ENTITY, row.id, code, updatedAt), warnings });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/applicability
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: ApplicabilityCreateRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const version = await this.frameworkVersionOf(trx, system);
      const target = await this.targetOf(trx, version, body.targetType, body.code);
      const duplicate = await sql<{ id: string }>`
        select id from applicability_entry
         where management_system_id = ${system.id} and deleted_at is null and target_type = ${body.targetType}
           and ${body.targetType === 'catalogue_item' ? sql`catalogue_item_id` : sql`requirement_id`} = ${target}
         limit 1`.execute(trx);
      if (duplicate.rows.length > 0) {
        throw new ConflictError(`${entryBusinessId(body.targetType, body.code)} already has an applicability entry in this system`, {
          messageKey: 'applicability.duplicate_target',
        });
      }
      await this.assertFrequency(trx, version, body.frequencyCode);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const status: ImplementationStatus = body.isApplicable ? 'not_started' : 'not_applicable';
      if (transitionsVia(MACHINE, null, status, null).length === 0) throw new Error(`C.13 has no creation row for ${status}`);
      const code = entryBusinessId(body.targetType, body.code);
      const id = randomUUID();
      const ref = refOf(ENTITY, id, code, new Date());
      const scope = { msIds: [system.id], ref };

      // BR-02 (A.4 5.2): a new applicable entry has no risk yet, so the engine holds its gate until one is linked.
      const br02 = body.isApplicable ? await this.rules.evaluate<Br02Input>(trx, 'BR-02', { applicable: true, riskCount: 0 }, scope) : [];
      const holdsGate = br02.length > 0;
      const warnings = body.exclusionJustification && !body.isApplicable
        ? await this.rules.enforce<Br03Input>(trx, 'BR-03', { justification: body.exclusionJustification }, scope)
        : [];

      const position = await sql<{ next: number }>`
        select coalesce(max(position), -1)::int + 1 as next from applicability_entry where management_system_id = ${system.id}`.execute(trx);
      const inserted = await trx
        .insertInto('applicability_entry')
        .values({
          id,
          management_system_id: system.id,
          target_type: body.targetType,
          catalogue_item_id: body.targetType === 'catalogue_item' ? target : null,
          requirement_id: body.targetType === 'requirement' ? target : null,
          is_applicable: body.isApplicable,
          inclusion_justification: body.inclusionJustification ?? null,
          exclusion_justification: body.exclusionJustification ?? null,
          implementation_status: status,
          owner_user_id: owner,
          holds_gate: holdsGate,
          gate_reason: holdsGate ? BR02_GATE_REASON : null,
          position: position.rows[0]?.next ?? 0,
          created_by: actor,
          updated_by: actor,
        })
        .returning(['updated_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('operating_criteria')
        .values({ management_system_id: system.id, applicability_entry_id: id, frequency_code: body.frequencyCode, created_by: actor, updated_by: actor })
        .execute();
      await this.audit.record(trx, {
        action: 'applicability.created',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: code,
        after: {
          target_type: body.targetType,
          code: body.code,
          is_applicable: body.isApplicable,
          implementation_status: status,
          owner: body.ownerHandle,
          frequency_code: body.frequencyCode,
          holds_gate: holdsGate,
          ...(body.inclusionJustification ? { inclusion_justification: body.inclusionJustification } : {}),
          ...(body.exclusionJustification ? { exclusion_justification: body.exclusionJustification } : {}),
        },
      });
      await enqueueFreshness(this.queue, trx, org, system.id, { entryIds: [id] }, actor);
      return commandResult([system.slug], { ref: refOf(ENTITY, id, code, new Date(inserted.updated_at)), warnings });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Writes the changed columns and a new `updated_at` (the ETag of the next version); returns that `updated_at`. */
  private async write(trx: Trx, id: string, set: Updateable<DB['applicability_entry']>): Promise<Date> {
    const row = await trx
      .updateTable('applicability_entry')
      .set({ ...set, updated_at: sql<Date>`greatest(clock_timestamp(), updated_at + interval '1 millisecond')` })
      .where('id', '=', id)
      .returning(['updated_at'])
      .executeTakeFirstOrThrow();
    return new Date(row.updated_at);
  }

  private async businessIdOf(trx: Trx, row: Pick<EntryRow, 'target_type' | 'catalogue_item_id' | 'requirement_id'>): Promise<string> {
    const { rows } = row.target_type === 'catalogue_item'
      ? await sql<{ code: string }>`select item_code as code from ref.catalogue_item where id = ${row.catalogue_item_id}`.execute(trx)
      : await sql<{ code: string }>`select requirement_code as code from ref.requirement where id = ${row.requirement_id}`.execute(trx);
    return entryBusinessId(row.target_type, rows[0]?.code ?? '');
  }

  private async riskCount(trx: Trx, entryId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from applicability_entry_risk er
        join risk r on r.id = er.risk_id and r.deleted_at is null
       where er.applicability_entry_id = ${entryId} and er.deleted_at is null`.execute(trx);
    return rows[0]?.n ?? 0;
  }

  private async frameworkVersionOf(trx: Trx, system: MsRef): Promise<string> {
    const row = await trx.selectFrom('management_system').select('framework_version_id').where('id', '=', system.id).executeTakeFirstOrThrow();
    return row.framework_version_id;
  }

  /** The catalogue item or requirement of the active edition with this code; 422 when the edition has none. */
  private async targetOf(trx: Trx, versionId: string, targetType: ApplicabilityCreateRequest['targetType'], code: string): Promise<string> {
    const { rows } = targetType === 'catalogue_item'
      ? await sql<{ id: string }>`select id from ref.catalogue_item where framework_version_id = ${versionId} and item_code = ${code}`.execute(trx)
      : await sql<{ id: string }>`select id from ref.requirement where framework_version_id = ${versionId} and requirement_code = ${code}`.execute(trx);
    const id = rows[0]?.id;
    if (!id) {
      throw unprocessable(
        'applicability.unknown_target',
        `${code} is not a ${targetType === 'catalogue_item' ? 'catalogue item' : 'requirement'} of the edition in use`,
        `${code} bukan ${targetType === 'catalogue_item' ? 'butir katalog' : 'persyaratan'} dari edisi yang digunakan`,
      );
    }
    return id;
  }

  private async assertFrequency(trx: Trx, versionId: string, frequencyCode: string): Promise<void> {
    const { rows } = await sql<{ code: string }>`
      select code from ref.evidence_frequency_rule where framework_version_id = ${versionId} and code = ${frequencyCode}`.execute(trx);
    if (rows.length === 0) {
      throw unprocessable(
        'applicability.unknown_frequency',
        `Frequency ${frequencyCode} is not defined by the edition in use`,
        `Frekuensi ${frequencyCode} tidak didefinisikan oleh edisi yang digunakan`,
      );
    }
  }

  /** Sets the entry's operating frequency (`operating_criteria`); returns the old value when it changed. */
  private async setFrequency(trx: Trx, system: MsRef, entryId: string, frequencyCode: string, actor: string): Promise<{ before: string | null } | null> {
    await this.assertFrequency(trx, await this.frameworkVersionOf(trx, system), frequencyCode);
    const current = await trx
      .selectFrom('operating_criteria')
      .select(['id', 'frequency_code'])
      .where('applicability_entry_id', '=', entryId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (current?.frequency_code === frequencyCode) return null;
    if (current) {
      await trx
        .updateTable('operating_criteria')
        .set({ frequency_code: frequencyCode, updated_at: sql<Date>`now()`, updated_by: actor })
        .where('id', '=', current.id)
        .execute();
    } else {
      await trx
        .insertInto('operating_criteria')
        .values({ management_system_id: system.id, applicability_entry_id: entryId, frequency_code: frequencyCode, created_by: actor, updated_by: actor })
        .execute();
    }
    return { before: current?.frequency_code ?? null };
  }

  /** Replaces the entry's linked risks with the risks of these codes linked to the system; 422 for unknown codes. */
  private async replaceRisks(trx: Trx, system: MsRef, entryId: string, codes: readonly string[], actor: string): Promise<{ changed: boolean; before: string[] }> {
    const wanted = [...new Set(codes)];
    const { rows: found } = wanted.length
      ? await sql<{ id: string; code: string }>`
          select r.id, r.code from risk r
           where r.deleted_at is null and r.code = any(${sql`${wanted}::text[]`})
             and exists (select 1 from entity_ms_link l where l.entity_type = 'risk' and l.entity_id = r.id
                          and l.management_system_id = ${system.id} and l.deleted_at is null)`.execute(trx)
      : { rows: [] as { id: string; code: string }[] };
    const unknown = wanted.filter((c) => !found.some((r) => r.code === c));
    if (unknown.length > 0) {
      throw unprocessable('applicability.unknown_risk', `Unknown risks for this system: ${unknown.join(', ')}`, `Risiko tidak dikenal untuk sistem ini: ${unknown.join(', ')}`);
    }
    const idOf = new Map(found.map((r) => [r.code, r.id]));
    return this.replaceLinks(trx, 'applicability_entry_risk', 'risk_id', entryId, wanted.map((c) => idOf.get(c)!), actor, async () =>
      (await sql<{ code: string }>`
        select r.code from applicability_entry_risk er join risk r on r.id = er.risk_id
         where er.applicability_entry_id = ${entryId} and er.deleted_at is null order by er.position, r.code`.execute(trx)).rows.map((r) => r.code),
    );
  }

  /** Replaces the entry's documents with the documents of these codes in the system (linked or organisation-wide). */
  private async replaceDocuments(trx: Trx, system: MsRef, entryId: string, codes: readonly string[], actor: string): Promise<{ changed: boolean; before: string[] }> {
    const wanted = [...new Set(codes)];
    const { rows: found } = wanted.length
      ? await sql<{ id: string; code: string }>`
          select d.id, d.doc_code as code from document d
           where d.deleted_at is null and d.doc_code = any(${sql`${wanted}::text[]`})
             and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                             and l.management_system_id = ${system.id} and l.deleted_at is null))`.execute(trx)
      : { rows: [] as { id: string; code: string }[] };
    const unknown = wanted.filter((c) => !found.some((d) => d.code === c));
    if (unknown.length > 0) {
      throw unprocessable('applicability.unknown_document', `Unknown documents for this system: ${unknown.join(', ')}`, `Dokumen tidak dikenal untuk sistem ini: ${unknown.join(', ')}`);
    }
    const idOf = new Map(found.map((d) => [d.code, d.id]));
    return this.replaceLinks(trx, 'applicability_entry_document', 'document_id', entryId, wanted.map((c) => idOf.get(c)!), actor, async () =>
      (await sql<{ code: string }>`
        select d.doc_code as code from applicability_entry_document ed join document d on d.id = ed.document_id
         where ed.applicability_entry_id = ${entryId} and ed.deleted_at is null order by ed.position, d.doc_code`.execute(trx)).rows.map((r) => r.code),
    );
  }

  /**
   * Makes the live link rows of an entry equal `targetIds` in this order: links no longer wanted are soft deleted
   * (BR-19), new ones inserted, positions follow the request.
   */
  private async replaceLinks(
    trx: Trx,
    table: 'applicability_entry_risk' | 'applicability_entry_document',
    column: 'risk_id' | 'document_id',
    entryId: string,
    targetIds: readonly string[],
    actor: string,
    codes: () => Promise<string[]>,
  ): Promise<{ changed: boolean; before: string[] }> {
    const before = await codes();
    const { rows: live } = await sql<{ id: string; target: string; position: number }>`
      select id, ${sql.ref(column)} as target, position from ${sql.table(table)}
       where applicability_entry_id = ${entryId} and deleted_at is null`.execute(trx);
    let changed = false;
    for (const link of live) {
      if (!targetIds.includes(link.target)) {
        await sql`update ${sql.table(table)} set deleted_at = now(), updated_at = now(), updated_by = ${actor} where id = ${link.id}`.execute(trx);
        changed = true;
      }
    }
    for (const [position, target] of targetIds.entries()) {
      const existing = live.find((l) => l.target === target);
      if (!existing) {
        await sql`insert into ${sql.table(table)} (applicability_entry_id, ${sql.ref(column)}, position, created_by, updated_by)
                  values (${entryId}, ${target}, ${position}, ${actor}, ${actor})`.execute(trx);
        changed = true;
      } else if (existing.position !== position) {
        await sql`update ${sql.table(table)} set position = ${position}, updated_at = now(), updated_by = ${actor} where id = ${existing.id}`.execute(trx);
        changed = true;
      }
    }
    return { changed, before };
  }
}

