// Scoping of the per-screen read endpoints (build plan D-04, F.7, D-34, WP-32): an ISMS Domain Owner (`bagus`) sees
// only own records on every endpoint and nothing of other systems; a QMS-only Domain Owner is refused on ISMS; Top
// Management gets pending data only as aggregates; an external auditor gets no holder names, no pending data and
// evidence only through ready packs; unknown systems are 404 and a missing session 401.
import {
  ActivityItem, ApplicabilityItem, ChainResponse, CycleItem, DocumentItem, DriftPattern, EvidenceItem, GateItemView, ImplementationSummary,
  PendingAggregate, PendingRecord, StageReadiness, SurveillanceEvent, pageOf,
  type UiMsSnapshot, type UiOrgSnapshot,
} from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { ORG_IDS, createScreenApp, screenClient, userId, type ReadModelApp, type ScreenClient } from './helpers';

/** Every RecordRef id found anywhere in a response body. */
function refIds(body: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(body)) for (const v of body) refIds(v, out);
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.module === 'string' && typeof o.entityType === 'string' && typeof o.id === 'string') out.add(o.id);
    for (const v of Object.values(o)) refIds(v, out);
  }
  return out;
}

describe('Per-screen read endpoints: scoping (D-04, F.7, D-34)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let rina: ScreenClient;
  let bagus: ScreenClient;
  let full: UiMsSnapshot;
  let org: UiOrgSnapshot;

  beforeAll(async () => {
    ctx = await createScreenApp(db);
    rina = await screenClient(ctx, db, 'rina', 'ndt');
    bagus = await screenClient(ctx, db, 'bagus', 'ndt');
    full = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    org = (await rina.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('gives an ISMS Domain Owner only own records on every endpoint', async () => {
    const isms = new Set(Object.values(full.refs).map((r) => r.id));
    const seen = new Set<string>();
    const collect = (body: unknown) => refIds(body, seen);

    const reqs = await bagus.all<ApplicabilityItem>('/api/v1/ms/isms/applicability');
    expect(reqs.total).toBeGreaterThan(0);
    expect(reqs.items.every((r) => r.owner === 'bagus')).toBe(true);
    expect(reqs.items.map((r) => r.id)).toEqual(full.bundle.reqs.filter((r) => r.owner === 'bagus').map((r) => r.id));
    collect(reqs.items);

    const docs = await bagus.all<DocumentItem>('/api/v1/ms/isms/documents');
    expect(docs.total).toBeGreaterThan(0);
    expect(docs.items.every((d) => d.owner === 'bagus')).toBe(true);
    const ownReqIds = new Set(reqs.items.map((r) => r.id));
    for (const d of docs.items) for (const code of d.requirements) expect(ownReqIds.has(code)).toBe(true);
    collect(docs.items);

    const evs = await bagus.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(evs.total).toBeGreaterThan(0);
    expect(evs.items.every((e) => e.owner === 'bagus')).toBe(true);
    expect(evs.items.map((e) => e.code)).toEqual(full.bundle.evs.filter((e) => e.owner === 'bagus').map((e) => e.code));
    collect(evs.items);

    const gates = (await bagus.get<GateItemView[]>('/api/v1/ms/isms/gates')).body;
    expect(gates.map((g) => g.id)).toEqual(full.bundle.gates.filter((g) => g.h === 'bagus').map((g) => g.id));
    collect(gates);

    for (const phase of full.bundle.phases) {
      const acts = (await bagus.get<ActivityItem[]>(`/api/v1/ms/isms/phases/${phase.no}/activities`)).body;
      expect(acts.map((a) => a.no)).toEqual(phase.acts.filter((a) => a.owner === 'bagus').map((a) => a.no));
      collect(acts);
    }

    const stages = (await bagus.get<StageReadiness[]>('/api/v1/ms/isms/audit/stages')).body;
    for (const stage of stages) {
      const records = await bagus.all<PendingRecord>(`/api/v1/ms/isms/audit/stages/${stage.key}/records`);
      for (const r of records.items) expect({ stage: stage.key, code: r.ref.code, holder: r.holder?.handle }).toEqual({ stage: stage.key, code: r.ref.code, holder: 'bagus' });
      expect(records.items.filter((r) => r.status !== 'ready')).toHaveLength(full.bundle.chain.items.filter((i) => i.stage === stage.key && i.h === 'bagus').length);
      collect(records.items);
    }

    const own = await bagus.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=bagus');
    const asManager = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=bagus');
    expect(own.total).toBe(full.bundle.chain.items.filter((i) => i.h === 'bagus').length);
    expect(own.items).toEqual(asManager.items);
    collect(own.items);

    // Chains: every node outside the owner's records is hidden; chains without an own record are 404.
    let shown = 0;
    for (const chain of org.CHAINS.isms ?? []) {
      const response = await bagus.get<ChainResponse>(`/api/v1/ms/isms/audit/chain?anchor_id=${encodeURIComponent(chain.id)}`);
      if (response.status === 404) continue;
      expect(response.status).toBe(200);
      shown += 1;
      for (const node of response.body.nodes) {
        if ('hidden' in node || node.id === null) continue;
        expect({ id: node.id, holder: node.holder }).toEqual({ id: node.id, holder: 'bagus' });
      }
      collect(response.body);
    }
    expect(shown).toBeGreaterThan(0);

    const cycle = (await bagus.get<CycleItem[]>('/api/v1/ms/isms/surveillance/cycle')).body;
    expect(cycle.every((c) => c.owner === 'bagus')).toBe(true);
    expect(cycle).toHaveLength(full.CYCLE_ITEMS.filter((row) => row[2] === 'bagus').length);
    collect(cycle);

    const drift = (await bagus.get<DriftPattern[]>('/api/v1/ms/isms/surveillance/drift')).body;
    expect(drift.length).toBeGreaterThan(0);
    for (const pattern of drift) for (const row of pattern.rows) expect(row.holder).toBe('bagus');
    collect(drift);

    const nextId = (await bagus.get<{ id: string }>('/api/v1/ms/isms/audit/event/next')).body.id;
    const event = (await bagus.get<SurveillanceEvent>(`/api/v1/ms/isms/surveillance/events/${nextId}`)).body;
    expect(event.prep.every((p) => p.owner === 'bagus')).toBe(true);
    expect(event.prep).toHaveLength(full.PREP.filter((row) => row[1] === 'bagus').length);
    collect(event);

    // Nothing of another system: every record ref belongs to the ISMS snapshot, or is a row of the ISMS system.
    const ismsRows = await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select f.id from finding f join management_system m on m.id = f.management_system_id where m.slug = 'isms'
        union all select p.id from audit_prep_task p join management_system m on m.id = p.management_system_id where m.slug = 'isms'
        union all select c.id from cycle_requirement_status c join management_system m on m.id = c.management_system_id where m.slug = 'isms'
        union all select r.id from drift_result r join management_system m on m.id = r.management_system_id where m.slug = 'isms'
        union all select l.entity_id from entity_ms_link l join management_system m on m.id = l.management_system_id
          where m.slug = 'isms' and l.deleted_at is null
        union all select t.id from risk_treatment t join management_system m on m.id = t.management_system_id where m.slug = 'isms'
        union all select c.id from chain_record c join management_system m on m.id = c.management_system_id where m.slug = 'isms'`.execute(trx);
      return new Set(rows.map((r) => r.id));
    });
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) expect(isms.has(id) || ismsRows.has(id), id).toBe(true);

    // Summary cards count the owner's records; phase counts stay those of the full data (D-04).
    const summary = (await bagus.get<ImplementationSummary>('/api/v1/ms/isms/implementation/summary')).body;
    expect(summary.cards.find((c) => c.key === 'implemented')!.total).toBe(reqs.total);
    expect(summary.phases.map((p) => p.counts)).toEqual(full.bundle.phases.map((p) => p.c));
  });

  it('refuses everyone\'s pending list, the aggregate and other people\'s records to a Domain Owner', async () => {
    expect((await bagus.get('/api/v1/ms/isms/audit/pending')).status).toBe(403);
    expect((await bagus.get('/api/v1/ms/isms/audit/pending?aggregate=unit')).status).toBe(403);
    expect((await bagus.get('/api/v1/ms/isms/audit/pending?owner=rina')).status).toBe(403);
  });

  it('refuses every ISMS endpoint to a QMS-only Domain Owner and shows only own QMS records', async () => {
    const staff = await userId(db, 'staff02');
    await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const qms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'qms').executeTakeFirstOrThrow();
      await trx.insertInto('user_ms_role').values({ user_id: staff, management_system_id: qms.id, role: 'domain_owner' }).execute();
    });
    const client = await screenClient(ctx, db, 'staff02', 'ndt');
    const paths = [
      'implementation/summary', 'applicability', 'documents', 'gates', 'phases/1/activities', 'audit/event/next', 'audit/stages',
      'audit/stages/risk/records', 'audit/chain?anchor_id=R-014', 'audit/pending?owner=staff02', 'surveillance/cycle', 'surveillance/drift', 'evidence',
    ];
    for (const path of paths) expect({ path, status: (await client.get(`/api/v1/ms/isms/${path}`)).status }).toEqual({ path, status: 403 });
    for (const path of ['applicability', 'documents', 'evidence']) {
      const page = (await client.get<{ total: number }>(`/api/v1/ms/qms/${path}`)).body;
      expect({ path, total: page.total }).toEqual({ path, total: 0 });
    }
    expect((await client.get<unknown[]>('/api/v1/ms/qms/gates')).body).toEqual([]);
  });

  it('gives Top Management pending data only as counts per stage and role', async () => {
    const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
    expect((await hendra.get('/api/v1/ms/isms/audit/pending')).status).toBe(403);
    expect((await hendra.get('/api/v1/ms/isms/audit/pending?owner=bagus')).status).toBe(403);
    const aggregate = await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit');
    expect(aggregate.status).toBe(200);
    expect(z.array(z.object({ stage: z.string(), role: z.string().nullable(), open: z.number(), overdue: z.number() }).strict()).parse(aggregate.body)).toBeTruthy();
    expect(aggregate.body.reduce((n, r) => n + r.open, 0)).toBe(full.bundle.chain.items.length);
    expect(aggregate.body.reduce((n, r) => n + r.overdue, 0)).toBe(full.bundle.chain.items.filter((i) => i.st !== 'pending').length);
    expect(JSON.stringify(aggregate.body)).not.toContain('bagus');
    const own = await hendra.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=hendra');
    expect(own.total).toBe(full.bundle.chain.items.filter((i) => i.h === 'hendra').length);
  });

  it('gives an external auditor no holders, no pending data and evidence only through ready packs (D-34)', async () => {
    const packed = await inScope(db.migrator, { orgId: ORG_IDS.tst, schema: 'org_tst', platformScope: true }, async (trx) => {
      const ms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow();
      const ev = await sql<{ id: string; evidence_code: string }>`
        select e.id, e.evidence_code from evidence e join evidence_target t on t.evidence_id = e.id
        where t.management_system_id = ${ms.id} order by e.position limit 1`.execute(trx);
      const evidence = ev.rows[0]!;
      const pack = await trx.insertInto('evidence_pack').values({ management_system_id: ms.id, status: 'ready', item_count: 1 }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('evidence_pack_item').values({ evidence_pack_id: pack.id, evidence_id: evidence.id, evidence_code: evidence.evidence_code, requirement_codes: ['A.5.1'] }).execute();
      return evidence.evidence_code;
    });
    const auditor = await screenClient(ctx, db, 'ext.auditor', 'tst');
    const evidence = pageOf(EvidenceItem).parse((await auditor.get('/api/v1/ms/isms/evidence')).body);
    expect(evidence.items.map((e) => e.code)).toEqual([packed]);
    expect(evidence.items[0]).not.toHaveProperty('owner');
    const reqs = await auditor.all<ApplicabilityItem>('/api/v1/ms/isms/applicability');
    expect(reqs.total).toBe(93);
    expect(reqs.items.every((r) => !('owner' in r))).toBe(true);
    expect((await auditor.get('/api/v1/ms/isms/gates')).body).toEqual([]);
    expect((await auditor.get('/api/v1/ms/isms/phases/4/activities')).body).toEqual([]);
    expect((await auditor.get('/api/v1/ms/isms/surveillance/cycle')).body).toEqual([]);
    expect((await auditor.get('/api/v1/ms/isms/surveillance/drift')).body).toEqual([]);
    expect((await auditor.get<{ total: number }>('/api/v1/ms/isms/audit/stages/risk/records')).body.total).toBe(0);
    expect((await auditor.get('/api/v1/ms/isms/audit/pending')).status).toBe(403);
    const chain = (await auditor.get<ChainResponse>('/api/v1/ms/isms/audit/chain?anchor_id=A.8.13')).body;
    for (const node of chain.nodes) if (!('hidden' in node)) expect({ holder: node.holder, due: node.due }).toEqual({ holder: null, due: null });
    expect(chain.nodes.some((n) => 'hidden' in n)).toBe(true);
    const nextId = (await auditor.get<{ id: string }>('/api/v1/ms/isms/audit/event/next')).body.id;
    const event = (await auditor.get<SurveillanceEvent>(`/api/v1/ms/isms/surveillance/events/${nextId}`)).body;
    expect(event.prep).toEqual([]);
    const documents = await auditor.all<DocumentItem>('/api/v1/ms/isms/documents');
    expect(documents.items.every((d) => !('owner' in d) && !('path' in d))).toBe(true);
  });

  it('answers 404 for unknown systems and systems of another organisation, 401 without a session', async () => {
    const rmn = await screenClient(ctx, db, 'rina', 'rmn');
    expect((await rmn.get('/api/v1/ms/qms/implementation/summary')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/nope/evidence')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/isms/phases/99/activities')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/isms/audit/stages/nope/records')).status).toBe(404);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/ms/isms/implementation/summary' });
    expect(response.statusCode).toBe(401);
  });
});
