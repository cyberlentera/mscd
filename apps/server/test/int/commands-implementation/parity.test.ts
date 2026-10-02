// Command parity (build plan J.4) for the WP-20 commands of UI section 3: `markComplete` (requirement and activity),
// `verify` (requirement and activity) and `verifyPhase` are applied to the web's `SampleDataSource` and to the API
// on a fresh copy of the demo template, as `rina` (persona `manager`) in `ndt`. The touched record, its chain item
// and the navigation counts of the system must match afterwards. Known differences are listed with the decision
// that causes them and asserted on the API side: BR-01 rejects a verification without valid evidence of the current
// period (E.3), and the sample's verifyPhase never answers with a problem (the controller toasts instead).
import path from 'node:path';
import type { CommandResult, Phase, UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { activitiesWithStatus, ACTIVITY_URL, createCommandsApp, entriesWithStatus, ENTRY_URL, inOrg, sessionFor, type Client, type CommandsApp } from './helpers';

/** The parts of a bundle UI section 3 compares: one record, its chain item, and the counts the navigation shows. */
interface BundleLike {
  reqs: { id: string; st: string; owner: string; by?: string | null }[];
  chain: { items: { key: string; st: string; h: string; due: string | null; kind: string }[]; recs: Record<string, number> };
  gates: { id: string }[];
  phases: { no: number; c: Phase['c']; acts: { no: string; st: string; owner: string; by?: string | null }[] }[];
}

interface SampleSource {
  load(org?: string): Promise<{ bundles: Record<string, BundleLike> }>;
  markComplete(key: string): Promise<CommandResult | { ok: false }>;
  verify(key: string, to: string): Promise<CommandResult | { ok: false }>;
  pageAction(ms: string, action: string): Promise<CommandResult | { ok: false }>;
}

const SAMPLE_SOURCE = path.resolve(__dirname, '../../../../web/src/data/SampleDataSource.js');

function histogram(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Navigation counts of a system (UI 4.7 numbers the screens show). */
function navCounts(b: BundleLike) {
  return {
    reqs: histogram(b.reqs.map((r) => r.st)),
    chainItems: b.chain.items.length,
    chainStatus: histogram(b.chain.items.map((i) => i.st)),
    notPending: b.chain.items.filter((i) => i.st !== 'pending').length,
    gates: b.gates.length,
    phases: b.phases.map((p) => ({ no: p.no, c: p.c })),
  };
}

const person = (v: string | null | undefined) => (v ? v : null);

function reqRecord(b: BundleLike, id: string) {
  const r = b.reqs.find((x) => x.id === id)!;
  return { st: r.st, owner: r.owner, by: person(r.by) };
}

function actRecord(b: BundleLike, no: string) {
  const a = b.phases.flatMap((p) => p.acts).find((x) => x.no === no)!;
  return { st: a.st, owner: a.owner, by: person(a.by) };
}

function chainItem(b: BundleLike, key: string) {
  const item = b.chain.items.find((i) => i.key === key);
  return item ? { st: item.st, h: item.h, due: item.due } : null;
}

describe('command parity with the sample source (J.4)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let sample: SampleSource;

  beforeAll(async () => {
    ctx = await createCommandsApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'ndt');
    const module = (await import(SAMPLE_SOURCE)) as { createSampleDataSource(o: { org: string; persona: string }): SampleSource };
    sample = module.createSampleDataSource({ org: 'ndt', persona: 'manager' });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function both(ms: string): Promise<{ api: BundleLike; sample: BundleLike }> {
    const api = await rina.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
    expect(api.status).toBe(200);
    const snap = await sample.load('ndt');
    return { api: api.body.bundle as unknown as BundleLike, sample: snap.bundles[ms]! };
  }

  it('the two sources start equal on the compared values', async () => {
    for (const ms of ['isms', 'qms', 'bcms', 'abms']) {
      const { api, sample: s } = await both(ms);
      expect(navCounts(api)).toEqual(navCounts(s));
    }
  });

  it('markComplete on a requirement', async () => {
    const [entry] = await entriesWithStatus(db, 'ndt', 'isms', 'partially_implemented');
    const key = `isms:req:${entry!.code}`;
    const apiResult = await rina.post(`${ENTRY_URL('isms', entry!.id)}/transitions`, { to: 'complete' });
    const sampleResult = await sample.markComplete(key);
    expect(apiResult.status).toBe(200);
    expect(apiResult.body.changed).toEqual((sampleResult as CommandResult).changed);
    const { api, sample: s } = await both('isms');
    expect(reqRecord(api, entry!.code)).toEqual(reqRecord(s, entry!.code));
    expect(reqRecord(api, entry!.code)).toMatchObject({ st: 'complete', by: 'rina' });
    expect(chainItem(api, key)).toEqual(chainItem(s, key));
    expect(navCounts(api)).toEqual(navCounts(s));
  });

  it('markComplete on an activity', async () => {
    const candidates = await activitiesWithStatus(db, 'ndt', 'isms', 'in_progress');
    const act = candidates.find((a) => !a.out || a.docId)!;
    const key = `isms:act:${act.no}`;
    const apiResult = await rina.post(ACTIVITY_URL('isms', act.id), { to: 'complete' });
    const sampleResult = await sample.markComplete(key);
    expect(apiResult.status).toBe(200);
    expect(apiResult.body.changed).toEqual((sampleResult as CommandResult).changed);
    const { api, sample: s } = await both('isms');
    expect(actRecord(api, act.no)).toEqual(actRecord(s, act.no));
    expect(actRecord(api, act.no)).toMatchObject({ st: 'complete', by: 'rina' });
    expect(navCounts(api)).toEqual(navCounts(s));
  });

  it('verify on a requirement awaiting verification (Cl. 8.7 of the QMS)', async () => {
    const [entry] = await entriesWithStatus(db, 'ndt', 'qms', 'complete');
    const code = `Cl. ${entry!.code}`;
    const key = `qms:req:${code}`;
    const apiResult = await rina.post(`${ENTRY_URL('qms', entry!.id)}/transitions`, { to: 'implemented' });
    await sample.verify(key, 'implemented');
    expect(apiResult.status).toBe(200);
    const { api, sample: s } = await both('qms');
    expect(reqRecord(api, code)).toEqual(reqRecord(s, code));
    expect(reqRecord(api, code).st).toBe('implemented');
    expect(chainItem(api, key)).toEqual(chainItem(s, key));
    expect(navCounts(api)).toEqual(navCounts(s));
  });

  it('verify on a completed activity', async () => {
    const [act] = await activitiesWithStatus(db, 'ndt', 'qms', 'complete');
    const key = `qms:act:${act!.no}`;
    const apiResult = await rina.post(ACTIVITY_URL('qms', act!.id), { to: 'verified' });
    const sampleResult = await sample.verify(key, 'verified');
    expect(apiResult.status).toBe(200);
    expect(apiResult.body.changed).toEqual((sampleResult as CommandResult).changed);
    const { api, sample: s } = await both('qms');
    expect(actRecord(api, act!.no)).toEqual(actRecord(s, act!.no));
    expect(actRecord(api, act!.no).st).toBe('verified');
    expect(navCounts(api)).toEqual(navCounts(s));
  });

  it('verifyPhase on a verified phase and on a phase with open activities', async () => {
    const verified = await rina.post('/api/v1/ms/isms/phases/1/verify');
    const sampleResult = await sample.pageAction('isms', 'verifyPhase');
    expect(verified.status).toBe(200);
    expect(sampleResult.ok).toBe(true);
    // The sample changes nothing; the API changes no bundle either (the phase state is derived, D-13), and both
    // answer that the seeded phase is already verified.
    expect(verified.body.changed).toEqual([]);
    expect(verified.body.message).toEqual(['Phase 1 is already verified', 'Fase 1 sudah terverifikasi']);
    const again = await rina.post('/api/v1/ms/isms/phases/1/verify');
    // The sample controller's toast for a fully verified phase.
    expect(again.body.message).toEqual(['Phase 1 is already verified', 'Fase 1 sudah terverifikasi']);
    const open = await rina.post('/api/v1/ms/isms/phases/9/verify');
    expect(open.status).toBe(422);
    // The sample controller's toast for a phase with open activities.
    expect(open.body.messages).toEqual({ en: 'Phase verification needs all activities Verified', id: 'Verifikasi fase memerlukan semua aktivitas Terverifikasi' });
    for (const ms of ['isms', 'qms']) {
      const { api, sample: s } = await both(ms);
      expect(navCounts(api)).toEqual(navCounts(s));
    }
  });

  // Last, because the two sources differ afterwards.
  it('known difference: BR-01 rejects a verification the sample accepts (E.3)', async () => {
    const entry = (await entriesWithStatus(db, 'ndt', 'qms', 'partially_implemented')).find((e) => e.owner !== 'rina')!;
    await inOrg(db, 'ndt', (trx) => sql`
      update evidence set produced_at = date '2024-01-01', frequency_code = 'annual'
       where id in (select evidence_id from evidence_target where applicability_entry_id = ${entry.id})`.execute(trx));
    const code = `Cl. ${entry.code}`;
    const apiResult = await rina.post(`${ENTRY_URL('qms', entry.id)}/transitions`, { to: 'implemented' });
    await sample.verify(`qms:req:${code}`, 'implemented');
    expect(apiResult.status).toBe(422);
    expect(apiResult.body.rule).toBe('BR-01');
    const { api, sample: s } = await both('qms');
    expect(reqRecord(api, code).st).toBe('partial');
    expect(reqRecord(s, code).st).toBe('implemented');
  });
});
