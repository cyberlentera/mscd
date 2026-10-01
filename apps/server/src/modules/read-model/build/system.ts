// One system's derived records (build plan G.5, D-05): the `MS[]` entry, the stage definitions with their record
// counts, the open chain records (`X`), and, with the bundle rows, the full `GET /ui/ms/{ms}` snapshot with its
// record refs. Pure functions over the loaders' rows.
import type { ManagementSystem, Pair, Stage, UiMsSnapshot, XRecord } from '@mscd/shared';
import { deriveCycleItems, deriveEvents, deriveFocus, derivePast, derivePrep, findingCounts, nextAuditEvent, type EventLabels } from '../derive/audit';
import { deriveChain, type ChainDocument, type ChainRequirement, type ChainStage } from '../derive/chain';
import { deriveDocument, sortDocuments } from '../derive/documents';
import { deriveDriftPatterns } from '../derive/drift';
import { deriveEvidence } from '../derive/evidence';
import { deriveGateItems } from '../derive/gates';
import type { StageDef } from '../derive/inputs';
import { deriveManagementSystem, themeLabels } from '../derive/ms-fields';
import { stageEntry } from '../derive/org-formats';
import { derivePhases } from '../derive/phases';
import { RefCollector, recordRef } from '../derive/refs';
import { deriveRequirement, requirementId, requirementKey } from '../derive/requirements';
import { NONE, type PeopleNames } from '../derive/text';
import type { LoadedChainRecord, SystemCore, SystemData } from '../load/loader';

export interface BuildContext {
  today: string;
  now: Date;
  timeZone: string;
  /** Display names by handle (texts that name a person). */
  people: PeopleNames;
  /** System code by system id (documents' `usedBy`). */
  systemCodes: ReadonlyMap<string, string>;
}

/** The records of a chain stage (C.10): rows of the stage's table, risks of its profile, chain records of its key. */
export function stageRecords(system: Pick<SystemCore, 'records'>, stage: StageDef): LoadedChainRecord[] {
  if (stage.source !== 'entity' && stage.source !== 'justification') return [];
  const table = stage.entityType ?? 'chain_record';
  return system.records.filter((r) => {
    if (r.table !== table) return false;
    if (table === 'risk' && stage.riskProfileCode) return r.riskProfileCode === stage.riskProfileCode;
    if (table === 'chain_record') return r.stageKey === stage.key;
    return true;
  });
}

/** C.10 `rec` of a stage: records of entity stages, applicability entries of the justification stage. */
export function stageRecordCount(system: Pick<SystemCore, 'records' | 'entryCount'>, stage: StageDef): number {
  if (stage.source === 'justification') return system.entryCount;
  return stageRecords(system, stage).length;
}

/** G.5 `STAGES[ms]`. */
export function systemStages(system: Pick<SystemCore, 'stages' | 'records' | 'entryCount'>): Stage[] {
  return system.stages.map((stage) => stageEntry(stage, stageRecordCount(system, stage)));
}

/** G.5 `X[ms]`: the open records of every entity and justification stage, in stage and position order. */
export function openRecords(system: Pick<SystemCore, 'stages' | 'records'>): Record<string, (XRecord & { recordId: string; table: string; updatedAt: Date })[]> {
  const X: Record<string, (XRecord & { recordId: string; table: string; updatedAt: Date })[]> = {};
  for (const stage of system.stages) {
    const open = stageRecords(system, stage)
      .filter((r) => r.pendingAction !== null)
      .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code));
    if (open.length === 0) continue;
    X[stage.key] = open.map((r) => {
      const x: XRecord & { recordId: string; table: string; updatedAt: Date } = {
        id: r.code,
        t: r.title,
        act: r.pendingAction!,
        h: r.holder ?? NONE,
        due: r.actionDueAt,
        recordId: r.id,
        table: r.table,
        updatedAt: r.updatedAt,
      };
      if (r.gate) x.gate = true;
      if (r.up.length) x.up = [...r.up];
      if (r.down.length) x.down = [...r.down];
      return x;
    });
  }
  return X;
}

/** Strips the loader fields of `openRecords` (wire `XRecord`). */
function wireX(X: ReturnType<typeof openRecords>): Record<string, XRecord[]> {
  return Object.fromEntries(Object.entries(X).map(([stage, list]) => [stage, list.map(({ recordId: _r, table: _t, updatedAt: _u, ...x }) => x)]));
}

/** G.5 `MS[]` entry of a system. */
export function systemFields(system: SystemCore, today: string): ManagementSystem {
  return deriveManagementSystem({
    slug: system.slug,
    code: system.code,
    scope: system.scope,
    certificationBody: system.certificationBody,
    color: system.color,
    display: system.display,
    active: system.active,
    target: system.target,
    labels: system.labels,
    primaryManager: system.primaryManager,
    nextEvent: nextAuditEvent(system.events, today),
    readiness: system.readiness,
    findings: findingCounts(system.findings),
    alerts: system.alerts,
    defaultRepository: { slug: system.defaultRepository.slug, adapter: system.defaultRepository.adapter },
    defaultRoutingMode: system.defaultRoute?.mode ?? null,
    approver: system.approver,
  });
}

