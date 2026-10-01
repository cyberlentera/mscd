// Sample data source (BUILD-PLAN H.3, WP-07). The reference is the controller as it was before the move
// (fixtures/legacy-controller.js): for every organisation, system and language, and after every command, the bundles
// of SampleDataSource must equal what the old controller derived from the same override patch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as SAMPLE from '../src/data/mscd-data.js';
import * as STATIC from '../src/data/static.js';
import { makeDates } from '../src/data/dates.js';
import { ORGS } from '../src/data/sample-orgs.js';
import { createSampleDataSource } from '../src/data/SampleDataSource.js';
import { createDataSource } from '../src/data/createDataSource.js';
import { LegacyController, legacyDates } from './fixtures/legacy-controller.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/data');
const LANGS = ['en', 'id'];
const li = (a, lang) => (Array.isArray(a) ? a[lang === 'id' ? 1 : 0] : a);
const ME = { manager: 'rina', owner: 'bagus', auditor: 'maya', top: 'hendra' };

// The bundle as the controller shows it in one language (MscdApp chain() and gateItems()).
function localise(b, lang) {
  return {
    reqs: b.reqs, docs: b.docs, evs: b.evs,
    chain: { items: b.chain.items.map((i) => ({ ...i, title: li(i.title, lang), act: li(i.act, lang) })), recs: b.chain.recs },
    gates: b.gates.map((g) => ({ ...g, type: li(g.type, lang), why: li(g.why, lang) })),
    phases: b.phases,
  };
}
// What the controller derived before WP-07 from the same override store.
function legacyBundle(msId, lang, ov) {
  const c = new LegacyController(SAMPLE, lang, ov);
  const d = c.data(SAMPLE.MS.find((m) => m.id === msId));
  return { reqs: d.reqs, docs: d.docs, evs: d.evs, chain: c.chain(d), gates: c.gateItems(d), phases: c.phases(d) };
}
// The fields WP-07 added to replace hard-coded switches (H.3) are compared separately.
const normDoc = ({ approver, path: p, hashAlg, ...rest }) => rest;
const normEv = ({ hash, lastCheck, lastGoodCheck, ...rest }) => rest;
const normRef = (r) => (!r ? r : 'code' in r ? normEv(r) : 'tier' in r ? normDoc(r) : r);
function norm(b) {
  return {
    reqs: b.reqs, docs: b.docs.map(normDoc), evs: b.evs.map(normEv),
    chain: { items: b.chain.items.map((i) => ({ ...i, ref: normRef(i.ref) })), recs: b.chain.recs },
    gates: b.gates,
    phases: b.phases.map((p) => ({ ...p, acts: p.acts.map((a) => ({ ...a, doc: a.doc && normDoc(a.doc) })) })),
  };
}
// Every system of the organisation, in both languages, equals the old controller with `ov`; reload and load agree.
async function expectLegacy(ds, ov, orgId = 'ndt', snapBefore = null, changed = []) {
  const snap = await ds.load(orgId);
  for (const ms of snap.MS) for (const lang of LANGS) {
    expect(norm(localise(snap.bundles[ms.id], lang)), `${orgId} ${ms.id} ${lang}`).toEqual(norm(legacyBundle(ms.id, lang, ov)));
  }
  if (snapBefore) {
    const re = await ds.reload(snapBefore, changed);
    for (const ms of snap.MS) {
      if (changed.includes(ms.id)) expect(re.bundles[ms.id]).toEqual(snap.bundles[ms.id]);
      else expect(re.bundles[ms.id]).toBe(snapBefore.bundles[ms.id]);
    }
  }
  return snap;
}
// Runs a command on a fresh source and on the legacy store, then compares everything.
async function commandCase(run, legacyPatch, { orgId = 'ndt', setup } = {}) {
  const ds = createSampleDataSource();
  const ov = {};
  const legacy = new LegacyController(SAMPLE, 'en', ov);
  if (setup) await setup(ds, legacy);
  const before = await ds.load(orgId);
  const res = await run(ds);
  legacyPatch(legacy);
  const after = await expectLegacy(ds, ov, orgId, before, res.changed);
  return { res, before, after, ds, ov };
}
const bundleOf = (snap, ms) => snap.bundles[ms];
const req = (snap, ms, id) => bundleOf(snap, ms).reqs.find((c) => c.id === id);
const doc = (snap, ms, id) => bundleOf(snap, ms).docs.find((d) => d.id === id);
const ev = (snap, ms, code) => bundleOf(snap, ms).evs.find((e) => e.code === code);
const item = (snap, ms, key) => bundleOf(snap, ms).chain.items.find((i) => i.key === key);
const act = (snap, ms, no) => bundleOf(snap, ms).phases.flatMap((p) => p.acts).find((a) => a.no === no);
// My Tasks (UI 2.11): chain items held by `me`, without requirements `me` marked complete.
const tasks = (snap, me) => snap.MS.flatMap((m) => snap.bundles[m.id].chain.items.filter((i) => i.h === me && !(i.kind === 'req' && i.ref.st === 'complete' && (i.ref.by || i.ref.owner) === me)));

