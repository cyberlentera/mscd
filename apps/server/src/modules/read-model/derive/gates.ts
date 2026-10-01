// Gate items of a system (build plan A-27, G.5 `bundle.gates`, UI 2.4, A.4 5.11): requirements that hold the gate,
// then every open chain record marked as a gate item. Derived from current state, so a reassignment shows.
import type { GateItem, Pair, Requirement, XRecord } from '@mscd/shared';
import { BLOCKED_REASON, NONE, REQUIREMENT_GATE_TYPE, same } from './text';

export interface GateInput {
  unit: 'ctrl' | 'req';
  /** Requirements with the stored gate reason (`applicability_entry.gate_reason`), when there is one. */
  reqs: readonly (Requirement & { gateReason?: string | null })[];
  /** Open records per stage, in stage order (`X[ms]`). */
  X: Readonly<Record<string, readonly XRecord[]>>;
  /** Gate type label per stage key (`traceability_chain_def.gate_type_label_*`); the stage key twice when absent. */
  gateTypes: Readonly<Record<string, Pair | null | undefined>>;
}

/** The gate type of a chain record of a stage: the pack's label pair, else the stage key in both languages. */
export function gateTypeOf(stage: string, gateTypes: GateInput['gateTypes']): Pair {
  const label = gateTypes[stage];
  return label ? [label[0], label[1]] : same(stage);
}

export function deriveGateItems(input: GateInput): GateItem[] {
  const out: GateItem[] = input.reqs
    .filter((c) => c.st === 'blocked')
    .map((c) => ({
      id: c.id,
      type: [...REQUIREMENT_GATE_TYPE[input.unit]] as Pair,
      why: c.gateReason ? same(c.gateReason) : c.note ? same(c.note) : ([...BLOCKED_REASON] as Pair),
      h: c.owner ?? NONE,
      due: null,
      key: `req:${c.id}`,
    }));
  for (const [stage, records] of Object.entries(input.X)) {
    for (const x of records) {
      if (!x.gate) continue;
      out.push({ id: x.id, type: gateTypeOf(stage, input.gateTypes), why: same(x.act), h: x.h, due: x.due, key: `x:${x.id}` });
    }
  }
  return out;
}
