// Bundle derivations (G.5 `bundle.chain`, `bundle.gates`, `bundle.phases`, D-12, D-13, D-29, UI 2.3 to 2.8) checked
// against the sample snapshot of every organisation and system, plus small fixtures for the rules.
import type { ChainItem, Evidence, Pair, Phase, Requirement, XRecord } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { chainItemStatus, deriveChain, dueAfterAudit, type ChainRequirement, type ChainStage } from '../../../src/modules/read-model/derive/chain';
import { deriveGateItems } from '../../../src/modules/read-model/derive/gates';
import type { ActivityRow } from '../../../src/modules/read-model/derive/inputs';
import { currentPhaseNo, derivePhases } from '../../../src/modules/read-model/derive/phases';
import { portfolioCounts } from '../../../src/modules/read-model/derive/portfolio';
import { deriveTaskList, heldChainItems, taskCounts } from '../../../src/modules/read-model/derive/tasks';
import { loadSampleSnapshot, type SampleOrgSnapshot } from '../../../src/seed/snapshot';

const sample = loadSampleSnapshot();
const today = sample.today;
const GATE_TYPES: Record<string, Pair> = { risk: ['Risk', 'Risiko'], treatment: ['Treatment', 'Perlakuan'], soa: ['SoA', 'SoA'], bia: ['BIA', 'BIA'] };

function systems(): { org: string; ms: string; snapshot: SampleOrgSnapshot }[] {
  return Object.entries(sample.snapshots).flatMap(([org, snapshot]) => Object.keys(snapshot.bundles).map((ms) => ({ org, ms, snapshot })));
}

function chainInput(snapshot: SampleOrgSnapshot, ms: string) {
  const bundle = snapshot.bundles[ms]!;
  const msRow = snapshot.MS.find((m) => m.id === ms)!;
  const dueOf = new Map(bundle.chain.items.filter((i) => i.kind === 'req').map((i) => [i.id, i.due]));
  const reqs: ChainRequirement[] = (bundle.reqs as unknown as Requirement[]).map((r) => ({ ...r, actionDueAt: dueOf.get(r.id) ?? null }));
  return {
    ms,
    today,
    auditDate: msRow.audit?.date ?? null,
    stages: snapshot.STAGES[ms] as ChainStage[],
    reqs,
    docs: bundle.docs as never,
    evs: bundle.evs as unknown as Evidence[],
    X: (snapshot.X[ms] ?? {}) as Record<string, XRecord[]>,
    people: new Map(Object.entries(snapshot.PEOPLE).map(([h, p]) => [h, p[0]])),
    frequencyLabels: new Map(Object.entries(sample.raw.FREQ).map(([code, f]) => [code, [f[0], f[1]] as Pair])),
    unit: msRow.unit,
  };
}

describe('chain items (UI 2.3, D-12)', () => {
  it('gives missing without holder and due date or with a missing source, overdue when past, else pending', () => {
    expect(chainItemStatus({ holder: 'none', due: null }, today)).toBe('missing');
    expect(chainItemStatus({ holder: 'rina', due: null, missing: true }, today)).toBe('missing');
    expect(chainItemStatus({ holder: 'rina', due: '2026-09-28' }, today)).toBe('overdue');
    expect(chainItemStatus({ holder: 'rina', due: today }, today)).toBe('pending');
    expect(chainItemStatus({ holder: 'rina', due: null }, today)).toBe('pending');
    expect(dueAfterAudit('2026-11-13', '2026-11-12')).toBe(true);
    expect(dueAfterAudit('2026-11-12', '2026-11-12')).toBe(false);
    expect(dueAfterAudit('2026-11-13', null)).toBe(false);
  });

  for (const { org, ms, snapshot } of systems()) {
    it(`reproduces the chain items and stage counts of ${org}/${ms}`, () => {
      const input = chainInput(snapshot, ms);
      const result = deriveChain(input);
      const expected = snapshot.bundles[ms]!.chain;
      expect(result.recs).toEqual(expected.recs);
      const strip = (items: readonly (ChainItem | (typeof expected.items)[number])[]) =>
        items.map((i) => {
          const { refKey, ref, ...rest } = i as ChainItem & { ref?: string };
          return { ...rest, ref: refKey ?? ref ?? null };
        });
      expect(strip(result.items)).toEqual(strip(expected.items));
    });
  }
});

