// `freshness.recompute` and `freshness.sweep` (build plan E.3, TS 6.1, BR-11, BR-31, D-29). Stores the derived
// freshness and integrity of evidence and applicability entries with the functions of
// `read-model/derive/freshness.ts`, so the read model, the commands and these jobs decide alike. An entry in
// `implemented` whose evidence no longer keeps it there moves to `partially_implemented` (actor system, audit
// `freshness.downgrade`, `freshness_downgrade` to the entry owner) and the evidence that caused it gets a BR-11
// (expired or critical) or BR-31 (unverifiable) task for its owner. Tasks close when the evidence is valid and in
// date again; promotion back is never automatic.
import { Inject, Injectable } from '@nestjs/common';
import type { FreshnessStatus } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fmtDay } from '../../common/dates';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { windowNow } from '../jobs/job-support';
import { activeRulesBySystem, ruleActive, RuleTaskService } from '../jobs/rule-tasks';
import { TenantJobRunner } from '../jobs/tenant-job';
import { entryEvidenceState, evidenceState, thresholdsFor, type EvidenceState, type ThresholdRow } from '../read-model/derive/freshness';
import type { IntegrityStatus, StorageObjectState } from '../read-model/derive/integrity';

export interface RecomputeScope {
  msId?: string;
  evidenceIds?: string[];
  entryIds?: string[];
}

export interface RecomputeResult {
  evidenceUpdated: number;
  entriesUpdated: number;
  downgraded: { entryId: string; code: string; rule: 'BR-11' | 'BR-31' }[];
  tasksOpened: number;
  tasksClosed: number;
  notifications: number;
  /** Evidence now in `aging` (the sweep notifies their owners). */
  aging: { id: string; code: string; title: string; ownerUserId: string | null; producedAt: string | null; msId: string | null }[];
}

interface EvidenceRow {
  id: string;
  evidence_code: string;
  title: string;
  owner_user_id: string | null;
  produced_at: string | null;
  frequency_code: string;
  freshness_status: FreshnessStatus | null;
  integrity_status: IntegrityStatus | null;
  so_link_status: StorageObjectState['linkStatus'] | null;
  so_hash_algorithm: StorageObjectState['hashAlgorithm'] | null;
  so_hash_source: StorageObjectState['hashSource'] | null;
  so_link_status_since: Date | null;
  so_link_status_reason: StorageObjectState['linkStatusReason'];
}

interface EntryRow {
  id: string;
  management_system_id: string;
  framework_version_id: string;
  implementation_status: string | null;
  owner_user_id: string | null;
  code: string;
  last_evidence_at: string | null;
  freshness_status: FreshnessStatus | null;
  integrity_status: IntegrityStatus | null;
}

interface TargetRow {
  evidence_id: string;
  applicability_entry_id: string;
}

function uuids(ids: readonly string[]) {
  return sql`${[...ids]}::uuid[]`;
}

@Injectable()
export class FreshnessService {
  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly tasks: RuleTaskService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /** `freshness.recompute` for an organisation (whole organisation when the scope is empty). */
  async recompute(org: TenantInfo, scope: RecomputeScope = {}, requestId?: string): Promise<RecomputeResult> {
    const today = await this.clock.today(org.id);
    const now = windowNow(this.clock, org.timeZone);
    return this.runner.run(org, (trx) => this.recomputeIn(trx, scope, today, now), requestId);
  }

  /** `freshness.sweep`: the whole organisation, then `evidence_aging` (digest) once per evidence and production date. */
  async sweep(org: TenantInfo, requestId?: string): Promise<RecomputeResult> {
    const today = await this.clock.today(org.id);
    const now = windowNow(this.clock, org.timeZone);
    return this.runner.run(
      org,
      async (trx) => {
        const result = await this.recomputeIn(trx, {}, today, now);
        for (const e of result.aging) {
          if (!e.ownerUserId) continue;
          const sent = await trx
            .selectFrom('notification')
            .select('id')
            .where('kind', '=', 'evidence_aging')
            .where('recipient_user_id', '=', e.ownerUserId)
            .where(sql<string>`entity_ref->>'id'`, '=', e.id)
            // Once per production: a newer record of the same evidence that ages again is notified again.
            .$if(e.producedAt !== null, (q) => q.where('created_at', '>=', sql<Date>`${e.producedAt}::date::timestamptz`))
            .limit(1)
            .executeTakeFirst();
          if (sent) continue;
          const created = await this.notifications.create(trx, {
            recipientUserId: e.ownerUserId,
            kind: 'evidence_aging',
            msId: e.msId,
            digest: true,
            title: { en: `Evidence ageing: ${e.code}`, id: `Bukti menua: ${e.code}` },
            body: {
              en: `${e.code} ${e.title} (produced ${fmtDay(e.producedAt, 'en')}) is ageing. Provide a newer version before it expires.`,
              id: `${e.code} ${e.title} (dibuat ${fmtDay(e.producedAt, 'id')}) mulai menua. Sediakan versi yang lebih baru sebelum kedaluwarsa.`,
            },
            ref: { module: 'implementation', entityType: 'evidence', id: e.id, code: e.code },
            createdBy: SYSTEM_USER_ID,
          });
          if (created) result.notifications += 1;
        }
        return result;
      },
      requestId,
    );
  }

