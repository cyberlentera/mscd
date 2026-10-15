// The controller in API mode (BUILD-PLAN H.5 steps 5, 6, 8, 9, 10, 12, 13, 14) over the API source and a fake fetch.
// MscdApp is used as a plain object (no DOM): setState merges at once, and renderVals() builds the view model of
// every screen, which is what AppView renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MscdApp from '../../src/MscdApp.jsx';
import { json, meOf, readRoutes, sourceWith, uuidOf, wireOf } from './fixtures';
import type { Routes } from './fixtures';
import { problem } from '../auth/helpers';

// Test data of many shapes (wire snapshots, view models) is read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
const SCREENS = ['portfolio', 'm1overview', 'controls', 'phases', 'docs', 'audit', 'chain', 'gt', 'timeline', 'fresh', 'cal', 'mytasks', 'fw', 'storage', 'journey', 'team'];

function mount(ds: unknown, props: AnyRecord = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the controller is a JavaScript class
  const app = new (MscdApp as any)({ lang: 'en', theme: 'light', deploy: 'saas', ...props, dataSource: ds }) as AnyRecord;
  app.setState = (u: unknown, cb?: () => void) => {
    const patch = typeof u === 'function' ? (u as (s: AnyRecord, p: AnyRecord) => AnyRecord)(app.state, app.props) : u;
    if (patch) app.state = { ...app.state, ...(patch as AnyRecord) };
    if (cb) cb();
  };
  return app;
}

async function start(routes: Routes, props: AnyRecord = {}) {
  const env = sourceWith(routes);
  const app = mount(env.ds, props);
  app.firstLoad();
  await vi.waitFor(() => expect(app.state.D || app.state.loadError).toBeTruthy());
  env.calls.length = 0;
  return { ...env, app };
}

/** Waits until every queued command of the controller has finished. */
async function settle(app: AnyRecord) {
  await vi.waitFor(() => expect(app.state.busy).toBe(0));
  await (app._q ?? Promise.resolve());
}

function renderAll(app: AnyRecord) {
  for (const lang of ['en', 'id']) {
    for (const screen of SCREENS) {
      app.state = { ...app.state, screen, lang, sel: null };
      expect(() => app.renderVals(), `${screen} ${lang}`).not.toThrow();
    }
  }
  app.state = { ...app.state, lang: 'en' };
}

async function acme() {
  const fx = await wireOf();
  const acmeOrg = { id: uuidOf('org:acme'), slug: 'acme', name: 'PT Acme Industri' };
  const perms = { isms: ['ms.read', 'applicability.verify', 'activity.verify', 'audit.pending.all'], qms: ['ms.read'] };
  const me = meOf({ org: acmeOrg, handle: 'joko', uiRoleByMs: { isms: 'manager', qms: 'owner' }, perms, orgs: [{ id: 'acme', name: 'PT Acme Industri', ms: ['isms', 'qms'], deploy: 'onprem', sites: 1 }] });
  const org = {
    ...fx.org,
    orgs: me.orgs,
    MS: fx.org.MS.filter((m: AnyRecord) => ['isms', 'qms'].includes(m.id)),
    PEOPLE: { ...fx.org.PEOPLE },
    ROLES: { manager: { who: 'joko', label: ['MS Manager', 'Manajer SM'] }, owner: { who: 'joko', label: ['Domain Owner', 'Pemilik Domain'] } },
    PACKS: {},
    LICENCE: null,
    permissions: { org: [], ms: perms },
  };
  return { fx, me, routes: { ...readRoutes(fx, me), 'GET /api/v1/ui/org': json(org) } as Routes };
}

