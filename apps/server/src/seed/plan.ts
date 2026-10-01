// Chain records of the demo seed (build plan G.6 `X[ms][stage]`, G.7 fillers, C.10). Pure functions: they decide
// which records every entity stage of a system gets, so that the stage ends up with exactly the sample's `rec`
// records, and check that no code is written twice where a code must be unique.
import type { SampleOrgSnapshot, SampleXRecord } from './snapshot';

/** Tables of entity stages (C.10) and of explicit chain records. */
export type ChainTable =
  | 'context_issue'
  | 'risk'
  | 'risk_treatment'
  | 'metric'
  | 'quality_objective'
  | 'prioritized_activity'
  | 'business_impact_analysis'
  | 'exercise'
  | 'business_associate'
  | 'chain_record';

/** Tables whose `code` is unique per organisation across systems (shareable records, C.6). */
export const ORG_UNIQUE_TABLES: ReadonlySet<ChainTable> = new Set(['context_issue', 'risk', 'metric']);

/** A chain stage of the system's framework version (`ref.traceability_chain_def`). */
export interface ChainStageDef {
  stageKey: string;
  position: number;
  source: 'entity' | 'applicability' | 'justification' | 'document' | 'evidence';
  entityType: string | null;
  riskProfileCode: string | null;
}

/** A regression detector rule of the pack (`ref.drift_rule_def`). */
export interface DriftRuleDef {
  code: string;
  sourceStage: string | null;
  sourceKind: string;
}

export type RecordOrigin = 'x' | 'chain' | 'requirement_risk' | 'drift' | 'titles' | 'filler';

export interface PlannedRecord {
  system: string;
  stage: string;
  table: ChainTable;
  code: string;
  title: string;
  /** Pending action (open record); null for a ready record. */
  action: string | null;
  /** Holder handle; null for Unassigned or when the sample names nobody. */
  holder: string | null;
  due: string | null;
  gate: boolean;
  up: string[];
  down: string[];
  /** Position within the stage (open records first, in sample order). */
  position: number;
  origin: RecordOrigin;
  riskProfileCode: string | null;
  /** A risk listed by a `stale_risk` drift rule (assessed 400 days ago, G.7). */
  staleRisk: boolean;
}

export interface SystemChainPlan {
  system: string;
  /** Entity stages with their records, in stage order. */
  stages: { stage: string; table: ChainTable; rec: number; prefix: string; records: PlannedRecord[] }[];
  /** Explicit records of the justification stage (for example SOA-01), kept in `chain_record`. */
  justification: PlannedRecord[];
}

export class SeedPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPlanError';
  }
}

/** The table of an entity stage: its `entity_type` (C.10). */
function tableOf(def: ChainStageDef): ChainTable {
  const tables: readonly string[] = [
    'context_issue', 'risk', 'risk_treatment', 'metric', 'quality_objective', 'prioritized_activity', 'business_impact_analysis', 'exercise',
    'business_associate', 'chain_record',
  ];
  if (!def.entityType || !tables.includes(def.entityType)) throw new SeedPlanError(`Stage ${def.stageKey} has no seedable entity type (${def.entityType})`);
  return def.entityType as ChainTable;
}

/** A code with its trailing digits removed (`R-031` gives `R-`, `CI-Q04` gives `CI-Q`). */
export function codePrefix(code: string): string {
  return code.replace(/\d+$/, '');
}

export interface PlanInput {
  /** The organisation's snapshot (its systems only). */
  snapshot: SampleOrgSnapshot;
  /** Systems of the organisation, in order. */
  systems: readonly string[];
  /** Chain stages per system, from the system's active framework version. */
  stageDefs: Readonly<Record<string, readonly ChainStageDef[]>>;
  /** Drift rules per system, from the system's active framework version. */
  driftDefs: Readonly<Record<string, readonly DriftRuleDef[]>>;
  /**
   * Chains of every sample system (the full sample, not only this organisation's systems), so a `TITLES` code is
   * placed in the system whose chain holds it and skipped when the organisation does not run that system.
   */
  allChains: Readonly<Record<string, readonly { id: string; nodes: readonly (readonly [string, string])[] }[]>>;
  /** The primary MS Manager of each system (owner of ready records the sample gives no owner). */
  primaryManager: Readonly<Record<string, string>>;
}

