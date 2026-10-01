// Parity comparison of the API snapshots with the sample snapshots (build plan J.4). Normalisation rules:
// - `undefined`, `null` and a missing key are equal; `false` equals a missing boolean; `[]` equals a missing array;
// - sample-only fields are removed (`reqs[].prod`, `reqs[].integ`, `reqs[].loc`, `reqs[].due`, `ChainItem.ref`,
//   `Activity.doc`), after their wire counterparts are checked: `ChainItem.ref` must equal the API's `refKey` and
//   `Activity.doc` must name the API's `docId` (`<ms>:doc:<docId>`);
// - API-only fields are removed (`refs`, `permissions`, `me`, `evs[].hash`, `evs[].lastGoodCheck`, `evs[].lastCheck`,
//   `docs[].approver`, `docs[].path`, `docs[].hashAlg`, `docs[].usedBy`, `MS[].gateName`, `MS[].gtSuggestions`,
//   `MS[].banner.kind`, `MS[].audit.prepWindowDays`, `PACKS[].status`, `REPOS[].ref`, `REPOS[].adapter`,
//   `REPOS[].ownershipType`, `REPOS[].actions`, and the clock-dependent `generatedAt`);
// - `GateItem.type` is compared as a pair on both sides; `TITLES` as "every sample entry is present and equal";
//   `LOC` compares only `[0]`, `[1]`, `[2]` for the slugs present in the API.
import type { SampleOrgSnapshot } from '../../../src/seed/snapshot';

type Json = unknown;
type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Removes `undefined`, `null`, `false` and `[]` members (J.4 equalities), recursively. Array elements are kept. */
export function prune(value: Json): Json {
  if (Array.isArray(value)) return value.map(prune);
  if (!isObject(value)) return value;
  const out: Obj = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined || member === null || member === false) continue;
    if (Array.isArray(member) && member.length === 0) continue;
    out[key] = prune(member);
  }
  return out;
}

/** Paths and values where two normalised values differ (at most `limit`). */
export function differences(actual: Json, expected: Json, limit = 40, path = '$'): string[] {
  const out: string[] = [];
  const walk = (a: Json, e: Json, p: string) => {
    if (out.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(e)) {
      if (a.length !== e.length) out.push(`${p}: length ${a.length} (api) != ${e.length} (sample)`);
      for (let i = 0; i < Math.min(a.length, e.length); i += 1) walk(a[i], e[i], `${p}[${i}]`);
      return;
    }
    if (isObject(a) && isObject(e)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(e)])) {
        if (!(key in a)) out.push(`${p}.${key}: missing in api, sample ${JSON.stringify(e[key])?.slice(0, 160)}`);
        else if (!(key in e)) out.push(`${p}.${key}: extra in api ${JSON.stringify(a[key])?.slice(0, 160)}`);
        else walk(a[key], e[key], `${p}.${key}`);
        if (out.length >= limit) return;
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(e)) out.push(`${p}: api ${JSON.stringify(a)?.slice(0, 160)} != sample ${JSON.stringify(e)?.slice(0, 160)}`);
  };
  walk(actual, expected, path);
  return out;
}

function pair(value: unknown): unknown {
  return typeof value === 'string' ? [value, value] : value;
}

function drop(obj: unknown, keys: readonly string[]): void {
  if (!isObject(obj)) return;
  for (const key of keys) delete obj[key];
}

// ---------------------------------------------------------------------------------------------------------------
// GET /ui/ms/{ms}
// ---------------------------------------------------------------------------------------------------------------

/** The sample's view of one system in the shape of `UiMsSnapshot` (without `refs`). */
export function sampleMsSnapshot(sample: SampleOrgSnapshot, ms: string): Obj {
  return {
    ms,
    bundle: clone(sample.bundles[ms]),
    X: clone(sample.X[ms] ?? {}),
    EVENTS: clone(sample.EVENTS[ms] ?? []),
    FOCUS: sample.FOCUS[ms],
    PREP: clone(sample.PREP[ms] ?? []),
    PAST: clone(sample.PAST[ms] ?? []),
    CYCLE_ITEMS: clone(sample.CYCLE_ITEMS[ms] ?? []),
    DRIFT: clone(sample.DRIFT[ms] ?? []),
  };
}

/** Wire-key mismatches found while normalising (`ChainItem.ref` against `refKey`, `Activity.doc` against `docId`). */
export interface NormalisedPair {
  api: Json;
  sample: Json;
  wireMismatches: string[];
}