describe('controller in API mode', () => {
  // The controller logs failed loads and commands; the tests assert what the user sees instead.
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a non-demo user of acme: state from Me, role per system, every screen renders', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    expect(app.api).toBe(true);
    expect(app.state.loadError).toBeNull();
    expect([app.state.org, app.state.ms, app.state.role]).toEqual(['acme', 'isms', 'manager']);
    expect(app.me).toBe('joko');
    expect(app.MSL.map((m: AnyRecord) => m.id)).toEqual(['isms', 'qms']);
    renderAll(app);
    // The UI role follows the system.
    app.state = { ...app.state, screen: 'storage' };
    app.setMs('qms');
    expect(app.state.role).toBe('owner');
    expect(app.state.screen).toBe('mytasks');
    renderAll(app);
    app.go('controls', { ms: 'isms' });
    expect(app.state.role).toBe('manager');
    // Persona menu outside demo mode: the role of this system and Sign out.
    const v = app.renderVals();
    expect(v.roleOptions.map((r: AnyRecord) => r.label)).toEqual(['MS Manager', '']);
    expect(v.roleOptions[1].name).toBe('Sign out');
    expect(v.me.name).toBe(app.personOf('joko')[0]);
  });

  it('Start here and Team & roles outside demo mode: no roster, unknown packs, a missing manager, owner systems left out', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    const isms = app.MSL.find((m: AnyRecord) => m.id === 'isms');
    const [s1, s2] = app.journeyOf(isms).stages.map((s: AnyRecord) => s.checks);
    // PACKS is empty for a user without pack.read: the standard is unknown, not missing, and does not hold stage 1.
    expect(s1[0]).toMatchObject({ label: 'Standard', tone: 'mute' });
    // ROLES names only the session user outside demo mode, so there is no internal auditor check.
    expect(s2.map((c: AnyRecord) => c.label)).toEqual(['MS Manager', 'PICs assigned', 'Items without a PIC']);
    // A system without a primary MS Manager (mgr 'none') does not pass stage 2.
    app.state = { ...app.state, D: { ...app.D, EVENTS: { ...app.D.EVENTS, isms: [] } } };
    const noMgr = app.journeyOf({ ...isms, mgr: 'none' });
    expect(noMgr.stages[1].checks[0]).toMatchObject({ label: 'MS Manager', tone: 'bad' });
    expect(noMgr.cur).toBe(2);
    // Team & roles counts only ISMS (joko is Domain Owner in QMS, where the api sends only his own records) and labels
    // nobody as internal auditor or top management.
    app.state = { ...app.state, screen: 'team' };
    const tm = app.renderVals().tm;
    const chips = tm.rows.flatMap((r: AnyRecord) => r.roles);
    expect(chips.length).toBeGreaterThan(0);
    expect(new Set(chips.map((g: AnyRecord) => g.short))).toEqual(new Set(['ISMS']));
    expect(chips.some((g: AnyRecord) => g.label === 'Internal Auditor' || g.label === 'Top Management')).toBe(false);
    // A chip of another system opens that system with the role there: a Domain Owner cannot open Outstanding items.
    app.go('chain', { ms: 'qms', person: 'joko' });
    expect([app.state.ms, app.state.role, app.state.screen]).toEqual(['qms', 'owner', 'mytasks']);
  });

  it('Top Management and external auditors do not get Start here or Team & roles; actions follow what the role opens', async () => {
    const fx = await wireOf();
    // ISMS as the top_management projection: holders come as aggregates only, so every item reads as unassigned.
    for (const it of fx.ms.isms.bundle.chain.items) it.h = 'none';
    const me = meOf({ uiRoleByMs: { isms: 'top', qms: 'manager', bcms: 'auditor', abms: 'owner' } });
    me.rolesByMs.abms = ['external_auditor'];
    me.uiRoleByMs.abms = 'auditor';
    const { app } = await start(readRoutes(fx, me));
    expect([app.state.ms, app.state.role]).toEqual(['isms', 'top']);
    const navIds = () => app.renderVals().nav.flatMap((g: AnyRecord) => g.items.map((i: AnyRecord) => i.label));
    expect(navIds()).not.toContain('Start here');
    expect(navIds()).not.toContain('Team & roles');
    // A system where the user is an external auditor: the same UI role as an internal auditor, but no full read.
    app.go('journey', { ms: 'abms' });
    expect([app.state.role, app.state.screen]).toEqual(['auditor', 'portfolio']);
    app.go('journey', { ms: 'bcms' });
    expect([app.state.role, app.state.screen]).toEqual(['auditor', 'journey']);
    const jr = app.renderVals().jr;
    // Only systems read in full appear in the strip; stage actions keep the screens the role can open.
    expect(jr.systems.map((s: AnyRecord) => s.short)).toEqual(['QMS', 'BCMS']);
    expect(jr.stages[0].acts).toEqual([]);
    expect(jr.track[0].go).toBeNull();
    // A stage without an action is inert: default cursor and aria-disabled; Certification keeps Audit readiness.
    expect(jr.track[0]).toMatchObject({ cursor: 'default', off: 'true' });
    expect(jr.track[5]).toMatchObject({ cursor: 'pointer', off: null });
    expect(jr.stages[5].acts.map((a: AnyRecord) => a.label)).toEqual(['Audit readiness']);
    app.state = { ...app.state, screen: 'team' };
    const tm = app.renderVals().tm;
    expect(new Set(tm.rows.flatMap((r: AnyRecord) => r.roles.map((g: AnyRecord) => g.short)))).toEqual(new Set(['QMS', 'BCMS']));
    const unassigned = ['qms', 'bcms'].reduce((n, id) => n + app.data(app.MSL.find((m: AnyRecord) => m.id === id)).chain.items.filter((i: AnyRecord) => i.h === 'none').length, 0);
    expect(tm.stats[1].n).toBe(unassigned);
    // Back to ISMS as Top Management: the journey falls back to the role's first screen.
    app.setMs('isms');
    expect([app.state.role, app.state.screen]).toEqual(['top', 'portfolio']);
  });

  it('absent licence and pack cards render as -', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    app.state = { ...app.state, screen: 'fw' };
    const fw = app.renderVals().fw;
    expect(fw.to).toBe('-');
    expect(fw.featureChips).toEqual([]);
    expect(fw.lic.map((l: AnyRecord) => l.n)).toEqual(['-', '-', '-']);
    expect(fw.cards.every((c: AnyRecord) => c.pack === '-' && c.installed === '-')).toBe(true);
  });

  it('verify and the people list follow the permissions of the system', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    const d = app.data(app.MSL.find((m: AnyRecord) => m.id === 'isms'));
    const done = d.reqs.find((c: AnyRecord) => c.st === 'complete') ?? { ...d.reqs[0], st: 'complete', by: 'bagus' };
    expect(app.reqDetail(done, d).actions.some((a: AnyRecord) => a.label === app.t('verify'))).toBe(true);
    const dq = app.data(app.MSL.find((m: AnyRecord) => m.id === 'qms'));
    const doneQ = { ...dq.reqs[0], st: 'complete', by: 'sari' };
    expect(app.reqDetail(doneQ, dq).actions.some((a: AnyRecord) => a.label === app.t('verify'))).toBe(false);
    app.state = { ...app.state, ms: 'isms', screen: 'chain' };
    expect(app.renderVals().people).not.toBeNull();
    app.state = { ...app.state, ms: 'qms', role: 'owner', screen: 'chain' };
    expect(app.chainScreen(dq).people).toBeNull();
  });

  it('My Tasks: stored tasks are listed and completed through /tasks; a SoA item opens the gate', async () => {
    const fx = await wireOf();
    const me = meOf();
    // A SoA item held by rina.
    const isms = fx.ms.isms;
    const soa = { key: 'isms:soa:A.5.23', stage: 'soa', kind: 'soa', id: 'A.5.23', title: ['A.5.23', 'A.5.23'], act: ['Write the justification', 'Tulis justifikasi'], h: 'rina', due: '2026-10-20', st: 'pending', after: false, gate: true, up: [], down: [], q: '', refKey: 'isms:req:A.5.23' };
    isms.bundle.chain.items.push(soa);
    const { app, calls } = await start(readRoutes(fx, me));
    app.state = { ...app.state, screen: 'mytasks' };
    const feed = app.renderVals().tasks.feed as AnyRecord[];
    // Feed items of kinds without an icon of their own (task, soa) show the record icon (kind x).
    const stored = feed.find((x) => x.id === uuidOf('task-1'));
    expect(stored).toBeDefined();
    expect(stored!.title).toBe('Upload overdue evidence');
    const soaItem = feed.find((x) => x.id === 'A.5.23' && x.btn === app.t('openGate'));
    expect(soaItem!.btn).toBe(app.t('openGate'));
    soaItem!.go();
    expect(app.state.screen).toBe('controls');
    expect(app.state.tab.controls).toBe('gate');
    expect(calls).toHaveLength(0);
    stored!.go();
    await settle(app);
    expect(calls[0]).toMatchObject({ method: 'POST', path: `/api/v1/tasks/${uuidOf('task-1')}/complete` });
    // The command reloads the changed system, the organisation and the tasks.
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(['/api/v1/ui/org', '/api/v1/ui/ms/isms', '/api/v1/tasks']));
    expect(app.state.toast).toBe(app.t('toastSaved'));
  });

  it('commands queue behind the busy bar; warnings are added to the toast; errors show the api message', async () => {
    const fx = await wireOf();
    const routes = readRoutes(fx, meOf());
    const { app, calls } = await start(routes);
    const id = app.state.snap.refs['isms:req:A.8.13'].id;
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = json({ ok: true, changed: ['isms'], warnings: [{ rule: 'BR-41', messages: { en: 'Holder has 12 open items', id: 'Pemegang memiliki 12 item terbuka' } }] });
    let maxBusy = 0;
    const set = app.setState;
    app.setState = (u: unknown, cb?: () => void) => { set(u, cb); maxBusy = Math.max(maxBusy, app.state.busy); };
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast(app.t('toastComplete')));
    app.command((ds: AnyRecord) => ds.remindAll('isms'), (r: AnyRecord) => app.toast('second ' + r.ok));
    await settle(app);
    // One command at a time: the second waits for the first (busy never counts two).
    expect(maxBusy).toBe(1);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/api/v1/ms/isms/applicability/${id}/transitions`, '/api/v1/reminders/bulk']);
    expect(app.state.toast).toBe('second true');
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast(app.t('toastComplete')));
    await settle(app);
    expect(app.state.toast).toBe(app.t('toastComplete') + '. Holder has 12 open items');
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = problem(422, 'business-rule', { rule: 'BR-01', messages: { en: 'No valid evidence in the current period', id: 'Tidak ada evidence valid pada periode berjalan' } });
    app.state = { ...app.state, lang: 'id' };
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast('done'));
    await settle(app);
    expect(app.state.toast).toBe('Tidak ada evidence valid pada periode berjalan');
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = 'network-error';
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast('done'));
    await settle(app);
    expect(app.state.toast).toBe('Koneksi terputus. Coba lagi.');
    expect(app.state.busy).toBe(0);
  });

  it('remind, remindAll and runCheck use the source and the counts of the result', async () => {
    const fx = await wireOf();
    const routes = { ...readRoutes(fx, meOf()), 'POST /api/v1/reminders/bulk': json({ ok: true, changed: [], count: 8 }), 'POST /api/v1/ms/isms/link-health/run': json({ ok: true, changed: [], count: 77 }, 202) };
    const { app, calls } = await start(routes);
    app.state = { ...app.state, screen: 'chain' };
    app.renderVals().pageActions[0].go();
    await settle(app);
    expect(app.state.toast).toBe('Reminders sent to 8 people');
    app.state = { ...app.state, screen: 'fresh' };
    app.renderVals().pageActions[0].go();
    await settle(app);
    expect(app.state.toast).toBe('Integrity check started for 77 references');
    calls.length = 0;
    const d = app.data();
    const det = app.docDetail(d.docs[0], d);
    det.actions.find((a: AnyRecord) => a.label === app.t('remind')).go();
    await settle(app);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/reminders', body: { ms: 'isms', recipient: d.docs[0].owner } });
  });

  it('the picker lists the repository files; upload uses the hidden file input', async () => {
    const fx = await wireOf();
    const listing = { path: 'Compliance / ISMS', files: [['Backup.xlsx', '28 Sep 2026', 'v3.0', 'quickXorHash', 'Bagus Prasetyo']], refs: [{ repositoryId: 'sp', externalItemId: 'demo-sp-picker-1' }] };
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/storage/repositories/:slug/browse': json(listing) };
    const { app, calls } = await start(routes);
    const ms = app.MSL.find((m: AnyRecord) => app.D.LOC[m.loc][1] !== 'vault');
    const ev = app.data(ms).evs[0];
    app.openPicker(`${ms.id}:ev:${ev.code}`, ms, 'ev');
    await vi.waitFor(() => expect(app.state.modal?.listing).toEqual(listing));
    expect(app.modalVals().files[0].name).toBe('Backup.xlsx');
    calls.length = 0;
    app.modalOk();
    await settle(app);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1' } });
    expect(app.state.modal).toBeNull();
    // Upload: modalOk opens the file dialog; the chosen file goes to uploadFile.
    const vault = { ...ms, loc: Object.keys(app.D.LOC).find((k) => app.D.LOC[k][1] === 'vault') };
    app.openPicker(`${ms.id}:ev:${ev.code}`, vault, 'ev');
    expect(app.state.modal.type).toBe('upload');
    const input = { accept: '', value: 'x', click: vi.fn() };
    app._file = input;
    app.modalOk();
    expect(input.click).toHaveBeenCalledTimes(1);
    const upload = vi.spyOn(app.ds, 'uploadFile').mockResolvedValue({ ok: true, changed: [] });
    const file = new File(['x'], 'Report.pdf');
    app.onFileChosen({ target: { files: [file] } });
    await settle(app);
    expect(upload).toHaveBeenCalledWith(`${ms.id}:ev:${ev.code}`, file);
    expect(app.state.toast).toBe(app.t('toastUploaded'));
  });

  it('an empty picker listing shows its empty state and keeps Link disabled', async () => {
    const fx = await wireOf();
    const listing = { path: 'Compliance / ISMS / Evidence / 2026 / Q4', files: [], refs: [] };
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/storage/repositories/:slug/browse': json(listing) };
    const { app, calls } = await start(routes);
    const ms = app.MSL.find((m: AnyRecord) => app.D.LOC[m.loc][1] !== 'vault');
    const ev = app.data(ms).evs[0];
    app.openPicker(`${ms.id}:ev:${ev.code}`, ms, 'ev');
    await vi.waitFor(() => expect(app.state.modal?.listing).toEqual(listing));
    const vals = app.modalVals();
    expect(vals.files).toEqual([]);
    expect(vals.okOff).toBe(true);
    expect(vals.sub).toMatch(/no files yet/);
    calls.length = 0;
    expect(() => app.modalOk()).not.toThrow();
    await settle(app);
    expect(calls).toHaveLength(0);
    expect(app.state.modal?.type).toBe('picker');
    expect(() => app.renderVals()).not.toThrow();
  });

  it('demo personas: the menu lists them and Sign out; a persona switch takes the role from the new Me', async () => {
    const fx = await wireOf();
    const personas = fx.org.ROLES;
    const me = meOf({ personas });
    const bagus = meOf({ handle: 'bagus', personas, uiRoleByMs: { isms: 'owner', qms: 'owner', bcms: 'owner', abms: 'owner' } });
    const routes = { ...readRoutes(fx, me), 'POST /api/v1/auth/demo/persona': json(bagus), 'POST /api/v1/auth/logout': { status: 204 } } as Routes;
    const { app, calls, ds } = await start(routes);
    const v = app.renderVals();
    expect(v.roleOptions).toHaveLength(Object.keys(personas).length + 1);
    routes['GET /api/v1/me'] = json(bagus);
    app.setRole('owner', 'portfolio', false);
    await vi.waitFor(() => expect(app.state.role).toBe('owner'));
    expect(app.me).toBe('bagus');
    expect(app.state.screen).toBe('mytasks');
    const logout = vi.spyOn(ds, 'logout');
    app.renderVals().roleOptions.slice(-1)[0].go();
    expect(logout).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/v1/auth/logout')).toBe(true));
  });

  it('a failed first load shows the error and Try again loads once more', async () => {
    const fx = await wireOf();
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/ui/org': [problem(503, 'dependency-unavailable', { messages: { en: 'Database busy', id: 'Basis data sibuk' } }), json(fx.org)] } as Routes;
    const env = sourceWith(routes);
    const app = mount(env.ds);
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.loadError).toBeTruthy());
    expect(app.state.D).toBeNull();
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.D).toBeTruthy());
    expect(app.state.loadError).toBeNull();
  });

  it('an organisation switch takes the system list and role of the new organisation; reauth-required shows no toast', async () => {
    const fx = await wireOf();
    const me = meOf({ orgs: [{ id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: ['isms', 'qms', 'bcms', 'abms'], deploy: 'saas', sites: 3 }, { id: 'rmn', name: 'RS Medika Nusantara', ms: ['isms'], deploy: 'onprem', sites: 1 }] });
    const rmnMe = { ...meOf({ org: { id: uuidOf('org:rmn'), slug: 'rmn', name: 'RS Medika Nusantara' }, uiRoleByMs: { isms: 'auditor' } }), orgs: me.orgs };
    const routes = { ...readRoutes(fx, me), 'PUT /api/v1/me/org': json(rmnMe) } as Routes;
    const { app } = await start(routes);
    app.state = { ...app.state, ms: 'qms' };
    routes['GET /api/v1/ui/org'] = json({ ...fx.org, orgs: me.orgs, MS: fx.org.MS.filter((m: AnyRecord) => m.id === 'isms') });
    app.setOrg('rmn');
    await vi.waitFor(() => expect(app.state.org).toBe('rmn'));
    expect([app.state.ms, app.state.role, app.state.deploy]).toEqual(['isms', 'auditor', 'onprem']);
    expect(() => app.renderVals()).not.toThrow();
    routes['PUT /api/v1/me/org'] = problem(409, 'reauth-required', { methods: { local: true, providers: [] } });
    app.state = { ...app.state, toast: null };
    app.setOrg('ndt');
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.org).toBe('rmn');
    expect(app.state.toast).toBeNull();
  });
});
