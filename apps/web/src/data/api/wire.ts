// Wire form of the API data source (BUILD-PLAN H.4): the routes the source calls, the record key and reference
// helpers, the mapping of api answers to `CommandResult`, and the assembly of the UI 4.2 `Snapshot` from
// `GET /me`, `GET /ui/org`, `GET /ui/ms/{ms}` and `GET /tasks`.
//
// Pure functions only (no fetch, no browser API), so the unit tests call them directly. Shared contract types are
// imported as types only: the API bundle holds no code of @mscd/shared or zod.
import type {
  CommandResult as WireCommandResult, Me, RecordRef, TaskItem, TaskList, UiMsSnapshot, UiOrgSnapshot,
} from '@mscd/shared';
// static.js is JavaScript without type declarations (the web tsconfig has no allowJs); its LOC_VISUALS is typed below.
// @ts-expect-error untyped JavaScript module
import { LOC_VISUALS } from '../static.js';
import type {
  Activity, ChainItem, CommandResult, Document, Evidence, MeView, MsBundle, MsId, Pair, RecordKey, Requirement, Snapshot,
} from '../types';
import { API_PREFIX, CONNECTION_LOST } from './ApiClient';
import type { ApiError, ApiResult, HttpMethod } from './ApiClient';

/** The api routes of the data source as `[method, path]`; test/api/contract.test.ts compares them with the shared table. */
export const API_ROUTES = {
  me: ['GET', `${API_PREFIX}/me`],
  switchOrg: ['PUT', `${API_PREFIX}/me/org`],
  persona: ['POST', `${API_PREFIX}/auth/demo/persona`],
  uiOrg: ['GET', `${API_PREFIX}/ui/org`],
  uiMs: ['GET', `${API_PREFIX}/ui/ms/:ms`],
  tasks: ['GET', `${API_PREFIX}/tasks`],
  applicabilityTransition: ['POST', `${API_PREFIX}/ms/:ms/applicability/:id/transitions`],
  activityTransition: ['POST', `${API_PREFIX}/ms/:ms/activities/:id/transitions`],
  phaseVerify: ['POST', `${API_PREFIX}/ms/:ms/phases/:n/verify`],
  assign: ['POST', `${API_PREFIX}/ms/:ms/records/:entityType/:id/assignment`],
  completeAction: ['POST', `${API_PREFIX}/ms/:ms/records/:entityType/:id/complete-action`],
  taskComplete: ['POST', `${API_PREFIX}/tasks/:id/complete`],
  documentTransition: ['POST', `${API_PREFIX}/ms/:ms/documents/:id/transitions`],
  remind: ['POST', `${API_PREFIX}/reminders`],
  remindBulk: ['POST', `${API_PREFIX}/reminders/bulk`],
  browse: ['GET', `${API_PREFIX}/storage/repositories/:slug/browse`],
  uploadIntent: ['POST', `${API_PREFIX}/storage/upload-intents`],
  evidenceFiles: ['POST', `${API_PREFIX}/ms/:ms/evidence/:id/files`],
  documentVersions: ['POST', `${API_PREFIX}/ms/:ms/documents/:id/versions`],
  repositoryTest: ['POST', `${API_PREFIX}/admin/storage/repositories/:id/test`],
  repositoryReauthorize: ['POST', `${API_PREFIX}/admin/storage/repositories/:id/reauthorize`],
  repositoryMove: ['POST', `${API_PREFIX}/admin/storage/repositories/:id/move-requests`],
  exportCreate: ['POST', `${API_PREFIX}/exports`],
  exportGet: ['GET', `${API_PREFIX}/exports/:taskId`],
  exportSoa: ['GET', `${API_PREFIX}/ms/:ms/applicability/export`],
  exportDocuments: ['GET', `${API_PREFIX}/ms/:ms/documents/export`],
  calendarFeed: ['POST', `${API_PREFIX}/ms/:ms/calendar-feed`],
  linkHealthRun: ['POST', `${API_PREFIX}/ms/:ms/link-health/run`],
  evidencePack: ['POST', `${API_PREFIX}/ms/:ms/evidence-packs`],
  auditorAccess: ['POST', `${API_PREFIX}/ms/:ms/auditor-access`],
  packsCheckUpdates: ['POST', `${API_PREFIX}/admin/packs/check-updates`],
  packsImport: ['POST', `${API_PREFIX}/admin/packs/import`],
} as const satisfies Record<string, readonly [HttpMethod, string]>;

export type ApiRouteName = keyof typeof API_ROUTES;

