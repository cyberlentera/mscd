// Evidence records and their targets (D.3 "Registers and workflows: risk side", WP-36): new evidence records with
// at least one target in the path system, their changes (BR-22 confirmation when shared, `freshness.recompute` for
// every system they serve), targets in other systems (`integrated_mode`, BR-23 warning for a non-reusable mapping)
// and the removal of a target (never the last one). Files are attached by the file commands (WP-21).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, EvidenceCreate, EvidencePatch, EvidenceTargetRemoveRequest, EvidenceTargetRequest } from '@mscd/shared';
import { sql } from 'kysely';
import { assertIfMatch } from '../../common/etag';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/problems';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import {
  AUDIT_WRITER, LICENCE_GATE, MEMBERSHIP_SERVICE, RECORD_RESOLVER, type AuditWriter, type AuthzState, type LicenceGate, type MembershipService,
  type MsRef, type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { confirmShared, type Br23Input } from './rules';
import {
  assertFrequency, bump, commandResult, duplicateCode, editionOf, enqueueFreshness, grantedInFull, linksOf, orgOf, refOf, unprocessable,
} from './support';

const ENTITY = 'evidence';

interface EvidenceRow {
  id: string;
  updated_at: Date;
  evidence_code: string;
  title: string;
  owner_user_id: string | null;
  frequency_code: string;
  classification: string;
  next_due_override: string | null;
}

/** One live target of an evidence record. */
interface TargetRow {
  id: string;
  ms_id: string;
  slug: string;
  entry_id: string;
  code: string;
}