/** Everything `GET /ui/ms/{ms}` returns for a system, before scoping (D-04: derived on the full data). */
export function buildSystemSnapshot(system: SystemData, ctx: BuildContext): UiMsSnapshot {
  const rows = system.bundle;
  if (!rows) throw new Error(`System ${system.slug} was loaded without its bundle rows`);
  const ms = system.slug;
  const fields = systemFields(system, ctx.today);
  const refs = new RefCollector();
  const unit = fields.unit;
  const themes = themeLabels(system.labels);

  // Requirements (G.5 bundle.reqs) with the stored chain fields.
  const reqs: (ChainRequirement & { gateReason: string | null })[] = rows.entries.map((entry) => {
    const req = deriveRequirement(entry, themes);
    refs.add(ms, 'req', req.id, recordRef('req', 'applicability_entry', entry.id, req.id, entry.updatedAt));
    refs.add(ms, 'soa', req.id, recordRef('soa', 'applicability_entry', entry.id, req.id, entry.updatedAt));
    return {
      ...req,
      actionDueAt: entry.actionDueAt,
      justificationHolder: entry.justificationHolder,
      justificationDueAt: entry.justificationDueAt,
      gateReason: entry.gateReason,
    };
  });
  const entryIds = new Map(rows.entries.map((e) => [e.id, { id: requirementId(e.targetType, e.code), key: requirementKey(e.code) }]));

  // Documents (G.5 bundle.docs).
  const docs: ChainDocument[] = sortDocuments(rows.documents).map((d) => {
    refs.add(ms, 'doc', d.code, recordRef('doc', 'document', d.id, d.code, d.updatedAt));
    return {
      ...deriveDocument(d, { ms, msId: system.id, today: ctx.today, docTypeLabels: system.docTypes, systemCodes: ctx.systemCodes }),
      pendingHolder: d.pendingHolder,
      pendingDueAt: d.pendingDueAt,
    };
  });

  // Evidence (G.5 bundle.evs).
  const frequencies = new Map(system.frequencies.map((f) => [f.code, f]));
  const evs = rows.evidence.map((e) => {
    refs.add(ms, 'ev', e.code, recordRef('ev', 'evidence', e.id, e.code, e.updatedAt));
    return deriveEvidence(e, { msId: system.id, today: ctx.today, timeZone: ctx.timeZone, frequencies, thresholds: rows.thresholds, entries: entryIds });
  });

  // Open chain records (G.5 X) and the chain.
  const openX = openRecords(system);
  for (const list of Object.values(openX)) {
    for (const x of list) refs.add(ms, 'x', x.id, recordRef('x', x.table, x.recordId, x.id, x.updatedAt));
  }
  const X = wireX(openX);
  const chainStages: ChainStage[] = systemStages(system);
  const chain = deriveChain({
    ms,
    today: ctx.today,
    auditDate: fields.audit?.date ?? null,
    stages: chainStages,
    reqs,
    docs,
    evs,
    X,
    people: ctx.people,
    frequencyLabels: new Map(system.frequencies.map((f) => [f.code, [f.labelEn, f.labelId] as Pair])),
  });
  const gateTypes = Object.fromEntries(system.stages.map((s) => [s.key, s.gateTypeLabel]));
  const gates = deriveGateItems({ unit, reqs, X, gateTypes });

  // Phases (G.5 bundle.phases).
  const phases = derivePhases(rows.activities, { ms, documentCodes: new Set(docs.map((d) => d.id)) });
  for (const a of rows.activities) {
    const no = `${a.phaseNo}.${a.activityNo}`;
    refs.add(ms, 'act', no, recordRef('act', 'implementation_activity_progress', a.id, no, a.updatedAt));
  }

  // Certification cycle (G.5 EVENTS, FOCUS, PREP, PAST, CYCLE_ITEMS, DRIFT).
  const next = nextAuditEvent(system.events, ctx.today);
  const labels = (system.display.eventLabels ?? {}) as EventLabels;
  const PREP = derivePrep(rows.prepTasks, next);
  for (const p of rows.prepTasks) {
    if (next && p.auditEventId === next.id) refs.add(ms, 'prep', p.id, recordRef('prep', 'audit_prep_task', p.id, p.title, p.updatedAt));
  }
  const CYCLE_ITEMS = deriveCycleItems(rows.cycleItems, rows.latestCycleId);
  for (const c of rows.cycleItems) {
    if (c.cycleId === rows.latestCycleId) refs.add(ms, 'cycle', c.id, recordRef('cycle', 'cycle_requirement_status', c.id, c.requirementCode, c.updatedAt));
  }
  const DRIFT = deriveDriftPatterns(system.driftDefs, rows.driftResults);
  for (const r of rows.driftResults) {
    refs.add(ms, 'drift', r.id, recordRef('drift', 'drift_result', r.id, r.entityCode, r.updatedAt ?? ctx.now));
  }

  return {
    ms,
    bundle: {
      reqs: reqs.map(({ actionDueAt: _a, justificationHolder: _h, justificationDueAt: _d, gateReason: _g, ...req }) => req),
      docs: docs.map(({ pendingHolder: _h, pendingDueAt: _d, ...doc }) => doc),
      evs,
      chain,
      gates,
      phases,
    },
    X,
    EVENTS: deriveEvents(system.events, ctx.today, labels),
    FOCUS: deriveFocus(next),
    PREP,
    PAST: derivePast(system.findings),
    CYCLE_ITEMS,
    DRIFT,
    refs: refs.refs,
  };
}
