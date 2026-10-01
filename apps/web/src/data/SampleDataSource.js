// Sample data source (BUILD-PLAN H.3, UI 4.4): serves the fictional sample organisations from mscd-data.js through
// the DataSource interface of types.ts. It owns the override store that the controller kept in `state.ov` until
// WP-07: every command applies exactly the patch the controller applied (UI 3.2 to 3.6) and returns
// {ok: true, changed: [msId]}, and snapshots carry the bundles that sample-derive.js computes over that store.
//
// Every promise is already settled when it is returned, so a command, the reload and the controller's follow-up
// state land in the same microtask checkpoint as the click that started them (the sample E2E suite sees the timing
// of the former synchronous setState). Imports no React, CSS or browser API, so Node can use it (export script,
// server parity tests).
import * as SAMPLE from './mscd-data.js';
import { ORGS } from './sample-orgs.js';
import { data as deriveData, chain as deriveChain, deriveBundle } from './sample-derive.js';

// Snapshot keys that hold one entry per management system; a snapshot keeps the systems of its organisation.
const PER_SYSTEM = ['STAGES', 'X', 'CHAINS', 'EVENTS', 'FOCUS', 'PREP', 'PAST', 'CYCLE_ITEMS', 'DRIFT', 'PACKS'];
const PAGE_ACTIONS = ['exportBoard', 'exportReadiness', 'exportSoa', 'exportDocs', 'evidencePack', 'auditorAccess', 'runCheck', 'calendarFeed', 'checkUpdates', 'importBundle', 'verifyPhase'];
const RECORD_KINDS = ['req', 'soa', 'doc', 'ev', 'act', 'x', 'prep', 'cycle', 'drift'];

const NOT_FOUND = ['Record not found', 'Rekaman tidak ditemukan'];
const NOT_APPLICABLE = ['This action does not apply to this record', 'Tindakan ini tidak berlaku untuk rekaman ini'];

const ok = (changed, extra) => ({ ok: true, changed, ...extra });
const fail = (status, message) => ({ ok: false, changed: [], error: { status, message } });
// Runs fn and returns its value as a settled promise; a thrown error becomes a rejection.
function settle(fn) {
  try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
}

/** A new sample source with its own empty override store. Options: `org` (default 'ndt'), `persona` (default 'manager'). */
export function createSampleDataSource(options) {
  return new SampleDataSource(options);
}

export class SampleDataSource {
  #data; #orgs; #org; #persona;
  #ov = {};

