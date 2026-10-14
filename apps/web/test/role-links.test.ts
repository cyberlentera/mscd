// Links follow what the role can open (sample and API mode). A link in the detail drawer (up and down the chain, the
// facts, the Trace action) or on a screen is shown only when the role can open the target screen and, for a Domain
// Owner, the record (their lists hold only their own records); otherwise it is plain text without a click handler,
// and a link that is shown opens its target with the record's detail open.
// MscdApp is used as a plain object (no DOM): setState merges at once, and renderVals() builds what AppView renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MscdApp from '../src/MscdApp.jsx';
import { createSampleDataSource } from '../src/data/SampleDataSource.js';
import { readRoutes, sourceWith, meOf, wireOf } from './api/fixtures';

// Test data of many shapes (view models, records) is read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
const SCREENS = ['portfolio', 'm1overview', 'controls', 'phases', 'docs', 'audit', 'chain', 'gt', 'timeline', 'fresh', 'cal', 'mytasks', 'fw', 'storage', 'journey', 'team'];
// The screens each demo persona opens (UI 2.12), written out here so the tests do not take them from the controller.
const OPENS: Record<string, string[]> = {
  manager: SCREENS,
  owner: ['mytasks', 'm1overview', 'controls', 'docs', 'fresh'],
  auditor: ['portfolio', 'audit', 'chain', 'gt', 'docs', 'controls', 'fresh', 'timeline', 'mytasks', 'journey', 'team'],
  top: ['portfolio', 'm1overview', 'timeline', 'audit', 'chain', 'mytasks', 'journey', 'team'],
};
const ROLES = Object.keys(OPENS);
const opens = (role: string, screen: string) => OPENS[role].includes(screen);
// A Domain Owner (bagus in the sample) opens only records they hold.
const holds = (role: string, holder: string) => role !== 'owner' || holder === 'bagus';

function mount(ds: unknown, props: AnyRecord = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the controller is a JavaScript class
  const app = new (MscdApp as any)({ lang: 'en', theme: 'light', deploy: 'saas', ...props, dataSource: ds }) as AnyRecord;
  app.setState = (u: unknown, cb?: () => void) => {
    const patch = typeof u === 'function' ? (u as (s: AnyRecord, p: AnyRecord) => AnyRecord)(app.state, app.props) : u;
    if (patch) app.state = { ...app.state, ...(patch as AnyRecord) };
    if (cb) cb();
  };
  // Nothing here changes data or starts a timer: commands, pickers and toasts are recorded only.
  app.command = vi.fn();
  app.openPicker = vi.fn();
  app.toast = vi.fn();
  return app;
}

async function sample(props: AnyRecord = {}) {
  const app = mount(createSampleDataSource(), props);
  app.firstLoad();
  await vi.waitFor(() => expect(app.state.D).toBeTruthy());
  return app;
}

function as(app: AnyRecord, role: string, screen = OPENS[role][0]) {
  app.state = { ...app.state, role, ms: 'isms', screen, sel: null, expanded: {}, tab: {}, chip: {}, person: null, modal: null };
}

const isms = (app: AnyRecord) => app.data(app.MSL.find((m: AnyRecord) => m.id === 'isms'));
const req = (d: AnyRecord, id: string) => d.reqs.find((c: AnyRecord) => c.id === id);
const doc = (d: AnyRecord, id: string) => d.docs.find((x: AnyRecord) => x.id === id);
const ev = (d: AnyRecord, code: string) => d.evs.find((e: AnyRecord) => e.code === code);
const fact = (app: AnyRecord, det: AnyRecord, key: string) => det.facts.find((f: AnyRecord) => f.k === app.t(key));
// [label, shown as a link] of each related record; a plain one has no click handler.
const links = (list: AnyRecord[]) => {
  for (const l of list) expect(l.plain, l.v).toBe(!l.go);
  return list.map((l) => [l.v, !!l.go]);
};
const hasTrace = (app: AnyRecord, det: AnyRecord) => det.actions.some((a: AnyRecord) => a.label === app.t('trace'));