/** Shared route id of each route above (D.3), for the contract test. */
export const API_ROUTE_IDS: Record<ApiRouteName, string> = {
  me: 'me.get',
  switchOrg: 'me.switch-org',
  persona: 'auth.demo-persona',
  uiOrg: 'ui.org',
  uiMs: 'ui.ms',
  tasks: 'ui.tasks',
  applicabilityTransition: 'applicability.transition',
  activityTransition: 'activity.transition',
  phaseVerify: 'phase.verify',
  assign: 'records.assign',
  completeAction: 'records.complete-action',
  taskComplete: 'tasks.complete',
  documentTransition: 'documents.transition',
  remind: 'reminders.send',
  remindBulk: 'reminders.bulk',
  browse: 'storage.browse',
  uploadIntent: 'storage.upload-intents.create',
  evidenceFiles: 'evidence.files',
  documentVersions: 'documents.versions',
  repositoryTest: 'admin.storage.repositories.test',
  repositoryReauthorize: 'admin.storage.repositories.reauthorize',
  repositoryMove: 'admin.storage.repositories.move-request',
  exportCreate: 'exports.create',
  exportGet: 'exports.get',
  exportSoa: 'exports.soa',
  exportDocuments: 'exports.documents',
  calendarFeed: 'calendar-feed.create',
  linkHealthRun: 'link-health.run',
  evidencePack: 'evidence-packs.build',
  auditorAccess: 'auditor-access.grant',
  packsCheckUpdates: 'admin.packs.check-updates',
  packsImport: 'admin.packs.import',
};

/** A stored task of `GET /tasks` (D-29, kind `task`), shown in My Tasks next to the chain items of the bundles. */
export type StoredTask = TaskItem & { kind: 'task' };

/** The snapshot of the API source: UI 4.2 keys plus the record references and the stored tasks. */
export interface ApiSnapshot extends Snapshot {
  me: MeView;
  /** Record references of every loaded system, by RecordKey (G.5 `refs`). */
  refs: Record<RecordKey, RecordRef>;
  /** Stored tasks of the session user (kind `task`); chain items of My Tasks come from the bundles. */
  tasks: StoredTask[];
  /** Systems of the current organisation where the session user holds a role, in organisation order. */
  systems: MsId[];
  /** True when the api runs with demo personas (`Me.personas`). */
  demo: boolean;
}

export interface ParsedKey {
  ms: MsId;
  kind: string;
  id: string;
}

/** `<ms>:<kind>:<business id>` (UI section 0); the business id may itself contain colons. */
export function parseKey(key: string): ParsedKey | null {
  const [ms, kind, ...rest] = String(key ?? '').split(':');
  const id = rest.join(':');
  if (!ms || !kind || !id) return null;
  return { ms, kind, id };
}

/** Kinds whose wire refs are keyed by the row uuid and found by `ref.code` (WP-17 deviation 1). */
const CODE_KEYED_KINDS = new Set(['prep', 'cycle', 'drift']);

/**
 * The record reference behind a RecordKey: the entry of `refs`, else (for `prep`, `cycle` and `drift`, whose wire keys
 * carry the row uuid) the reference of the same system and kind whose code is the key's business id.
 */
export function findRef(refs: Record<string, RecordRef>, key: RecordKey): RecordRef | null {
  if (refs[key]) return refs[key];
  const k = parseKey(key);
  if (!k) return null;
  const prefix = `${k.ms}:${k.kind}:`;
  if (CODE_KEYED_KINDS.has(k.kind) || k.kind === 'x') {
    for (const [refKey, ref] of Object.entries(refs)) if (refKey.startsWith(prefix) && ref.code === k.id) return ref;
  }
  // A drift row of the timeline that the controller shows as an explicit record (`<ms>:x:<code>`).
  if (k.kind === 'x') {
    for (const [refKey, ref] of Object.entries(refs)) if (refKey.startsWith(`${k.ms}:drift:`) && ref.code === k.id) return ref;
  }
  return null;
}

/** `Messages` of the api as a pair. */
export function messagesPair(m: { en: string; id: string } | undefined | null): Pair | undefined {
  return m ? [m.en, m.id] : undefined;
}

/** The `CommandResult` of the controller for an error answer (H.4). */
export function errorResult(error: ApiError): CommandResult {
  const out: CommandResult = { ok: false, changed: [], error: { status: error.status, message: error.message } };
  if (error.rule) out.error!.rule = error.rule;
  if (error.methods) out.error!.methods = error.methods;
  return out;
}

/** A failure the source detects itself (no request sent). */
export function localError(status: number, message: Pair): CommandResult {
  return { ok: false, changed: [], error: { status, message } };
}

