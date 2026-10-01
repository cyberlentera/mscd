// Scoping of the UI parity reads (build plan D-04, F.7, G.5, D-34, A.4): a Domain Owner (`bagus`) sees only own
// records with counts computed on the full data; an external auditor gets the `EaProjection`; a QMS-only Domain
// Owner sees nothing of ABMS in `TITLES` or `CHAINS`; `LICENCE`, `PACKS`, `REPOS` and `ROUTING` follow the
// permissions; `ROLES` outside demo personas.
import type { UiMsSnapshot, UiOrgSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { createReadModelApp, ORG_IDS, sessionFor, userId, type ReadModelApp } from './helpers';

describe('UI parity reads: scoping (D-04, F.7, D-34)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let full: UiMsSnapshot;
  let fullOrg: UiOrgSnapshot;

  beforeAll(async () => {
    ctx = await createReadModelApp(db);
    const rina = await sessionFor(ctx, db, 'rina', 'ndt');
    full = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    fullOrg = (await rina.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('gives an MS Manager the licence card, pack cards, repositories and routing', () => {
    expect(fullOrg.LICENCE).not.toBeNull();
    expect(Object.keys(fullOrg.PACKS)).toEqual(['isms', 'qms', 'bcms', 'abms']);
    expect(fullOrg.REPOS.map((r) => r.id)).toEqual(['sp', 'gd', 'vault', 'od']);
    expect(fullOrg.ROUTING).toHaveLength(4);
  });

  it('limits a Domain Owner (bagus) to own records, keeps the counts of the full data, and hides licence, packs and storage', async () => {
    const bagus = await sessionFor(ctx, db, 'bagus', 'ndt');
    const response = await bagus.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    expect(response.status).toBe(200);
    const own = response.body;
    expect(own.bundle.reqs.length).toBeGreaterThan(0);
    expect(own.bundle.reqs.every((r) => r.owner === 'bagus')).toBe(true);
    expect(own.bundle.reqs).toEqual(full.bundle.reqs.filter((r) => r.owner === 'bagus'));
    expect(own.bundle.evs).toEqual(full.bundle.evs.filter((e) => e.owner === 'bagus'));
    expect(own.bundle.docs.every((d) => d.owner === 'bagus')).toBe(true);
    expect(own.bundle.chain.items).toEqual(full.bundle.chain.items.filter((i) => i.h === 'bagus'));
    expect(own.bundle.chain.recs).toEqual(full.bundle.chain.recs);
    expect(own.bundle.gates.every((g) => g.h === 'bagus')).toBe(true);
    for (const phase of own.bundle.phases) {
      const fullPhase = full.bundle.phases.find((p) => p.no === phase.no)!;
      expect(phase.c).toEqual(fullPhase.c);
      expect(phase.total).toBe(fullPhase.total);
      expect(phase.acts.every((a) => a.owner === 'bagus')).toBe(true);
    }
    for (const records of Object.values(own.X)) expect(records.every((x) => x.h === 'bagus')).toBe(true);
    expect(own.PREP.every((row) => row[1] === 'bagus')).toBe(true);
    expect(own.CYCLE_ITEMS.every((row) => row[2] === 'bagus')).toBe(true);
    // Refs only of kept records.
    const keys = Object.keys(own.refs);
    expect(keys.length).toBeLessThan(Object.keys(full.refs).length);
    for (const r of own.bundle.reqs) expect(own.refs[`isms:req:${r.id}`]).toEqual(full.refs[`isms:req:${r.id}`]);
    const foreign = full.bundle.reqs.find((r) => r.owner !== 'bagus')!;
    expect(own.refs[`isms:req:${foreign.id}`]).toBeUndefined();

    const org = (await bagus.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    expect(org.LICENCE).toBeNull();
    expect(org.PACKS).toEqual({});
    expect(org.REPOS).toEqual([]);
    expect(org.ROUTING).toEqual([]);
    expect(org.MS.map((m) => m.id)).toEqual(['isms', 'qms', 'bcms', 'abms']);
    // Chains of own-scoped systems keep only codes the owner holds or references.
    for (const chain of org.CHAINS.isms ?? []) expect(chain.nodes.some(([, code]) => code !== null)).toBe(true);
    expect(org.permissions.ms.isms).not.toContain('applicability.verify');
  });

  it('gives an external auditor the EaProjection of the audited system (D-34)', async () => {
    // A ready evidence pack of tst ISMS with one item, so one evidence record is visible to the auditor.
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
    const auditor = await sessionFor(ctx, db, 'ext.auditor', 'tst');
    const response = await auditor.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    expect(response.status).toBe(200);
    const p = response.body;
    expect(p.bundle.reqs.length).toBe(93);
    for (const r of p.bundle.reqs) {
      expect(r).not.toHaveProperty('owner');
      expect(r).not.toHaveProperty('by');
      expect(r).not.toHaveProperty('note');
    }
    for (const d of p.bundle.docs) {
      expect(d).not.toHaveProperty('owner');
      expect(d).not.toHaveProperty('approver');
      expect(d).not.toHaveProperty('path');
    }
    expect(p.bundle.evs.map((e) => e.code)).toEqual([packed]);
    expect(p.bundle.evs[0]).not.toHaveProperty('owner');
    expect(p.bundle.evs[0]).not.toHaveProperty('path');
    expect(p.bundle.evs[0]).not.toHaveProperty('hash');
    expect(p.bundle.chain.items).toEqual([]);
    expect(p.bundle.chain.recs.control).toBe(93);
    expect(p.bundle.gates).toEqual([]);
    expect(p.bundle.phases).toEqual([]);
    expect(p.X).toEqual({});
    expect(p.PREP).toEqual([]);
    expect(p.CYCLE_ITEMS).toEqual([]);
    expect(p.DRIFT).toEqual([]);
    expect(p.EVENTS.length).toBeGreaterThan(0);
    expect(p.PAST.length).toBeGreaterThan(0);
    const kinds = new Set(Object.keys(p.refs).map((k) => k.split(':')[1]));
    expect([...kinds].sort()).toEqual(['doc', 'ev', 'req']);
    expect(p.refs[`isms:ev:${packed}`]).toBeDefined();

    const org = (await auditor.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    expect(org.MS.map((m) => m.id)).toEqual(['isms']);
    expect(org.REPOS).toEqual([]);
    expect(org.ROUTING).toEqual([]);
    expect(org.PACKS).toEqual({});
    expect(org.LICENCE).toBeNull();
    for (const [handle, person] of Object.entries(org.PEOPLE)) if (handle !== 'none') expect(person[1]).toBe('-');
    // Every read of the auditor is logged (F.7).
    const logged = await inScope(db.migrator, { orgId: ORG_IDS.tst, schema: 'org_tst', platformScope: true }, (trx) =>
      trx.selectFrom('audit_trail').select('action').where('action', '=', 'auditor.read').execute(),
    );
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a QMS-only Domain Owner no ABMS titles or chains, and refuses the ABMS snapshot', async () => {
    const staff = await userId(db, 'staff01');
    await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const qms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'qms').executeTakeFirstOrThrow();
      await trx.insertInto('user_ms_role').values({ user_id: staff, management_system_id: qms.id, role: 'domain_owner' }).execute();
      // One open QMS record held by the new owner, so the owner's chains are not empty.
      await sql`update risk set owner_user_id = ${staff} where code = 'RO-07'`.execute(trx);
    });
    const client = await sessionFor(ctx, db, 'staff01', 'ndt');
    // An ABMS business associate in an ABMS chain (the demo ABMS has no chain records yet).
    await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const abms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'abms').executeTakeFirstOrThrow();
      await trx.insertInto('business_associate').values({ management_system_id: abms.id, code: 'BA-T01', title: 'Customs broker in Batam' }).execute();
      const chain = await trx.insertInto('trace_chain_instance').values({ management_system_id: abms.id, anchor_code: 'BA-T01' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('trace_chain_node').values({ trace_chain_instance_id: chain.id, position: 0, stage_key: 'associate', record_code: 'BA-T01' }).execute();
    });
    const abmsCodes = ['BA-T01'];
    const manager = (await (await sessionFor(ctx, db, 'rina', 'ndt')).get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    expect(manager.TITLES['BA-T01']).toBe('Customs broker in Batam');
    expect(manager.CHAINS.abms).toEqual([{ id: 'BA-T01', nodes: [['associate', 'BA-T01']] }]);
    const org = (await client.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    expect(Object.keys(org.CHAINS)).toEqual(['qms']);
    for (const code of abmsCodes) expect(org.TITLES).not.toHaveProperty(code);
    const chainCodes = new Set(Object.values(org.CHAINS).flat().flatMap((c) => [c.id, ...c.nodes.map((n) => n[1])]));
    for (const code of Object.keys(org.TITLES)) expect(chainCodes.has(code)).toBe(true);
    expect(org.TITLES['RO-07']).toBeDefined();
    // Clauses at risk of the QMS stages only (no ISMS treatment or SoA, no ABMS or ISMS control stage).
    expect(Object.keys(org.CLAUSE_AT_RISK).sort()).toEqual(['action', 'context', 'document', 'evidence', 'metric', 'objective', 'process', 'risk']);
    expect(org.orgs.find((o) => o.id === 'ndt')!.ms).toEqual(['qms']);
    expect(org.PEOPLE).toHaveProperty('staff01');
    expect((await client.get('/api/v1/ui/ms/abms')).status).toBe(403);
    expect((await client.get('/api/v1/ui/ms/qms')).status).toBe(200);
  });

  it('answers 404 for an unknown system and for a system of another organisation', async () => {
    const rina = await sessionFor(ctx, db, 'rina', 'rmn');
    expect((await rina.get('/api/v1/ui/ms/qms')).status).toBe(404);
    expect((await rina.get('/api/v1/ui/ms/nope')).status).toBe(404);
  });

  it('answers 401 without a session', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/ui/org' });
    expect(response.statusCode).toBe(401);
  });
});

describe('UI parity reads: ROLES without demo personas (G.5)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;

  beforeAll(async () => {
    ctx = await createReadModelApp(db, { MSCD__DEMO__PERSONAS: 'false' });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists one entry per UI role of the session user, each naming the user', async () => {
    const sari = await sessionFor(ctx, db, 'sari', 'ndt');
    const org = (await sari.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    expect(org.ROLES).toEqual({
      manager: { who: 'sari', label: ['MS Manager', 'Manajer SM'] },
      owner: { who: 'sari', label: ['Domain Owner', 'Pemilik Domain'] },
    });
  });
});