describe('detail drawer links per role (sample personas)', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a control: risks and Trace need the Traceability viewer; its document and evidence need their list and the record', async () => {
    const app = await sample();
    // A.5.9 is held by bagus (the Domain Owner); its document PRC-05 by rina, its evidence EV-0124 by bagus.
    for (const role of ROLES) {
      as(app, role);
      const d = isms(app);
      const det = app.reqDetail(req(d, 'A.5.9'), d);
      const gt = opens(role, 'gt');
      expect(links(det.up), role).toEqual([['R-003', gt], ['R-014', gt]]);
      expect(links(det.down), role).toEqual([['PRC-05', opens(role, 'controls') && holds(role, 'rina')], ['EV-0124', opens(role, 'fresh') && holds(role, 'bagus')]]);
      expect(!!fact(app, det, 'c_doc').go, role).toBe(opens(role, 'controls') && holds(role, 'rina'));
      expect(!!fact(app, det, 'c_lastev').go, role).toBe(opens(role, 'fresh') && holds(role, 'bagus'));
      expect(hasTrace(app, det), role).toBe(gt);
    }
    // Written out: the Domain Owner follows only their own evidence, Top Management nothing.
    as(app, 'owner');
    expect(links(app.reqDetail(req(isms(app), 'A.5.9'), isms(app)).down)).toEqual([['PRC-05', false], ['EV-0124', true]]);
    as(app, 'top');
    const top = app.reqDetail(req(isms(app), 'A.5.9'), isms(app));
    expect([...links(top.up), ...links(top.down)].every(([, on]) => !on)).toBe(true);
    expect(top.facts.filter((f: AnyRecord) => f.go)).toEqual([]);
  });

  it('a control that holds a gate: Trace opens the SoA in Outstanding items for every role that has that screen', async () => {
    const app = await sample();
    for (const role of ROLES) {
      as(app, role);
      const det = app.reqDetail(req(isms(app), 'A.8.12'), isms(app));
      expect(hasTrace(app, det), role).toBe(opens(role, 'chain'));
    }
    as(app, 'top', 'chain');
    const trace = app.reqDetail(req(isms(app), 'A.8.12'), isms(app)).actions.find((a: AnyRecord) => a.label === app.t('trace'));
    trace.go();
    expect([app.state.screen, app.state.tab.chain]).toEqual(['chain', 'soa']);
  });

  it('a document: the controls it implements open only for roles with the controls list, a Domain Owner only their own', async () => {
    const app = await sample();
    // PLN-02 implements A.5.29 and A.5.30 (held by rina) and A.8.6 and A.8.14 (held by bagus).
    for (const role of ROLES) {
      as(app, role);
      const det = app.docDetail(doc(isms(app), 'PLN-02'), isms(app));
      const ctrl = opens(role, 'controls');
      expect(links(det.up), role).toEqual([['A.5.29', ctrl && holds(role, 'rina')], ['A.5.30', ctrl && holds(role, 'rina')], ['A.8.6', ctrl && holds(role, 'bagus')], ['A.8.14', ctrl && holds(role, 'bagus')]]);
      expect(hasTrace(app, det), role).toBe(opens(role, 'gt'));
    }
  });

  it('evidence: its control opens with the controls list and the record; its document and Trace need the Traceability viewer', async () => {
    const app = await sample();
    for (const role of ROLES) {
      as(app, role);
      const det = app.evDetail(ev(isms(app), 'EV-0124'), isms(app));
      const ctrl = opens(role, 'controls') && holds(role, 'bagus');
      expect(!!fact(app, det, 'c_ctrl').go, role).toBe(ctrl);
      expect(links(det.up), role).toEqual([['A.5.9', ctrl], ['PRC-05', opens(role, 'gt')]]);
      expect(hasTrace(app, det), role).toBe(opens(role, 'gt'));
    }
  });

  it('an item of Outstanding items: the records up and down the chain and Trace need the Traceability viewer', async () => {
    const app = await sample();
    for (const role of ROLES) {
      as(app, role);
      const d = isms(app);
      const it = app.chain(d).items.find((i: AnyRecord) => i.key === 'isms:x:R-014');
      const det = app.itemDetail(it, d);
      const gt = opens(role, 'gt');
      expect(links(det.up), role).toEqual([['CI-02', gt]]);
      expect(links(det.down), role).toEqual([['T-014', gt], ['A.8.2', gt]]);
      expect(hasTrace(app, det), role).toBe(gt);
    }
  });

  it('the drawer as rendered: Top Management in Outstanding items sees plain records and no Trace', async () => {
    const app = await sample();
    as(app, 'top', 'chain');
    app.state = { ...app.state, tab: { chain: 'risk' }, sel: 'isms:x:R-014' };
    const det = app.renderVals().det;
    expect(det.id).toBe('R-014');
    expect([...links(det.up), ...links(det.down)]).toEqual([['CI-02', false], ['T-014', false], ['A.8.2', false]]);
    expect(hasTrace(app, det)).toBe(false);
    // The navigation itself refuses a screen the role cannot open.
    app.go('gt', { gtId: 'R-014' });
    expect(app.state.screen).toBe('chain');
  });

  it('a link that is shown opens its record with the detail open (Domain Owner, from the control to its evidence and back)', async () => {
    const app = await sample();
    as(app, 'owner', 'controls');
    app.state = { ...app.state, sel: 'isms:req:A.5.9', chip: { controls: 'all' } };
    const det = app.renderVals().det;
    expect(det.id).toBe('A.5.9');
    expect(hasTrace(app, det)).toBe(false);
    // An earlier tab of Evidence status (critical) does not hide the evidence the link opens.
    app.state = { ...app.state, tab: { ...app.state.tab, fresh: 'critical' } };
    det.down.find((l: AnyRecord) => l.v === 'EV-0124').go();
    expect(app.state.screen).toBe('fresh');
    const evDet = app.renderVals().det;
    expect(evDet.id).toBe('EV-0124');
    fact(app, evDet, 'c_ctrl').go();
    expect(app.state.screen).toBe('controls');
    expect(app.renderVals().det.id).toBe('A.5.9');
  });

  it('My Tasks: Top Management opens a gate item in Outstanding items, since the controls list is not theirs', async () => {
    const app = await sample();
    as(app, 'top', 'mytasks');
    const soa = app.renderVals().tasks.feed.find((k: AnyRecord) => k.id === 'SOA-01' && k.btn === app.t('openGate'));
    soa.go();
    expect(app.state.screen).toBe('chain');
    expect(app.renderVals().det.id).toBe('SOA-01');
    // The Domain Owner keeps the controls' blocking items.
    as(app, 'owner', 'mytasks');
    app.renderVals().tasks.feed.find((k: AnyRecord) => k.id === 'A.8.12' && k.btn === app.t('openGate')).go();
    expect([app.state.screen, app.state.tab.controls]).toEqual(['controls', 'gate']);
    expect(app.renderVals().det.id).toBe('A.8.12');
  });

  it('Blocking items: a Domain Owner lists and counts only the items they hold, as the api sends them', async () => {
    const app = await sample();
    const gateTab = (role: string) => {
      as(app, role, 'controls');
      app.state = { ...app.state, tab: { controls: 'gate' } };
      const v = app.renderVals();
      return { ids: v.rows.filter((r: AnyRecord) => r.cells).map((r: AnyRecord) => r.cells[0].v), n: v.tabs.find((t: AnyRecord) => t.id === 'gate').n };
    };
    const all = gateTab('manager');
    expect(all.ids).toEqual(expect.arrayContaining(['A.5.23', 'A.8.12']));
    const mine = isms(app).gates.filter((g: AnyRecord) => g.h === 'bagus').map((g: AnyRecord) => g.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(all.ids.length);
    expect(gateTab('owner')).toEqual({ ids: mine, n: mine.length });
  });

  it('Home, Readiness by clause, Audit readiness and the system menu show plain text where the role cannot follow', async () => {
    const app = await sample();
    as(app, 'top', 'portfolio');
    let v = app.renderVals();
    const card = v.pf.find((m: AnyRecord) => m.id === 'isms');
    // The figures: findings open Audit readiness; blocking items, expired documents and critical evidence are plain.
    expect(card.stats.map((s: AnyRecord) => [s.label, !!s.go, s.plain])).toEqual([[app.t('gateItems'), false, true], [expect.stringContaining(app.t('findings')), true, false], [app.t('docsExpired'), false, true], [app.t('evCritical'), false, true]]);
    expect(card.gateItems.every((g: AnyRecord) => !g.go && g.plain)).toBe(true);
    // The card title opens what Top Management has: Readiness by clause.
    card.go();
    expect([app.state.screen, app.state.ms]).toEqual(['m1overview', 'isms']);
    const items = v.attentionGroups.flatMap((g: AnyRecord) => g.items);
    expect(items.filter((a: AnyRecord) => a.go).every((a: AnyRecord) => a.w === 1)).toBe(true);
    expect(items.filter((a: AnyRecord) => !a.go).every((a: AnyRecord) => a.plain)).toBe(true);
    expect(v.goIntegrated).not.toBeNull();
    // Readiness by clause as Top Management: the roadmap is not theirs, the chain is.
    as(app, 'top', 'm1overview');
    v = app.renderVals();
    expect(v.ov.phases.every((p: AnyRecord) => !p.go && p.plain)).toBe(true);
    expect(v.ov.clauses.map((c: AnyRecord) => [c.n, !!c.go])).toEqual([[4, true], [5, false], [6, true], [7, false], [8, false], [9, true], [10, true]]);
    // As Domain Owner: the controls are theirs; Outstanding items, Audit readiness and Home are not.
    as(app, 'owner', 'm1overview');
    v = app.renderVals();
    expect(v.ov.clauses.map((c: AnyRecord) => [c.n, !!c.go])).toEqual([[4, false], [5, true], [6, false], [7, true], [8, true], [9, false], [10, false]]);
    expect(v.ov.phases.every((p: AnyRecord) => !p.go)).toBe(true);
    expect(v.goIntegrated).toBeNull();
    // An overdue item in the blockers opens only when it is the owner's own record.
    for (const b of v.ov.blockers) expect(b.plain).toBe(!b.go);
    // Audit readiness as Top Management: chain items open in Outstanding items; controls, documents and evidence are plain.
    as(app, 'top', 'audit');
    v = app.renderVals();
    for (const n of v.trace.nodes) {
      const kind = app.data().reqs.some((c: AnyRecord) => c.id === n.id) || app.data().docs.some((x: AnyRecord) => x.id === n.id) || app.data().evs.some((e: AnyRecord) => e.code === n.id);
      const item = app.chain(app.data()).items.some((i: AnyRecord) => i.id === n.id);
      expect(!!n.go, n.id).toBe(item || !kind);
      expect(n.plain).toBe(!n.go);
    }
  });
});

