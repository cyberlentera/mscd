// Chain record planning of the demo seed (G.7): open records, ready records for the codes the sample names elsewhere,
// numbered fillers with the stage prefix, and the errors for unknown codes, too many records and duplicate codes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { codePrefix, planChainRecords, SeedPlanError, type ChainStageDef, type DriftRuleDef, type PlanInput } from '../../../src/seed/plan';
import { SYSTEM_PACKS } from '../../../src/seed/ref-data';
import { loadSampleSnapshot, type SampleOrgSnapshot } from '../../../src/seed/snapshot';

const SOURCES = path.resolve(__dirname, '../../../../../packs/sources');
const sample = loadSampleSnapshot();

function stageDefs(packId: string): ChainStageDef[] {
  const rows = parse(readFileSync(path.join(SOURCES, packId, 'chain.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
  return rows.map((r) => ({
    stageKey: r.stage_key!,
    position: Number(r.position),
    source: r.source as ChainStageDef['source'],
    entityType: r.entity_type || null,
    riskProfileCode: r.risk_profile_code || null,
  }));
}

function driftDefs(packId: string): DriftRuleDef[] {
  const rules = JSON.parse(readFileSync(path.join(SOURCES, packId, 'drift_rules.json'), 'utf8')) as { code: string; source_stage: string | null; source_kind: string }[];
  return rules.map((r) => ({ code: r.code, sourceStage: r.source_stage, sourceKind: r.source_kind }));
}

function inputOf(org: 'ndt' | 'bsd' | 'rmn', snapshot: SampleOrgSnapshot = sample.snapshots[org]!): PlanInput {
  const systems = snapshot.MS.map((m) => m.id);
  return {
    snapshot,
    systems,
    stageDefs: Object.fromEntries(systems.map((s) => [s, stageDefs(SYSTEM_PACKS[s]!.active)])),
    driftDefs: Object.fromEntries(systems.map((s) => [s, driftDefs(SYSTEM_PACKS[s]!.active)])),
    allChains: sample.snapshots.ndt!.CHAINS,
    primaryManager: Object.fromEntries(snapshot.MS.map((m) => [m.id, m.mgr])),
  };
}

/** A deep copy of a sample snapshot to change in a test. */
const copy = (org: 'ndt' | 'bsd' | 'rmn'): SampleOrgSnapshot => structuredClone(sample.snapshots[org]!);

describe('chain record plan of the demo seed (G.7)', () => {
  it('removes trailing digits for the stage prefix', () => {
    expect(['R-031', 'CI-09', 'CI-Q04', 'CI-B02', 'BIA-03', 'SOA-01'].map(codePrefix)).toEqual(['R-', 'CI-', 'CI-Q', 'CI-B', 'BIA-', 'SOA-']);
  });

  it('gives every entity stage exactly STAGES.rec records: open X records, named ready records, then fillers', () => {
    const plans = planChainRecords(inputOf('ndt'));
    for (const plan of plans) {
      for (const stage of plan.stages) {
        expect(stage.records.length, `${plan.system} ${stage.stage}`).toBe(stage.rec);
        expect(stage.records.map((r) => r.position)).toEqual(stage.records.map((_, i) => i));
      }
    }
    const isms = plans.find((p) => p.system === 'isms')!;
    const risk = isms.stages.find((s) => s.stage === 'risk')!;
    expect(risk.prefix).toBe('R-');
    expect(risk.records.slice(0, 5).map((r) => [r.code, r.origin, r.action !== null])).toEqual([
      ['R-031', 'x', true], ['R-014', 'x', true], ['R-022', 'x', true], ['R-027', 'x', true], ['R-035', 'x', true],
    ]);
    const byCode = new Map(risk.records.map((r) => [r.code, r]));
    expect(byCode.get('R-003')).toMatchObject({ origin: 'chain', title: 'Unauthorised access to customer environments', holder: 'rina', staleRisk: false });
    expect(byCode.get('R-019')).toMatchObject({ origin: 'requirement_risk', title: 'Ready record R-019', holder: 'rina' });
    // R-009 is named by a requirement first and by the stale-risk drift rule: one record, stale, owned by the drift holder.
    expect(byCode.get('R-009')).toMatchObject({ origin: 'requirement_risk', holder: 'dewi', staleRisk: true });
    expect(byCode.get('R-005')).toMatchObject({ origin: 'drift', title: 'Data centre power failure', holder: 'bagus', staleRisk: true });
    expect(risk.records.filter((r) => r.staleRisk).map((r) => r.code).sort()).toEqual(['R-005', 'R-009', 'R-011', 'R-017', 'R-020', 'R-029']);
    expect(risk.records.filter((r) => r.origin === 'filler').map((r) => r.code)).toEqual(Array.from({ length: 24 }, (_, i) => `R-F${String(i + 1).padStart(2, '0')}`));
    expect(risk.records.find((r) => r.code === 'R-031')).toMatchObject({ holder: 'rina', gate: true, due: null, riskProfileCode: 'information_security' });
    // Records the sample assigns to nobody stay unassigned; ready records get the primary MS Manager.
    const treatment = isms.stages.find((s) => s.stage === 'treatment')!;
    expect(treatment.records.find((r) => r.code === 'T-031')).toMatchObject({ holder: null, action: 'Assign owner and plan treatment' });
    expect(treatment.records.find((r) => r.code === 'T-F01')).toMatchObject({ holder: 'rina', action: null, title: 'Ready record T-F01' });
    expect(isms.justification.map((r) => [r.code, r.stage, r.table, r.gate])).toEqual([['SOA-01', 'soa', 'chain_record', true]]);
    const qms = plans.find((p) => p.system === 'qms')!;
    expect(qms.stages.find((s) => s.stage === 'context')!.records.map((r) => r.code)).toEqual(['CI-Q04', 'CI-Q01', ...Array.from({ length: 7 }, (_, i) => `CI-QF0${i + 1}`)]);
    expect(qms.stages.find((s) => s.stage === 'risk')!.records.map((r) => r.riskProfileCode)).toEqual(Array(21).fill('quality'));
    const abms = plans.find((p) => p.system === 'abms')!;
    expect(abms.stages.map((s) => [s.stage, s.prefix, s.records.length])).toEqual([['context', 'CONTEXT-', 0], ['brisk', 'BRISK-', 0], ['associate', 'ASSOCIATE-', 0]]);
  });

  it('places TITLES codes in the system whose chain holds them and skips systems the organisation does not run', () => {
    const plans = planChainRecords(inputOf('rmn'));
    expect(plans.map((p) => p.system)).toEqual(['isms']);
    const codes = plans[0]!.stages.flatMap((s) => s.records.map((r) => r.code));
    expect(codes).toContain('CI-02');
    expect(codes).not.toContain('CI-Q01');
    expect(codes).not.toContain('ACT-04');
  });

  it('stops on a code no stage claims', () => {
    const snapshot = copy('rmn');
    snapshot.bundles.isms!.reqs[0]!.risks = ['ZZ-001'];
    expect(() => planChainRecords(inputOf('rmn', snapshot))).toThrow(/Unknown code ZZ-001 in the risks of A\.5\.1 of system isms/);
    const titles = copy('rmn');
    titles.TITLES['QQ-01'] = 'Not in any chain';
    expect(() => planChainRecords(inputOf('rmn', titles))).toThrow(/Unknown code QQ-01 in TITLES/);
  });

  it('stops when a stage would have more records than STAGES.rec', () => {
    const snapshot = copy('rmn');
    snapshot.STAGES.isms!.find((s) => s.id === 'metric')!.rec = 3;
    expect(() => planChainRecords(inputOf('rmn', snapshot))).toThrow(SeedPlanError);
    expect(() => planChainRecords(inputOf('rmn', snapshot))).toThrow(/Stage metric of system isms would have 6 records, more than its 3/);
  });

  it('stops before writing a code twice where codes are unique per organisation, naming the duplicates', () => {
    const snapshot = copy('ndt');
    snapshot.X.qms!.context![0]!.id = 'CI-09'; // the ISMS context issue
    expect(() => planChainRecords(inputOf('ndt', snapshot))).toThrow(/would write these codes twice: context_issue:CI-09 \(isms\.context, qms\.context\)/);
  });

  it('uses the first chain code for a stage without X records, else the stage key', () => {
    const snapshot = copy('rmn');
    delete snapshot.X.isms!.metric;
    const plans = planChainRecords(inputOf('rmn', snapshot));
    const metric = plans[0]!.stages.find((s) => s.stage === 'metric')!;
    expect(metric.prefix).toBe('M-');
    expect(metric.records.map((r) => r.code).slice(0, 3)).toEqual(['M-07', 'M-03', 'M-02']);
    expect(metric.records).toHaveLength(24);
  });
});