/**
 * Plans the chain records of an organisation (G.7): the open records of `X`, then ready records for every code of
 * the stage that appears in `CHAINS`, in requirement `risks`, in `DRIFT` rows or in `TITLES`, then numbered fillers
 * `<prefix>F01`, `<prefix>F02`, ... until the stage has `rec` records. Throws `SeedPlanError` for an unknown code, a
 * stage with more records than `rec`, or a code written twice where it must be unique.
 */
export function planChainRecords(input: PlanInput): SystemChainPlan[] {
  const plans = input.systems.map((system) => planSystem(input, system));
  assertNoDuplicates(plans);
  return plans;
}

function planSystem(input: PlanInput, system: string): SystemChainPlan {
  const { snapshot } = input;
  const defs = input.stageDefs[system];
  if (!defs) throw new SeedPlanError(`No chain stages for system ${system}`);
  const sampleStages = snapshot.STAGES[system] ?? [];
  const xRecords = snapshot.X[system] ?? {};
  const chains = snapshot.CHAINS[system] ?? [];
  const entityDefs = defs.filter((d) => d.source === 'entity').sort((a, b) => a.position - b.position);

  // Prefix of each entity stage: its first X record, else its first code in CHAINS, else STAGEKEY- (G.7).
  const prefixes = new Map<string, string>();
  for (const def of entityDefs) {
    const first = (xRecords[def.stageKey] ?? [])[0]?.id ?? chains.flatMap((c) => c.nodes).find(([stage]) => stage === def.stageKey)?.[1];
    prefixes.set(def.stageKey, first ? codePrefix(first) : `${def.stageKey.toUpperCase()}-`);
  }
  const chainStageOf = new Map<string, string>();
  for (const chain of chains) for (const [stage, code] of chain.nodes) if (prefixes.has(stage)) chainStageOf.set(code, stage);
  /** Stage of a code: from CHAINS node pairs, else from the stage prefixes; null when no stage claims it. */
  const stageOf = (code: string): string | null => {
    const fromChain = chainStageOf.get(code);
    if (fromChain) return fromChain;
    const matching = [...prefixes].filter(([, prefix]) => codePrefix(code) === prefix).map(([stage]) => stage);
    if (matching.length > 1) throw new SeedPlanError(`Code ${code} of system ${system} matches the prefixes of stages ${matching.join(', ')}`);
    return matching[0] ?? null;
  };
  const requireStage = (code: string, from: string): string => {
    const stage = stageOf(code);
    if (!stage) throw new SeedPlanError(`Unknown code ${code} in ${from} of system ${system}: no chain stage claims it`);
    return stage;
  };

  const records = new Map<string, PlannedRecord[]>(entityDefs.map((d) => [d.stageKey, []]));
  const seen = new Set<string>();
  const add = (stage: string, record: Omit<PlannedRecord, 'system' | 'stage' | 'table' | 'position' | 'riskProfileCode' | 'staleRisk'> & { staleRisk?: boolean }) => {
    const def = entityDefs.find((d) => d.stageKey === stage)!;
    const key = `${stage}:${record.code}`;
    const list = records.get(stage)!;
    if (seen.has(key)) {
      if (record.staleRisk) {
        const existing = list.find((r) => r.code === record.code)!;
        existing.staleRisk = true;
        if (!existing.holder && record.holder) existing.holder = record.holder;
      }
      return;
    }
    seen.add(key);
    list.push({
      ...record,
      system,
      stage,
      table: tableOf(def),
      position: list.length,
      riskProfileCode: def.riskProfileCode,
      staleRisk: record.staleRisk ?? false,
    });
  };

  // 1. Open records of X, in sample order.
  for (const def of entityDefs) {
    for (const x of xRecords[def.stageKey] ?? []) add(def.stageKey, openRecord(x));
  }
  // 2. Ready records for the codes the sample names elsewhere.
  const readyTitle = (code: string, fallback?: string) => snapshot.TITLES[code] ?? fallback ?? `Ready record ${code}`;
  for (const chain of chains) {
    for (const [stage, code] of chain.nodes) {
      if (records.has(stage)) add(stage, readyRecord(code, readyTitle(code), null, 'chain'));
    }
  }
  const bundle = snapshot.bundles[system];
  for (const req of bundle?.reqs ?? []) {
    for (const code of req.risks) add(requireStage(code, `the risks of ${req.id}`), readyRecord(code, readyTitle(code), null, 'requirement_risk'));
  }
  const driftDefs = input.driftDefs[system] ?? [];
  for (const rule of snapshot.DRIFT[system] ?? []) {
    if (!rule.rows) continue;
    const def = driftDefs.find((d) => d.code === rule.id);
    if (!def) throw new SeedPlanError(`Drift rule ${rule.id} of system ${system} is not in the pack`);
    // Rows of rules about something other than chain records (management review inputs) are not records.
    if (!def.sourceStage || !records.has(def.sourceStage)) continue;
    for (const [code, title, holder] of rule.rows) {
      const stage = requireStage(code, `drift rule ${rule.id}`);
      add(stage, { ...readyRecord(code, readyTitle(code, title), holder === 'none' ? null : holder, 'drift'), staleRisk: def.sourceKind === 'stale_risk' });
    }
  }
  // TITLES holds the titles of chain records of every sample system: a code belongs to the system whose chain
  // holds it, and is skipped in organisations that do not run that system.
  for (const code of Object.keys(snapshot.TITLES)) {
    const owner = Object.entries(input.allChains).find(([, list]) => list.some((c) => c.nodes.some(([, n]) => n === code)));
    if (!owner) throw new SeedPlanError(`Unknown code ${code} in TITLES: no chain of the sample holds it`);
    if (owner[0] !== system) continue;
    const stage = chainStageOf.get(code);
    if (stage) add(stage, readyRecord(code, readyTitle(code), null, 'titles'));
  }

  // 3. Fillers up to the sample's record count of the stage.
  const stages = entityDefs.map((def) => {
    const sample = sampleStages.find((s) => s.id === def.stageKey);
    const rec = sample?.rec ?? 0;
    const list = records.get(def.stageKey)!;
    if (list.length > rec) {
      throw new SeedPlanError(`Stage ${def.stageKey} of system ${system} would have ${list.length} records, more than its ${rec} (STAGES.rec)`);
    }
    const prefix = prefixes.get(def.stageKey)!;
    const used = new Set(list.map((r) => r.code));
    for (let n = 1; list.length < rec; n++) {
      const code = `${prefix}F${String(n).padStart(2, '0')}`;
      if (used.has(code)) continue;
      used.add(code);
      add(def.stageKey, readyRecord(code, `Ready record ${code}`, null, 'filler'));
    }
    for (const record of list) if (!record.action && !record.holder) record.holder = input.primaryManager[system] ?? null;
    return { stage: def.stageKey, table: tableOf(def), rec, prefix, records: list };
  });

  // Explicit records of the justification stage (SOA-01): open chain records of that stage (C.10).
  const justification: PlannedRecord[] = [];
  for (const def of defs.filter((d) => d.source === 'justification')) {
    (xRecords[def.stageKey] ?? []).forEach((x, position) => {
      justification.push({ ...openRecord(x), system, stage: def.stageKey, table: 'chain_record', position, riskProfileCode: null, staleRisk: false });
    });
  }
  return { system, stages, justification };
}