@Injectable()
export class EvidenceService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly rules: RuleEngine,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/evidence
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, authz: AuthzState | null, ms: string, body: EvidenceCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      if (!grantedInFull(authz, 'evidence.manage') && owner !== actor) throw new ForbiddenError('You can add evidence only with yourself as the owner');
      await assertFrequency(trx, await editionOf(trx, system.id), body.frequencyCode);
      const { rows: taken } = await sql<{ id: string }>`
        select id from evidence where evidence_code = ${body.code} and deleted_at is null limit 1`.execute(trx);
      if (taken.length > 0) throw new ConflictError(`${body.code} already exists`, { messageKey: 'register.duplicate_code' });
      const entries: { id: string; targetType: 'catalogue_item' | 'requirement'; targetId: string; code: string }[] = [];
      for (const target of body.targets) {
        const entry = await this.entryOf(trx, system, target.targetType, target.code);
        if (!entries.some((e) => e.id === entry.id)) entries.push({ ...entry, code: target.code });
      }

      const id = randomUUID();
      const position = await sql<{ next: number }>`select coalesce(max(position), -1)::int + 1 as next from evidence`.execute(trx);
      let updatedAt: Date;
      try {
        const inserted = await trx
          .insertInto('evidence')
          .values({
            id, evidence_code: body.code, title: body.title, owner_user_id: owner, frequency_code: body.frequencyCode, classification: body.classification,
            position: position.rows[0]?.next ?? 0, created_by: actor, updated_by: actor,
          })
          .returning(['updated_at'])
          .executeTakeFirstOrThrow();
        updatedAt = new Date(inserted.updated_at);
      } catch (error) {
        duplicateCode(error, body.code);
      }
      await trx
        .insertInto('entity_ms_link')
        .values({ entity_type: ENTITY, entity_id: id, management_system_id: system.id, is_primary: true, created_by: actor, updated_by: actor })
        .execute();
      for (const [index, entry] of entries.entries()) {
        await trx
          .insertInto('evidence_target')
          .values({
            evidence_id: id, management_system_id: system.id, applicability_entry_id: entry.id, target_type: entry.targetType,
            catalogue_item_id: entry.targetType === 'catalogue_item' ? entry.targetId : null,
            requirement_id: entry.targetType === 'requirement' ? entry.targetId : null,
            position: index, created_by: actor, updated_by: actor,
          })
          .execute();
      }
      await this.audit.record(trx, {
        action: 'evidence.created',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: body.code,
        after: {
          evidence_code: body.code, title: body.title, owner: body.ownerHandle, frequency_code: body.frequencyCode, classification: body.classification,
          targets: entries.map((e) => `${system.slug}:${e.code}`),
        },
      });
      await enqueueFreshness(this.queue, trx, org, system.id, { evidenceIds: [id], entryIds: entries.map((e) => e.id) }, actor);
      return commandResult([system.slug], { ref: refOf('surveillance', ENTITY, id, body.code, updatedAt!) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/evidence/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, authz: AuthzState | null, ms: string, id: string, patch: EvidencePatch, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as EvidenceRow;
      assertIfMatch(ifMatch, row.updated_at, refOf('surveillance', ENTITY, row.id, row.evidence_code, row.updated_at));
      const full = grantedInFull(authz, 'evidence.manage');
      if (!full && row.owner_user_id !== actor) throw new ForbiddenError('Only the owner of this evidence can change it');

      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof EvidenceRow, value: unknown, shown: unknown = value) => {
        if ((row[column] ?? null) === (value ?? null)) return;
        set[column] = value;
        before[column] = row[column] ?? null;
        after[column] = shown ?? null;
      };
      if (patch.title !== undefined) change('title', patch.title);
      if (patch.ownerHandle !== undefined) {
        const owner = await this.members.resolveHandle(trx, patch.ownerHandle);
        if (!full && owner !== actor) throw new ForbiddenError('You cannot hand your evidence to someone else');
        change('owner_user_id', owner, patch.ownerHandle);
      }
      if (patch.frequencyCode !== undefined) {
        await assertFrequency(trx, await editionOf(trx, record.ms.id), patch.frequencyCode);
        change('frequency_code', patch.frequencyCode);
      }
      if (patch.classification !== undefined) change('classification', patch.classification);
      if (patch.nextDueOverride !== undefined) change('next_due_override', patch.nextDueOverride);

      const targets = await this.targetsOf(trx, row.id);
      const systems = await this.systemsOf(trx, row.id, targets);
      await confirmShared(trx, this.rules, systems, record.ms.slug, patch.confirm);

      const changed = Object.keys(after).length > 0;
      const updatedAt = changed ? await bump(trx, ENTITY, row.id, { ...set, updated_by: actor }) : new Date(row.updated_at);
      if (changed) {
        await this.audit.record(trx, { action: 'evidence.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: row.evidence_code, before, after });
        // Frequency, override and ownership change the derived freshness of every system the evidence serves.
        for (const s of new Map(targets.map((t) => [t.ms_id, t])).values()) {
          await enqueueFreshness(this.queue, trx, org, s.ms_id, { evidenceIds: [row.id], entryIds: targets.filter((t) => t.ms_id === s.ms_id).map((t) => t.entry_id) }, actor);
        }
      }
      return commandResult(systems.map((s) => s.slug), {
        ref: refOf('surveillance', ENTITY, row.id, row.evidence_code, updatedAt),
        ...(changed ? {} : { message: ['Nothing to change', 'Tidak ada yang diubah'] }),
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/evidence/{id}/targets
  // -------------------------------------------------------------------------------------------------------------

  async addTarget(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: EvidenceTargetRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as EvidenceRow;
      if (!grantedInFull(authz, 'evidence.manage') && row.owner_user_id !== actor) throw new ForbiddenError('Only the owner of this evidence can change its targets');
      const target = body.ms === record.ms.slug ? record.ms : await this.records.resolveMs(trx, body.ms);
      // TS 3.5: evidence that serves another system is the Integrated Management System feature.
      if (target.id !== record.ms.id) await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      const entry = await this.entryOf(trx, target, body.targetType, body.code);
      const { rows: existing } = await sql<{ id: string }>`
        select id from evidence_target where evidence_id = ${row.id} and applicability_entry_id = ${entry.id} and deleted_at is null`.execute(trx);
      if (existing.length > 0) throw new ConflictError(`The evidence already targets ${body.code} in ${target.slug}`, { messageKey: 'evidence.duplicate_target' });

      const position = await sql<{ next: number }>`
        select coalesce(max(position), -1)::int + 1 as next from evidence_target where evidence_id = ${row.id}`.execute(trx);
      const targetId = randomUUID();
      await trx
        .insertInto('evidence_target')
        .values({
          id: targetId, evidence_id: row.id, management_system_id: target.id, applicability_entry_id: entry.id, target_type: body.targetType,
          catalogue_item_id: body.targetType === 'catalogue_item' ? entry.targetId : null,
          requirement_id: body.targetType === 'requirement' ? entry.targetId : null,
          mapping_note: body.mappingNote ?? null, position: position.rows[0]?.next ?? 0, created_by: actor, updated_by: actor,
        })
        .execute();
      // The evidence is now part of the target system (entity_ms_link, never primary through a target).
      const links = await linksOf(trx, ENTITY, row.id);
      if (!links.some((l) => l.msId === target.id)) {
        await trx
          .insertInto('entity_ms_link')
          .values({ entity_type: ENTITY, entity_id: row.id, management_system_id: target.id, is_primary: false, created_by: actor, updated_by: actor })
          .execute();
      }
      const updatedAt = await bump(trx, ENTITY, row.id, { updated_by: actor });
      const targets = await this.targetsOf(trx, row.id);
      const systems = await this.systemsOf(trx, row.id, targets);
      const ref = refOf('surveillance', ENTITY, row.id, row.evidence_code, updatedAt);
      // BR-23 (warning): a target reached through a mapping marked not reusable.
      const warnings = await this.rules.enforce<Br23Input>(trx, 'BR-23', { evidenceId: row.id }, { msIds: systems.map((s) => s.msId), ref });
      await this.audit.record(trx, {
        action: 'evidence.target_added',
        msId: record.ms.id,
        entityType: ENTITY,
        entityId: row.id,
        entityCode: row.evidence_code,
        after: { target: `${target.slug}:${body.code}`, target_type: body.targetType, ...(body.mappingNote ? { mapping_note: body.mappingNote } : {}) },
      });
      await enqueueFreshness(this.queue, trx, org, target.id, { evidenceIds: [row.id], entryIds: [entry.id] }, actor);
      return commandResult([record.ms.slug, target.slug], { ref, warnings, data: { targetId } });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/evidence/{id}/targets/{targetId}/remove
  // -------------------------------------------------------------------------------------------------------------

  async removeTarget(
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    id: string,
    targetId: string,
    body: EvidenceTargetRemoveRequest,
  ): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as unknown as EvidenceRow;
      if (!grantedInFull(authz, 'evidence.manage') && row.owner_user_id !== actor) throw new ForbiddenError('Only the owner of this evidence can change its targets');
      const targets = await this.targetsOf(trx, row.id);
      const target = targets.find((t) => t.id === targetId);
      if (!target) throw new NotFoundError();
      if (targets.length === 1) {
        throw unprocessable('evidence.last_target', 'The last target of an evidence record cannot be removed; delete the evidence instead',
          'Target terakhir dari catatan evidence tidak dapat dihapus; hapus evidence-nya');
      }
      await sql`update evidence_target set deleted_at = now(), updated_at = now(), updated_by = ${actor} where id = ${target.id}`.execute(trx);
      // A system the evidence no longer serves loses its link, unless the link is the primary one (A-29).
      if (!targets.some((t) => t.id !== target.id && t.ms_id === target.ms_id)) {
        await sql`update entity_ms_link set deleted_at = now(), updated_at = now(), updated_by = ${actor}
                   where entity_type = ${ENTITY} and entity_id = ${row.id} and management_system_id = ${target.ms_id}
                     and deleted_at is null and not is_primary`.execute(trx);
      }
      const updatedAt = await bump(trx, ENTITY, row.id, { updated_by: actor });
      await this.audit.record(trx, {
        action: 'evidence.target_removed',
        msId: record.ms.id,
        entityType: ENTITY,
        entityId: row.id,
        entityCode: row.evidence_code,
        before: { target: `${target.slug}:${target.code}` },
        after: { target: null, reason: body.reason },
      });
      await enqueueFreshness(this.queue, trx, org, target.ms_id, { evidenceIds: [row.id], entryIds: [target.entry_id] }, actor);
      return commandResult([record.ms.slug, target.slug], { ref: refOf('surveillance', ENTITY, row.id, row.evidence_code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** The live applicability entry of a system for a catalogue item or requirement code; 422 when there is none. */
  private async entryOf(trx: Trx, system: MsRef, targetType: 'catalogue_item' | 'requirement', code: string): Promise<{ id: string; targetType: 'catalogue_item' | 'requirement'; targetId: string }> {
    const { rows } = targetType === 'catalogue_item'
      ? await sql<{ id: string; target_id: string }>`
          select e.id, ci.id as target_id from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
           where e.management_system_id = ${system.id} and e.deleted_at is null and ci.item_code = ${code}`.execute(trx)
      : await sql<{ id: string; target_id: string }>`
          select e.id, r.id as target_id from applicability_entry e join ref.requirement r on r.id = e.requirement_id
           where e.management_system_id = ${system.id} and e.deleted_at is null and r.requirement_code = ${code}`.execute(trx);
    const row = rows[0];
    if (!row) {
      throw unprocessable('evidence.unknown_target', `${code} has no applicability entry in ${system.slug}`, `${code} tidak memiliki entri penerapan di ${system.slug}`);
    }
    return { id: row.id, targetType, targetId: row.target_id };
  }

  private async targetsOf(trx: Trx, evidenceId: string): Promise<TargetRow[]> {
    const { rows } = await sql<TargetRow>`
      select t.id, t.management_system_id as ms_id, m.slug, t.applicability_entry_id as entry_id, coalesce(ci.item_code, r.requirement_code) as code
        from evidence_target t
        join management_system m on m.id = t.management_system_id
        left join ref.catalogue_item ci on ci.id = t.catalogue_item_id
        left join ref.requirement r on r.id = t.requirement_id
       where t.evidence_id = ${evidenceId} and t.deleted_at is null
       order by t.position`.execute(trx);
    return rows;
  }

  /** Systems the evidence belongs to: its links and the systems of its targets. */
  private async systemsOf(trx: Trx, evidenceId: string, targets: readonly TargetRow[]): Promise<{ msId: string; slug: string }[]> {
    const out = new Map<string, string>();
    for (const l of await linksOf(trx, ENTITY, evidenceId)) out.set(l.msId, l.slug);
    for (const t of targets) out.set(t.ms_id, t.slug);
    return [...out.entries()].map(([msId, slug]) => ({ msId, slug }));
  }
}
