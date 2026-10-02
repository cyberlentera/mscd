// Command parity (build plan J.4) for the WP-35 commands of UI section 3: Reassign and Change due date (`assign`) on
// a requirement, a SoA gate item, a document, an evidence item, an activity and an explicit chain record; Send
// reminder (`remind`); Remind all holders (`remindAll`); My Tasks Mark done on a chain record
// (`completeRecordAction`); and Start review of an expired document (`startReview`). Each command is applied to the
// web's `SampleDataSource` (imported from `apps/web/src/data`) and to the API on a fresh copy of the demo template,
// as `rina` (persona `manager`) in `ndt`; the touched record, its chain item and the navigation counts must match.
// Assign also runs on a preparation task, a cycle item and a drift row; completeRecordAction also runs on a stored task
// and a drift row (API mode only, see the test). File and implementation commands are covered by WP-21 and WP-20.
import path from 'node:path';
import type { CommandResult, UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { createApp, inOrg, RECORD_URL, sessionFor, type Client, type CommandsApp } from './helpers';

interface BundleLike {
  reqs: { id: string; st: string; owner: string; gate?: boolean }[];
  docs: { id: string; st: string; owner: string }[];
  evs: { code: string; owner: string; next: string | null }[];
  chain: { items: { key: string; st: string; h: string; due: string | null; kind: string; after: boolean; gate: boolean }[]; recs: Record<string, number> };
  gates: { id: string }[];
  phases: { no: number; acts: { no: string; st: string; owner: string; date: string | null }[] }[];
}

type SampleResult = CommandResult | { ok: false };

interface SampleSource {
  load(org?: string): Promise<{ bundles: Record<string, BundleLike> }>;
  assign(key: string, h: string, due: string | null): Promise<SampleResult>;
  remind(key: string, recipient: string): Promise<SampleResult>;
  remindAll(ms: string): Promise<SampleResult>;
  completeRecordAction(key: string): Promise<SampleResult>;
  startReview(key: string): Promise<SampleResult>;
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
    docs: histogram(b.docs.map((d) => d.st)),
    chainItems: b.chain.items.length,
    chainStatus: histogram(b.chain.items.map((i) => i.st)),
    after: b.chain.items.filter((i) => i.after).length,
    notPending: b.chain.items.filter((i) => i.st !== 'pending').length,
    gates: b.gates.length,
    recs: b.chain.recs,
  };
}

function chainItem(b: BundleLike, key: string) {
  const item = b.chain.items.find((i) => i.key === key);
  return item ? { st: item.st, h: item.h, due: item.due, after: item.after } : null;
}