  private async recomputeIn(trx: Trx, scope: RecomputeScope, today: string, now: Date): Promise<RecomputeResult> {
    const result: RecomputeResult = { evidenceUpdated: 0, entriesUpdated: 0, downgraded: [], tasksOpened: 0, tasksClosed: 0, notifications: 0, aging: [] };
    const whole = !scope.msId && !scope.evidenceIds?.length && !scope.entryIds?.length;

    // 1. The entries in scope and every evidence that targets them.
    let entryIds: string[] | null = null;
    if (!whole) {
      const ids = new Set<string>(scope.entryIds ?? []);
      if (scope.evidenceIds?.length) {
        const targeted = await sql<{ id: string }>`
          SELECT DISTINCT applicability_entry_id AS id FROM evidence_target
           WHERE evidence_id = ANY(${uuids(scope.evidenceIds)}) AND deleted_at IS NULL`.execute(trx);
        for (const r of targeted.rows) ids.add(r.id);
      }
      if (scope.msId) {
        const ofMs = await sql<{ id: string }>`
          SELECT id FROM applicability_entry WHERE management_system_id = ${scope.msId} AND deleted_at IS NULL`.execute(trx);
        for (const r of ofMs.rows) ids.add(r.id);
      }
      entryIds = [...ids];
    }
    const entries = (
      await sql<EntryRow>`
        SELECT e.id, e.management_system_id, ms.framework_version_id, e.implementation_status, e.owner_user_id,
               coalesce(ci.item_code, rq.requirement_code) AS code, e.last_evidence_at, e.freshness_status, e.integrity_status
          FROM applicability_entry e
          JOIN management_system ms ON ms.id = e.management_system_id
          LEFT JOIN ref.catalogue_item ci ON ci.id = e.catalogue_item_id
          LEFT JOIN ref.requirement rq ON rq.id = e.requirement_id
         WHERE e.deleted_at IS NULL AND ms.deleted_at IS NULL
           ${entryIds ? sql`AND e.id = ANY(${uuids(entryIds)})` : sql``}
         ORDER BY e.management_system_id, e.position, e.id`.execute(trx)
    ).rows;
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const targets = entries.length
      ? (
          await sql<TargetRow>`
            SELECT t.evidence_id, t.applicability_entry_id FROM evidence_target t
              JOIN evidence ev ON ev.id = t.evidence_id AND ev.deleted_at IS NULL
             WHERE t.deleted_at IS NULL AND t.applicability_entry_id = ANY(${uuids(entries.map((e) => e.id))})
             ORDER BY t.position, t.id`.execute(trx)
        ).rows
      : [];
    const evidenceIds = new Set<string>(targets.map((t) => t.evidence_id));
    for (const id of scope.evidenceIds ?? []) evidenceIds.add(id);
    const evidence = whole
      ? await this.loadEvidence(trx, null)
      : evidenceIds.size > 0
        ? await this.loadEvidence(trx, [...evidenceIds])
        : [];
    const evidenceById = new Map(evidence.map((e) => [e.id, e]));

    // 2. Frequencies and thresholds.
    const fvIds = [...new Set(entries.map((e) => e.framework_version_id))];
    const periods = new Map<string, number>(); // `<framework version>:<code>` and `*:<code>`
    if (fvIds.length > 0 || evidence.length > 0) {
      const rules = await sql<{ framework_version_id: string; code: string; period_days: number }>`
        SELECT framework_version_id, code, period_days FROM ref.evidence_frequency_rule
         WHERE framework_version_id IN (SELECT DISTINCT framework_version_id FROM management_system WHERE deleted_at IS NULL)`.execute(trx);
      for (const r of rules.rows) {
        periods.set(`${r.framework_version_id}:${r.code}`, Number(r.period_days));
        if (!periods.has(`*:${r.code}`)) periods.set(`*:${r.code}`, Number(r.period_days));
      }
    }
    const thresholdRows: ThresholdRow[] = (
      await sql<{ management_system_id: string | null; frequency_code: string; fresh_grace_days: string; aging_factor: string; expired_factor: string }>`
        SELECT management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor FROM freshness_threshold WHERE deleted_at IS NULL`.execute(trx)
    ).rows.map((t) => ({
      managementSystemId: t.management_system_id,
      frequencyCode: t.frequency_code,
      freshGraceDays: Number(t.fresh_grace_days),
      agingFactor: Number(t.aging_factor),
      expiredFactor: Number(t.expired_factor),
    }));

    const objectOf = (e: EvidenceRow): StorageObjectState | null =>
      e.so_link_status
        ? {
            linkStatus: e.so_link_status,
            hashAlgorithm: e.so_hash_algorithm!,
            hashSource: e.so_hash_source!,
            linkStatusSince: e.so_link_status_since!,
            linkStatusReason: e.so_link_status_reason,
          }
        : null;
    // Evidence state in the context of one system (its frequency rule and thresholds).
    const stateIn = (e: EvidenceRow, msId: string | null, fvId: string | null): EvidenceState => ({
      producedAt: e.produced_at,
      periodDays: (fvId ? periods.get(`${fvId}:${e.frequency_code}`) : undefined) ?? periods.get(`*:${e.frequency_code}`) ?? 0,
      // Without a system only the organisation's row applies (no system id matches '').
      thresholds: thresholdsFor(thresholdRows, msId ?? '', e.frequency_code),
      object: objectOf(e),
    });

    // 3. Stored values of each evidence record, in the context of its first target's system.
    const firstEntryOf = new Map<string, EntryRow>();
    for (const t of targets) if (!firstEntryOf.has(t.evidence_id)) firstEntryOf.set(t.evidence_id, entryById.get(t.applicability_entry_id)!);
    const derivedOf = new Map<string, ReturnType<typeof evidenceState>>();
    for (const e of evidence) {
      const entry = firstEntryOf.get(e.id) ?? null;
      const derived = evidenceState(stateIn(e, entry?.management_system_id ?? null, entry?.framework_version_id ?? null), today, now);
      derivedOf.set(e.id, derived);
      if (derived.freshness !== e.freshness_status || derived.integrity !== e.integrity_status) {
        await trx
          .updateTable('evidence')
          .set({ freshness_status: derived.freshness, integrity_status: derived.integrity, derived_at: now })
          .where('id', '=', e.id)
          .execute();
        result.evidenceUpdated += 1;
      }
      if (derived.freshness === 'aging') {
        result.aging.push({ id: e.id, code: e.evidence_code, title: e.title, ownerUserId: e.owner_user_id, producedAt: e.produced_at, msId: entry?.management_system_id ?? null });
      }
    }

    // 4. Entries: stored state and the TS 6.1 automatic downgrade.
    const rules = await activeRulesBySystem(trx);
    const evidenceOfEntry = new Map<string, EvidenceRow[]>();
    for (const t of targets) {
      const e = evidenceById.get(t.evidence_id);
      if (!e) continue;
      const list = evidenceOfEntry.get(t.applicability_entry_id) ?? [];
      list.push(e);
      evidenceOfEntry.set(t.applicability_entry_id, list);
    }
    // Evidence whose task must stay open, per rule (closing considers only evidence recomputed in this run).
    const keepOpen = { 'BR-11': new Set<string>(), 'BR-31': new Set<string>() };
    for (const entry of entries) {
      const list = evidenceOfEntry.get(entry.id) ?? [];
      const state = entryEvidenceState(
        list.map((e) => stateIn(e, entry.management_system_id, entry.framework_version_id)),
        today,
        now,
      );
      if (
        state.lastEvidenceAt !== entry.last_evidence_at ||
        state.freshnessStatus !== entry.freshness_status ||
        state.integrityStatus !== entry.integrity_status
      ) {
        await trx
          .updateTable('applicability_entry')
          .set({ last_evidence_at: state.lastEvidenceAt, freshness_status: state.freshnessStatus, integrity_status: state.integrityStatus, derived_at: now })
          .where('id', '=', entry.id)
          .execute();
        result.entriesUpdated += 1;
      }
      if (entry.implementation_status !== 'implemented' || list.length === 0 || state.keepsImplemented) continue;
      // Which rule: an unverifiable file (BR-31) wins over an out-of-date record (BR-11).
      const derivedList = list.map((e) => ({ e, s: evidenceState(stateIn(e, entry.management_system_id, entry.framework_version_id), today, now) }));
      const unverifiable = derivedList.filter((d) => !d.s.valid);
      const rule: 'BR-11' | 'BR-31' = unverifiable.length > 0 ? 'BR-31' : 'BR-11';
      if (!ruleActive(rules, rule, [entry.management_system_id])) continue;
      await this.downgrade(trx, entry, rule, result);
      const causes = rule === 'BR-31' ? unverifiable : derivedList.filter((d) => d.s.freshness === 'expired' || d.s.freshness === 'critical');
      for (const { e } of causes) {
        const task = await this.tasks.open(trx, {
          rule,
          entityType: 'evidence',
          entityId: e.id,
          entityCode: e.evidence_code,
          msId: entry.management_system_id,
          ownerUserId: e.owner_user_id,
          dueAt: null,
          title:
            rule === 'BR-31'
              ? { en: `Re-link or upload the correct version of ${e.evidence_code}`, id: `Tautkan ulang atau unggah versi yang benar untuk ${e.evidence_code}` }
              : { en: `Provide current evidence for ${e.evidence_code}`, id: `Sediakan bukti terkini untuk ${e.evidence_code}` },
        });
        if (task.created) result.tasksOpened += 1;
      }
    }
    // A task stays open while its evidence is still unverifiable (BR-31) or out of date (BR-11).
    for (const [id, derived] of derivedOf) {
      if (!derived.valid) keepOpen['BR-31'].add(id);
      if (derived.freshness === 'expired' || derived.freshness === 'critical') keepOpen['BR-11'].add(id);
    }
    const within = whole ? undefined : new Set(derivedOf.keys());
    for (const rule of ['BR-11', 'BR-31'] as const) {
      result.tasksClosed += (await this.tasks.closeCleared(trx, rule, 'evidence', keepOpen[rule], within)).length;
    }
    return result;
  }

