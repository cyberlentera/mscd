// TS 9.6 "one number, one function" (build plan D-05, WP-32): the expired document count, the critical and
// unverifiable evidence counts, the gate item count and the chain stage numbers are equal between
// `/implementation/summary`, `/audit/stages`, `/audit/event/next`, `/evidence`, `/documents`, `/gates`,
// `/audit/stages/{key}/records` and `/ui/ms/{ms}`, for every system of ndt, and match the sample's numbers (UI 2.8).
import {
  UNVERIFIABLE_INTEG_IDS, type DocumentItem, type EvidenceItem, type GateItemView, type ImplementationSummary, type NextAuditEvent, type PendingRecord,
  type StageReadiness, type UiMsSnapshot,
} from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { createScreenApp, screenClient, type ReadModelApp, type ScreenClient } from './helpers';

/** UI 2.8 card statistics of the sample (gate items, expired documents, critical and unverifiable evidence, after audit). */
const SAMPLE: Record<string, { gate: number; docExp: number; evCrit: number; evBad: number; af: number }> = {
  isms: { gate: 4, docExp: 5, evCrit: 3, evBad: 3, af: 16 },
  qms: { gate: 0, docExp: 1, evCrit: 0, evBad: 0, af: 4 },
  bcms: { gate: 3, docExp: 0, evCrit: 0, evBad: 0, af: 0 },
  abms: { gate: 1, docExp: 0, evCrit: 0, evBad: 0, af: 0 },
};

const card = (summary: ImplementationSummary, key: string) => summary.cards.find((c) => c.key === key)!;

describe('TS 9.6: one number, one function across the read endpoints', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let rina: ScreenClient;

  beforeAll(async () => {
    ctx = await createScreenApp(db);
    rina = await screenClient(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  for (const [ms, sample] of Object.entries(SAMPLE)) {
    it(`gives ${ms} the same numbers on every endpoint`, async () => {
      const snapshot = (await rina.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`)).body;
      const summaryResponse = await rina.get<ImplementationSummary>(`/api/v1/ms/${ms}/implementation/summary`);
      expect(summaryResponse.status).toBe(200);
      const summary = summaryResponse.body;
      const stages = (await rina.get<StageReadiness[]>(`/api/v1/ms/${ms}/audit/stages`)).body;
      const gates = (await rina.get<GateItemView[]>(`/api/v1/ms/${ms}/gates`)).body;
      const documents = await rina.all<DocumentItem>(`/api/v1/ms/${ms}/documents`);
      const expired = await rina.all<DocumentItem>(`/api/v1/ms/${ms}/documents?status=expired`);
      const evidence = await rina.all<EvidenceItem>(`/api/v1/ms/${ms}/evidence`);
      const critical = await rina.all<EvidenceItem>(`/api/v1/ms/${ms}/evidence?freshness=critical`);
      const bundle = snapshot.bundle;
      const unverifiable = (list: readonly { integ: string }[]) => list.filter((e) => (UNVERIFIABLE_INTEG_IDS as readonly string[]).includes(e.integ)).length;

      // Expired documents: Module 1 card, Module 3 register, UI snapshot, sample.
      const expiredCount = bundle.docs.filter((d) => d.st === 'expired').length;
      expect(card(summary, 'documents_expired').count).toBe(expiredCount);
      expect(expired.total).toBe(expiredCount);
      expect(documents.items.filter((d) => d.st === 'expired')).toHaveLength(expiredCount);
      expect(expiredCount).toBe(sample.docExp);
      expect(card(summary, 'documents_approved')).toMatchObject({ count: bundle.docs.filter((d) => d.st === 'approved').length, total: bundle.docs.length });
      expect(documents.total).toBe(bundle.docs.length);

      // Critical and unverifiable evidence (A.4 5.13: two functions).
      const criticalCount = bundle.evs.filter((e) => e.fresh === 'critical').length;
      expect(summary.criticalEvidence).toBe(criticalCount);
      expect(critical.total).toBe(criticalCount);
      expect(criticalCount).toBe(sample.evCrit);
      expect(summary.unverifiableEvidence).toBe(unverifiable(bundle.evs));
      expect(unverifiable(evidence.items)).toBe(unverifiable(bundle.evs));
      expect(summary.unverifiableEvidence).toBe(sample.evBad);
      expect(evidence.total).toBe(bundle.evs.length);

      // Gate items: Module 1 card, gate list, UI snapshot, sample.
      expect(card(summary, 'gate_items').count).toBe(bundle.gates.length);
      expect(gates.map((g) => g.id)).toEqual(bundle.gates.map((g) => g.id));
      expect(gates).toHaveLength(sample.gate);

      // Chain stage numbers: every stage of the snapshot, its records list, and the hero numbers of the next event.
      expect(stages.map((s) => s.key)).toEqual(Object.keys(bundle.chain.recs));
      for (const stage of stages) {
        const items = bundle.chain.items.filter((i) => i.stage === stage.key);
        expect({ key: stage.key, rec: stage.rec, open: stage.open, pending: stage.pending, overdue: stage.overdue, after: stage.after }).toEqual({
          key: stage.key,
          rec: bundle.chain.recs[stage.key],
          open: items.length,
          pending: items.filter((i) => i.st === 'pending').length,
          overdue: items.filter((i) => i.st !== 'pending').length,
          after: items.filter((i) => i.after).length,
        });
        expect(stage.ready).toBe(Math.max(0, stage.rec - stage.open));
        const records = await rina.all<PendingRecord>(`/api/v1/ms/${ms}/audit/stages/${stage.key}/records`);
        expect(records.items.filter((r) => r.status !== 'ready')).toHaveLength(stage.open);
        expect(records.items.filter((r) => r.status === 'overdue' || r.status === 'missing')).toHaveLength(stage.overdue);
        expect(records.items.filter((r) => r.afterAudit)).toHaveLength(stage.after);
      }
      const after = stages.reduce((n, s) => n + s.after, 0);
      expect(after).toBe(sample.af);
      const next = await rina.get<NextAuditEvent>(`/api/v1/ms/${ms}/audit/event/next`);
      if (next.status === 200) {
        expect(next.body.numbers).toEqual({
          open: stages.reduce((n, s) => n + s.open, 0),
          overdueOrMissing: stages.reduce((n, s) => n + s.overdue, 0),
          afterAudit: after,
          ready: Math.max(0, stages.reduce((n, s) => n + s.rec, 0) - bundle.chain.items.length),
        });
      } else {
        expect(next.status).toBe(204);
      }

      // Phases: the same counts as the snapshot; the current phase per UI 2.6.
      expect(summary.phases.map((p) => ({ no: p.no, total: p.total, counts: p.counts }))).toEqual(bundle.phases.map((p) => ({ no: p.no, total: p.total, counts: p.c })));
    });
  }
});
