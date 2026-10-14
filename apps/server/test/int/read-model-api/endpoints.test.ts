// Behaviour of the per-screen read endpoints (build plan D.3 "Read model per screen", D.1 Lists and Language, TS 9.2,
// TS 9.3, TS 9.4): responses parse with the shared schemas, paging, the common filters and server search, the
// language of Accept-Language, stage records with ready rows, chains from stored and derived anchors, pending lists,
// event detail, cycle, drift and the 204 of a system without a planned audit.
import {
  ActivityItem, ApplicabilityItem, ChainResponse, CycleItem, DocumentItem, DriftPattern, EvidenceItem, GateItemView, ImplementationSummary,
  NextAuditEvent, PendingPerson, PendingRecord, StageReadiness, SurveillanceEvent, pageOf,
  type UiMsSnapshot, type UiOrgSnapshot,
} from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { ORG_IDS, createScreenApp, screenClient, type ReadModelApp, type ScreenClient } from './helpers';

const NDT = { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true } as const;

describe('Per-screen read endpoints (TS 9.2)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let rina: ScreenClient;
  let full: UiMsSnapshot;

  beforeAll(async () => {
    ctx = await createScreenApp(db);
    rina = await screenClient(ctx, db, 'rina', 'ndt');
    full = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('gives the implementation summary with five cards, phases with text and maturity per clause', async () => {
    const summary = ImplementationSummary.parse((await rina.get('/api/v1/ms/isms/implementation/summary')).body);
    expect(summary.cards.map((c) => [c.key, c.count, c.total])).toEqual([
      ['implemented', 61, 93], ['partial', 18, undefined], ['gate_items', 4, undefined], ['documents_approved', 14, 22], ['documents_expired', 5, undefined],
    ]);
    expect(summary.cards[0]!.label).toBe('Controls implemented');
    expect(summary.cards[2]!.label).toBe('Blocking items, Risk & SoA');
    expect(summary.currentPhase).toBe(4);
    expect(summary.phases[0]).toMatchObject({ no: 1, text: '5 of 5 verified' });
    expect(summary.maturity.map((m) => m.clause)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    const qms = ImplementationSummary.parse((await rina.get('/api/v1/ms/qms/implementation/summary')).body);
    expect(qms.cards[0]!.label).toBe('Requirements implemented');
  });

  it('answers in the language of Accept-Language (D.1)', async () => {
    const id = ImplementationSummary.parse((await rina.get('/api/v1/ms/isms/implementation/summary', 'id-ID,id;q=0.9,en;q=0.8')).body);
    expect(id.cards.map((c) => c.label)).toEqual(['Kontrol diimplementasikan', 'Diimplementasikan sebagian', 'Item penghambat, Risiko & SoA', 'Dokumen disetujui', 'Dokumen kedaluwarsa']);
    expect(id.phases[0]!.text).toBe('5 dari 5 terverifikasi');
    const en = (await rina.get<ImplementationSummary>('/api/v1/ms/isms/implementation/summary', 'fr-FR, en;q=0.5, id;q=0.4')).body;
    expect(en.cards[0]!.label).toBe('Controls implemented');
    const stagesId = (await rina.get<StageReadiness[]>('/api/v1/ms/isms/audit/stages', 'id')).body;
    expect(stagesId.find((s) => s.key === 'risk')!.label).toBe('Risiko');
  });

  it('pages, filters and searches the applicability list', async () => {
    const all = await rina.all<ApplicabilityItem>('/api/v1/ms/isms/applicability');
    expect(all.total).toBe(93);
    expect(all.items.map((r) => r.id)).toEqual(full.bundle.reqs.map((r) => r.id));
    const page2 = pageOf(ApplicabilityItem).parse((await rina.get('/api/v1/ms/isms/applicability?page=2&pageSize=10')).body);
    expect(page2).toMatchObject({ page: 2, pageSize: 10, total: 93 });
    expect(page2.items.map((r) => r.id)).toEqual(all.items.slice(10, 20).map((r) => r.id));
    const blocked = (await rina.get<{ items: ApplicabilityItem[] }>('/api/v1/ms/isms/applicability?status=blocked')).body.items;
    expect(blocked.map((r) => r.id).sort()).toEqual(['A.5.23', 'A.8.12']);
    const tech = await rina.all<ApplicabilityItem>('/api/v1/ms/isms/applicability?group=A.8');
    expect(tech.total).toBeGreaterThan(0);
    expect(tech.items.every((r) => r.id.startsWith('A.8.'))).toBe(true);
    const backup = (await rina.get<{ items: ApplicabilityItem[] }>('/api/v1/ms/isms/applicability?q=information%20BACKUP')).body.items;
    expect(backup.map((r) => r.id)).toContain('A.8.13');
    const bagus = await rina.all<ApplicabilityItem>('/api/v1/ms/isms/applicability?owner=bagus');
    expect(bagus.items.every((r) => r.owner === 'bagus')).toBe(true);
    // The owner's display name is searchable.
    const byName = await rina.all<ApplicabilityItem>('/api/v1/ms/isms/applicability?q=prasetyo');
    expect(byName.items.map((r) => r.id)).toEqual(bagus.items.map((r) => r.id));
    // E.3 state of the entry's evidence: critical evidence of A.8.13 (EV-0313) shows on the entry.
    const a813 = all.items.find((r) => r.id === 'A.8.13')!;
    expect(a813.ref).toEqual(full.refs['isms:req:A.8.13']);
    expect(a813.lastEvidence).not.toBeNull();
    expect(['fresh', 'aging', 'expired', 'critical']).toContain(a813.freshness);
    expect((await rina.get('/api/v1/ms/isms/applicability?status=partially_implemented')).status).toBe(400);
    expect((await rina.get('/api/v1/ms/isms/applicability?page=0')).status).toBe(400);
  });

  it('filters the document register by status, type, owner, review window and search', async () => {
    const all = await rina.all<DocumentItem>('/api/v1/ms/isms/documents');
    expect(all.items.map((d) => d.id)).toEqual(full.bundle.docs.map((d) => d.id));
    const prc11 = all.items.find((d) => d.id === 'PRC-11')!;
    expect(prc11.requirements).toContain('A.8.13');
    const types = await inScope(db.migrator, NDT, async (trx) => (await sql<{ doc_code: string; doc_type: string }>`select doc_code, doc_type from document where deleted_at is null`.execute(trx)).rows);
    const type = types.find((t) => t.doc_code === 'PRC-11')!.doc_type;
    const ofType = await rina.all<DocumentItem>(`/api/v1/ms/isms/documents?type=${type}`);
    expect(ofType.items.map((d) => d.id)).toContain('PRC-11');
    expect(ofType.items.every((d) => types.find((t) => t.doc_code === d.id)!.doc_type === type)).toBe(true);
    const due = await rina.all<DocumentItem>('/api/v1/ms/isms/documents?due_within=30');
    const today = '2026-09-29';
    const in30 = (rev: string) => rev !== '' && (Date.parse(rev) - Date.parse(today)) / 86_400_000 <= 30;
    expect(due.items.map((d) => d.id)).toEqual(full.bundle.docs.filter((d) => in30(d.rev)).map((d) => d.id));
    expect(due.items.filter((d) => d.st === 'expired')).toHaveLength(5);
    const search = (await rina.get<{ items: DocumentItem[] }>('/api/v1/ms/isms/documents?q=backup')).body.items;
    expect(search.map((d) => d.id)).toContain('PRC-11');
    expect((await rina.get('/api/v1/ms/isms/documents?status=in_review')).status).toBe(400);
  });

  it('lists gate items with refs and the activities they hold back', async () => {
    const gates = z.array(GateItemView).parse((await rina.get('/api/v1/ms/isms/gates')).body);
    expect(gates.map((g) => g.id)).toEqual(['A.5.23', 'A.8.12', 'R-031', 'SOA-01']);
    for (const g of gates) expect(g.affected.length).toBeGreaterThan(0);
    expect(gates[0]!.ref).toEqual(full.refs['isms:req:A.5.23']);
    expect(gates[2]!.ref).toEqual(full.refs['isms:x:R-031']);
  });

  it('gives the activities of one phase with output document and stored outcome', async () => {
    const acts = z.array(ActivityItem).parse((await rina.get('/api/v1/ms/isms/phases/4/activities')).body);
    const phase = full.bundle.phases.find((p) => p.no === 4)!;
    expect(acts.map((a) => [a.no, a.st])).toEqual(phase.acts.map((a) => [a.no, a.st]));
    expect(acts.some((a) => a.expectedOutcome)).toBe(true);
    const withDoc = acts.find((a) => a.docId)!;
    expect(withDoc.outputDocument?.code).toBe(withDoc.docId);
    expect((await rina.get('/api/v1/ms/isms/phases/0/activities')).status).toBe(400);
  });

  it('gives stage records with open items first, ready records after, and TS 9.3 fields', async () => {
    const stages = z.array(StageReadiness).parse((await rina.get('/api/v1/ms/isms/audit/stages')).body);
    const risk = stages.find((s) => s.key === 'risk')!;
    const records = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/stages/risk/records');
    expect(records.total).toBe(risk.rec);
    expect(records.items.filter((r) => r.status === 'ready')).toHaveLength(risk.ready);
    const r014 = records.items.find((r) => r.ref.code === 'R-014')!;
    expect(r014).toMatchObject({ status: 'overdue', dueAt: '2026-09-10', daysToDue: -19, holder: { handle: 'bagus', displayName: 'Bagus Prasetyo', roleLabel: 'IT Infrastructure Lead' } });
    expect(r014.ref).toMatchObject({ entityType: 'risk', stage: 'risk' });
    expect(r014.upstream).toEqual([{ stage: 'context', id: 'CI-02' }]);
    const control = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/stages/control/records');
    expect(control.total).toBe(93);
    const overdue = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/stages/risk/records?status=overdue');
    expect(overdue.items.every((r) => r.status === 'overdue')).toBe(true);
    const owned = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/stages/risk/records?owner=bagus');
    expect(owned.items.length).toBeGreaterThan(0);
    expect(owned.items.every((r) => r.holder?.handle === 'bagus')).toBe(true);
    const search = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/stages/risk/records?q=privileged');
    expect(search.items.map((r) => r.ref.code)).toEqual(['R-014']);
    // Evidence records carry the repository and link status of their file (TS 9.3 `file`).
    const evidence = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/stages/evidence/records');
    expect(evidence.items.find((r) => r.ref.code === 'EV-0313')?.file).toMatchObject({ repository: expect.any(String), linkStatus: expect.any(String) });
    pageOf(PendingRecord).parse((await rina.get('/api/v1/ms/isms/audit/stages/evidence/records?pageSize=5')).body);
  });

  it('resolves chains from stored anchors, nodes inside chains and requirement records (UI 2.10)', async () => {
    const org = (await rina.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    const stored = org.CHAINS.isms![0]!;
    const chain = ChainResponse.parse((await rina.get(`/api/v1/ms/isms/audit/chain?anchor_id=${encodeURIComponent(stored.id)}`)).body);
    expect(chain.anchor).toBe(stored.id);
    expect(chain.nodes.map((n) => [n.stage, 'hidden' in n ? null : n.id])).toEqual(stored.nodes.map(([stage, code]) => [stage, code?.startsWith('ev:') ? expect.anything() : code]));
    for (const node of chain.nodes) {
      if ('hidden' in node || !node.id) continue;
      const item = full.bundle.chain.items.find((i) => i.id === node.id);
      expect({ id: node.id, status: node.status }).toEqual({ id: node.id, status: item ? item.st : 'ready' });
      if (node.status === 'overdue' || node.status === 'missing') expect(node.clauseAtRisk).toBe(org.CLAUSE_AT_RISK[node.stage] ?? null);
    }
    const r014 = (await rina.get<ChainResponse>('/api/v1/ms/isms/audit/chain?anchor_id=r-014')).body;
    expect(r014.nodes.some((n) => !('hidden' in n) && n.id === 'R-014')).toBe(true);
    const derived = (await rina.get<ChainResponse>('/api/v1/ms/isms/audit/chain?anchor_id=PRC-11')).body;
    expect(derived.nodes.length).toBeGreaterThan(0);
    expect((await rina.get('/api/v1/ms/isms/audit/chain?anchor_id=NOPE-1')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/isms/audit/chain')).status).toBe(400);
  });

  it('lists pending items per person, for one person and with filters', async () => {
    const people = z.array(PendingPerson).parse((await rina.get('/api/v1/ms/isms/audit/pending')).body);
    expect(people.reduce((n, p) => n + p.open, 0)).toBe(full.bundle.chain.items.length);
    for (let i = 1; i < people.length; i += 1) {
      const [a, b] = [people[i - 1]!, people[i]!];
      expect(a.overdue > b.overdue || (a.overdue === b.overdue && a.open >= b.open)).toBe(true);
    }
    const bagus = people.find((p) => p.holder === 'bagus')!;
    expect(bagus).toMatchObject({ displayName: 'Bagus Prasetyo', jobTitle: 'IT Infrastructure Lead' });
    const overdueOnly = z.array(PendingPerson).parse((await rina.get('/api/v1/ms/isms/audit/pending?overdue_only=true')).body);
    expect(overdueOnly.reduce((n, p) => n + p.open, 0)).toBe(full.bundle.chain.items.filter((i) => i.st !== 'pending').length);
    const riskOnly = z.array(PendingPerson).parse((await rina.get('/api/v1/ms/isms/audit/pending?stage=risk')).body);
    expect(riskOnly.reduce((n, p) => n + p.open, 0)).toBe(full.bundle.chain.items.filter((i) => i.stage === 'risk').length);
    const records = pageOf(PendingRecord).parse((await rina.get('/api/v1/ms/isms/audit/pending?owner=bagus&pageSize=5')).body);
    expect(records.total).toBe(bagus.open);
    expect(records.items).toHaveLength(5);
    expect((await rina.get('/api/v1/ms/isms/audit/pending?stage=nope')).status).toBe(404);
  });

  it('gives the next audit event, event detail with preparation and findings, the cycle and drift patterns', async () => {
    const next = NextAuditEvent.parse((await rina.get('/api/v1/ms/isms/audit/event/next')).body);
    expect(next).toMatchObject({ type: 'surveillance', scheduledAt: '2026-11-12', daysLeft: 44, certificationBody: expect.any(String) });
    const detail = SurveillanceEvent.parse((await rina.get(`/api/v1/ms/isms/surveillance/events/${next.id}`)).body);
    expect(detail).toMatchObject({ next: true, past: false });
    expect(detail.prep.map((p) => p.title)).toEqual(full.PREP.map((row) => row[0]));
    const openCertification = full.PAST.filter((row) => row[4] !== 'closed').map((row) => row[0]);
    for (const code of openCertification) expect(detail.findings.map((f) => f.code)).toContain(code);
    const past = await inScope(db.migrator, NDT, async (trx) =>
      (await sql<{ id: string }>`select e.id from audit_event e join management_system m on m.id = e.management_system_id
        where m.slug = 'isms' and e.deleted_at is null and e.scheduled_at < '2026-09-29' order by e.scheduled_at desc limit 1`.execute(trx)).rows[0],
    );
    if (past) expect((await rina.get<SurveillanceEvent>(`/api/v1/ms/isms/surveillance/events/${past.id}`)).body).toMatchObject({ next: false, past: true });
    expect((await rina.get('/api/v1/ms/isms/surveillance/events/00000000-0000-4000-8000-000000000999')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/qms/surveillance/events/' + next.id)).status).toBe(404);

    const cycle = z.array(CycleItem).parse((await rina.get('/api/v1/ms/isms/surveillance/cycle')).body);
    expect(cycle.map((c) => c.requirementCode)).toEqual(full.CYCLE_ITEMS.map((row) => row[0]));
    expect((await rina.get('/api/v1/ms/isms/surveillance/cycle?cycle_id=00000000-0000-4000-8000-000000000999')).status).toBe(404);

    const drift = z.array(DriftPattern).parse((await rina.get('/api/v1/ms/isms/surveillance/drift')).body);
    expect(drift.length).toBeGreaterThan(0);
    for (const pattern of drift) expect(pattern.rows.length).toBeGreaterThan(0);
    const unverif = drift.find((p) => p.sourceKind === 'unverif');
    if (unverif) expect(unverif.rows).toHaveLength(3);
    const one = z.array(DriftPattern).parse((await rina.get(`/api/v1/ms/isms/surveillance/drift?rule=${drift[0]!.code}`)).body);
    expect(one.map((p) => p.code)).toEqual([drift[0]!.code]);
    expect((await rina.get('/api/v1/ms/isms/surveillance/drift?rule=nope')).status).toBe(404);
  });

  it('filters evidence by freshness, frequency, owner and search, with the A-05 integrity status', async () => {
    const all = await rina.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(all.items.map((e) => e.code)).toEqual(full.bundle.evs.map((e) => e.code));
    for (const e of all.items) {
      if (['changed', 'missing', 'revoked'].includes(e.integ)) expect(e.integrity).not.toBe('ok');
      if (e.integ === 'ok') expect(e.integrity).toBe('ok');
    }
    const monthly = await rina.all<EvidenceItem>('/api/v1/ms/isms/evidence?frequency=monthly');
    expect(monthly.items.every((e) => e.freq === 'monthly')).toBe(true);
    expect(monthly.total).toBe(full.bundle.evs.filter((e) => e.freq === 'monthly').length);
    const code = (await rina.get<{ items: EvidenceItem[] }>('/api/v1/ms/isms/evidence?q=ev-0313')).body.items;
    expect(code.map((e) => e.code)).toEqual(['EV-0313']);
    pageOf(EvidenceItem).parse((await rina.get('/api/v1/ms/isms/evidence?freshness=aging&pageSize=3')).body);
    expect((await rina.get('/api/v1/ms/isms/evidence?freshness=old')).status).toBe(400);
  });

  it('answers 204 without a body when the system has no planned audit event (TS 9.4)', async () => {
    await inScope(db.migrator, NDT, async (trx) => {
      await sql`update audit_prep_task set deleted_at = now() where management_system_id = (select id from management_system where slug = 'abms')`.execute(trx);
      await sql`update audit_event set deleted_at = now() where management_system_id = (select id from management_system where slug = 'abms')`.execute(trx);
    });
    const response = await rina.get('/api/v1/ms/abms/audit/event/next');
    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });
});
