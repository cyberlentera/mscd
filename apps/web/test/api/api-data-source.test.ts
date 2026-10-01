// ApiDataSource (BUILD-PLAN H.4) against a fake fetch: snapshot assembly and rehydration, every command mapping of
// the H.4 table, problem to error mapping, 401 handling, the organisation switch with reauth-required, the persona
// switch, and createDataSource in API mode.
import { describe, expect, it, vi } from 'vitest';
import { ApiLoadError, pickerFolder } from '../../src/data/api/ApiDataSource';
import { findRef, parseKey, rehydrateBundle } from '../../src/data/api/wire';
import { LOC_VISUALS } from '../../src/data/static.js';
import { problem } from '../auth/helpers';
import { json, meOf, readRoutes, sourceWith, uuidOf, wireOf } from './fixtures';
import type { Routes } from './fixtures';

type AnyRecord = Record<string, any>;
const CMD = (extra: AnyRecord = {}) => json({ ok: true, changed: ['isms'], ...extra });

async function loaded(extraRoutes: Routes = {}, me: AnyRecord = meOf()) {
  const fx = await wireOf();
  const routes = { ...readRoutes(fx, me), ...extraRoutes };
  const env = sourceWith(routes);
  const snap = (await env.ds.load()) as AnyRecord;
  env.calls.length = 0;
  return { ...env, fx, snap, me };
}