export const NOT_FOUND: Pair = ['Record not found. Reload the page and try again.', 'Rekaman tidak ditemukan. Muat ulang halaman lalu coba lagi.'];
export const NOT_APPLICABLE: Pair = ['This action does not apply to this record', 'Tindakan ini tidak berlaku untuk rekaman ini'];

/** Maps an api answer of a command (D.2 `CommandResult`) to the controller's `CommandResult`. */
export function toCommandResult(res: ApiResult<unknown>): CommandResult {
  if (!res.ok) return errorResult(res.error);
  const body = (res.data ?? {}) as Partial<WireCommandResult>;
  const out: CommandResult = { ok: true, changed: Array.isArray(body.changed) ? [...body.changed] : [] };
  if (typeof body.count === 'number') out.count = body.count;
  if (Array.isArray(body.message)) out.message = [body.message[0], body.message[1]];
  if (Array.isArray(body.warnings) && body.warnings.length) {
    out.warnings = body.warnings.map((w) => ({ rule: w.rule, message: messagesPair(w.messages) ?? [w.rule, w.rule] }));
  }
  if (typeof body.redirectUrl === 'string') out.redirectUrl = body.redirectUrl;
  if (typeof body.downloadUrl === 'string') out.downloadUrl = body.downloadUrl;
  const extra = out as CommandResult & { taskId?: string; data?: unknown; ref?: RecordRef };
  if (typeof body.taskId === 'string') extra.taskId = body.taskId;
  if (body.ref) extra.ref = body.ref;
  if (body.data !== undefined) extra.data = body.data;
  return out;
}

/** The status of a network failure (ApiClient answers 0), shown as "Connection lost. Try again." by the controller. */
export function isConnectionLost(result: CommandResult): boolean {
  return !result.ok && result.error?.status === 0;
}

export { CONNECTION_LOST };

// ---------------------------------------------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------------------------------------------

type WireBundle = UiMsSnapshot['bundle'];

/**
 * The controller form of a bundle: `ChainItem.refKey` and `Activity.docId` become `ref` and `doc`, the objects of
 * the same bundle (`it.ref.st`, `a.doc.st` keep working, H.4). A refKey that names no record of the bundle (a record
 * outside the reader's scope) leaves `ref` undefined.
 */
export function rehydrateBundle(wire: WireBundle): MsBundle {
  const reqs = wire.reqs.map((r) => ({ ...r })) as unknown as Requirement[];
  const docs = wire.docs.map((d) => ({ ...d })) as unknown as Document[];
  const evs = wire.evs.map((e) => ({ ...e })) as unknown as Evidence[];
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const evByCode = new Map(evs.map((e) => [e.code, e]));
  const lookup = (refKey: string | undefined): Requirement | Document | Evidence | undefined => {
    const k = refKey ? parseKey(refKey) : null;
    if (!k) return undefined;
    if (k.kind === 'req' || k.kind === 'soa') return reqById.get(k.id);
    if (k.kind === 'doc') return docById.get(k.id);
    if (k.kind === 'ev') return evByCode.get(k.id);
    return undefined;
  };
  const items = wire.chain.items.map((it) => {
    const item = { ...it } as unknown as ChainItem;
    const ref = lookup(it.refKey ?? (it.kind === 'req' || it.kind === 'doc' || it.kind === 'ev' ? it.key : undefined));
    if (ref) item.ref = ref;
    return item;
  });
  const phases = wire.phases.map((p) => ({
    ...p,
    acts: p.acts.map((a) => ({ ...a, doc: (a.docId && docById.get(a.docId)) || null }) as unknown as Activity),
  }));
  return {
    reqs, docs, evs,
    chain: { items, recs: { ...wire.chain.recs } },
    gates: wire.gates.map((g) => ({ ...g })) as unknown as MsBundle['gates'],
    phases: phases as unknown as MsBundle['phases'],
  };
}

/** `LOC` entries with the colour and icon of their repository kind (H.4); an entry that has them keeps its own. */
export function withLocVisuals(loc: Record<string, readonly unknown[]>): Snapshot['LOC'] {
  const out: Snapshot['LOC'] = {};
  for (const [slug, entry] of Object.entries(loc)) {
    const [name, kind, short, colour, icon] = entry as [string, string, string, string?, string?];
    const v = (LOC_VISUALS as Record<string, { color: string; icon: string }>)[kind] ?? { color: '#6b655a', icon: '' };
    out[slug] = [name, kind, short, colour ?? v.color, icon ?? v.icon];
  }
  return out;
}

