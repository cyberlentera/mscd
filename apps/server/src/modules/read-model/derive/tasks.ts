// My Tasks (build plan D-29, C.9 "Tasks", D.2 `TaskList`, UI 2.11): the chain items a person holds in every system
// where they hold a role, without requirement items they marked complete themselves (they wait for someone else's
// verification), merged with the open stored tasks (`task` rows of BR-10, BR-11, BR-15, BR-31) whose record is not
// already one of those chain items.
import type { ChainItem, Pair, RecordRef, Requirement, TaskItem, TaskList } from '@mscd/shared';
import { diffDays } from '../../../common/dates';
import { chainItemStatus, dueAfterAudit } from './chain';
import { same } from './text';

export interface SystemTaskSource {
  ms: string;
  /** Date of the system's next audit, for `after` of stored tasks. */
  auditDate: string | null;
  items: readonly ChainItem[];
  reqs: readonly Pick<Requirement, 'id' | 'st' | 'owner' | 'by'>[];
  /** Record refs of the system's snapshot, to match stored tasks to chain items by record. */
  refs: Readonly<Record<string, RecordRef>>;
}

/** An open `task` row owned by the person. */
export interface StoredTask {
  id: string;
  ms: string;
  entityType: string;
  entityId: string;
  entityCode: string | null;
  title: Pair;
  dueAt: string | null;
}

/** UI 2.11 `taskItems(me)` of one system. */
export function heldChainItems(handle: string, source: SystemTaskSource): ChainItem[] {
  const reqs = new Map(source.reqs.map((r) => [r.id, r]));
  return source.items.filter((i) => {
    if (i.h !== handle) return false;
    if (i.kind !== 'req') return true;
    const req = reqs.get(i.id);
    return !(req && req.st === 'complete' && (req.by || req.owner) === handle);
  });
}

function toTask(ms: string, item: ChainItem): TaskItem {
  return { key: item.key, ms, kind: item.kind, id: item.id, title: item.title, act: item.act, due: item.due, st: item.st, after: item.after, stage: item.stage };
}

/** Days from `today` to a due date (UI `dd`), null without one. */
function daysUntil(due: string | null, today: string): number | null {
  return due ? diffDays(today, due) : null;
}

/** Items sorted by due date (no due date last), keeping the source order among equal dates. */
export function sortTasks(items: readonly TaskItem[], today: string): TaskItem[] {
  return items
    .map((item, index) => ({ item, index, dn: daysUntil(item.due, today) }))
    .sort((a, b) => (a.dn ?? 9999) - (b.dn ?? 9999) || a.index - b.index)
    .map((x) => x.item);
}

/** UI 2.11 groups: overdue (not pending), this week (pending, due within 7 days), later (pending, no due date or later). */
export function taskCounts(items: readonly Pick<TaskItem, 'st' | 'due'>[], today: string): TaskList['counts'] {
  let overdue = 0;
  let week = 0;
  let later = 0;
  for (const item of items) {
    const dn = daysUntil(item.due, today);
    if (item.st !== 'pending') overdue += 1;
    else if (dn !== null && dn <= 7) week += 1;
    else later += 1;
  }
  return { total: items.length, overdue, week, later };
}

/** D-29: the person's chain items in every system, then the stored tasks that are not already one of them. */
export function deriveTaskList(handle: string, today: string, sources: readonly SystemTaskSource[], stored: readonly StoredTask[]): TaskList {
  const items: TaskItem[] = [];
  const held = new Set<string>();
  for (const source of sources) {
    for (const item of heldChainItems(handle, source)) {
      items.push(toTask(source.ms, item));
      for (const key of [item.key, item.refKey]) {
        const ref = key ? source.refs[key] : undefined;
        if (ref) held.add(`${ref.entityType}:${ref.id}`);
      }
    }
  }
  const auditDates = new Map(sources.map((s) => [s.ms, s.auditDate]));
  for (const task of stored) {
    if (held.has(`${task.entityType}:${task.entityId}`)) continue;
    items.push({
      key: `${task.ms}:task:${task.id}`,
      ms: task.ms,
      kind: 'task',
      id: task.id,
      title: task.entityCode ? same(task.entityCode) : task.title,
      act: task.title,
      due: task.dueAt,
      st: chainItemStatus({ holder: handle, due: task.dueAt }, today),
      after: dueAfterAudit(task.dueAt, auditDates.get(task.ms) ?? null),
      stage: null,
    });
  }
  const sorted = sortTasks(items, today);
  return { items: sorted, counts: taskCounts(sorted, today) };
}