/** The one request of a command (after the load), with its body. */
function only(calls: AnyRecord[]) {
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('snapshot assembly', () => {
  it('reads /me, /ui/org, every system of the organisation and /tasks', async () => {
    const fx = await wireOf();
    const env = sourceWith(readRoutes(fx, meOf()));
    const snap = (await env.ds.load()) as AnyRecord;
    const paths = env.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.slice(0, 2)).toEqual(['GET /api/v1/me', 'GET /api/v1/ui/org']);
    expect(paths.slice(2).sort()).toEqual(['GET /api/v1/tasks', 'GET /api/v1/ui/ms/abms', 'GET /api/v1/ui/ms/bcms', 'GET /api/v1/ui/ms/isms', 'GET /api/v1/ui/ms/qms']);
    expect(env.calls.every((c) => c.credentials === 'same-origin')).toBe(true);
    expect(Object.keys(snap.bundles).sort()).toEqual(['abms', 'bcms', 'isms', 'qms']);
    expect(snap.today).toBe(fx.sample.today);
    expect(snap.me.org.slug).toBe('ndt');
    expect(snap.permissions).toEqual(fx.org.permissions);
    expect(snap.systems).toEqual(['isms', 'qms', 'bcms', 'abms']);
    expect(snap.demo).toBe(false);
    // Per-system keys are keyed by system, as in the sample snapshot.
    for (const key of ['X', 'EVENTS', 'FOCUS', 'PREP', 'PAST', 'CYCLE_ITEMS', 'DRIFT']) expect(snap[key]).toEqual(fx.sample[key]);
    // Only stored tasks are kept: chain items of My Tasks come from the bundles (D-29).
    expect(snap.tasks.map((t: AnyRecord) => t.kind)).toEqual(['task']);
  });

  it('adds the colour and icon of the repository kind to every LOC entry', async () => {
    const { snap, fx } = await loaded();
    for (const [slug, entry] of Object.entries(fx.org.LOC as Record<string, string[]>)) {
      const v = (LOC_VISUALS as AnyRecord)[entry[1]];
      expect(snap.LOC[slug]).toEqual([...entry, v.color, v.icon]);
    }
  });

  it('rehydrates refKey and docId to the objects of the same bundle and equals the sample bundles', async () => {
    const { snap, fx } = await loaded();
    for (const ms of Object.keys(fx.ms)) {
      const b = snap.bundles[ms];
      let refs = 0;
      for (const it of b.chain.items) {
        if (!it.refKey) continue;
        refs += 1;
        const pool = it.kind === 'ev' ? b.evs : it.kind === 'doc' ? b.docs : b.reqs;
        expect(pool.includes(it.ref)).toBe(true);
        expect(it.ref.st ?? it.ref.fresh).toBeDefined();
      }
      if (ms === 'isms') expect(refs).toBeGreaterThan(0);
      for (const p of b.phases) for (const a of p.acts) {
        if (a.docId) expect(b.docs.includes(a.doc)).toBe(true);
        else expect(a.doc).toBeNull();
      }
      // Without the wire-only keys the rehydrated bundle is the sample bundle.
      const strip = (x: AnyRecord) => ({
        ...x,
        chain: { ...x.chain, items: x.chain.items.map(({ refKey, ...i }: AnyRecord) => i) },
        phases: x.phases.map((p: AnyRecord) => ({ ...p, acts: p.acts.map(({ docId, ...a }: AnyRecord) => a) })),
      });
      const sample = fx.sample.bundles[ms];
      // The sample leaves `doc` out for an activity without an output document; the API source sets null.
      const expected = { ...sample, phases: sample.phases.map((p: AnyRecord) => ({ ...p, acts: p.acts.map((a: AnyRecord) => ({ ...a, doc: a.doc ?? null })) })) };
      expect(strip(b)).toEqual(expected);
    }
  });

  it('leaves ref undefined for a refKey outside the bundle (a record out of scope)', () => {
    const b = rehydrateBundle({ reqs: [], docs: [], evs: [], chain: { items: [{ key: 'isms:req:A.5.1', kind: 'req', refKey: 'isms:req:A.5.1' }], recs: {} }, gates: [], phases: [] } as never);
    expect(b.chain.items[0].ref).toBeUndefined();
  });

  it('keeps refs by RecordKey and finds prep, cycle and drift refs by code', async () => {
    const { snap, fx } = await loaded();
    expect(snap.refs['isms:req:A.8.13']).toEqual(fx.ms.isms.refs['isms:req:A.8.13']);
    const drift = Object.entries(fx.ms.isms.refs as Record<string, AnyRecord>).find(([k]) => k.startsWith('isms:drift:'));
    if (drift) {
      expect(findRef(snap.refs, `isms:drift:${drift[1].code}`)).toEqual(drift[1]);
      // A drift row shown as an explicit record of the timeline.
      expect(findRef(snap.refs, `isms:x:${drift[1].code}`)?.id).toBeDefined();
    }
    expect(findRef(snap.refs, 'isms:prep:does-not-exist')).toBeNull();
    expect(parseKey('isms:req:Cl. 4:1')).toEqual({ ms: 'isms', kind: 'req', id: 'Cl. 4:1' });
  });

  it('reload fetches /ui/org, the changed systems and /tasks, and keeps the other bundles', async () => {
    const { ds, calls, snap } = await loaded();
    const next = (await ds.reload(snap as never, ['qms'])) as AnyRecord;
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/v1/tasks', '/api/v1/ui/ms/qms', '/api/v1/ui/org']);
    expect(next.bundles.isms).toBe(snap.bundles.isms);
    expect(next.bundles.qms).not.toBe(snap.bundles.qms);
    expect(next.bundles.qms).toEqual(snap.bundles.qms);
    expect(next.me).toBe(snap.me);
  });

  it('rejects a load that fails with ApiLoadError carrying the api message', async () => {
    const fx = await wireOf();
    const env = sourceWith({ ...readRoutes(fx, meOf()), 'GET /api/v1/ui/ms/qms': problem(503, 'dependency-unavailable', { messages: { en: 'Database busy', id: 'Basis data sibuk' } }) });
    const e = await env.ds.load().catch((x) => x);
    expect(e).toBeInstanceOf(ApiLoadError);
    expect(e.error.message).toEqual(['Database busy', 'Basis data sibuk']);
  });

  it('a non-demo user of the organisation acme with roles that differ per system', async () => {
    const fx = await wireOf();
    const acme = { id: uuidOf('org:acme'), slug: 'acme', name: 'PT Acme Industri' };
    const me = meOf({ org: acme, handle: 'joko', uiRoleByMs: { isms: 'manager', qms: 'owner' }, orgs: [{ id: 'acme', name: 'PT Acme Industri', ms: ['isms', 'qms'], deploy: 'onprem', sites: 1 }] });
    const org = {
      ...fx.org,
      orgs: me.orgs,
      MS: fx.org.MS.filter((m: AnyRecord) => ['isms', 'qms'].includes(m.id)),
      ROLES: { manager: { who: 'joko', label: ['MS Manager', 'Manajer SM'] }, owner: { who: 'joko', label: ['Domain Owner', 'Pemilik Domain'] } },
    };
    const routes = { ...readRoutes(fx, me), 'GET /api/v1/ui/org': json(org) };
    const env = sourceWith(routes);
    const snap = (await env.ds.load()) as AnyRecord;
    expect(snap.systems).toEqual(['isms', 'qms']);
    expect(Object.keys(snap.bundles).sort()).toEqual(['isms', 'qms']);
    expect(env.calls.some((c) => c.path === '/api/v1/ui/ms/bcms')).toBe(false);
    expect(snap.me.uiRoleByMs).toEqual({ isms: 'manager', qms: 'owner' });
    expect(snap.demo).toBe(false);
  });
});