function openRecord(x: SampleXRecord): Omit<PlannedRecord, 'system' | 'stage' | 'table' | 'position' | 'riskProfileCode' | 'staleRisk'> {
  return {
    code: x.id,
    title: x.t,
    action: x.act,
    holder: x.h === 'none' ? null : x.h,
    due: x.due ?? null,
    gate: x.gate === true,
    up: [...(x.up ?? [])],
    down: [...(x.down ?? [])],
    origin: 'x',
  };
}

function readyRecord(code: string, title: string, holder: string | null, origin: RecordOrigin): Omit<PlannedRecord, 'system' | 'stage' | 'table' | 'position' | 'riskProfileCode' | 'staleRisk'> {
  return { code, title, action: null, holder, due: null, gate: false, up: [], down: [], origin };
}

/** Codes are unique per organisation for shareable tables and per system for the others (C.6); stop on any clash. */
function assertNoDuplicates(plans: readonly SystemChainPlan[]): void {
  const owners = new Map<string, string[]>();
  for (const plan of plans) {
    for (const stage of plan.stages) {
      for (const record of stage.records) {
        const scope = ORG_UNIQUE_TABLES.has(record.table) ? record.table : `${record.table}@${plan.system}`;
        const key = `${scope}:${record.code}`;
        owners.set(key, [...(owners.get(key) ?? []), `${plan.system}.${stage.stage}`]);
      }
    }
  }
  const duplicates = [...owners].filter(([, where]) => where.length > 1).map(([key, where]) => `${key.replace(/@.*?:/, ':')} (${where.join(', ')})`);
  if (duplicates.length > 0) throw new SeedPlanError(`The seed would write these codes twice: ${duplicates.join('; ')}`);
}
