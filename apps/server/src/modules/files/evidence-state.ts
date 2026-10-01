// The stored freshness and integrity of one evidence record after a new file (build plan E.3): the same derivation
// as `freshness.recompute`, in the context of the evidence's first target system (its pack frequency rule and its
// freshness thresholds), written in the command's transaction. The applicability entries follow through the
// `freshness.recompute` job the command enqueues.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { evidenceState, thresholdsFor, type DerivedEvidenceState, type StorageObjectState, type ThresholdRow } from '../read-model';

/** E.3 values of an evidence record with the given production date and storage object. */
export async function deriveEvidence(
  trx: Trx,
  input: { evidenceId: string; frequencyCode: string; producedAt: string; object: StorageObjectState | null; today: string; now: Date },
): Promise<DerivedEvidenceState> {
  const first = await sql<{ management_system_id: string; framework_version_id: string }>`
    select t.management_system_id, ms.framework_version_id
      from evidence_target t join management_system ms on ms.id = t.management_system_id
     where t.evidence_id = ${input.evidenceId} and t.deleted_at is null
     order by t.position, t.id limit 1`.execute(trx);
  const target = first.rows[0] ?? null;
  const rules = await sql<{ framework_version_id: string; period_days: number }>`
    select framework_version_id, period_days from ref.evidence_frequency_rule
     where code = ${input.frequencyCode}
       and framework_version_id in (select distinct framework_version_id from management_system where deleted_at is null)`.execute(trx);
  const period =
    rules.rows.find((r) => target && r.framework_version_id === target.framework_version_id)?.period_days ?? rules.rows[0]?.period_days ?? 0;
  const thresholds: ThresholdRow[] = (
    await sql<{ management_system_id: string | null; frequency_code: string; fresh_grace_days: string; aging_factor: string; expired_factor: string }>`
      select management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor
        from freshness_threshold where deleted_at is null and frequency_code = ${input.frequencyCode}`.execute(trx)
  ).rows.map((t) => ({
    managementSystemId: t.management_system_id,
    frequencyCode: t.frequency_code,
    freshGraceDays: Number(t.fresh_grace_days),
    agingFactor: Number(t.aging_factor),
    expiredFactor: Number(t.expired_factor),
  }));
  return evidenceState(
    {
      producedAt: input.producedAt,
      periodDays: Number(period),
      thresholds: thresholdsFor(thresholds, target?.management_system_id ?? '', input.frequencyCode),
      object: input.object,
    },
    input.today,
    input.now,
  );
}
