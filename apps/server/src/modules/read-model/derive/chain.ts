// Chain items and stage denominators of a system (build plan G.5 `bundle.chain`, C.10, D-12, UI 2.3). The rules
// are the sample's `chain(d)` over stored state: requirement items take their due date from `action_due_at`,
// justification items their holder and due date from the justification fields, documents their holder and due date
// from the pending review assignment (else owner and review date).
import type { ChainItem, Document, Evidence, ItemStatus, Pair, Requirement, StageSrc, XRecord } from '@mscd/shared';
import { diffDays } from '../../../common/dates';
import { isMissingFile, isUnverifiable } from './integrity';
import {
  DOCUMENT_ACTION, JUSTIFICATION_ACTION, NONE, REQUIREMENT_ACTION, applicabilityEntryTitle, personName, relinkAction, same,
  submitEvidenceAction, verifyOutputAction, type PeopleNames,
} from './text';

/** A chain stage as the derivation needs it (`STAGES[ms]` entry plus the C.10 record count). */
export interface ChainStage {
  id: string;
  src?: StageSrc;
  q: string;
  /** Record count of entity and justification stages (C.10). */
  rec?: number;
}

/** A requirement with the stored chain fields (`action_due_at`, justification holder and due date). */
export interface ChainRequirement extends Requirement {
  actionDueAt: string | null;
  justificationHolder?: string | null;
  justificationDueAt?: string | null;
}

/** A document with its pending review assignment (holder and due date of the `doc` chain item). */
export interface ChainDocument extends Document {
  pendingHolder?: string | null;
  pendingDueAt?: string | null;
}

export interface ChainInput {
  ms: string;
  today: string;
  /** Date of the system's next audit event (`MS.audit.date`), for `after`. */
  auditDate: string | null;
  stages: readonly ChainStage[];
  reqs: readonly ChainRequirement[];
  docs: readonly ChainDocument[];
  evs: readonly Evidence[];
  /** Open records per stage (`X[ms]`). */
  X: Readonly<Record<string, readonly XRecord[]>>;
  people: PeopleNames;
  /** Frequency labels by code (`FREQ`). */
  frequencyLabels: ReadonlyMap<string, Pair>;
}

export interface ChainResult {
  items: ChainItem[];
  recs: Record<string, number>;
}

/** D-12: `missing` without holder and due date (or a missing source), `overdue` when the due date is past, else `pending`. */
export function chainItemStatus(input: { holder: string; due: string | null; missing?: boolean }, today: string): ItemStatus {
  if (input.missing || (!input.due && input.holder === NONE)) return 'missing';
  if (input.due && diffDays(today, input.due) < 0) return 'overdue';
  return 'pending';
}

/** `after`: the due date is after the date of the next audit (UI 2.3). */
export function dueAfterAudit(due: string | null, auditDate: string | null): boolean {
  return !!(due && auditDate && due > auditDate);
}

interface ItemOptions {
  missing?: boolean;
  gate?: boolean;
  up?: readonly string[];
  down?: readonly string[];
  refKey?: string;
}

/** UI 2.3 chain items and `recs` of one system. */
export function deriveChain(input: ChainInput): ChainResult {
  const { ms, today, auditDate, people } = input;
  const items: ChainItem[] = [];
  const recs: Record<string, number> = {};
  const make = (stage: ChainStage, kind: ChainItem['kind'], id: string, title: Pair, act: Pair, holder: string, due: string | null, o: ItemOptions = {}) => {
    const item: ChainItem = {
      key: `${ms}:${kind}:${id}`,
      stage: stage.id,
      kind,
      id,
      title,
      act,
      h: holder,
      due,
      st: chainItemStatus({ holder, due, missing: o.missing }, today),
      after: dueAfterAudit(due, auditDate),
      gate: !!o.gate,
      up: [...(o.up ?? [])],
      down: [...(o.down ?? [])],
      q: stage.q,
    };
    if (o.refKey) item.refKey = o.refKey;
    items.push(item);
  };
  const explicit = (stage: ChainStage) => {
    for (const x of input.X[stage.id] ?? []) {
      make(stage, 'x', x.id, same(x.t), same(x.act), x.h, x.due, { gate: x.gate, up: x.up, down: x.down });
    }
  };

  for (const stage of input.stages) {
    switch (stage.src) {
      case 'req':
        recs[stage.id] = input.reqs.length;
        for (const c of input.reqs) {
          if (c.st === 'implemented' || c.st === 'na') continue;
          const act = c.st === 'complete' ? verifyOutputAction(personName(people, c.by || c.owner)) : REQUIREMENT_ACTION[c.st]!;
          const due = c.st === 'blocked' ? null : c.actionDueAt;
          make(stage, 'req', c.id, same(c.title), act, c.owner ?? NONE, due, {
            missing: c.st === 'blocked',
            gate: c.gate,
            up: c.risks,
            down: [c.doc],
            refKey: `${ms}:req:${c.id}`,
          });
        }
        break;
      case 'soa':
        recs[stage.id] = stage.rec ?? input.reqs.length;
        for (const c of input.reqs) {
          if (c.st !== 'blocked') continue;
          make(stage, 'soa', c.id, applicabilityEntryTitle(c.title), JUSTIFICATION_ACTION, c.justificationHolder ?? c.owner ?? NONE, c.justificationDueAt ?? null, {
            missing: true,
            gate: true,
            down: [c.id],
          });
        }
        explicit(stage);
        break;
      case 'doc':
        recs[stage.id] = input.docs.length;
        for (const doc of input.docs) {
          if (doc.st === 'approved') continue;
          const up = input.reqs.filter((c) => c.doc === doc.id).slice(0, 3).map((c) => c.id);
          make(stage, 'doc', doc.id, same(`${doc.title}, v${doc.ver}`), DOCUMENT_ACTION[doc.st], doc.pendingHolder ?? doc.owner ?? NONE, doc.pendingDueAt ?? (doc.rev || null), {
            up,
            refKey: `${ms}:doc:${doc.id}`,
          });
        }
        break;
      case 'ev':
        recs[stage.id] = input.evs.length;
        for (const e of input.evs) {
          const bad = isUnverifiable(e.integ);
          const stale = e.fresh === 'expired' || e.fresh === 'critical';
          if (!bad && !stale) continue;
          const act = bad ? relinkAction(e.integ) : submitEvidenceAction(input.frequencyLabels.get(e.freq) ?? same(e.freq));
          make(stage, 'ev', e.code, same(`${e.title}, ${e.ctrl}`), act, e.owner ?? NONE, e.next, {
            missing: isMissingFile(e.integ),
            up: [e.ctrl],
            refKey: `${ms}:ev:${e.code}`,
          });
        }
        break;
      default:
        recs[stage.id] = stage.rec ?? (input.X[stage.id] ?? []).length;
        explicit(stage);
    }
  }
  return { items, recs };
}