describe('snapshot of the sample source', () => {
  it('has the UI 4.7 reference numbers for PT Nusantara Digital Teknologi', async () => {
    const snap = await createSampleDataSource().load('ndt');
    const row = (id) => {
      const b = snap.bundles[id];
      return [b.reqs.length, b.evs.length, b.docs.length, b.chain.items.length, b.chain.items.filter((i) => i.st !== 'pending').length, b.gates.length, b.evs.filter((e) => e.fresh === 'critical').length];
    };
    expect(Object.keys(snap.bundles)).toEqual(['isms', 'qms', 'bcms', 'abms']);
    expect(row('isms')).toEqual([93, 79, 22, 63, 24, 4, 3]);
    expect(row('qms')).toEqual([28, 27, 10, 18, 5, 0, 0]);
    expect(row('bcms')).toEqual([27, 11, 8, 25, 2, 3, 0]);
    expect(row('abms')).toEqual([32, 2, 5, 35, 3, 1, 0]);
  });

  it('gives My Tasks counts per persona: rina 3, bagus 31, maya 1, hendra 3', async () => {
    const snap = await createSampleDataSource().load('ndt');
    expect(Object.fromEntries(Object.entries(ME).map(([role, who]) => [role, tasks(snap, who).length]))).toEqual({ manager: 3, owner: 31, auditor: 1, top: 3 });
  });

  it('equals the old controller derivation for every organisation, system and language', async () => {
    const ds = createSampleDataSource();
    for (const org of ORGS) await expectLegacy(ds, {}, org.id);
  });

  it('holds the systems of the organisation and its repositories only', async () => {
    const ds = createSampleDataSource();
    const ndt = await ds.load('ndt');
    expect(ndt.today).toBe('2026-09-29');
    expect(ndt.orgs).toEqual(ORGS);
    expect(ndt.MS.map((m) => m.id)).toEqual(['isms', 'qms', 'bcms', 'abms']);
    expect(ndt.REPOS.map((r) => r.id)).toEqual(['sp', 'gd', 'vault', 'od']);
    const bsd = await ds.load('bsd');
    expect(bsd.MS.map((m) => m.id)).toEqual(['isms', 'qms']);
    expect(Object.keys(bsd.bundles)).toEqual(['isms', 'qms']);
    for (const k of ['STAGES', 'X', 'CHAINS', 'EVENTS', 'FOCUS', 'PREP', 'PAST', 'CYCLE_ITEMS', 'DRIFT', 'PACKS']) expect(Object.keys(bsd[k]), k).toEqual(['isms', 'qms']);
    expect(bsd.REPOS.map((r) => [r.id, r.ms])).toEqual([['sp', ['ISMS']], ['vault', ['QMS']], ['od', ['ISMS']]]);
    expect(bsd.ROUTING.map((r) => r[0])).toEqual(['ISMS', 'QMS']);
    const rmn = await ds.load('rmn');
    expect(rmn.MS.map((m) => m.id)).toEqual(['isms']);
    expect(rmn.REPOS.map((r) => r.id)).toEqual(['sp', 'od']);
    await expect(ds.load('nope')).rejects.toThrow(/unknown organisation/);
  });

  it('is plain data that survives JSON, with the static content left to the controller', async () => {
    const snap = await createSampleDataSource().load('ndt');
    const copy = JSON.parse(JSON.stringify(snap));
    expect(copy.bundles.isms.chain.items).toHaveLength(63);
    for (const k of ['T', 'TERA', 'INTEG']) expect(snap[k]).toBeUndefined();
    expect(snap.PICKER_FILES).toBe(SAMPLE.PICKER_FILES);
  });

  it('gives gate item types as pairs that read as before in English and Indonesian', async () => {
    const snap = await createSampleDataSource().load('ndt');
    const types = (ms) => snap.bundles[ms].gates.map((g) => [g.id, g.type]);
    expect(types('isms')).toEqual([['A.5.23', ['Control', 'Kontrol']], ['A.8.12', ['Control', 'Kontrol']], ['R-031', ['Risk', 'Risiko']], ['SOA-01', ['SoA', 'SoA']]]);
    expect(types('qms')).toEqual([]);
    expect(types('bcms')).toEqual([['Cl. 8.2', ['Requirement', 'Persyaratan']], ['BIA-03', ['BIA', 'BIA']], ['BIA-06', ['BIA', 'BIA']]]);
    expect(types('abms')).toEqual([['Cl. 4.5', ['Requirement', 'Persyaratan']]]);
    for (const ms of ['isms', 'bcms', 'abms']) for (const lang of LANGS) {
      expect(snap.bundles[ms].gates.map((g) => li(g.type, lang))).toEqual(legacyBundle(ms, lang, {}).gates.map((g) => g.type));
    }
  });

  it('fills the optional fields of UI 2.14 with the literals the controller used (H.3)', async () => {
    const snap = await createSampleDataSource().load('ndt');
    const ms = Object.fromEntries(snap.MS.map((m) => [m.id, m]));
    expect(ms.isms.gateName).toEqual(['Risk & SoA', 'Risiko & SoA']);
    expect(ms.qms.gateName).toEqual(['Risk & Opportunity + Process Map', 'Risiko & Peluang + Peta Proses']);
    expect(ms.bcms.gateName).toEqual(['BIA & Risk Assessment', 'BIA & Penilaian Risiko']);
    expect(ms.abms.gateName).toEqual(['Bribery Risk Assessment', 'Penilaian Risiko Penyuapan']);
    expect([ms.isms, ms.qms, ms.bcms, ms.abms].map((m) => m.gtSuggestions)).toEqual([['A.8.13', 'PRC-07', 'A.5.23'], ['Cl. 8.4', 'PRC-Q04'], ['BIA-03', 'PLN-B02'], ['Cl. 4.5']]);
    expect([ms.isms, ms.qms, ms.bcms, ms.abms].map((m) => m.approver)).toEqual(['hendra', 'sari', 'hendra', 'lina']);
    expect([ms.qms, ms.bcms, ms.abms].map((m) => m.banner.kind)).toEqual(['transition', 'connector', 'beta']);
    expect(ms.isms.banner).toBeUndefined();
    expect([ms.isms, ms.qms, ms.bcms].map((m) => m.audit.prepWindowDays)).toEqual([60, 60, 60]);
    expect(Object.fromEntries(Object.entries(snap.PACKS).map(([k, p]) => [k, p.status]))).toEqual({ isms: 'current', qms: 'transition', bcms: 'current', abms: 'beta' });
    expect(snap.REPOS.map((r) => [r.id, r.adapter, r.ownershipType, [...r.actions].sort()])).toEqual([
      ['sp', 'm365', 'organizational', ['test']],
      ['gd', 'google_drive', 'organizational', ['reauthorise', 'test']],
      ['vault', 'managed_vault', 'organizational', ['test']],
      ['od', 'm365', 'personal', ['moveToLibrary', 'test']],
    ]);
    // Documents: approver of the system, storage path and pinned hash algorithm of the system's repository.
    for (const m of snap.MS) for (const d of snap.bundles[m.id].docs) {
      expect(d.approver).toBe(m.approver);
      expect(d.path).toBe('Compliance / ' + m.short + ' / Documents');
      expect(d.hashAlg).toBe(m.loc === 'vault' ? 'SHA-256' : m.loc === 'gd' ? 'SHA-256 (provider)' : 'quickXorHash');
    }
    // Evidence: the fingerprint shortens (first 10, '...', last 4) to the old literal; check times as before.
    const short = (h) => h.slice(0, 10) + '...' + h.slice(-4);
    for (const m of snap.MS) for (const e of snap.bundles[m.id].evs) {
      if (e.hashAlg === 'none') expect(e.hash).toBeUndefined();
      else expect(short(e.hash)).toBe(e.code.replace(/\W/g, '').toLowerCase() + 'a91f...3c7e');
      expect(e.lastCheck).toBe(e.integ === 'pending' ? '27 Sep 2026 06:00' : '29 Sep 2026 06:00');
      if (e.integ === 'pending') expect(e.lastGoodCheck).toBe('27 Sep 2026 06:00');
    }
    expect(snap.bundles.bcms.evs.every((e) => e.integ === 'pending')).toBe(true);
  });
});