describe('command parity with the sample source (J.4, WP-35 commands)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let sample: SampleSource;

  beforeAll(async () => {
    ctx = await createApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'ndt');
    const module = (await import(SAMPLE_SOURCE)) as { createSampleDataSource(o: { org: string; persona: string }): SampleSource };
    sample = module.createSampleDataSource({ org: 'ndt', persona: 'manager' });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function apiSnapshot(ms: string): Promise<UiMsSnapshot> {
    const r = await rina.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
    expect(r.status).toBe(200);
    return r.body;
  }

  async function both(ms: string): Promise<{ api: BundleLike; sample: BundleLike }> {
    const api = (await apiSnapshot(ms)).bundle as unknown as BundleLike;
    const snap = await sample.load('ndt');
    return { api, sample: snap.bundles[ms]! };
  }

  /** Applies `assign` to both sources and compares the chain item, the navigation counts and `changed`. */
  async function assignBoth(ms: string, key: string, entityType: string, kind: string, holder: string, due: string | null) {
    const ref = (await apiSnapshot(ms)).refs[key];
    expect(ref, key).toBeDefined();
    const api = await rina.post(RECORD_URL(ms, entityType, ref!.id, 'assignment'), { kind, holder, dueAt: due });
    const s = await sample.assign(key, holder, due);
    expect(api.status).toBe(200);
    expect(s.ok).toBe(true);
    expect(api.body.changed).toEqual((s as CommandResult).changed);
    const b = await both(ms);
    expect(chainItem(b.api, key)).toEqual(chainItem(b.sample, key));
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
    return b;
  }

  it('the two sources start equal on the compared values', async () => {
    for (const ms of ['isms', 'qms', 'bcms', 'abms']) {
      const { api, sample: s } = await both(ms);
      expect(navCounts(api)).toEqual(navCounts(s));
    }
  });

  it('remindAll counts the same holders', async () => {
    for (const ms of ['isms', 'qms']) {
      const api = await rina.post('/api/v1/reminders/bulk', { ms, scope: 'open_chain_items' });
      const s = (await sample.remindAll(ms)) as CommandResult;
      expect(api.status).toBe(200);
      expect(api.body.count).toBe(s.count);
      expect(api.body.changed).toEqual(s.changed);
    }
  });

  it('remind changes nothing on either side', async () => {
    const { api: before } = await both('isms');
    const item = before.chain.items.find((i) => i.kind === 'x' && i.h !== 'none')!;
    const api = await rina.post('/api/v1/reminders', { ms: 'isms', recordKey: item.key, recipient: 'sari' });
    const s = (await sample.remind(item.key, 'sari')) as CommandResult;
    expect(api.status).toBe(200);
    expect(api.body.changed).toEqual(s.changed);
    const b = await both('isms');
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
    expect(navCounts(b.api)).toEqual(navCounts(before));
  });

  it('assign on an explicit chain record (Reassign and Change due date)', async () => {
    const { api } = await both('isms');
    const item = api.chain.items.find((i) => i.kind === 'x' && !i.gate && i.h !== 'none')!;
    const tableOf = (await apiSnapshot('isms')).refs[item.key]!.entityType;
    await assignBoth('isms', item.key, tableOf, 'x', 'bagus', '2026-11-20');
    const b = await assignBoth('isms', item.key, tableOf, 'x', 'dewi', '2026-10-05');
    expect(chainItem(b.api, item.key)).toMatchObject({ h: 'dewi', due: '2026-10-05' });
  });

  it('assign on a requirement', async () => {
    const { api } = await both('isms');
    const req = api.reqs.find((r) => r.st === 'partial' && !r.gate)!;
    const b = await assignBoth('isms', `isms:req:${req.id}`, 'applicability_entry', 'req', 'yusuf', '2026-10-25');
    expect(b.api.reqs.find((r) => r.id === req.id)!.owner).toBe(b.sample.reqs.find((r) => r.id === req.id)!.owner);
  });

  it('assign on a SoA gate item', async () => {
    const { api } = await both('isms');
    const gate = api.chain.items.find((i) => i.kind === 'soa')!;
    await assignBoth('isms', gate.key, 'applicability_entry', 'soa', 'andi', '2026-10-19');
  });

  it('assign on a document under review and on evidence', async () => {
    const { api } = await both('isms');
    const doc = api.chain.items.find((i) => i.kind === 'doc')!;
    await assignBoth('isms', doc.key, 'document', 'doc', 'fajar', '2026-10-14');
    const ev = api.chain.items.find((i) => i.kind === 'ev')!;
    const b = await assignBoth('isms', ev.key, 'evidence', 'ev', 'andi', '2026-10-16');
    const code = ev.key.split(':')[2]!;
    const pick = (x: BundleLike) => x.evs.find((e) => e.code === code);
    expect({ owner: pick(b.api)!.owner, next: pick(b.api)!.next }).toEqual({ owner: pick(b.sample)!.owner, next: pick(b.sample)!.next });
  });

  it('assign on an activity', async () => {
    const { api } = await both('qms');
    const act = api.phases.flatMap((p) => p.acts).find((a) => a.st === 'progress')!;
    const key = `qms:act:${act.no}`;
    const ref = (await apiSnapshot('qms')).refs[key]!;
    const r = await rina.post(RECORD_URL('qms', 'implementation_activity_progress', ref.id, 'assignment'), { kind: 'act', holder: 'lina', dueAt: '2026-10-22' });
    const s = await sample.assign(key, 'lina', '2026-10-22');
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual((s as CommandResult).changed);
    const b = await both('qms');
    const pick = (x: BundleLike) => {
      const a = x.phases.flatMap((p) => p.acts).find((y) => y.no === act.no)!;
      return { st: a.st, owner: a.owner, date: a.date };
    };
    expect(pick(b.api)).toEqual(pick(b.sample));
    expect(pick(b.api)).toMatchObject({ owner: 'lina', date: '2026-10-22' });
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
  });

  it('completeRecordAction (My Tasks Mark done) removes the chain item on both sides', async () => {
    const { api } = await both('isms');
    const item = api.chain.items.find((i) => i.kind === 'x' && !i.gate)!;
    const ref = (await apiSnapshot('isms')).refs[item.key]!;
    const r = await rina.post(RECORD_URL('isms', ref.entityType, ref.id, 'complete-action'), {});
    const s = await sample.completeRecordAction(item.key);
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual((s as CommandResult).changed);
    const b = await both('isms');
    expect(chainItem(b.api, item.key)).toBeNull();
    expect(chainItem(b.sample, item.key)).toBeNull();
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
  });

  it('startReview on an expired document', async () => {
    const { api } = await both('isms');
    const doc = api.docs.find((d) => d.st === 'expired')!;
    const key = `isms:doc:${doc.id}`;
    const ref = (await apiSnapshot('isms')).refs[key]!;
    const r = await rina.post(`/api/v1/ms/isms/documents/${ref.id}/transitions`, { to: 'in_review' });
    const s = await sample.startReview(key);
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual((s as CommandResult).changed);
    const b = await both('isms');
    const pick = (x: BundleLike) => x.docs.find((d) => d.id === doc.id)!.st;
    expect(pick(b.api)).toBe('review');
    expect(pick(b.sample)).toBe('review');
    expect(chainItem(b.api, key)).toEqual(chainItem(b.sample, key));
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
  });

  it('assign on a preparation task, a cycle item and a drift row', async () => {
    const s = await apiSnapshot('isms');
    const keyOf = (prefix: string, code: string) => Object.keys(s.refs).find((k) => k.startsWith(prefix) && s.refs[k]!.code === code)!;
    const prepKey = keyOf('isms:prep:', 'Approve SoA v3.0');
    const cycleKey = keyOf('isms:cycle:', '9.1');
    const driftKey = keyOf('isms:drift:', 'R-009');
    // The sample keeps these assignments as overrides of the record key without changing its static PREP,
    // CYCLE_ITEMS and DRIFT lists, so parity covers the command result, the chain and the navigation counts.
    await assignBoth('isms', prepKey, 'audit_prep_task', 'prep', 'bagus', '2026-11-01');
    await assignBoth('isms', cycleKey, 'cycle_requirement_status', 'cycle', 'maya', '2026-10-16');
    await assignBoth('isms', driftKey, 'drift_result', 'drift', 'andi', '2026-10-18');
  });

  // The two kinds below exist in API mode only (H.5 `completeRecordAction`): the sample has no stored tasks (kind
  // `task`, H.5 step 13) and no completion for drift rows, so it answers 404 and 422 and changes nothing. The API
  // completes them; the chain and the navigation counts stay equal on both sides.
  it('completeRecordAction on a stored task (POST /tasks/{id}/complete) and on a drift row', async () => {
    const { api: before } = await both('isms');
    const [task] = await inOrg(db, 'ndt', async (trx) => (await sql<{ id: string }>`
      insert into task (management_system_id, source_rule, entity_type, entity_id, entity_code, title_en, title_id, owner_user_id, due_at)
      select m.id, 'manual', 'document', gen_random_uuid(), 'PRC-07', 'Review PRC-07', 'Tinjau PRC-07', u.id, '2026-10-05'::date
      from management_system m, platform.app_user u where m.slug = 'isms' and u.handle = 'rina' returning id`.execute(trx)).rows);
    const taskKey = `isms:task:${task!.id}`;
    const r = await rina.post(`/api/v1/tasks/${task!.id}/complete`, {});
    const s = await sample.completeRecordAction(taskKey);
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['isms']);
    expect(s.ok).toBe(false);
    let b = await both('isms');
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
    expect(navCounts(b.api)).toEqual(navCounts(before));

    const refs = (await apiSnapshot('isms')).refs;
    const driftKey = Object.keys(refs).find((k) => k.startsWith('isms:drift:') && refs[k]!.code === 'R-011')!;
    const d = await rina.post(RECORD_URL('isms', 'drift_result', refs[driftKey]!.id, 'complete-action'), {});
    const sd = await sample.completeRecordAction(driftKey);
    expect(d.status).toBe(200);
    expect(sd.ok).toBe(false);
    b = await both('isms');
    expect(chainItem(b.api, driftKey)).toEqual(chainItem(b.sample, driftKey));
    expect(navCounts(b.api)).toEqual(navCounts(b.sample));
    expect((await apiSnapshot('isms')).refs[driftKey]).toBeUndefined();
  });

  it('assign on a document review to Unassigned (holder none) matches the sample', async () => {
    const { api } = await both('isms');
    const doc = api.chain.items.find((i) => i.kind === 'doc' && i.h !== 'none')!;
    const b = await assignBoth('isms', doc.key, 'document', 'doc', 'none', '2026-10-21');
    expect(chainItem(b.api, doc.key)).toMatchObject({ h: 'none', due: '2026-10-21' });
  });
});