/** Normalises an API system snapshot and the sample's (J.4). */
export function normaliseMs(api: Json, sample: Obj): NormalisedPair {
  const a = clone(api) as Obj;
  const s = clone(sample);
  const wireMismatches: string[] = [];
  drop(a, ['refs', 'permissions', 'me']);
  const ab = a.bundle as Obj | undefined;
  const sb = s.bundle as Obj | undefined;
  for (const r of (sb?.reqs as Obj[] | undefined) ?? []) drop(r, ['prod', 'integ', 'loc', 'due']);
  for (const e of (ab?.evs as Obj[] | undefined) ?? []) drop(e, ['hash', 'lastGoodCheck', 'lastCheck']);
  for (const e of (sb?.evs as Obj[] | undefined) ?? []) drop(e, ['hash', 'lastGoodCheck', 'lastCheck']);
  for (const d of [...((ab?.docs as Obj[] | undefined) ?? []), ...((sb?.docs as Obj[] | undefined) ?? [])]) drop(d, ['approver', 'path', 'hashAlg', 'usedBy']);
  const aItems = ((ab?.chain as Obj | undefined)?.items as Obj[] | undefined) ?? [];
  const sItems = ((sb?.chain as Obj | undefined)?.items as Obj[] | undefined) ?? [];
  const apiRefKeys = new Map(aItems.map((i) => [i.key as string, i.refKey]));
  for (const item of sItems) {
    const want = item.ref ?? undefined;
    const got = apiRefKeys.get(item.key as string);
    if (apiRefKeys.has(item.key as string) && (want ?? undefined) !== (got ?? undefined)) wireMismatches.push(`${String(item.key)}: ref ${String(want)} != refKey ${String(got)}`);
    drop(item, ['ref']);
  }
  for (const item of aItems) drop(item, ['refKey']);
  const aActs = new Map<string, Obj>();
  for (const phase of (ab?.phases as Obj[] | undefined) ?? []) for (const act of (phase.acts as Obj[]) ?? []) aActs.set(act.key as string, act);
  for (const phase of (sb?.phases as Obj[] | undefined) ?? []) {
    for (const act of (phase.acts as Obj[]) ?? []) {
      const apiAct = aActs.get(act.key as string);
      if (apiAct) {
        const want = (act.doc as string | null | undefined) ?? null;
        const got = apiAct.docId ? `${String(s.ms)}:doc:${String(apiAct.docId)}` : null;
        if (want !== got) wireMismatches.push(`${String(act.key)}: doc ${String(want)} != docId ${String(apiAct.docId)}`);
      }
      drop(act, ['doc']);
    }
  }
  for (const act of aActs.values()) drop(act, ['docId']);
  for (const gate of [...((ab?.gates as Obj[] | undefined) ?? []), ...((sb?.gates as Obj[] | undefined) ?? [])]) gate.type = pair(gate.type);
  return { api: prune(a), sample: prune(s), wireMismatches };
}

// ---------------------------------------------------------------------------------------------------------------
// GET /ui/org
// ---------------------------------------------------------------------------------------------------------------

const ORG_KEYS = ['today', 'orgs', 'MS', 'PEOPLE', 'ROLES', 'LOC', 'REPOS', 'ROUTING', 'PACKS', 'LICENCE', 'STAGES', 'CHAINS', 'TITLES', 'CLAUSE_AT_RISK', 'EXAMPLES', 'FREQ', 'FREQ_ORDER'] as const;

/** The sample's view of the organisation in the shape of `UiOrgSnapshot`. */
export function sampleOrgSnapshot(sample: SampleOrgSnapshot): Obj {
  const source = sample as unknown as Obj;
  return Object.fromEntries(ORG_KEYS.filter((k) => k in source).map((k) => [k, clone(source[k])]));
}

/** Normalises an API organisation snapshot and the sample's (J.4). */
export function normaliseOrg(api: Json, sample: Obj): { api: Json; sample: Json } {
  const a = clone(api) as Obj;
  const s = clone(sample);
  drop(a, ['generatedAt', 'permissions', 'me']);
  drop(s, ['generatedAt', 'permissions', 'me']);
  for (const ms of [...((a.MS as Obj[] | undefined) ?? []), ...((s.MS as Obj[] | undefined) ?? [])]) {
    drop(ms, ['gateName', 'gtSuggestions']);
    drop(ms.banner, ['kind']);
    drop(ms.audit, ['prepWindowDays']);
  }
  for (const card of [...Object.values((a.PACKS as Obj | undefined) ?? {}), ...Object.values((s.PACKS as Obj | undefined) ?? {})]) drop(card, ['status']);
  for (const repo of [...((a.REPOS as Obj[] | undefined) ?? []), ...((s.REPOS as Obj[] | undefined) ?? [])]) drop(repo, ['ref', 'adapter', 'ownershipType', 'actions']);
  // LOC: the first three members, for the slugs the API has.
  const apiLoc = (a.LOC as Record<string, unknown[]> | undefined) ?? {};
  const sampleLoc = (s.LOC as Record<string, unknown[]> | undefined) ?? {};
  a.LOC = Object.fromEntries(Object.entries(apiLoc).map(([k, v]) => [k, v.slice(0, 3)]));
  s.LOC = Object.fromEntries(Object.keys(apiLoc).map((k) => [k, sampleLoc[k]?.slice(0, 3)]));
  // TITLES: every sample entry present and equal.
  const apiTitles = (a.TITLES as Record<string, string> | undefined) ?? {};
  const sampleTitles = (s.TITLES as Record<string, string> | undefined) ?? {};
  a.TITLES = Object.fromEntries(Object.keys(sampleTitles).map((k) => [k, apiTitles[k]]));
  return { api: prune(a), sample: prune(s) };
}