/** Systems whose snapshot the source loads: those of the current organisation where the user holds a role. */
export function systemsOf(me: Me, org: UiOrgSnapshot): MsId[] {
  const slug = me.org?.slug;
  const entry = org.orgs.find((o) => o.id === slug) ?? me.orgs.find((o) => o.id === slug);
  const msIds = new Set(org.MS.map((m) => m.id));
  const wanted = entry ? entry.ms : Object.keys(me.uiRoleByMs);
  return wanted.filter((id) => msIds.has(id));
}

const PER_SYSTEM_KEYS = ['X', 'EVENTS', 'FOCUS', 'PREP', 'PAST', 'CYCLE_ITEMS', 'DRIFT'] as const;

/** Stored tasks of `GET /tasks` (kind `task`): the chain items are already in the bundles (D-29). */
export function storedTasks(list: TaskList | null | undefined): StoredTask[] {
  return (list?.items ?? []).filter((t): t is StoredTask => t.kind === 'task').map((t) => ({ ...t }));
}

/** Writes one system snapshot into the assembled snapshot (bundle, per-system keys and refs of that system). */
export function applySystem(snap: ApiSnapshot, sys: UiMsSnapshot): void {
  const ms = sys.ms;
  snap.bundles[ms] = rehydrateBundle(sys.bundle);
  const target = snap as unknown as Record<string, Record<string, unknown>>;
  for (const key of PER_SYSTEM_KEYS) target[key][ms] = (sys as unknown as Record<string, unknown>)[key];
  for (const k of Object.keys(snap.refs)) if (k.startsWith(`${ms}:`)) delete snap.refs[k];
  Object.assign(snap.refs, sys.refs);
}

/**
 * The UI 4.2 snapshot of the API source: `/ui/org` keys, every system snapshot merged in (bundles rehydrated,
 * per-system keys by system id), `LOC` with visuals, the session user and permissions, and the stored tasks.
 */
export function assembleSnapshot(me: Me, org: UiOrgSnapshot, systems: UiMsSnapshot[], tasks: TaskList | null): ApiSnapshot {
  const snap = {
    today: org.today,
    generatedAt: org.generatedAt,
    orgs: org.orgs.map((o) => ({ ...o, ms: [...o.ms] })),
    MS: org.MS.map((m) => ({ ...m })),
    PEOPLE: { none: ['Unassigned', '-'], ...org.PEOPLE },
    ROLES: { ...(org.ROLES as Record<string, { who: string; label: Pair }>) },
    LOC: withLocVisuals(org.LOC),
    FREQ: org.FREQ,
    FREQ_ORDER: org.FREQ_ORDER,
    STAGES: org.STAGES,
    CHAINS: org.CHAINS,
    TITLES: org.TITLES,
    CLAUSE_AT_RISK: org.CLAUSE_AT_RISK,
    EXAMPLES: org.EXAMPLES,
    PACKS: org.PACKS,
    LICENCE: org.LICENCE ?? null,
    REPOS: org.REPOS.map((r) => ({ ...r })),
    ROUTING: org.ROUTING,
    X: {}, EVENTS: {}, FOCUS: {}, PREP: {}, PAST: {}, CYCLE_ITEMS: {}, DRIFT: {},
    bundles: {},
    me: me as unknown as MeView,
    permissions: org.permissions ?? me.permissions,
    refs: {},
    tasks: storedTasks(tasks),
    systems: systemsOf(me, org),
    demo: Boolean(me.personas && Object.keys(me.personas).length),
  } as unknown as ApiSnapshot;
  for (const sys of systems) applySystem(snap, sys);
  return snap;
}

/** A new snapshot with `/ui/org` replaced, the given systems replaced, and the stored tasks replaced (reload). */
export function mergeReload(prev: ApiSnapshot, org: UiOrgSnapshot | null, systems: UiMsSnapshot[], tasks: TaskList | null, me?: Me): ApiSnapshot {
  const base = org ? assembleSnapshot(me ?? (prev.me as unknown as Me), org, [], null) : ({ ...prev } as ApiSnapshot);
  const snap: ApiSnapshot = {
    ...base,
    bundles: { ...prev.bundles },
    refs: { ...prev.refs },
    tasks: tasks ? storedTasks(tasks) : prev.tasks,
  };
  const target = snap as unknown as Record<string, Record<string, unknown>>;
  const source = prev as unknown as Record<string, Record<string, unknown>>;
  for (const key of PER_SYSTEM_KEYS) target[key] = { ...source[key] };
  for (const sys of systems) applySystem(snap, sys);
  // Systems no longer in the organisation snapshot are dropped.
  const keep = new Set(snap.MS.map((m) => m.id));
  for (const id of Object.keys(snap.bundles)) if (!keep.has(id)) delete snap.bundles[id];
  return snap;
}