describe('commands apply the override patches of the old controller', () => {
  it('markComplete on a requirement records the persona as the completer', async () => {
    const { res, after } = await commandCase((ds) => ds.markComplete('isms:req:A.8.8'), (c) => c.ovSet('isms:req:A.8.8', { st: 'complete', by: 'rina' }));
    expect(res).toEqual({ ok: true, changed: ['isms'] });
    expect(req(after, 'isms', 'A.8.8')).toMatchObject({ st: 'complete', by: 'rina' });
    expect(item(after, 'isms', 'isms:req:A.8.8').act).toEqual(['Verify output (Rina Kusuma marked complete)', 'Verifikasi output (ditandai selesai oleh Rina Kusuma)']);
  });

  it('markComplete acts as the persona chosen with switchPersona', async () => {
    const { after } = await commandCase(async (ds) => { await ds.switchPersona('owner'); return ds.markComplete('isms:req:A.8.9'); }, (c) => c.ovSet('isms:req:A.8.9', { st: 'complete', by: 'bagus' }));
    expect(req(after, 'isms', 'A.8.9').by).toBe('bagus');
    expect(tasks(after, 'bagus').some((i) => i.key === 'isms:req:A.8.9')).toBe(false);
  });

  it('markComplete on an activity', async () => {
    const { res, after } = await commandCase((ds) => ds.markComplete('isms:act:9.4'), (c) => c.ovSet('isms:act:9.4', { st: 'complete', by: 'rina' }));
    expect(res.changed).toEqual(['isms']);
    expect(act(after, 'isms', '9.4')).toMatchObject({ st: 'complete', by: 'rina' });
  });

  it('verify sets a completed requirement to implemented and clears the completer', async () => {
    const setup = async (ds, c) => { await ds.switchPersona('owner'); await ds.markComplete('isms:req:A.8.8'); await ds.switchPersona('manager'); c.ovSet('isms:req:A.8.8', { st: 'complete', by: 'bagus' }); };
    const { res, after } = await commandCase((ds) => ds.verify('isms:req:A.8.8', 'implemented'), (c) => c.ovSet('isms:req:A.8.8', { st: 'implemented', by: null }), { setup });
    expect(res.ok).toBe(true);
    expect(req(after, 'isms', 'A.8.8')).toMatchObject({ st: 'implemented', by: null });
    expect(item(after, 'isms', 'isms:req:A.8.8')).toBeUndefined();
  });

  it('verify sets a completed activity to verified', async () => {
    const { after } = await commandCase((ds) => ds.verify('qms:act:9.4', 'verified'), (c) => c.ovSet('qms:act:9.4', { st: 'verified', by: null }));
    expect(act(after, 'qms', '9.4').st).toBe('verified');
  });

  it('verify refuses a target that does not fit the record and changes nothing', async () => {
    const { res } = await commandCase((ds) => ds.verify('qms:act:9.4', 'implemented'), () => {});
    expect(res.ok).toBe(false);
    expect(res.error.status).toBe(422);
    expect(res.changed).toEqual([]);
  });

  it('assign gives a chain record a holder and a due date; gate items keep the stored holder (UI 5.11)', async () => {
    const { after } = await commandCase((ds) => ds.assign('isms:x:R-031', 'bagus', '2026-10-20'), (c) => c.ovSet('isms:x:R-031', { h: 'bagus', due: '2026-10-20' }));
    expect(item(after, 'isms', 'isms:x:R-031')).toMatchObject({ h: 'bagus', due: '2026-10-20', st: 'pending' });
    expect(bundleOf(after, 'isms').gates.find((g) => g.id === 'R-031').h).toBe('rina');
  });

  it('assign on a requirement and on evidence changes owner and due date', async () => {
    const code = SAMPLE.buildEvidence(SAMPLE.MS[0], SAMPLE.buildReqs(SAMPLE.MS[0])).find((e) => e.ctrl === 'A.8.8').code;
    const { after } = await commandCase(async (ds) => { await ds.assign('isms:req:A.8.9', 'dewi', '2026-11-30'); return ds.assign('isms:ev:' + code, 'yusuf', '2026-10-05'); },
      (c) => { c.ovSet('isms:req:A.8.9', { h: 'dewi', due: '2026-11-30' }); c.ovSet('isms:ev:' + code, { h: 'yusuf', due: '2026-10-05' }); });
    expect(req(after, 'isms', 'A.8.9')).toMatchObject({ owner: 'dewi', due: '2026-11-30' });
    expect(ev(after, 'isms', code)).toMatchObject({ owner: 'yusuf', next: '2026-10-05' });
  });

  it('completeRecordAction takes an explicit record out of every chain list', async () => {
    const { res, before, after } = await commandCase((ds) => ds.completeRecordAction('isms:x:M-07'), (c) => c.ovSet('isms:x:M-07', { done: true }));
    expect(res.changed).toEqual(['isms']);
    expect(item(after, 'isms', 'isms:x:M-07')).toBeUndefined();
    expect(tasks(after, 'bagus').length).toBe(tasks(before, 'bagus').length - 1);
    const wrong = await createSampleDataSource().completeRecordAction('isms:req:A.8.8');
    expect(wrong.error.status).toBe(422);
  });

  it('startReview moves an expired document to review', async () => {
    const { after } = await commandCase((ds) => ds.startReview('isms:doc:PRC-07'), (c) => c.ovSet('isms:doc:PRC-07', { st: 'review' }));
    expect(doc(after, 'isms', 'PRC-07').st).toBe('review');
    expect(item(after, 'isms', 'isms:doc:PRC-07').act).toEqual(['Approve review', 'Setujui review']);
    expect((await createSampleDataSource().startReview('isms:req:A.8.8')).error.status).toBe(422);
  });

  it('linkFile on evidence pins the file and restarts the cycle, dropping a due date set by Reassign', async () => {
    const e0 = (await createSampleDataSource().load('ndt')).bundles.isms.evs.find((e) => e.integ === 'missing');
    const key = 'isms:ev:' + e0.code; const f = SAMPLE.PICKER_FILES.sp.files[0];
    const setup = async (ds, c) => { await ds.assign(key, 'dewi', '2026-12-01'); c.ovSet(key, { h: 'dewi', due: '2026-12-01' }); };
    const { after } = await commandCase((ds) => ds.linkFile(key, { src: 'sp', index: 0 }),
      (c) => c.newEvidence(key, { prod: SAMPLE.TODAY_S, integ: 'ok', ver: f[2], hashAlg: f[3], loc: 'sp' }), { setup });
    expect(ev(after, 'isms', e0.code)).toMatchObject({ prod: '2026-09-29', integ: 'ok', ver: 'v3.0', hashAlg: 'quickXorHash', loc: 'sp', owner: 'dewi', fresh: 'fresh', next: SAMPLE.addD('2026-09-29', e0.p) });
  });

  it('linkFile with a Google file without a hash records nohash', async () => {
    const code = (await createSampleDataSource().load('ndt')).bundles.bcms.evs[0].code;
    const { after } = await commandCase((ds) => ds.linkFile('bcms:ev:' + code, { src: 'gd', index: 0 }),
      (c) => c.newEvidence('bcms:ev:' + code, { prod: SAMPLE.TODAY_S, integ: 'nohash', ver: 'rev 7', hashAlg: 'none', loc: 'gd' }));
    expect(ev(after, 'bcms', code)).toMatchObject({ integ: 'nohash', hashAlg: 'none', ver: 'rev 7' });
    expect(ev(after, 'bcms', code).hash).toBeUndefined();
  });

  it('linkFile on a document approves its next major version for a year', async () => {
    const { res, after } = await commandCase((ds) => ds.linkFile('isms:doc:POL-01', { src: 'sp', index: 1 }), (c) => {
      const d = c.data(SAMPLE.MS[0]).docs.find((x) => x.id === 'POL-01');
      c.ovSet('isms:doc:POL-01', { ver: c.nextDocVer(d), appr: SAMPLE.TODAY_S, rev: SAMPLE.addD(SAMPLE.TODAY_S, 365), st: 'approved' });
    });
    expect(res.ok).toBe(true);
    expect(doc(after, 'isms', 'POL-01')).toMatchObject({ ver: '5.0', appr: '2026-09-29', rev: '2027-09-29', st: 'approved' });
    expect((await createSampleDataSource().linkFile('isms:doc:POL-01', { src: 'sp', index: 99 })).error.status).toBe(404);
  });

  it('uploadFile on evidence stores the next vault version with SHA-256', async () => {
    const e0 = (await createSampleDataSource().load('ndt')).bundles.qms.evs[0];
    const n = parseInt(String(e0.ver).replace(/\D/g, ''), 10) || 0;
    const { after } = await commandCase((ds) => ds.uploadFile('qms:ev:' + e0.code, null),
      (c) => c.newEvidence('qms:ev:' + e0.code, { prod: SAMPLE.TODAY_S, integ: 'ok', ver: 'v' + (n + 1), hashAlg: 'SHA-256' }));
    expect(ev(after, 'qms', e0.code)).toMatchObject({ ver: 'v' + (n + 1), hashAlg: 'SHA-256', integ: 'ok', prod: '2026-09-29' });
  });

  it('uploadFile on a document approves its next major version', async () => {
    const d0 = (await createSampleDataSource().load('ndt')).bundles.abms.docs.find((d) => d.id === 'POL-A01');
    const { after } = await commandCase((ds) => ds.uploadFile('abms:doc:POL-A01', null),
      (c) => c.ovSet('abms:doc:POL-A01', { ver: c.nextDocVer(d0), appr: SAMPLE.TODAY_S, rev: SAMPLE.addD(SAMPLE.TODAY_S, 365), st: 'approved' }));
    expect(doc(after, 'abms', 'POL-A01')).toMatchObject({ ver: '1.0', st: 'approved' });
  });

  it('remind and recordBlocker change nothing', async () => {
    const r1 = await commandCase((ds) => ds.remind('isms:req:A.8.8', 'bagus'), () => {});
    expect(r1.res).toEqual({ ok: true, changed: [] });
    const r2 = await commandCase((ds) => ds.recordBlocker('isms:act:9.4', 'A.8.12', 'Waiting for the SoA'), () => {});
    expect(r2.res).toEqual({ ok: true, changed: [] });
    const ds = createSampleDataSource();
    expect((await ds.remind('isms:req:A.8.8', 'nobody')).error.status).toBe(404);
    expect((await ds.recordBlocker('isms:req:A.8.8', 'A.8.12', 'x')).error.status).toBe(422);
  });

  it('remindAll counts the distinct holders of the open chain items, as the page action did', async () => {
    const ds = createSampleDataSource();
    for (const id of ['isms', 'qms', 'bcms', 'abms']) {
      const legacy = legacyBundle(id, 'en', {}).chain.items;
      const res = await ds.remindAll(id);
      expect(res).toEqual({ ok: true, changed: [], count: new Set(legacy.map((i) => i.h).filter((h) => h !== 'none')).size });
    }
    expect((await ds.remindAll('isms')).count).toBe(8);
    expect((await ds.remindAll('nope')).error.status).toBe(404);
  });

  it('repositoryAction checks the repository actions and counts references on test', async () => {
    const ds = createSampleDataSource();
    const snap = await ds.load('ndt');
    const refs = (id) => snap.MS.flatMap((m) => snap.bundles[m.id].evs).filter((e) => e.loc === id).length;
    expect(await ds.repositoryAction('sp', 'test')).toEqual({ ok: true, changed: [], count: refs('sp') });
    expect(await ds.repositoryAction('gd', 'reauthorise')).toEqual({ ok: true, changed: [] });
    expect(await ds.repositoryAction('od', 'moveToLibrary')).toEqual({ ok: true, changed: [] });
    expect((await ds.repositoryAction('sp', 'reauthorise')).error.status).toBe(422);
    expect((await ds.repositoryAction('nope', 'test')).error.status).toBe(404);
  });

  it('pageAction changes nothing and counts the evidence for runCheck', async () => {
    const ds = createSampleDataSource();
    expect(await ds.pageAction('isms', 'runCheck')).toEqual({ ok: true, changed: [], count: 79 });
    for (const a of ['exportBoard', 'exportReadiness', 'exportSoa', 'exportDocs', 'evidencePack', 'auditorAccess', 'calendarFeed', 'checkUpdates', 'importBundle', 'verifyPhase']) {
      expect(await ds.pageAction('isms', a), a).toEqual({ ok: true, changed: [] });
    }
    expect((await ds.pageAction('isms', 'bogus')).error.status).toBe(422);
  });

  it('refuses keys outside the organisation and unknown kinds without storing anything', async () => {
    const ds = createSampleDataSource();
    await ds.switchOrg('rmn');
    expect((await ds.markComplete('qms:req:Cl. 8.4')).error.status).toBe(404);
    expect((await ds.markComplete('isms:bogus:A.8.8')).error.status).toBe(404);
    expect((await ds.markComplete('isms:doc:PRC-07')).error.status).toBe(422);
    expect((await ds.assign('', 'bagus', '2026-10-01')).error.status).toBe(404);
    await expectLegacy(ds, {}, 'ndt');
  });

  it('keeps overrides across organisations, as the controller store did (UI 5.18)', async () => {
    const ds = createSampleDataSource();
    await ds.markComplete('isms:req:A.8.8');
    const bsd = await ds.switchOrg('bsd');
    expect(req(bsd, 'isms', 'A.8.8').st).toBe('complete');
    expect((await ds.load()).MS.map((m) => m.id)).toEqual(['isms', 'qms']);
  });

  it('lists picker files with a reference per file', async () => {
    const listing = await createSampleDataSource().listPickerFiles('isms:ev:EV-0100', 'sp');
    expect(listing.path).toBe(SAMPLE.PICKER_FILES.sp.path);
    expect(listing.files).toEqual(SAMPLE.PICKER_FILES.sp.files);
    expect(listing.refs).toHaveLength(SAMPLE.PICKER_FILES.sp.files.length);
    expect(listing.refs[0]).toEqual({ repositoryId: 'sp', externalItemId: 'picker-sp-1', externalVersionId: 'v3.0' });
    await expect(createSampleDataSource().listPickerFiles('isms:ev:EV-0100', 'zz')).rejects.toThrow();
  });

  it('settles a command and its reload without waiting for a timer or I/O', async () => {
    const ds = createSampleDataSource();
    const snap = await ds.load('ndt');
    let done = false;
    ds.markComplete('isms:req:A.8.8').then((r) => ds.reload(snap, r.changed)).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toBe(true);
  });

  it('has the session methods of H.2', async () => {
    const ds = createSampleDataSource();
    expect(ds.kind).toBe('sample');
    await expect(ds.logout()).resolves.toBeUndefined();
    const off = ds.onUnauthenticated(() => { throw new Error('never called'); });
    expect(typeof off).toBe('function');
    off();
    await expect(ds.switchPersona('nobody')).rejects.toThrow(/unknown persona/);
    expect((await ds.switchPersona('top')).MS).toHaveLength(4);
  });
});