describe('gate items (UI 2.4, A-27)', () => {
  for (const { org, ms, snapshot } of systems()) {
    it(`reproduces the gate items of ${org}/${ms}`, () => {
      const input = chainInput(snapshot, ms);
      const gates = deriveGateItems({ unit: input.unit, reqs: input.reqs, X: input.X, gateTypes: GATE_TYPES });
      expect(gates).toEqual(snapshot.bundles[ms]!.gates);
    });
  }

  it('prefers the stored gate reason, then the note, then Blocked; stage keys stand in for missing type labels', () => {
    const base = { key: '4.1', title: 'Context', theme: 'Clause 4', owner: 'lina', doc: 'POL-01', freq: 'annual', gate: true, just: '', risks: [] };
    const gates = deriveGateItems({
      unit: 'req',
      reqs: [
        { ...base, id: 'Cl. 4.1', st: 'blocked', note: 'note', gateReason: 'reason' },
        { ...base, id: 'Cl. 4.2', st: 'blocked', note: 'note' },
        { ...base, id: 'Cl. 4.3', st: 'blocked', note: '' },
        { ...base, id: 'Cl. 4.4', st: 'partial', note: '' },
      ],
      X: { drisk: [{ id: 'DR-01', t: 'Flood', act: 'Assess', h: 'tono', due: null, gate: true }, { id: 'DR-02', t: 'Fire', act: 'x', h: 'tono', due: null }] },
      gateTypes: {},
    });
    expect(gates.map((g) => [g.id, g.type, g.why])).toEqual([
      ['Cl. 4.1', ['Requirement', 'Persyaratan'], ['reason', 'reason']],
      ['Cl. 4.2', ['Requirement', 'Persyaratan'], ['note', 'note']],
      ['Cl. 4.3', ['Requirement', 'Persyaratan'], ['Blocked', 'Terblokir']],
      ['DR-01', ['drisk', 'drisk'], ['Assess', 'Assess']],
    ]);
  });
});

const ACT_STATUS = { verified: 'verified', complete: 'complete', progress: 'in_progress', ns: 'not_started', blocked: 'blocked', locked: 'not_started' } as const;

function activityRows(phases: readonly Phase[] | SampleOrgSnapshot['bundles'][string]['phases']): ActivityRow[] {
  return phases.flatMap((p) =>
    p.acts.map((a) => {
      const [phaseNo, activityNo] = a.no.split('.').map(Number) as [number, number];
      const verified = a.st === 'verified';
      return {
        id: a.key,
        updatedAt: new Date(0),
        phaseNo,
        activityNo,
        phaseName: p.n,
        isGatePhase: p.gate,
        title: a.title,
        status: ACT_STATUS[a.st],
        owner: a.owner === 'none' ? null : a.owner,
        outputDocumentCode: a.out,
        linkedDocumentCode: 'doc' in a && a.doc ? String(a.doc).split(':').pop()! : null,
        blockerGateItemRef: a.blocker,
        dueAt: verified || a.st === 'locked' ? null : a.date,
        verifiedAt: verified ? a.date : null,
        completedBy: null,
      };
    }),
  );
}

describe('phases (UI 2.7, D-13)', () => {
  for (const { org, ms, snapshot } of systems()) {
    it(`reproduces the phases of ${org}/${ms}, locked activities included`, () => {
      const expected = snapshot.bundles[ms]!.phases;
      const docs = new Set(snapshot.bundles[ms]!.docs.map((d) => d.id));
      const phases = derivePhases(activityRows(expected), { ms, documentCodes: docs });
      const wire = expected.map((p) => ({
        ...p,
        acts: p.acts.map(({ doc, ...a }) => ({ ...a, docId: doc ? String(doc).split(':').pop()! : null })),
      }));
      expect(phases).toEqual(wire);
    });
  }

  it('locks not-started activities while the previous phase is not fully verified, never in phase 1', () => {
    const row = (phaseNo: number, activityNo: number, status: ActivityRow['status']): ActivityRow => ({
      id: `${phaseNo}.${activityNo}`, updatedAt: new Date(0), phaseNo, activityNo, phaseName: `P${phaseNo}`, isGatePhase: phaseNo === 2, title: 't', status,
      owner: 'rina', outputDocumentCode: null, linkedDocumentCode: null, blockerGateItemRef: null, dueAt: '2026-10-10', verifiedAt: null, completedBy: null,
    });
    const phases = derivePhases([row(1, 1, 'not_started'), row(1, 2, 'verified'), row(2, 1, 'not_started'), row(2, 2, 'in_progress'), row(3, 1, 'not_started')], { ms: 'isms', documentCodes: new Set() });
    expect(phases.map((p) => p.acts.map((a) => a.st))).toEqual([['ns', 'verified'], ['locked', 'progress'], ['locked']]);
    expect(phases[1]!.acts[0]!.date).toBeNull();
    expect(currentPhaseNo(phases)).toBe(1);
  });
});