  constructor({ data = SAMPLE, orgs = ORGS, org, persona = 'manager' } = {}) {
    this.#data = data;
    this.#orgs = orgs;
    this.#org = this.#findOrg(org ?? orgs[0].id);
    if (!this.#org) throw new Error('SampleDataSource: unknown organisation ' + org);
    if (!data.ROLES[persona]) throw new Error('SampleDataSource: unknown persona ' + persona);
    this.#persona = persona;
  }

  get kind() { return 'sample'; }

  // ---------- snapshots ----------

  /** Snapshot of an organisation (default: the current one), which becomes the current organisation. */
  load(orgId) {
    return settle(() => {
      const org = this.#findOrg(orgId ?? this.#org.id);
      if (!org) throw new Error('SampleDataSource: unknown organisation ' + orgId);
      this.#org = org;
      return this.#snapshot(org);
    });
  }

  /** The snapshot with the bundles of `msIds` recomputed from the override store. */
  reload(snapshot, msIds) {
    return settle(() => {
      const bundles = { ...snapshot.bundles };
      for (const id of new Set(msIds)) {
        const ms = snapshot.MS.find((m) => m.id === id);
        if (ms && bundles[id]) bundles[id] = deriveBundle(this.#data, this.#ov, this.#system(id));
      }
      return { ...snapshot, bundles };
    });
  }

  /** The picker listing of a repository (PICKER_FILES), with a reference per file. */
  listPickerFiles(key, src) {
    return settle(() => {
      const listing = this.#data.PICKER_FILES[src];
      if (!listing || !this.#parse(key)) throw new Error('SampleDataSource: no picker listing for ' + src);
      return {
        path: listing.path,
        files: listing.files.map((f) => [...f]),
        refs: listing.files.map((f, i) => ({ repositoryId: src, externalItemId: 'picker-' + src + '-' + (i + 1), externalVersionId: f[2] })),
      };
    });
  }

  // ---------- commands (UI 3.2 to 3.6) ----------

  /** Requirement or activity: complete, awaiting verification by someone else. */
  markComplete(key) {
    return this.#patch(key, ['req', 'act'], () => ({ st: 'complete', by: this.#me() }));
  }

  /** Requirement to implemented, activity to verified. */
  verify(key, to) {
    return this.#patch(key, ['req', 'act'], (k) => ((k.kind === 'req' ? 'implemented' : 'verified') === to ? { st: to, by: null } : null));
  }

  /** New holder and due date of any record (reassign and change due date). */
  assign(key, h, due) {
    return this.#patch(key, RECORD_KINDS, () => ({ h, due }));
  }

  /** Reminder to one person: nothing changes in the sample. */
  remind(key, recipient) {
    return settle(() => (this.#parse(key) && this.#data.PEOPLE[recipient] ? ok([]) : fail(404, NOT_FOUND)));
  }

  /** Reminders to every holder of an open chain item of the system; `count` is the number of distinct holders. */
  remindAll(msId) {
    return settle(() => {
      if (!this.#inOrg(msId)) return fail(404, NOT_FOUND);
      const d = deriveData(this.#data, this.#ov, this.#system(msId));
      const holders = new Set(deriveChain(this.#data, this.#ov, d).items.map((i) => i.h).filter((h) => h !== 'none'));
      return ok([], { count: holders.size });
    });
  }

  /** Completes the pending action of an explicit chain record (My Tasks): the item leaves every chain list. */
  completeRecordAction(key) {
    return this.#patch(key, ['x'], () => ({ done: true }));
  }

  /** Expired document: review started. */
  startReview(key) {
    return this.#patch(key, ['doc'], () => ({ st: 'review' }));
  }

  /** Blocker of an activity: the sample only acknowledges it (the UI has no form yet). */
  recordBlocker(key) {
    return settle(() => { const k = this.#parse(key); return !k ? fail(404, NOT_FOUND) : k.kind !== 'act' ? fail(422, NOT_APPLICABLE) : ok([]); });
  }

  /** Links a picker file: evidence pins the file's version and hash, a document gets its next approved version. */
  linkFile(key, file) {
    return settle(() => {
      const f = ((this.#data.PICKER_FILES[file && file.src] || {}).files || [])[file && file.index];
      if (!f) return fail(404, NOT_FOUND);
      return this.#patchNow(key, ['ev', 'doc'], (k) => (k.kind === 'ev'
        ? { evidence: { prod: this.#data.TODAY_S, integ: f[3] === 'none' ? 'nohash' : 'ok', ver: f[2], hashAlg: f[3] === 'none' ? 'none' : f[3], loc: file.src } }
        : this.#newDocVersion(k)));
    });
  }

  /** Upload to the Managed Vault: evidence gets the next version with SHA-256, a document its next approved version. */
  uploadFile(key) {
    return settle(() => this.#patchNow(key, ['ev', 'doc'], (k) => {
      if (k.kind === 'doc') return this.#newDocVersion(k);
      const rec = this.#record(k);
      const n = parseInt(String((rec && rec.ver) || '').replace(/\D/g, ''), 10) || 0;
      return { evidence: { prod: this.#data.TODAY_S, integ: 'ok', ver: 'v' + (n + 1), hashAlg: 'SHA-256' } };
    }));
  }

  /** Repository actions of the storage screen; `test` counts the references held in the repository. */
  repositoryAction(repoId, action) {
    return settle(() => {
      const repo = this.#data.REPOS.find((r) => r.id === repoId);
      if (!repo) return fail(404, NOT_FOUND);
      if (!(repo.actions || ['test']).includes(action)) return fail(422, NOT_APPLICABLE);
      if (action !== 'test') return ok([]);
      const count = this.#org.ms.reduce((n, id) => n + deriveData(this.#data, this.#ov, this.#system(id)).evs.filter((e) => e.loc === repoId).length, 0);
      return ok([], { count });
    });
  }

  /** Page actions (UI 3.6): nothing changes in the sample; `runCheck` counts the evidence of the system. */
  pageAction(msId, action) {
    return settle(() => {
      if (!PAGE_ACTIONS.includes(action)) return fail(422, NOT_APPLICABLE);
      if (action === 'exportBoard' || action === 'checkUpdates' || action === 'importBundle') return ok([]);
      if (!this.#inOrg(msId)) return fail(404, NOT_FOUND);
      if (action === 'runCheck') return ok([], { count: deriveData(this.#data, this.#ov, this.#system(msId)).evs.length });
      return ok([]);
    });
  }

  // ---------- session ----------

  /** Demo persona switch: later commands act as that persona's person. */
  switchPersona(role) {
    return settle(() => {
      if (!this.#data.ROLES[role]) throw new Error('SampleDataSource: unknown persona ' + role);
      this.#persona = role;
      return this.#snapshot(this.#org);
    });
  }

  switchOrg(orgId) {
    return this.load(orgId);
  }

  logout() {
    return Promise.resolve();
  }

  /** The sample never signs out, so listeners are never called. Returns the unsubscribe function. */
  onUnauthenticated() {
    return () => {};
  }

  // ---------- internals ----------

  #findOrg(id) { return this.#orgs.find((o) => o.id === id) || null; }
  #inOrg(msId) { return this.#org.ms.includes(msId); }
  #me() { return this.#data.ROLES[this.#persona].who; }
  #system(id) { return { ...this.#data.MS.find((m) => m.id === id) }; }

  // RecordKey `<ms>:<kind>:<id>` of a system of the current organisation, else null.
  #parse(key) {
    const [ms, kind, ...rest] = String(key || '').split(':');
    const id = rest.join(':');
    if (!ms || !kind || !id || !this.#inOrg(ms) || !RECORD_KINDS.includes(kind)) return null;
    return { key, ms, kind, id };
  }

  // Current document or evidence behind a key.
  #record(k) {
    const d = deriveData(this.#data, this.#ov, this.#system(k.ms));
    return k.kind === 'doc' ? d.docs.find((x) => x.id === k.id) : k.kind === 'ev' ? d.evs.find((x) => x.code === k.id) : null;
  }

  // A new document version is the next major version of the current one, approved today, next review in a year.
  #newDocVersion(k) {
    const doc = this.#record(k);
    const ver = (Math.floor(parseFloat(doc && doc.ver) || 0) + 1).toFixed(1);
    const { TODAY_S, addD } = this.#data;
    return { ver, appr: TODAY_S, rev: addD(TODAY_S, 365), st: 'approved' };
  }

  #patch(key, kinds, make) {
    return settle(() => this.#patchNow(key, kinds, make));
  }

  // Merges the patch made for the parsed key into the override store (UI 3.1). `{evidence: patch}` is new evidence:
  // the cycle restarts, so a due date set earlier by Reassign is dropped before the merge.
  #patchNow(key, kinds, make) {
    const k = this.#parse(key);
    if (!k) return fail(404, NOT_FOUND);
    if (!kinds.includes(k.kind)) return fail(422, NOT_APPLICABLE);
    const patch = make(k);
    if (!patch) return fail(422, NOT_APPLICABLE);
    const cur = { ...(this.#ov[key] || {}) };
    if (patch.evidence) { delete cur.due; this.#ov[key] = { ...cur, ...patch.evidence }; }
    else this.#ov[key] = { ...cur, ...patch };
    return ok([k.ms]);
  }

  #snapshot(org) {
    const S = this.#data;
    const MS = S.MS.filter((m) => org.ms.includes(m.id)).map((m) => ({ ...m }));
    const shorts = MS.map((m) => m.short);
    const pick = (map) => Object.fromEntries(MS.filter((m) => m.id in map).map((m) => [m.id, map[m.id]]));
    const snap = {
      today: S.TODAY_S,
      generatedAt: S.TODAY_S + 'T00:00:00.000Z',
      orgs: this.#orgs.map((o) => ({ ...o, ms: [...o.ms] })),
      MS,
      PEOPLE: S.PEOPLE,
      ROLES: S.ROLES,
      LOC: S.LOC,
      FREQ: S.FREQ,
      FREQ_ORDER: S.FREQ_ORDER,
      TITLES: S.TITLES,
      CLAUSE_AT_RISK: S.CLAUSE_AT_RISK,
      EXAMPLES: S.EXAMPLES,
      LICENCE: S.LICENCE,
      REPOS: S.REPOS.filter((r) => r.ms.some((x) => shorts.includes(x))).map((r) => ({ ...r, ms: r.ms.filter((x) => shorts.includes(x)) })),
      ROUTING: S.ROUTING.filter((r) => shorts.includes(r[0])),
      PICKER_FILES: S.PICKER_FILES,
      bundles: Object.fromEntries(MS.map((m) => [m.id, deriveBundle(S, this.#ov, m)])),
    };
    for (const k of PER_SYSTEM) snap[k] = pick(S[k]);
    return snap;
  }
}
