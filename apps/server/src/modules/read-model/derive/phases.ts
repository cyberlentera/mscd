// Phases and activities of a system (build plan G.5 `bundle.phases`, D-13, D-30, C.11, UI 1.9, UI 2.7) and the
// current phase of the implementation overview (UI 2.6).
import { uiActStatus, type Activity, type ActStatus, type Phase } from '@mscd/shared';
import type { ActivityRow } from './inputs';
import { NONE } from './text';

const COUNTED: readonly ActStatus[] = ['verified', 'complete', 'progress', 'blocked', 'ns', 'locked'];

/**
 * D-13: an activity is shown `locked` when it is not started and the previous phase is not fully verified (every
 * activity `verified`). The first phase is never locked.
 */
export function phaseVerified(rows: readonly Pick<ActivityRow, 'status'>[]): boolean {
  return rows.every((r) => r.status === 'verified');
}

export interface PhaseContext {
  ms: string;
  /** Document codes of the bundle: `docId` names an output document only when the bundle shows it. */
  documentCodes: ReadonlySet<string>;
}

/** One activity of a phase (UI 1.9 in wire form). */
export function deriveActivity(row: ActivityRow, previousPhaseVerified: boolean, ctx: PhaseContext): Activity {
  const st = uiActStatus(row.status, previousPhaseVerified);
  const out = row.outputDocumentCode ?? row.linkedDocumentCode;
  const docCode = row.linkedDocumentCode ?? out;
  const activity: Activity = {
    key: `${ctx.ms}:act:${row.phaseNo}.${row.activityNo}`,
    no: `${row.phaseNo}.${row.activityNo}`,
    title: row.title,
    st,
    blocker: st === 'blocked' ? row.blockerGateItemRef : null,
    owner: row.owner ?? NONE,
    out,
    docId: docCode && ctx.documentCodes.has(docCode) ? docCode : null,
    date: st === 'verified' ? row.verifiedAt : st === 'locked' ? null : row.dueAt,
    pno: row.phaseNo,
  };
  if (row.completedBy) activity.by = row.completedBy;
  return activity;
}

/** UI 2.7 phases with their activities and counts per status, in phase and activity order. */
export function derivePhases(rows: readonly ActivityRow[], ctx: PhaseContext): Phase[] {
  const byPhase = new Map<number, ActivityRow[]>();
  for (const row of [...rows].sort((a, b) => a.phaseNo - b.phaseNo || a.activityNo - b.activityNo)) {
    const list = byPhase.get(row.phaseNo) ?? [];
    list.push(row);
    byPhase.set(row.phaseNo, list);
  }
  const phases: Phase[] = [];
  let previous: ActivityRow[] | null = null;
  for (const [no, list] of byPhase) {
    const previousVerified = previous === null || phaseVerified(previous);
    const acts = list.map((row) => deriveActivity(row, previousVerified, ctx));
    const c = Object.fromEntries(COUNTED.map((s) => [s, acts.filter((a) => a.st === s).length])) as Phase['c'];
    phases.push({ no, n: list[0]!.phaseName, gate: list.some((r) => r.isGatePhase), acts, total: acts.length, c });
    previous = list;
  }
  return phases;
}

/** UI 2.6 current phase: the first phase not fully verified and without a locked activity, else the last. */
export function currentPhaseNo(phases: readonly Pick<Phase, 'no' | 'total' | 'c'>[]): number | null {
  if (phases.length === 0) return null;
  return (phases.find((p) => p.c.verified < p.total && !p.c.locked) ?? phases[phases.length - 1]!).no;
}