describe('portfolio counts (UI 2.8, UI 4.7)', () => {
  it('gives the sample reference numbers and card statistics of ndt', () => {
    const bundles = sample.snapshots.ndt!.bundles;
    const counts = Object.fromEntries(Object.entries(bundles).map(([ms, b]) => [ms, portfolioCounts(b as never)]));
    expect(Object.fromEntries(Object.entries(counts).map(([ms, c]) => [ms, [c.requirements, c.evidence, c.documents, c.chainItems, c.notPending, c.gateItems, c.criticalEvidence]]))).toEqual({
      isms: [93, 79, 22, 63, 24, 4, 3],
      qms: [28, 27, 10, 18, 5, 0, 0],
      bcms: [27, 11, 8, 25, 2, 3, 0],
      abms: [32, 2, 5, 35, 3, 1, 0],
    });
    expect(Object.fromEntries(Object.entries(counts).map(([ms, c]) => [ms, [c.gateItems, c.expiredDocuments, c.criticalEvidence, c.unverifiableEvidence, c.afterAudit]]))).toEqual({
      isms: [4, 5, 3, 3, 16],
      qms: [0, 1, 0, 0, 4],
      bcms: [3, 0, 0, 0, 0],
      abms: [1, 0, 0, 0, 0],
    });
  });
});

describe('My Tasks (UI 2.11, D-29)', () => {
  const ndt = sample.snapshots.ndt!;
  const sources = Object.entries(ndt.bundles).map(([ms, b]) => ({
    ms,
    auditDate: ndt.MS.find((m) => m.id === ms)!.audit?.date ?? null,
    items: b.chain.items as unknown as ChainItem[],
    reqs: b.reqs as unknown as Requirement[],
    refs: {},
  }));

  it('gives the sample counts of the four personas across the four systems', () => {
    const totals = Object.fromEntries(['rina', 'bagus', 'maya', 'hendra'].map((h) => [h, deriveTaskList(h, today, sources, []).counts.total]));
    expect(totals).toEqual({ rina: 3, bagus: 31, maya: 1, hendra: 3 });
  });

  it('leaves out requirements the person marked complete, and keeps those someone else completed', () => {
    const item = { key: 'isms:req:A.5.1', stage: 'control', kind: 'req', id: 'A.5.1', title: ['t', 't'], act: ['a', 'a'], h: 'bagus', due: null, st: 'pending', after: false, gate: false, up: [], down: [], q: '' } as ChainItem;
    const req = (by: string) => ({ id: 'A.5.1', st: 'complete' as const, owner: 'bagus', by });
    expect(heldChainItems('bagus', { ms: 'isms', auditDate: null, items: [item], reqs: [req('bagus')], refs: {} })).toEqual([]);
    expect(heldChainItems('bagus', { ms: 'isms', auditDate: null, items: [item], reqs: [req('rina')], refs: {} })).toEqual([item]);
  });

  it('counts overdue, this week and later as the UI groups them', () => {
    expect(taskCounts([{ st: 'overdue', due: '2026-09-01' }, { st: 'missing', due: null }, { st: 'pending', due: '2026-10-06' }, { st: 'pending', due: '2026-10-07' }, { st: 'pending', due: null }], today)).toEqual({
      total: 5, overdue: 2, week: 1, later: 2,
    });
  });

  it('merges stored tasks whose record is not one of the person’s chain items', () => {
    const refs = { 'isms:ev:EV-1': { module: 'surveillance' as const, entityType: 'evidence', id: '11111111-1111-4111-8111-111111111111', code: 'EV-1' } };
    const item = { key: 'isms:ev:EV-1', refKey: 'isms:ev:EV-1', stage: 'evidence', kind: 'ev', id: 'EV-1', title: ['t', 't'], act: ['a', 'a'], h: 'rina', due: '2026-10-01', st: 'pending', after: false, gate: false, up: [], down: [], q: '' } as ChainItem;
    const list = deriveTaskList('rina', today, [{ ms: 'isms', auditDate: '2026-10-05', items: [item], reqs: [], refs }], [
      { id: 'a', ms: 'isms', entityType: 'evidence', entityId: '11111111-1111-4111-8111-111111111111', entityCode: 'EV-1', title: ['x', 'y'], dueAt: null },
      { id: 'b', ms: 'isms', entityType: 'evidence', entityId: '22222222-2222-4222-8222-222222222222', entityCode: null, title: ['Fix', 'Perbaiki'], dueAt: '2026-10-09' },
    ]);
    expect(list.items.map((i) => [i.key, i.kind, i.st, i.after])).toEqual([
      ['isms:ev:EV-1', 'ev', 'pending', false],
      ['isms:task:b', 'task', 'pending', true],
    ]);
    expect(list.items[1]!.title).toEqual(['Fix', 'Perbaiki']);
  });
});