// Calls every link of every screen the role opens and of the drawers of its first rows, and checks that each one lands
// on a screen the role (in the system it lands in) can open, with the detail open when it opened a record. A link that
// is shown but does nothing (refused by go) is counted as a dead end.
function sweep(app: AnyRecord, role: string | null, allowed: (a: AnyRecord) => boolean) {
  const realGo = app.go.bind(app);
  const dead: string[] = [];
  app.go = (screen: string, extra?: AnyRecord) => { const before = app.state; realGo(screen, extra); if (app.state === before) dead.push(screen); };
  const fns = (root: unknown) => {
    const out: [string, (e?: unknown) => void][] = [];
    const seen = new WeakSet();
    const walk = (o: unknown, path: string) => {
      if (!o || typeof o !== 'object' || seen.has(o as object) || (o as AnyRecord).$$typeof) return;
      seen.add(o as object);
      for (const [k, val] of Object.entries(o as AnyRecord)) {
        if (['t', 'roleOptions', 'orgOptions', 'pageActions', 'modal'].includes(k)) continue;
        if (typeof val === 'function' && /^go/.test(k)) out.push([path + '.' + k, val]);
        else walk(val, path + '.' + k);
      }
    };
    walk(root, '');
    return out;
  };
  const evt = { stopPropagation() {} };
  let calls = 0;
  const check = (start: AnyRecord, list: [string, (e?: unknown) => void][], where: string) => {
    for (const [path, fn] of list) {
      calls++;
      app.state = { ...start };
      fn(evt);
      const s = app.state;
      expect(allowed(s), `${where}${path} -> ${s.screen} (${s.ms}, ${s.role})`).toBe(true);
      if (s.sel && s.sel !== start.sel) expect(app.renderVals().det, `${where}${path} opens ${s.sel}`).toBeTruthy();
    }
  };
  for (const screen of SCREENS) {
    app.state = { ...app.state, screen, sel: null, expanded: {}, person: null, modal: null, more: 0 };
    if (!allowed(app.state)) continue;
    const start = { ...app.state };
    const v = app.renderVals();
    check(start, fns(v), `${role} ${screen}`);
    // The drawers of the first rows.
    for (const row of v.rows.filter((r: AnyRecord) => r.isRow).slice(0, 4)) {
      const open = { ...start, sel: row.key };
      app.state = { ...open };
      const det = app.renderVals().det;
      expect(det, `${screen} ${row.key}`).toBeTruthy();
      check(open, fns({ det }), `${role} ${screen} ${row.key}`);
    }
    app.state = { ...start };
  }
  app.go = realGo;
  expect(dead, `${role}: links that lead nowhere`).toEqual([]);
  return calls;
}

