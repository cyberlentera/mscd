// Freshness and integrity derivation (build plan E.3, A-42, TS 6.1, TS 6.4). One module for the read model, the
// commands (BR-01 in the applicability verify command, WP-20) and the jobs (`freshness.recompute`, WP-22): the same
// functions decide whether evidence satisfies BR-01 and whether an implemented entry keeps its status.
import type { FreshnessStatus } from '@mscd/shared';
import { addDays, diffDays } from '../../../common/dates';
import { br01LinkOk, integOf, integrityStatus, validForStatus, type IntegrityStatus, type StorageObjectState } from './integrity';

/** Thresholds of one frequency (A-42): fresh up to `period + grace`, aging up to `period * aging + grace`, expired up to `period * expired`. */
export interface FreshnessThresholds {
  grace: number;
  aging: number;
  expired: number;
}

/** A-42 defaults: grace 1 day, aging factor 1.25, expired factor 2. */
export const DEFAULT_THRESHOLDS: FreshnessThresholds = { grace: 1, aging: 1.25, expired: 2 };

/** A `freshness_threshold` row (`managementSystemId` null for the organisation default). */
export interface ThresholdRow {
  managementSystemId: string | null;
  frequencyCode: string;
  freshGraceDays: number;
  agingFactor: number;
  expiredFactor: number;
}

/** E.3 `thresholds(ms, frequency)`: the system's row, then the organisation's, else the defaults. */
export function thresholdsFor(rows: readonly ThresholdRow[], msId: string, frequencyCode: string): FreshnessThresholds {
  const row =
    rows.find((r) => r.managementSystemId === msId && r.frequencyCode === frequencyCode) ??
    rows.find((r) => r.managementSystemId === null && r.frequencyCode === frequencyCode);
  return row ? { grace: row.freshGraceDays, aging: row.agingFactor, expired: row.expiredFactor } : DEFAULT_THRESHOLDS;
}

/** Days since production on `today` (negative for a future date). */
export function ageInDays(producedAt: string, today: string): number {
  return diffDays(producedAt, today);
}

/**
 * E.3 `band(produced_at, p)`: `fresh` for per-event evidence (`p = 0`) or up to `p + grace` days, `aging` up to
 * `p * aging + grace`, `expired` up to `p * expired`, else `critical`. Evidence never produced is `critical`
 * unless it is per event.
 */
export function freshnessBand(producedAt: string | null, periodDays: number, today: string, t: FreshnessThresholds = DEFAULT_THRESHOLDS): FreshnessStatus {
  if (periodDays === 0) return 'fresh';
  if (!producedAt) return 'critical';
  const age = ageInDays(producedAt, today);
  if (age <= periodDays + t.grace) return 'fresh';
  if (age <= periodDays * t.aging + t.grace) return 'aging';
  if (age <= periodDays * t.expired) return 'expired';
  return 'critical';
}

/** E.3 `next_due(e)`: the stored override, else `produced_at + p` when `p > 0`, else null. */
export function nextDue(producedAt: string | null, periodDays: number, override: string | null): string | null {
  if (override) return override;
  if (periodDays > 0 && producedAt) return addDays(producedAt, periodDays);
  return null;
}

/** One evidence record as E.3 reads it. */
export interface EvidenceState {
  producedAt: string | null;
  periodDays: number;
  thresholds: FreshnessThresholds;
  object: StorageObjectState | null;
}

/** The derived values of one evidence record (E.3), as `freshness.recompute` stores them. */
export interface DerivedEvidenceState {
  freshness: FreshnessStatus;
  integrity: IntegrityStatus;
  valid: boolean;
  br01LinkOk: boolean;
  /** Band `fresh` or `aging` and valid for status logic (E.3 candidate). */
  candidate: boolean;
}

export function evidenceState(e: EvidenceState, today: string, now: Date): DerivedEvidenceState {
  const freshness = freshnessBand(e.producedAt, e.periodDays, today, e.thresholds);
  const valid = validForStatus(e.object, now);
  return {
    freshness,
    integrity: integrityStatus(e.object, now),
    valid,
    br01LinkOk: br01LinkOk(e.object),
    candidate: (freshness === 'fresh' || freshness === 'aging') && valid,
  };
}

/** E.3 `entryEvidenceState(entry)`: what the evidence of one applicability entry says about it. */
export interface EntryEvidenceState {
  /** A candidate with an intact or moved link produced within the current operating period (BR-01). */
  satisfiesBr01: boolean;
  /** At least one candidate exists (TS 6.1 automatic downgrade when false). */
  keepsImplemented: boolean;
  /** Stored on the entry: `last_evidence_at`, `freshness_status`, `integrity_status` of the best evidence. */
  lastEvidenceAt: string | null;
  freshnessStatus: FreshnessStatus | null;
  integrityStatus: IntegrityStatus | null;
}

/**
 * E.3 over the non-deleted evidence targeting an entry: candidates are fresh or aging and valid; the best is the
 * candidate with the latest `produced_at`, else the evidence with the latest `produced_at`; BR-01 needs a candidate
 * with a BR-01 link produced within the current operating period (`today - produced_at <= period + grace`, any date
 * for per-event evidence).
 */
export function entryEvidenceState(evidence: readonly EvidenceState[], today: string, now: Date): EntryEvidenceState {
  const rows = evidence.map((e) => ({ e, s: evidenceState(e, today, now) }));
  const candidates = rows.filter((r) => r.s.candidate);
  // The latest `produced_at` (records without one come last); the first of equal dates wins.
  const latest = (list: typeof rows) => {
    let best: (typeof rows)[number] | null = null;
    for (const r of list) {
      if (!best || (r.e.producedAt !== null && (best.e.producedAt === null || r.e.producedAt > best.e.producedAt))) best = r;
    }
    return best;
  };
  const best = candidates.length > 0 ? latest(candidates) : latest(rows);
  const satisfiesBr01 = candidates.some(
    (r) => r.s.br01LinkOk && (r.e.periodDays === 0 || (r.e.producedAt !== null && ageInDays(r.e.producedAt, today) <= r.e.periodDays + r.e.thresholds.grace)),
  );
  return {
    satisfiesBr01,
    keepsImplemented: candidates.length > 0,
    lastEvidenceAt: best?.e.producedAt ?? null,
    freshnessStatus: best ? best.s.freshness : null,
    integrityStatus: best ? best.s.integrity : null,
  };
}

/** C.12 integrity code of an evidence record (re-exported for readers that import only this module). */
export { integOf };