describe('commands', () => {
  it('markComplete of a requirement and an activity', async () => {
    const { ds, calls, snap } = await loaded({ 'POST /api/v1/ms/isms/applicability/:id/transitions': CMD() });
    const id = snap.refs['isms:req:A.8.13'].id;
    const r = await ds.markComplete('isms:req:A.8.13');
    const req = only(calls);
    expect(req.path).toBe(`/api/v1/ms/isms/applicability/${id}/transitions`);
    expect(req.body).toEqual({ to: 'complete' });
    expect(req.headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(r.ok).toBe(true);
    calls.length = 0;
    const act = snap.bundles.isms.phases[0].acts[0];
    await ds.markComplete(act.key);
    expect(only(calls).path).toBe(`/api/v1/ms/isms/activities/${snap.refs[act.key].id}/transitions`);
    expect(calls[0].body).toEqual({ to: 'complete' });
  });

  it('verify sends implemented for a requirement and verified for an activity, and refuses the wrong target', async () => {
    const { ds, calls, snap } = await loaded();
    await ds.verify('isms:req:A.8.13', 'implemented');
    expect(only(calls).body).toEqual({ to: 'implemented' });
    calls.length = 0;
    const act = snap.bundles.isms.phases[0].acts[0];
    await ds.verify(act.key, 'verified');
    expect(only(calls).body).toEqual({ to: 'verified' });
    calls.length = 0;
    const r = await ds.verify('isms:req:A.8.13', 'verified');
    expect(r.ok).toBe(false);
    expect(r.error?.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('assign sends the kind of the key, the holder, the due date and If-Match for every kind', async () => {
    const { ds, calls, snap } = await loaded();
    const keys = Object.keys(snap.refs);
    const pick = (kind: string) => keys.find((k) => k.startsWith(`isms:${kind}:`))!;
    for (const kind of ['req', 'soa', 'doc', 'ev', 'act', 'x', 'prep', 'cycle', 'drift']) {
      const key = pick(kind);
      if (!key) continue;
      calls.length = 0;
      const ref = snap.refs[key];
      const r = await ds.assign(key, 'bagus', '2026-10-20');
      expect(r.ok, kind).toBe(true);
      const req = only(calls);
      expect(req.path).toBe(`/api/v1/ms/isms/records/${ref.entityType}/${ref.id}/assignment`);
      expect(req.body).toEqual({ kind, holder: 'bagus', dueAt: '2026-10-20' });
      expect(req.headers['if-match']).toBe(ref.etag);
    }
    calls.length = 0;
    await ds.assign(pick('x'), 'none', null);
    expect(calls[0].body).toEqual({ kind: 'x', holder: 'none', dueAt: null });
  });

  it('remind sends the system, the record ref and the recipient; remindAll the bulk scope; counts are kept', async () => {
    const { ds, calls, snap } = await loaded({ 'POST /api/v1/reminders': json({ ok: true, changed: [], count: 1 }), 'POST /api/v1/reminders/bulk': json({ ok: true, changed: [], count: 8, data: { skipped: [] } }) });
    await ds.remind('isms:doc:POL-01', 'rina');
    const ref = snap.refs['isms:doc:POL-01'];
    expect(only(calls).body).toEqual({ ms: 'isms', ref: { module: ref.module, entityType: ref.entityType, id: ref.id, code: 'POL-01' }, recipient: 'rina' });
    calls.length = 0;
    await ds.remind('isms:x:UNKNOWN-1', 'rina');
    expect(only(calls).body).toEqual({ ms: 'isms', recordKey: 'isms:x:UNKNOWN-1', recipient: 'rina' });
    calls.length = 0;
    const all = await ds.remindAll('isms');
    expect(only(calls).body).toEqual({ ms: 'isms', scope: 'open_chain_items' });
    expect(all.count).toBe(8);
  });

  it('completeRecordAction: a stored task, an explicit record and a drift row; never a SoA item', async () => {
    const { ds, calls, snap } = await loaded();
    const task = snap.tasks[0];
    await ds.completeRecordAction(task.key);
    expect(only(calls).path).toBe(`/api/v1/tasks/${task.id}/complete`);
    expect(calls[0].body).toEqual({});
    calls.length = 0;
    const xKey = Object.keys(snap.refs).find((k) => k.startsWith('isms:x:'))!;
    await ds.completeRecordAction(xKey);
    expect(only(calls).path).toBe(`/api/v1/ms/isms/records/risk/${snap.refs[xKey].id}/complete-action`);
    calls.length = 0;
    const dKey = Object.keys(snap.refs).find((k) => k.startsWith('isms:drift:'));
    if (dKey) {
      await ds.completeRecordAction(`isms:drift:${snap.refs[dKey].code}`);
      expect(only(calls).path).toBe(`/api/v1/ms/isms/records/drift_result/${snap.refs[dKey].id}/complete-action`);
      calls.length = 0;
    }
    const soa = await ds.completeRecordAction('isms:soa:A.8.13');
    expect(soa.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('startReview and recordBlocker', async () => {
    const { ds, calls, snap } = await loaded();
    await ds.startReview('isms:doc:POL-01');
    expect(only(calls)).toMatchObject({ path: `/api/v1/ms/isms/documents/${snap.refs['isms:doc:POL-01'].id}/transitions`, body: { to: 'in_review' } });
    calls.length = 0;
    const act = snap.bundles.isms.phases[0].acts[0];
    await ds.recordBlocker(act.key, 'A.8.12', 'Blocked by gate item A.8.12');
    expect(only(calls).body).toEqual({ to: 'blocked', blockerGateItemRef: 'A.8.12', blockerReason: 'Blocked by gate item A.8.12' });
  });

  it('listPickerFiles opens the system root when the period folder does not exist', async () => {
    const listing = { path: 'Compliance / ISMS', files: [], refs: [] };
    const { ds, calls } = await loaded({
      'GET /api/v1/storage/repositories/sp/browse': (req) => (new URL(req.url, 'http://x').searchParams.has('path') ? problem(404, 'not-found') : json(listing)),
    });
    const got = await ds.listPickerFiles('isms:doc:POL-01', 'sp');
    expect(calls).toHaveLength(2);
    expect(got).toEqual(listing);
  });

  it('listPickerFiles browses the default repository of the system for the record', async () => {
    const listing = { path: 'Compliance / ISMS / Evidence', files: [['Backup.xlsx', '28 Sep 2026', 'v3.0', 'quickXorHash', 'Bagus Prasetyo']], refs: [{ repositoryId: 'sp', externalItemId: 'demo-sp-picker-1', externalVersionId: '3.0' }] };
    const { ds, calls, snap } = await loaded({ 'GET /api/v1/storage/repositories/sp/browse': json(listing) });
    const ev = snap.bundles.isms.evs[0];
    const got = await ds.listPickerFiles(`isms:ev:${ev.code}`, 'sp');
    const req = only(calls);
    const q = new URL(req.url, 'http://x').searchParams;
    expect(req.path).toBe(`/api/v1/storage/repositories/${snap.MS.find((m: AnyRecord) => m.id === 'isms').loc}/browse`);
    // The folder of the current quarter below the system root (where uploads go too).
    expect(Object.fromEntries(q)).toEqual({ ms: 'isms', kind: 'evidence', recordId: snap.refs[`isms:ev:${ev.code}`].id, path: 'Evidence/2026/Q3' });
    expect(got).toEqual(listing);
    calls.length = 0;
    await ds.listPickerFiles('isms:doc:POL-01', 'sp');
    expect(new URL(calls[0].url, 'http://x').searchParams.get('path')).toBe('Documents');
    expect(pickerFolder('ev', '2027-01-05')).toBe('Evidence/2027/Q1');
    expect(pickerFolder('ev', undefined)).toBe('Evidence');
    await expect(ds.listPickerFiles('isms:req:A.8.13', 'sp')).rejects.toBeInstanceOf(ApiLoadError);
  });

  it('linkFile: evidence with submit or relink and the organisation date; a document version', async () => {
    const { ds, calls, snap } = await loaded();
    const evs = snap.bundles.isms.evs as AnyRecord[];
    const good = evs.find((e) => ['ok', 'nohash', 'pending'].includes(e.integ))!;
    const bad = evs.find((e) => !['ok', 'nohash', 'pending'].includes(e.integ))!;
    const file = { src: 'sp', index: 0, ref: { repositoryId: 'sp', externalItemId: 'demo-sp-picker-1', externalVersionId: '3.0' } };
    await ds.linkFile(`isms:ev:${good.code}`, file);
    expect(only(calls)).toMatchObject({ path: `/api/v1/ms/isms/evidence/${snap.refs[`isms:ev:${good.code}`].id}/files`, body: { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', producedAt: snap.today, mode: 'submit' } });
    calls.length = 0;
    await ds.linkFile(`isms:ev:${bad.code}`, file);
    expect(only(calls).body.mode).toBe('relink');
    calls.length = 0;
    await ds.linkFile('isms:doc:POL-01', file);
    expect(only(calls)).toMatchObject({ path: `/api/v1/ms/isms/documents/${snap.refs['isms:doc:POL-01'].id}/versions`, body: { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1' } });
    calls.length = 0;
    const noRef = await ds.linkFile('isms:doc:POL-01', { src: 'sp', index: 0 });
    expect(noRef.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uploadFile: upload intent, the raw content to contentUrl, then the evidence file or document version', async () => {
    const intentId = uuidOf('intent');
    const intent = { intentId, mode: 'stored', repository: { slug: 'vault', name: 'Managed Vault', adapter: 'managed_vault' }, contentUrl: `/api/v1/storage/upload-intents/${intentId}/content`, maxBytes: 1000, expiresAt: '2026-09-29T07:00:00Z', correlationCode: 'MSCD-1', folderPath: '/vault' };
    const { ds, calls, snap } = await loaded({
      'POST /api/v1/storage/upload-intents': json(intent, 201),
      [`PUT /api/v1/storage/upload-intents/${intentId}/content`]: json({ storageObjectId: uuidOf('obj'), hashAlgorithm: 'sha256', hashValue: 'ab', sizeBytes: 5, versionLabel: 'v2' }),
    });
    const ev = snap.bundles.isms.evs[0];
    const file = new File(['hello'], 'Report.pdf', { type: 'application/pdf' });
    const progress: (number | null)[] = [];
    ds.onProgress((p) => progress.push(p));
    const r = await ds.uploadFile(`isms:ev:${ev.code}`, file);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/storage/upload-intents', `PUT /api/v1/storage/upload-intents/${intentId}/content`, `POST /api/v1/ms/isms/evidence/${snap.refs[`isms:ev:${ev.code}`].id}/files`,
    ]);
    expect(calls[0].body).toEqual({ ms: 'isms', kind: 'evidence', recordId: snap.refs[`isms:ev:${ev.code}`].id, fileName: 'Report.pdf', size: 5 });
    expect(calls[1].body).toBe(file);
    expect(calls[1].headers['content-type']).toBe('application/octet-stream');
    expect(calls[1].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(calls[2].body).toMatchObject({ source: 'upload', uploadIntentId: intentId, producedAt: snap.today });
    expect(progress).toEqual([0, null]);
    calls.length = 0;
    await ds.uploadFile('isms:doc:POL-01', file);
    expect(calls[2]).toMatchObject({ path: `/api/v1/ms/isms/documents/${snap.refs['isms:doc:POL-01'].id}/versions`, body: { source: 'upload', uploadIntentId: intentId } });
    calls.length = 0;
    expect((await ds.uploadFile('isms:doc:POL-01', null)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uploadFile stops when the intent fails or has no content address', async () => {
    const { ds, calls, routes } = await loaded({ 'POST /api/v1/storage/upload-intents': problem(422, 'business-rule', { rule: 'BR-29', messages: { en: 'File type not allowed', id: 'Jenis berkas tidak diizinkan' } }) });
    const r = await ds.uploadFile('isms:doc:POL-01', new File(['x'], 'a.exe'));
    expect(r).toMatchObject({ ok: false, error: { status: 422, rule: 'BR-29', message: ['File type not allowed', 'Jenis berkas tidak diizinkan'] } });
    expect(calls).toHaveLength(1);
    routes['POST /api/v1/storage/upload-intents'] = json({ intentId: uuidOf('i2'), mode: 'zero_transit', repository: { slug: 'gd', name: 'Google', adapter: 'google_drive' }, maxBytes: 1, expiresAt: '2026-09-29T07:00:00Z', correlationCode: 'c', folderPath: '/' }, 201);
    calls.length = 0;
    const z = await ds.uploadFile('isms:doc:POL-01', new File(['x'], 'a.pdf'));
    expect(z.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('repositoryAction uses the repository uuid: test, reauthorise (follows redirectUrl) and moveToLibrary', async () => {
    const { ds, calls, snap, navigated } = await loaded({ 'POST /api/v1/admin/storage/repositories/:id/reauthorize': json({ ok: true, changed: [], redirectUrl: 'https://accounts.example/consent' }) });
    const repo = snap.REPOS[0];
    await ds.repositoryAction(repo.id, 'test');
    expect(only(calls).path).toBe(`/api/v1/admin/storage/repositories/${repo.ref}/test`);
    const gd = snap.REPOS.find((r: AnyRecord) => (r.actions ?? []).includes('reauthorise'));
    if (gd) {
      calls.length = 0;
      const env2 = await loaded({ [`POST /api/v1/admin/storage/repositories/${gd.ref}/reauthorize`]: json({ ok: true, changed: [], redirectUrl: 'https://accounts.example/consent' }) });
      await env2.ds.repositoryAction(gd.id, 'reauthorise');
      expect(env2.navigated).toEqual(['https://accounts.example/consent']);
    }
    const od = snap.REPOS.find((r: AnyRecord) => (r.actions ?? []).includes('moveToLibrary'));
    if (od) {
      calls.length = 0;
      await ds.repositoryAction(od.id, 'moveToLibrary', 'isms');
      expect(only(calls)).toMatchObject({ path: `/api/v1/admin/storage/repositories/${od.ref}/move-requests`, body: { ms: 'isms' } });
    }
    calls.length = 0;
    expect((await ds.repositoryAction('nope', 'test')).ok).toBe(false);
    expect((await ds.repositoryAction(repo.id, 'moveToLibrary' as never)).ok).toBe(repo.actions.includes('moveToLibrary') ? true : false);
    expect(navigated).toEqual([]);
  });

  it('pageAction maps every action of H.4', async () => {
    const taskId = uuidOf('export');
    const { ds, calls, navigated } = await loaded({
      'POST /api/v1/exports': json({ ok: true, changed: [], taskId }, 202),
      [`GET /api/v1/exports/${taskId}`]: [json({ id: taskId, kind: 'export', status: 'running', progress: 50 }), json({ id: taskId, kind: 'export', status: 'succeeded', progress: 100, downloadUrl: `/api/v1/exports/${taskId}/download` })],
      'POST /api/v1/ms/isms/evidence-packs': json({ ok: true, changed: ['isms'], message: ['Evidence pack is being compiled in SharePoint', 'Evidence pack sedang disusun di SharePoint'] }, 202),
      'POST /api/v1/ms/isms/auditor-access': json({ ok: true, changed: ['isms'], data: { grantId: uuidOf('g'), expiresAt: '2026-10-13T06:00:00Z' } }, 201),
      'POST /api/v1/ms/isms/link-health/run': json({ ok: true, changed: [], count: 42, taskId }, 202),
      'POST /api/v1/ms/isms/calendar-feed': json({ ok: true, changed: [], downloadUrl: '/api/v1/ms/isms/surveillance/reviews.ics?token=Q2FsZW5kYXItVG9rZW4tMDEyMzQ1Njc4OWFiY2RlZg' }),
      'POST /api/v1/admin/packs/check-updates': json({ ok: true, changed: [], message: ['2 updates available', '2 pembaruan tersedia'] }),
      'POST /api/v1/admin/packs/import': json({ ok: true, changed: [], taskId }, 202),
      'POST /api/v1/ms/isms/phases/4/verify': json({ ok: true, changed: [], message: ['Phase 4 is already verified', 'Fase 4 sudah terverifikasi'] }),
    });
    const board = await ds.pageAction('isms', 'exportBoard');
    expect(calls[0].body).toEqual({ type: 'portfolio_board', format: 'pdf' });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET']);
    expect(board.downloadUrl).toBe(`/api/v1/exports/${taskId}/download`);
    expect(navigated).toEqual([`/api/v1/exports/${taskId}/download`]);
    calls.length = 0;
    await ds.pageAction('isms', 'exportReadiness');
    expect(calls[0].body).toEqual({ type: 'readiness', ms: 'isms', format: 'pdf' });
    calls.length = 0;
    navigated.length = 0;
    await ds.pageAction('isms', 'exportSoa');
    await ds.pageAction('isms', 'exportDocs');
    expect(calls).toHaveLength(0);
    expect(navigated).toEqual(['/api/v1/ms/isms/applicability/export?format=xlsx', '/api/v1/ms/isms/documents/export?format=xlsx']);
    const pack = await ds.pageAction('isms', 'evidencePack');
    expect(pack.message).toEqual(['Evidence pack is being compiled in SharePoint', 'Evidence pack sedang disusun di SharePoint']);
    expect(only(calls).body).toEqual({});
    calls.length = 0;
    expect((await ds.pageAction('isms', 'auditorAccess')).ok).toBe(false);
    expect(calls).toHaveLength(0);
    await ds.pageAction('isms', 'auditorAccess', ' lead.auditor@certifier.co.id ');
    expect(only(calls).body).toEqual({ email: 'lead.auditor@certifier.co.id' });
    calls.length = 0;
    expect((await ds.pageAction('isms', 'runCheck')).count).toBe(42);
    expect(only(calls).path).toBe('/api/v1/ms/isms/link-health/run');
    calls.length = 0;
    expect((await ds.pageAction('isms', 'calendarFeed')).downloadUrl).toContain('/reviews.ics?token=');
    calls.length = 0;
    expect((await ds.pageAction('isms', 'checkUpdates')).message).toEqual(['2 updates available', '2 pembaruan tersedia']);
    calls.length = 0;
    const bundle = new File([new Uint8Array([0x1f, 0x8b])], 'ISO9001-2026-1.0.0.pack');
    await ds.pageAction('isms', 'importBundle', bundle);
    const imp = only(calls);
    expect(imp.body).toBeInstanceOf(FormData);
    expect((imp.body as FormData).get('bundle')).toBeInstanceOf(Blob);
    calls.length = 0;
    expect((await ds.pageAction('isms', 'verifyPhase', 4)).message).toEqual(['Phase 4 is already verified', 'Fase 4 sudah terverifikasi']);
    expect(only(calls).path).toBe('/api/v1/ms/isms/phases/4/verify');
    calls.length = 0;
    expect((await ds.pageAction('isms', 'verifyPhase')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('an export still running after the polls answers queued', async () => {
    const taskId = uuidOf('slow');
    const { ds, navigated } = await loaded({
      'POST /api/v1/exports': json({ ok: true, changed: [], taskId }, 202),
      [`GET /api/v1/exports/${taskId}`]: json({ id: taskId, kind: 'export', status: 'queued', progress: 0 }),
    });
    const r = await ds.pageAction('isms', 'exportReadiness');
    expect(r.ok).toBe(true);
    expect(r.message?.[0]).toMatch(/queued/);
    expect(navigated).toEqual([]);
  });
});

describe('errors and session', () => {
  it('maps a problem to the error of the result: messages, then the title; warnings to pairs', async () => {
    const { ds, routes } = await loaded({
      'POST /api/v1/ms/isms/applicability/:id/transitions': problem(422, 'business-rule', { rule: 'BR-01', messages: { en: 'No valid evidence in the current period', id: 'Tidak ada bukti valid pada periode berjalan' } }),
    });
    const id = (await ds.snapshot)!.refs['isms:req:A.8.13'].id;
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = problem(422, 'business-rule', { rule: 'BR-01', messages: { en: 'No valid evidence in the current period', id: 'Tidak ada bukti valid pada periode berjalan' } });
    const r = await ds.markComplete('isms:req:A.8.13');
    expect(r).toEqual({ ok: false, changed: [], error: { status: 422, rule: 'BR-01', message: ['No valid evidence in the current period', 'Tidak ada bukti valid pada periode berjalan'] } });
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = problem(412, 'precondition-failed');
    expect((await ds.markComplete('isms:req:A.8.13')).error).toEqual({ status: 412, message: ['Title of precondition-failed', 'Title of precondition-failed'] });
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = json({ ok: true, changed: ['isms'], warnings: [{ rule: 'BR-41', messages: { en: 'Holder has 12 open items', id: 'Pemegang memiliki 12 item terbuka' } }] });
    expect((await ds.markComplete('isms:req:A.8.13')).warnings).toEqual([{ rule: 'BR-41', message: ['Holder has 12 open items', 'Pemegang memiliki 12 item terbuka'] }]);
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = 'network-error';
    expect((await ds.markComplete('isms:req:A.8.13')).error).toEqual({ status: 0, message: ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'] });
  });

  it('a 401 of a command tells the onUnauthenticated listeners and answers ok false', async () => {
    const { ds, routes, snap } = await loaded();
    const id = snap.refs['isms:doc:POL-01'].id;
    routes[`POST /api/v1/ms/isms/documents/${id}/transitions`] = problem(401, 'unauthenticated');
    const listener = vi.fn();
    const off = ds.onUnauthenticated(listener);
    const r = await ds.startReview('isms:doc:POL-01');
    expect(r.ok).toBe(false);
    expect(r.error?.status).toBe(401);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await ds.startReview('isms:doc:POL-01');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a 401 while loading rejects and notifies', async () => {
    const fx = await wireOf();
    const env = sourceWith({ ...readRoutes(fx, meOf()), 'GET /api/v1/ui/org': problem(401, 'unauthenticated') });
    const listener = vi.fn();
    env.ds.onUnauthenticated(listener);
    await expect(env.ds.load()).rejects.toBeInstanceOf(ApiLoadError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('switchOrg: PUT /me/org then the new organisation; reauth-required rejects and reaches onReauthRequired', async () => {
    const fx = await wireOf();
    const me = meOf();
    const bsdMe = meOf({ org: { id: uuidOf('org:bsd'), slug: 'bsd', name: 'PT Bank Sejahtera' }, csrf: 'csrf-token-after-switch-000' });
    const { ds, calls, routes, client } = await loaded({ 'PUT /api/v1/me/org': json(bsdMe) }, me);
    routes['GET /api/v1/ui/org'] = json({ ...fx.org, orgs: bsdMe.orgs });
    const snap = (await ds.switchOrg('bsd')) as AnyRecord;
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/v1/me/org', body: { org: 'bsd' } });
    expect(calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(calls.slice(1).every((c) => c.method === 'GET')).toBe(true);
    expect(snap.me.org.slug).toBe('bsd');
    expect(client.csrfToken).toBe('csrf-token-after-switch-000');
    // The organisation needs another sign-in method (D-26).
    routes['PUT /api/v1/me/org'] = problem(409, 'reauth-required', { methods: { local: false, providers: [{ slug: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak' }] } });
    const reauth = vi.fn();
    client.onReauthRequired(reauth);
    calls.length = 0;
    const e = await ds.switchOrg('rmn').catch((x) => x);
    expect(e).toBeInstanceOf(ApiLoadError);
    expect(e.reauth).toBe(true);
    expect(reauth).toHaveBeenCalledWith({ methods: { local: false, providers: [{ slug: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak' }] }, org: 'rmn' });
    expect(calls).toHaveLength(1);
  });

  it('switchPersona posts the role, then loads as the new session user', async () => {
    const personas = { manager: { who: 'rina', label: ['MS Manager', 'Manajer SM'] }, owner: { who: 'bagus', label: ['Domain Owner', 'Pemilik Domain'] } };
    const bagus = meOf({ handle: 'bagus', personas, uiRoleByMs: { isms: 'owner', qms: 'owner', bcms: 'owner', abms: 'owner' } });
    const { ds, calls } = await loaded({ 'POST /api/v1/auth/demo/persona': json(bagus) }, meOf({ personas }));
    const snap = (await ds.switchPersona('owner')) as AnyRecord;
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/auth/demo/persona', body: { role: 'owner' } });
    expect(snap.me.user.handle).toBe('bagus');
    expect(snap.demo).toBe(true);
  });

  it('load with another organisation switches first; logout posts /auth/logout', async () => {
    const fx = await wireOf();
    const bsdMe = meOf({ org: { id: uuidOf('org:bsd'), slug: 'bsd', name: 'PT Bank Sejahtera' } });
    const env = sourceWith({ ...readRoutes(fx, meOf()), 'PUT /api/v1/me/org': json(bsdMe), 'POST /api/v1/auth/logout': { status: 204 } });
    await env.ds.load('bsd');
    expect(env.calls.map((c) => c.path).slice(0, 3)).toEqual(['/api/v1/me', '/api/v1/me/org', '/api/v1/ui/org']);
    env.calls.length = 0;
    const out = vi.fn();
    env.client.onSignedOut(out);
    await env.ds.logout();
    expect(env.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/auth/logout' });
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('setLanguage sets Accept-Language of later requests', async () => {
    const { ds, calls } = await loaded();
    ds.setLanguage('id');
    await ds.remindAll('isms');
    expect(calls[0].headers['accept-language']).toBe('id');
  });
});

describe('createDataSource in API mode', () => {
  it('loads the API source with the boot router client, and refuses a call without it', async () => {
    const { createDataSource } = await import('../../src/data/createDataSource.js');
    const { ApiClient } = await import('../../src/data/api/ApiClient');
    vi.stubEnv('VITE_DATA_SOURCE', 'api');
    try {
      const client = new ApiClient({ fetch: (async () => new Response(null, { status: 204 })) as typeof fetch });
      const ds = await createDataSource({ client, me: meOf(), profile: {} });
      expect(ds.kind).toBe('api');
      expect((ds as unknown as { client: unknown }).client).toBe(client);
      await expect(createDataSource()).rejects.toThrow(/boot router/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