describe('modules', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('makeDates gives the old helpers for 20 dates', () => {
    const now = makeDates('2026-09-29');
    const dates = ['2024-02-29', '2024-09-01', '2024-12-31', '2025-01-01', '2025-03-10', '2025-03-30', '2025-10-26', '2026-01-31', '2026-02-28', '2026-03-29',
      '2026-06-30', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-25', '2026-11-12', '2026-12-31', '2027-02-10', '2028-02-29'];
    expect(now.TODAY_S).toBe(legacyDates.TODAY_S);
    for (const s of dates) {
      expect(now.P(s).getTime(), s).toBe(legacyDates.P(s).getTime());
      expect(now.dd(s), s).toBe(legacyDates.dd(s));
      expect(now.iso(now.P(s)), s).toBe(legacyDates.iso(legacyDates.P(s)));
      for (const n of [-400, -60, -1, 0, 1, 30, 365]) expect(now.addD(s, n), s + ' ' + n).toBe(legacyDates.addD(s, n));
      for (const l of [undefined, 'en', 'id']) expect(now.fmt(s, l), s + ' ' + l).toBe(legacyDates.fmt(s, l));
    }
    expect(now.fmt('')).toBe('-');
    expect(now.fmt(null, 'id')).toBe('-');
    // The sample module's helpers are the same functions of makeDates(TODAY_S).
    for (const s of dates) expect(SAMPLE.dd(s)).toBe(legacyDates.dd(s));
    expect(makeDates('2027-01-01').dd('2026-12-31')).toBe(-1);
    for (const bad of ['', '2026-9-29', '29-09-2026', '2026-13-01', null, 20260929]) expect(() => makeDates(bad), String(bad)).toThrow(TypeError);
  });

  it('mscd-data.js re-exports the static content it moved', () => {
    expect(SAMPLE.T).toBe(STATIC.T);
    expect(SAMPLE.TERA).toBe(STATIC.TERA);
    expect(SAMPLE.INTEG).toBe(STATIC.INTEG);
    for (const [kind, l] of Object.entries(SAMPLE.LOC)) {
      expect(l[1]).toBe(kind);
      expect([l[3], l[4]]).toEqual([STATIC.LOC_VISUALS[kind].color, STATIC.LOC_VISUALS[kind].icon]);
    }
    for (const [role, r] of Object.entries(SAMPLE.ROLES)) expect(r).toEqual({ who: ME[role], label: STATIC.ROLE_LABELS[role] });
  });

  it('data modules import only each other, so Node can load them', () => {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.js'));
    expect(files.sort()).toEqual(['SampleDataSource.js', 'createDataSource.js', 'dates.js', 'mscd-data.js', 'sample-derive.js', 'sample-orgs.js', 'static.js']);
    for (const f of files) {
      const src = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
      const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] || m[2]);
      for (const s of specs) expect(s, f).toMatch(/^\.\/[\w-]+(\/[\w-]+)*\.(js|ts)$/);
      expect(src, f).not.toMatch(/\b(window|localStorage|sessionStorage)\.|\bdocument\.\w+\(/);
    }
  });

  it('createDataSource loads the sample source unless the build selects the API source', async () => {
    const ds = await createDataSource();
    expect(ds.kind).toBe('sample');
    expect((await ds.load()).MS).toHaveLength(4);
    for (const value of ['sample', 'demo', '']) {
      vi.stubEnv('VITE_DATA_SOURCE', value);
      expect((await createDataSource()).kind, value).toBe('sample');
    }
    vi.stubEnv('VITE_DATA_SOURCE', 'api');
    await expect(createDataSource()).rejects.toThrow(/VITE_DATA_SOURCE=api is not available/);
  });
});
