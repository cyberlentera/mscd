// Area `ui` (owner from wave 7: WP-17): the parity reads (D-05, D.3 "UI parity reads") and My Tasks (D.2 `TaskList`,
// D-29). The snapshot schemas live in `src/ui`.
import { z } from 'zod';
import { ItemStatus, TaskItemKind } from '../enums.js';
import { UiMsSnapshot, UiOrgSnapshot } from '../ui/snapshot.js';
import { IsoDate, MsId, MsParams, Pair, RecordKey, StageKey, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

const EXAMPLE_TASK = {
  key: 'isms:x:T-014', ms: 'isms', kind: 'x', id: 'T-014',
  title: ['Deploy PAM for hypervisor administrators', 'Deploy PAM for hypervisor administrators'],
  act: ['Report implementation progress', 'Report implementation progress'], due: '2026-09-15', st: 'overdue', after: false, stage: 'treatment',
} as const;

export const TaskItem = named(
  'TaskItem',
  z.object({
    key: RecordKey,
    ms: MsId,
    kind: TaskItemKind,
    id: z.string(),
    title: Pair,
    act: Pair,
    due: IsoDate.nullable(),
    st: ItemStatus,
    after: z.boolean(),
    stage: StageKey.nullable(),
  }),
  'One item of My Tasks: a chain item held by the user, or a stored task (kind task, key <ms>:task:<uuid>, stage null) (D.2, D-29)',
  {
    valid: [EXAMPLE_TASK, { ...EXAMPLE_TASK, key: 'isms:task:8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', kind: 'task', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', stage: null }],
    invalid: [{ ...EXAMPLE_TASK, kind: 'drift' }, { ...EXAMPLE_TASK, title: 'x' }],
  },
);
export type TaskItem = z.infer<typeof TaskItem>;

export const TaskList = named(
  'TaskList',
  z.object({
    items: z.array(TaskItem),
    counts: z.object({ total: z.int().min(0), overdue: z.int().min(0), week: z.int().min(0), later: z.int().min(0) }),
  }),
  'GET /tasks: items across every system where the user holds a role, with the My Tasks counts (D.2)',
  { valid: [{ items: [EXAMPLE_TASK], counts: { total: 1, overdue: 1, week: 0, later: 0 } }], invalid: [{ items: [] }, { items: [], counts: { total: -1, overdue: 0, week: 0, later: 0 } }] },
);
export type TaskList = z.infer<typeof TaskList>;

export const uiOrgRoute = defineRoute({
  id: 'ui.org',
  owner: 'WP-17',
  method: 'GET',
  path: '/api/v1/ui/org',
  summary: 'Organisation snapshot for the UI (parity with the sample, limited by ScopePolicy)',
  auth: 'session',
  response: UiOrgSnapshot,
  errors: [],
});

export const uiMsRoute = defineRoute({
  id: 'ui.ms',
  owner: 'WP-17',
  method: 'GET',
  path: '/api/v1/ui/ms/:ms',
  summary: 'System snapshot for the UI: bundle, chain records, cycle, drift and record refs',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  response: UiMsSnapshot,
  errors: [404],
});

export const uiTasksRoute = defineRoute({
  id: 'ui.tasks',
  owner: 'WP-17',
  method: 'GET',
  path: '/api/v1/tasks',
  summary: 'My Tasks across the systems of the organisation, with stored tasks merged (D-29)',
  auth: 'session',
  response: TaskList,
  errors: [],
});

export const routes: RouteDef[] = [uiOrgRoute, uiMsRoute, uiTasksRoute];
