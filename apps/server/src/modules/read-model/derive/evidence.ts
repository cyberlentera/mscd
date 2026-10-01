// Evidence of a system (build plan G.5 `bundle.evs`, E.3, C.12, UI 1.7).
import type { Evidence } from '@mscd/shared';
import { fmtDayTime } from '../../../common/dates';
import { freshnessBand, nextDue, thresholdsFor, type ThresholdRow } from './freshness';
import type { EvidenceRow, FrequencyDef } from './inputs';
import { hashAlgText, integOf } from './integrity';
import { NONE } from './text';

export interface EvidenceContext {
  msId: string;
  today: string;
  timeZone: string;
  frequencies: ReadonlyMap<string, FrequencyDef>;
  thresholds: readonly ThresholdRow[];
  /** The UI id (`ctrl`) and key (`ctrlKey`) of each applicability entry of the system, by entry id. */
  entries: ReadonlyMap<string, { id: string; key: string }>;
}

/** Period of a frequency in days (E.3 `period`; 0 for per event and for unknown codes). */
export function periodOf(frequencies: ReadonlyMap<string, FrequencyDef>, code: string): number {
  return frequencies.get(code)?.periodDays ?? 0;
}

/** One evidence record of `bundle.evs` (G.5 with E.3 and C.12). */
export function deriveEvidence(e: EvidenceRow, ctx: EvidenceContext): Evidence {
  const p = periodOf(ctx.frequencies, e.frequency);
  const thresholds = thresholdsFor(ctx.thresholds, ctx.msId, e.frequency);
  const entry = ctx.entries.get(e.entryId);
  const object = e.object;
  const out: Evidence = {
    code: e.code,
    ctrl: entry?.id ?? '',
    ctrlKey: entry?.key ?? '',
    title: e.title,
    freq: e.frequency,
    p,
    prod: e.producedAt ?? '',
    next: nextDue(e.producedAt, p, e.nextDueOverride),
    fresh: freshnessBand(e.producedAt, p, ctx.today, thresholds),
    integ: integOf(object),
    loc: object?.repositorySlug ?? '',
    owner: e.owner ?? NONE,
    ver: object?.versionLabel ?? '-',
    hashAlg: hashAlgText(object),
    path: object?.folderPath ?? '',
  };
  if (object?.hashValue) out.hash = object.hashValue;
  if (object?.lastVerifiedAt) out.lastCheck = fmtDayTime(object.lastVerifiedAt, ctx.timeZone);
  if (object?.lastGoodCheckAt) out.lastGoodCheck = fmtDayTime(object.lastGoodCheckAt, ctx.timeZone);
  return out;
}
