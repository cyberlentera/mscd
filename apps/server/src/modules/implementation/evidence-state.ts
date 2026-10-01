// The E.3 evidence state of one applicability entry, read in the command's transaction: the non-deleted evidence that
// targets the entry with its storage object, the pack period of each evidence frequency in the system's edition and
// the freshness thresholds (system, then organisation, then the A-42 defaults). The decision itself is
// `entryEvidenceState` of the read model, the same function `freshness.recompute` uses (WP-17, WP-22), so the verify
// command and the automatic downgrade never disagree.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import {
  entryEvidenceState, thresholdsFor, type EntryEvidenceState, type EvidenceState, type StorageObjectState, type ThresholdRow,
} from '../read-model';

interface EvidenceRow {
  produced_at: string | null;
  frequency_code: string;
  period_days: number | null;
  link_status: StorageObjectState['linkStatus'] | null;
  hash_algorithm: StorageObjectState['hashAlgorithm'] | null;
  hash_source: StorageObjectState['hashSource'] | null;
  link_status_since: Date | null;
  link_status_reason: StorageObjectState['linkStatusReason'];
}

/** The E.3 inputs of every non-deleted evidence record that targets the entry, in the context of the entry's system. */
export async function loadEntryEvidence(trx: Trx, entryId: string, msId: string): Promise<EvidenceState[]> {
  const { rows } = await sql<EvidenceRow>`
    select ev.produced_at::text as produced_at, ev.frequency_code, fr.period_days,
           so.link_status, so.hash_algorithm, so.hash_source, so.link_status_since, so.link_status_reason
      from evidence_target t
      join evidence ev on ev.id = t.evidence_id and ev.deleted_at is null
      join management_system ms on ms.id = ${msId}
      left join ref.evidence_frequency_rule fr on fr.framework_version_id = ms.framework_version_id and fr.code = ev.frequency_code
      left join storage_object so on so.id = ev.storage_object_id
     where t.applicability_entry_id = ${entryId} and t.deleted_at is null
     order by ev.produced_at desc nulls last, ev.id`.execute(trx);
  const thresholds = await loadThresholds(trx);
  return rows.map((r) => ({
    producedAt: r.produced_at,
    periodDays: Number(r.period_days ?? 0),
    thresholds: thresholdsFor(thresholds, msId, r.frequency_code),
    object: r.link_status
      ? {
          linkStatus: r.link_status,
          hashAlgorithm: r.hash_algorithm!,
          hashSource: r.hash_source!,
          linkStatusSince: r.link_status_since!,
          linkStatusReason: r.link_status_reason,
        }
      : null,
  }));
}

async function loadThresholds(trx: Trx): Promise<ThresholdRow[]> {
  const { rows } = await sql<{ management_system_id: string | null; frequency_code: string; fresh_grace_days: string; aging_factor: string; expired_factor: string }>`
    select management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor
      from freshness_threshold where deleted_at is null`.execute(trx);
  return rows.map((t) => ({
    managementSystemId: t.management_system_id,
    frequencyCode: t.frequency_code,
    freshGraceDays: Number(t.fresh_grace_days),
    agingFactor: Number(t.aging_factor),
    expiredFactor: Number(t.expired_factor),
  }));
}

/** E.3 `entryEvidenceState` of one entry on `today` (organisation date) at `now` (validity windows). */
export async function evidenceStateOfEntry(trx: Trx, entryId: string, msId: string, today: string, now: Date): Promise<EntryEvidenceState> {
  return entryEvidenceState(await loadEntryEvidence(trx, entryId, msId), today, now);
}
