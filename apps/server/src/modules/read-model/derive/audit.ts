// Certification cycle rows of a system (build plan G.5 `EVENTS`, `FOCUS`, `PREP`, `PAST`, `CYCLE_ITEMS`, TS 9.4,
// C.11, UI 1.10).
import {
  uiFindingClass, uiFindingState, uiTupleStatus, type CycleRow, type EventRow, type FindingClassification, type FindingStatus,
  type Pair, type PastRow, type PrepRow, type TaskProgressStatus, type Text,
} from '@mscd/shared';
import { NONE } from './text';

/** An `audit_event` row. */
export interface AuditEventRow {
  id: string;
  updatedAt: Date;
  scheduledAt: string;
  auditDays: number | null;
  shortLabel: string;
  nameEn: string;
  nameId: string;
  leadAuditorName: string | null;
  expectedFocus: string | null;
  prepWindowDays: number;
  outcomeSummary: string | null;
}

/** Bilingual event labels kept by date in `management_system.display.eventLabels` (D-06). */
export type EventLabels = Readonly<Record<string, { t?: Pair; short?: Pair; result?: Pair } | undefined>>;

/** TS 9.4: the next audit event is the first one scheduled on or after `today`. */
export function nextAuditEvent<T extends Pick<AuditEventRow, 'scheduledAt'>>(events: readonly T[], today: string): T | null {
  return [...events].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).find((e) => e.scheduledAt >= today) ?? null;
}

/** A stored English text with its stored pair when the pair's English part is that text. */
function withPair(text: string, pair: Pair | undefined): Text {
  return pair && pair[0] === text ? [pair[0], pair[1]] : text;
}

/** G.5 `EVENTS[ms]`: events by date with the short label, days, result and the `next` flag. */
export function deriveEvents(events: readonly AuditEventRow[], today: string, labels: EventLabels = {}): EventRow[] {
  const next = nextAuditEvent(events, today);
  return [...events]
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .map((e) => {
      const label = labels[e.scheduledAt];
      const matched = label?.t !== undefined && label.t[0] === e.shortLabel;
      const row: EventRow = { t: withPair(e.shortLabel, label?.t), d: e.scheduledAt, days: e.auditDays };
      if (matched && label?.short) row.short = [label.short[0], label.short[1]];
      if (e.outcomeSummary) row.result = withPair(e.outcomeSummary, label?.result);
      if (next && e.id === next.id) row.next = true;
      return row;
    });
}

/** G.5 `FOCUS[ms]`: the next event's expected focus, else `-`. */
export function deriveFocus(next: Pick<AuditEventRow, 'expectedFocus'> | null): string {
  return next?.expectedFocus || '-';
}

/** An `audit_prep_task` row. */
export interface PrepTaskRow {
  id: string;
  updatedAt: Date;
  auditEventId: string;
  title: string;
  owner: string | null;
  dueAt: string;
  status: TaskProgressStatus;
  position: number;
}

/** G.5 `PREP[ms]`: preparation tasks of the next event by position. */
export function derivePrep(tasks: readonly PrepTaskRow[], next: Pick<AuditEventRow, 'id'> | null): PrepRow[] {
  if (!next) return [];
  return tasks
    .filter((t) => t.auditEventId === next.id)
    .sort((a, b) => a.position - b.position)
    .map((t): PrepRow => [t.title, t.owner ?? NONE, t.dueAt, uiTupleStatus(t.status)]);
}

/** A `finding` row. */
export interface FindingRow {
  id: string;
  code: string;
  title: string;
  classification: FindingClassification;
  clauseRef: string | null;
  source: 'certification_audit' | 'internal_audit' | 'self_assessment' | 'other';
  status: FindingStatus;
  statusNote: string | null;
  position: number;
}

/** G.5 `PAST[ms]`: certification audit findings by position (classifications major, minor and OFI). */
export function derivePast(findings: readonly FindingRow[]): PastRow[] {
  const rows: PastRow[] = [];
  for (const f of [...findings].sort((a, b) => a.position - b.position)) {
    if (f.source !== 'certification_audit') continue;
    const label = uiFindingClass(f.classification);
    if (!label) continue;
    rows.push([f.code, label, f.clauseRef ?? '', f.title, uiFindingState(f.status), f.statusNote ?? '']);
  }
  return rows;
}

/** G.5 `MS.findings`: findings not closed with classification major, minor or OFI, and the major ones among them. */
export function findingCounts(findings: readonly Pick<FindingRow, 'classification' | 'status'>[]): { open: number; major: number } {
  const open = findings.filter((f) => f.status !== 'closed' && uiFindingClass(f.classification) !== null);
  return { open: open.length, major: open.filter((f) => f.classification === 'major').length };
}

/** A `cycle_requirement_status` row. */
export interface CycleItemRow {
  id: string;
  updatedAt: Date;
  cycleId: string;
  requirementCode: string;
  title: string;
  owner: string | null;
  dueAt: string;
  status: TaskProgressStatus;
  conditionNote: string | null;
  position: number;
}

/** G.5 `CYCLE_ITEMS[ms]`: items of the latest cycle by position. */
export function deriveCycleItems(items: readonly CycleItemRow[], latestCycleId: string | null): CycleRow[] {
  if (!latestCycleId) return [];
  return items
    .filter((i) => i.cycleId === latestCycleId)
    .sort((a, b) => a.position - b.position)
    .map((i): CycleRow => [i.requirementCode, i.title, i.owner ?? NONE, i.dueAt, uiTupleStatus(i.status), i.conditionNote ?? '']);
}
