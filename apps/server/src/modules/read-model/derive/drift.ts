// Regression detector (build plan G.5 `DRIFT`, A.4 5.15, UI 2.11): rule definitions with their stored open rows,
// or the live list a rule reads, and the predicates the `drift.evaluate` job (WP-23) applies to find rows.
import type { DriftRow, Evidence, UiDriftPattern } from '@mscd/shared';
import { addDays } from '../../../common/dates';
import { isUnverifiable } from './integrity';
import { NONE } from './text';

/** A `ref.drift_rule_def` row. */
export interface DriftRuleDefRow {
  code: string;
  labelEn: string;
  labelId: string;
  sourceKind: 'manual' | 'unverif' | 'nohash' | 'metric' | 'exercise' | 'stale_risk' | 'dd_expired';
  sourceStage: string | null;
  predicate: Record<string, unknown>;
  sortOrder: number;
}

/** An open `drift_result` row. */
export interface DriftResultRow {
  id: string;
  updatedAt?: Date;
  ruleCode: string;
  entityCode: string;
  title: string;
  holder: string | null;
  dueAt: string | null;
  /** Local date the row was detected; stands in for a missing due date (the wire tuple needs a date). */
  detectedOn: string;
  position: number;
}

/** Rule kinds whose rows are read live from other lists (G.5 `src`); every other kind shows stored rows. */
export const LIVE_DRIFT_SOURCES = ['unverif', 'nohash', 'metric', 'exercise'] as const;
type LiveSource = (typeof LIVE_DRIFT_SOURCES)[number];

function isLive(kind: DriftRuleDefRow['sourceKind']): kind is LiveSource {
  return (LIVE_DRIFT_SOURCES as readonly string[]).includes(kind);
}

/** G.5 `DRIFT[ms]`: definitions by sort order with stored rows (`manual`, `stale_risk`, `dd_expired`) or `src`. */
export function deriveDriftPatterns(defs: readonly DriftRuleDefRow[], results: readonly DriftResultRow[]): UiDriftPattern[] {
  return [...defs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map((def): UiDriftPattern => {
      const base = { id: def.code, l: [def.labelEn, def.labelId] as [string, string] };
      if (isLive(def.sourceKind)) return { ...base, src: def.sourceKind };
      const rows = results
        .filter((r) => r.ruleCode === def.code)
        .sort((a, b) => a.position - b.position)
        .map((r): DriftRow => [r.entityCode, r.title, r.holder ?? NONE, r.dueAt ?? r.detectedOn]);
      return { ...base, rows };
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Predicates (shared with `drift.evaluate`, WP-23)
// ---------------------------------------------------------------------------------------------------------------

/** The date `months` calendar months before `iso` (clamped to the last day of a shorter month). */
export function monthsBefore(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** `stale_risk` (`predicate.months`, default 12): never assessed, or assessed before `today` minus the months. */
export function isStaleRisk(risk: { assessedAt: string | null }, today: string, months = 12): boolean {
  return risk.assessedAt === null || risk.assessedAt < monthsBefore(today, months);
}

/** `dd_expired`: no completed due diligence that is still valid on `today`. */
export function lacksValidDueDiligence(records: readonly { status: string; validUntil: string | null }[], today: string): boolean {
  return !records.some((r) => r.status === 'completed' && r.validUntil !== null && r.validUntil >= today);
}

/** `unverif`: evidence whose file cannot be verified (changed, moved, missing, revoked). */
export function unverifiableEvidenceOf<T extends Pick<Evidence, 'integ'>>(evs: readonly T[]): T[] {
  return evs.filter((e) => isUnverifiable(e.integ));
}

/** `nohash`: evidence without a content hash (Google-native files). */
export function evidenceWithoutHashOf<T extends Pick<Evidence, 'integ'>>(evs: readonly T[]): T[] {
  return evs.filter((e) => e.integ === 'nohash');
}

/** `metric`: a metric not measured within its period plus one day of grace (never measured counts as stale). */
export function isStaleMetric(metric: { lastMeasuredAt: string | null; periodDays: number }, today: string): boolean {
  if (metric.periodDays <= 0) return false;
  return metric.lastMeasuredAt === null || addDays(metric.lastMeasuredAt, metric.periodDays + 1) < today;
}

/** `exercise`: a business continuity plan without an exercise planned or performed on or after `today` minus a year. */
export function lacksScheduledExercise(exercises: readonly { plannedAt: string | null; performedAt: string | null }[], today: string): boolean {
  const since = monthsBefore(today, 12);
  return !exercises.some((x) => (x.plannedAt !== null && x.plannedAt >= today) || (x.performedAt !== null && x.performedAt >= since));
}