  private async downgrade(trx: Trx, entry: EntryRow, rule: 'BR-11' | 'BR-31', result: RecomputeResult): Promise<void> {
    await trx
      .updateTable('applicability_entry')
      .set({ implementation_status: 'partially_implemented', updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
      .where('id', '=', entry.id)
      .execute();
    await this.audit.record(trx, {
      action: 'freshness.downgrade',
      actor: { userId: SYSTEM_USER_ID, kind: 'system' },
      msId: entry.management_system_id,
      entityType: 'applicability_entry',
      entityId: entry.id,
      entityCode: entry.code,
      before: { implementation_status: 'implemented' },
      after: { implementation_status: 'partially_implemented', rule },
    });
    result.downgraded.push({ entryId: entry.id, code: entry.code, rule });
    if (!entry.owner_user_id) return;
    const text =
      rule === 'BR-31'
        ? {
            en: `The evidence file of ${entry.code} can no longer be verified in its repository, so the control is now partially implemented (BR-31). Re-link it or upload the correct version.`,
            id: `Berkas bukti ${entry.code} tidak dapat diverifikasi lagi di repositorinya, sehingga kontrol kini diterapkan sebagian (BR-31). Tautkan ulang atau unggah versi yang benar.`,
          }
        : {
            en: `The evidence of ${entry.code} has expired, so the control is now partially implemented (BR-11). Provide current evidence and verify it again.`,
            id: `Bukti ${entry.code} telah kedaluwarsa, sehingga kontrol kini diterapkan sebagian (BR-11). Sediakan bukti terkini dan verifikasi kembali.`,
          };
    const created = await this.notifications.create(trx, {
      recipientUserId: entry.owner_user_id,
      kind: 'freshness_downgrade',
      msId: entry.management_system_id,
      title: { en: `${entry.code} downgraded to partially implemented`, id: `${entry.code} diturunkan menjadi diterapkan sebagian` },
      body: text,
      ref: { module: 'implementation', entityType: 'applicability_entry', id: entry.id, code: entry.code },
      createdBy: SYSTEM_USER_ID,
    });
    if (created) result.notifications += 1;
  }

  private async loadEvidence(trx: Trx, ids: string[] | null): Promise<EvidenceRow[]> {
    const { rows } = await sql<EvidenceRow>`
      SELECT ev.id, ev.evidence_code, ev.title, ev.owner_user_id, ev.produced_at, ev.frequency_code, ev.freshness_status, ev.integrity_status,
             so.link_status AS so_link_status, so.hash_algorithm AS so_hash_algorithm, so.hash_source AS so_hash_source,
             so.link_status_since AS so_link_status_since, so.link_status_reason AS so_link_status_reason
        FROM evidence ev
        LEFT JOIN storage_object so ON so.id = ev.storage_object_id
       WHERE ev.deleted_at IS NULL ${ids ? sql`AND ev.id = ANY(${uuids(ids)})` : sql``}
       ORDER BY ev.position, ev.evidence_code`.execute(trx);
    return rows;
  }
}
