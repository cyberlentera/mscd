// Test doubles of the WP-25 unit tests: api answers in the shapes of the shared contract (`Me`, `UiOrgSnapshot`,
// `UiMsSnapshot`, `TaskList`), built from the sample source the way the read model of WP-17 builds them from the demo
// seed (G.5): chain items carry `refKey` instead of `ref`, activities `docId` instead of `doc`, LOC entries their first
// three fields, repositories a uuid `ref`, and every record a `RecordRef` keyed by its RecordKey.
import { createHash } from 'node:crypto';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { ApiClient } from '../../src/data/api/ApiClient';
import { ApiDataSource } from '../../src/data/api/ApiDataSource';
import type { ApiDataSourceOptions } from '../../src/data/api/ApiDataSource';
import { json, problem } from '../auth/helpers';
import type { Answer, Handler, Recorded } from '../auth/helpers';

/** A stable uuid for a label. */
export function uuidOf(label: string): string {
  const h = createHash('sha1').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ENTITY: Record<string, [string, string]> = {
  req: ['implementation', 'applicability_entry'],
  soa: ['implementation', 'applicability_entry'],
  doc: ['implementation', 'document'],
  ev: ['surveillance', 'evidence'],
  act: ['implementation', 'implementation_activity_progress'],
  x: ['audit', 'risk'],
  prep: ['audit', 'audit_prep_task'],
  cycle: ['audit', 'cycle_requirement_status'],
  drift: ['audit', 'drift_result'],
};

export function refOf(key: string, code: string, kind = key.split(':')[1]) {
  const [module, entityType] = ENTITY[kind];
  return { module, entityType, id: uuidOf(key), code, etag: `W/"${1790000000000 + code.length}"` };
}

type AnyRecord = Record<string, any>;

export interface WireFixture {
  sample: AnyRecord;
  org: AnyRecord;
  ms: Record<string, AnyRecord>;
  tasks: AnyRecord;
}

/** The sample snapshot of an organisation (default ndt, persona manager) in the wire form of the api. */
export async function wireOf(orgId = 'ndt', persona = 'manager'): Promise<WireFixture> {
  const src = createSampleDataSource({ org: orgId, persona });
  const sample = (await src.load(orgId)) as AnyRecord;
  const permissions = { org: ['storage.repository.read', 'pack.read', 'license.read'], ms: Object.fromEntries(sample.MS.map((m: AnyRecord) => [m.id, ['ms.read', 'applicability.verify', 'activity.verify', 'audit.pending.all']])) };
  const org = {
    today: sample.today,
    generatedAt: '2026-09-29T00:00:00.000Z',
    orgs: sample.orgs,
    MS: sample.MS,
    PEOPLE: sample.PEOPLE,
    ROLES: sample.ROLES,
    LOC: Object.fromEntries(Object.entries(sample.LOC as Record<string, unknown[]>).map(([k, l]) => [k, [l[0], l[1], l[2]]])),
    REPOS: sample.REPOS.map((r: AnyRecord) => ({ ...r, ref: uuidOf('repo:' + r.id), actions: r.actions ?? ['test'] })),
    ROUTING: sample.ROUTING,
    PACKS: sample.PACKS,
    LICENCE: sample.LICENCE,
    STAGES: sample.STAGES,
    CHAINS: sample.CHAINS,
    TITLES: sample.TITLES,
    CLAUSE_AT_RISK: sample.CLAUSE_AT_RISK,
    EXAMPLES: sample.EXAMPLES,
    FREQ: sample.FREQ,
    FREQ_ORDER: sample.FREQ_ORDER,
    permissions,
  };
  const ms: Record<string, AnyRecord> = {};
  for (const m of sample.MS as AnyRecord[]) {
    const b = sample.bundles[m.id];
    const refs: Record<string, AnyRecord> = {};
    const add = (key: string, code: string) => { refs[key] = refOf(key, code); };
    b.reqs.forEach((r: AnyRecord) => { add(`${m.id}:req:${r.id}`, r.id); add(`${m.id}:soa:${r.id}`, r.id); });
    b.docs.forEach((d: AnyRecord) => add(`${m.id}:doc:${d.id}`, d.id));
    b.evs.forEach((e: AnyRecord) => add(`${m.id}:ev:${e.code}`, e.code));
    b.phases.forEach((p: AnyRecord) => p.acts.forEach((a: AnyRecord) => add(a.key, a.no)));
    b.chain.items.forEach((it: AnyRecord) => { if (!refs[it.key]) add(it.key, it.id); });
    (sample.PREP[m.id] ?? []).forEach((p: AnyRecord[], i: number) => { const k = `${m.id}:prep:${uuidOf(m.id + 'prep' + i)}`; refs[k] = refOf(k, String(p[0]), 'prep'); });
    (sample.CYCLE_ITEMS[m.id] ?? []).forEach((c: AnyRecord[], i: number) => { const k = `${m.id}:cycle:${uuidOf(m.id + 'cycle' + i)}`; refs[k] = refOf(k, String(c[0]), 'cycle'); });
    (sample.DRIFT[m.id] ?? []).forEach((r: AnyRecord) => (r.rows ?? []).forEach((row: unknown[]) => { const k = `${m.id}:drift:${uuidOf(m.id + 'drift' + row[0])}`; refs[k] = refOf(k, String(row[0]), 'drift'); }));
    const refKeyOf = (it: AnyRecord) => {
      if (!it.ref) return undefined;
      if (it.kind === 'ev') return `${m.id}:ev:${it.ref.code}`;
      if (it.kind === 'doc') return `${m.id}:doc:${it.ref.id}`;
      return `${m.id}:req:${it.ref.id}`;
    };
    ms[m.id] = {
      ms: m.id,
      bundle: {
        reqs: b.reqs, docs: b.docs, evs: b.evs,
        chain: { items: b.chain.items.map(({ ref, ...it }: AnyRecord) => ({ ...it, refKey: refKeyOf({ ...it, ref }) })), recs: b.chain.recs },
        gates: b.gates,
        phases: b.phases.map((p: AnyRecord) => ({ ...p, acts: p.acts.map(({ doc, ...a }: AnyRecord) => ({ ...a, docId: doc ? doc.id : null })) })),
      },
      X: sample.X[m.id] ?? {}, EVENTS: sample.EVENTS[m.id] ?? [], FOCUS: sample.FOCUS[m.id] ?? '-', PREP: sample.PREP[m.id] ?? [],
      PAST: sample.PAST[m.id] ?? [], CYCLE_ITEMS: sample.CYCLE_ITEMS[m.id] ?? [], DRIFT: sample.DRIFT[m.id] ?? [],
      refs,
    };
  }
  const tasks = {
    items: [
      { key: 'isms:x:R-014', ms: 'isms', kind: 'x', id: 'R-014', title: ['R-014', 'R-014'], act: ['Select a treatment', 'Pilih perlakuan'], due: '2026-10-20', st: 'pending', after: false, stage: 'risk' },
      { key: `isms:task:${uuidOf('task-1')}`, ms: 'isms', kind: 'task', id: uuidOf('task-1'), title: ['EV-0101', 'EV-0101'], act: ['Upload overdue evidence', 'Unggah bukti terlambat'], due: '2026-09-20', st: 'overdue', after: false, stage: null },
    ],
    counts: { total: 2, overdue: 1, week: 0, later: 1 },
  };
  return { sample, org, ms, tasks };
}

/** A `Me` of the demo organisation (or another), with the UI role of every system. */
export function meOf(options: { org?: { id: string; slug: string; name: string }; handle?: string; uiRoleByMs?: Record<string, string>; orgs?: AnyRecord[]; personas?: AnyRecord; perms?: Record<string, string[]>; csrf?: string } = {}) {
  const uiRoleByMs = options.uiRoleByMs ?? { isms: 'manager', qms: 'manager', bcms: 'manager', abms: 'manager' };
  return {
    user: { id: uuidOf('user:' + (options.handle ?? 'rina')), handle: options.handle ?? 'rina', email: `${options.handle ?? 'rina'}@example.test`, displayName: options.handle === 'joko' ? 'Joko Santoso' : 'Rina Kusuma', jobTitle: 'Compliance Lead' },
    org: options.org ?? { id: uuidOf('org:ndt'), slug: 'ndt', name: 'PT Nusantara Digital Teknologi' },
    orgs: options.orgs ?? [{ id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: Object.keys(uiRoleByMs), deploy: 'saas', sites: 3 }],
    rolesByMs: Object.fromEntries(Object.entries(uiRoleByMs).map(([k, r]) => [k, [r === 'manager' ? 'ms_manager' : r === 'owner' ? 'domain_owner' : r === 'top' ? 'top_management' : 'internal_auditor']])),
    uiRoleByMs,
    adminRoles: [],
    platformRoles: [],
    permissions: { org: [], ms: options.perms ?? Object.fromEntries(Object.keys(uiRoleByMs).map((k) => [k, ['ms.read']])) },
    csrfToken: options.csrf ?? 'csrf-token-0123456789abcdef',
    session: { authMethod: 'local', idleExpiresAt: '2026-09-29T07:00:00Z', absoluteExpiresAt: '2026-09-29T14:00:00Z' },
    ...(options.personas ? { personas: options.personas } : {}),
    preferences: {},
  };
}

export type Routes = Record<string, Handler | Answer | Answer[]>;

/** The read routes of a wire fixture: `/me`, `/ui/org`, `/ui/ms/{ms}` and `/tasks`. */
export function readRoutes(fx: WireFixture, me: AnyRecord): Routes {
  const routes: Routes = {
    'GET /api/v1/me': json(me),
    'GET /api/v1/ui/org': json(fx.org),
    'GET /api/v1/tasks': json(fx.tasks),
  };
  for (const [id, snap] of Object.entries(fx.ms)) routes[`GET /api/v1/ui/ms/${id}`] = json(snap);
  return routes;
}

/**
 * A fake fetch over a route table read at call time: keys are `METHOD /path`, where a `:name` segment matches any
 * segment. A command (POST, PUT, PATCH) without a route answers `{ok: true, changed: ['isms']}`; a GET without one 404.
 */
export function patternFetch(routes: Routes) {
  const calls: Recorded[] = [];
  const match = (method: string, path: string) => {
    if (routes[`${method} ${path}`] !== undefined) return routes[`${method} ${path}`];
    for (const [key, route] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (m !== method || !p.includes(':')) continue;
      const re = new RegExp('^' + p.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');
      if (re.test(path)) return route;
    }
    return undefined;
  };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const parsed = new URL(url, 'http://localhost');
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init.body;
    if (typeof init.body === 'string' && headers['content-type'] === 'application/json') body = JSON.parse(init.body);
    const req: Recorded = { method: init.method ?? 'GET', url, path: parsed.pathname, headers, body, credentials: init.credentials };
    calls.push(req);
    const route = match(req.method, req.path);
    let answer: Answer;
    if (route === undefined) answer = req.method === 'GET' ? problem(404, 'not-found') : json({ ok: true, changed: ['isms'] });
    else if (typeof route === 'function') answer = route(req);
    else if (Array.isArray(route)) answer = route.length > 1 ? (route.shift() as Answer) : route[0];
    else answer = route;
    if (answer === 'network-error') throw new TypeError('Failed to fetch');
    const payload = answer.body === undefined ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(answer.status === 204 ? null : payload, { status: answer.status, headers: answer.headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** A source over a fake fetch; `navigate` and `sleep` are recorded fakes. */
export function sourceWith(routes: Routes, options: Partial<ApiDataSourceOptions> = {}) {
  const f = patternFetch(routes);
  const client = new ApiClient({ fetch: f.fetch });
  const navigated: string[] = [];
  const ds = new ApiDataSource({ client, navigate: (u) => navigated.push(u), sleep: async () => {}, useXhr: false, ...options });
  return { ...f, client, ds, navigated, routes };
}

export { json };