describe('every link of every screen per role', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sample personas: each link lands on a screen the persona opens, with the record open', async () => {
    const app = await sample();
    for (const role of ROLES) {
      as(app, role);
      expect(sweep(app, role, (s) => opens(role, s.screen) && s.role === role), role).toBeGreaterThan(150);
    }
  }, 60000);

  it('API mode with a different role in each system: links into another system land where the role there can go', async () => {
    const fx = await wireOf();
    const me = meOf({ uiRoleByMs: { isms: 'manager', qms: 'top', bcms: 'auditor', abms: 'owner' } });
    const env = sourceWith(readRoutes(fx, me));
    const app = mount(env.ds);
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.D).toBeTruthy());
    expect([app.state.ms, app.state.role]).toEqual(['isms', 'manager']);
    const allowed = (s: AnyRecord) => {
      const vis = app.visFor(s.role, s.ms);
      return s.role === app.roleIn(app.D, s.ms) && (!vis || vis.includes(s.screen));
    };
    for (const ms of ['isms', 'qms', 'bcms', 'abms']) {
      app.state = { ...app.state, ms, role: app.roleIn(app.D, ms), tab: {}, chip: {} };
      expect(sweep(app, ms, allowed), ms).toBeGreaterThan(50);
    }
    // Storage lists the evidence of every system: as MS Manager of ISMS, the ABMS evidence of someone else does not
    // open its control (Domain Owner there), and its holder does not open Outstanding items.
    const d = app.data(app.MSL.find((m: AnyRecord) => m.id === 'abms'));
    const other = d.evs.find((e: AnyRecord) => e.owner !== 'rina' && d.reqs.some((c: AnyRecord) => c.id === e.ctrl && c.owner !== 'rina'));
    app.state = { ...app.state, ms: 'isms', role: 'manager', screen: 'storage', chip: { storage: 'all' }, q: other.code, sel: null };
    const row = app.renderVals().rows.find((r: AnyRecord) => r.key === 'abms:ev:' + other.code);
    expect(row.cells[5].go).toBeNull();
    app.state = { ...app.state, sel: row.key };
    const det = app.renderVals().det;
    expect(det.id).toBe(other.code);
    expect(fact(app, det, 'c_ctrl').go).toBeNull();
    expect(hasTrace(app, det)).toBe(false);
    // In QMS, where the user is Top Management, evidence does not open either; in BCMS (auditor) it does.
    for (const [ms, on] of [['qms', false], ['bcms', true]] as const) {
      const e = app.data(app.MSL.find((m: AnyRecord) => m.id === ms)).evs[0];
      app.state = { ...app.state, q: e.code, sel: ms + ':ev:' + e.code };
      const x = app.renderVals().det;
      expect(!!fact(app, x, 'c_ctrl').go, ms).toBe(on);
      expect(hasTrace(app, x), ms).toBe(on);
    }
  }, 60000);
});
