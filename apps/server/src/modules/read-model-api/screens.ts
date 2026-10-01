// Per-screen projections of TS 9.2 (build plan D.3 "Read model per screen", D-05, TS 9.6). Every function reads one
// `ScreenData`: the system's rows, its snapshot derived by the WP-17 functions on the full data (`full`), and the
// same snapshot after `ScopePolicy.projectSnapshot` for the caller (`view`). Lists, counts and readiness numbers
// come from `view`, so every number of these endpoints equals the number the caller's `GET /ui/ms/{ms}` gives
// (one derivation per concept, TS 9.6); chain node statuses come from `full`, limited to the nodes the caller may see.
import {
  type ActivityItem, type ApplicabilityItem, type ApplicabilityQuery, type BusinessRole, type ChainItem, type ChainNode, type ChainResponse,
  type ClauseMaturity, type CycleItem, type DocumentItem, type DocumentsQuery, type DriftPattern, type EvidenceItem, type EvidenceQuery,
  type GateItemView, type ImplementationSummary, type NextAuditEvent, type Page, type PendingAggregate, type PendingPerson, type PendingRecord,
  type RecordDisplayStatus, type RecordRef, type StageReadiness, type StageRecordsQuery, type SummaryCard, type SurveillanceEvent, type UiMsSnapshot,
  BUSINESS_ROLES,
} from '@mscd/shared';
import { diffDays } from '../../common/dates';
import { etagOf } from '../../common/etag';
import { NotFoundError } from '../../common/problems';
import type { ScopeContext } from '../authz/scope-policy';
import {
  OVERVIEW_CLAUSES, currentPhaseNo, entryEvidenceState, integrityStatus, isUnverifiable, maturityLevel, maturityValues, openPerClause,
  stageRecords, thresholdsFor, type SystemData,
} from '../read-model';
import { matchesQuery, paginate } from './query';
import {
  CARD_LABELS, DOC_STATUS_LABELS, FRESHNESS_LABELS, INTEG_LABELS, NODE_MISSING, RECORD_STATE, REQ_STATUS_LABELS, UNASSIGNED, phaseText, pick,
  type Lang,
} from './texts';

type Bundle = UiMsSnapshot['bundle'];
type Requirement = Bundle['reqs'][number];
type Document = Bundle['docs'][number];
type Evidence = Bundle['evs'][number];
type StageDef = SystemData['stages'][number];
type ChainRecord = SystemData['records'][number];

const NONE = 'none';

/** A member of the organisation as the endpoints name holders. */
export interface Person {
  name: string;
  jobTitle: string | null;
}

/** Everything one request of a per-screen endpoint reads. */
export interface ScreenData {
  ms: string;
  lang: Lang;
  today: string;
  now: Date;
  scope: ScopeContext;
  /** The system's rows, loaded with the bundle. */
  system: SystemData & { bundle: NonNullable<SystemData['bundle']> };
  /** `buildSystemSnapshot` on the full data (D-04). */
  full: UiMsSnapshot;
  /** `full` after `ScopePolicy.projectSnapshot` for the caller. */
  view: UiMsSnapshot;
  /** Members of the organisation by handle. */
  people: ReadonlyMap<string, Person>;
  /** `MS[].unit` and `MS[].gateName` of the system. */
  unit: 'ctrl' | 'req';
  gateName: string | readonly [string, string] | undefined;
  /** Classification rules of `ScopePolicy` for a document or evidence code of the system. */
  documentVisible(code: string): boolean;
  evidenceVisible(code: string): boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------

/** External auditors never get holder names, due dates of pending work or pending data (D-34). */
function isAuditor(d: ScreenData): boolean {
  return d.scope.kind === 'external_auditor';
}

/** Display name of a handle (Unassigned for `none`). */
export function personName(d: ScreenData, handle: string | null | undefined): string {
  if (!handle || handle === NONE) return pick(UNASSIGNED, d.lang);
  return d.people.get(handle)?.name ?? handle;
}

function holderOf(d: ScreenData, handle: string | null | undefined): PendingRecord['holder'] {
  if (isAuditor(d) || !handle || handle === NONE) return null;
  const person = d.people.get(handle);
  return { handle, displayName: person?.name ?? handle, roleLabel: person?.jobTitle ?? '' };
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function stageOfSource(d: ScreenData, source: StageDef['source']): StageDef | undefined {
  return d.system.stages.find((s) => s.source === source);
}

function stageByKey(d: ScreenData, key: string): StageDef | undefined {
  return d.system.stages.find((s) => s.key === key);
}

function refOf(snapshot: UiMsSnapshot, key: string): RecordRef | undefined {
  return snapshot.refs[key];
}

/** Ref of a chain record of an entity stage, built from its row (open records also have one in the snapshot). */
function chainRecordRef(r: ChainRecord): RecordRef {
  return { module: 'audit', entityType: r.table, id: r.id, code: r.code, etag: etagOf(r.updatedAt) };
}

/** True when the record of a chain record row may be shown to the caller (owner scope; auditors see none). */
function chainRecordVisible(d: ScreenData, r: ChainRecord): boolean {
  if (d.scope.kind === 'external_auditor') return false;
  if (d.scope.kind === 'own') return r.holder === d.scope.handle;
  return true;
}

/** Stage of a business id: requirements, documents and evidence by their stage source, records by their stage. */
function stageIndex(d: ScreenData): Map<string, string> {
  const index = new Map<string, string>();
  const put = (code: string | null | undefined, stage: string | undefined) => {
    if (code && stage && !index.has(code)) index.set(code, stage);
  };
  const req = stageOfSource(d, 'applicability')?.key;
  const doc = stageOfSource(d, 'document')?.key;
  const ev = stageOfSource(d, 'evidence')?.key;
  for (const r of d.full.bundle.reqs) put(r.id, req);
  for (const x of d.full.bundle.docs) put(x.id, doc);
  for (const e of d.full.bundle.evs) {
    put(e.code, ev);
    put(`ev:${e.ctrl}`, ev);
  }
  for (const stage of d.system.stages) {
    for (const r of stageRecords(d.system, stage)) put(r.code, stage.key);
  }
  return index;
}

function links(index: ReadonlyMap<string, string>, ids: readonly string[]): { stage: string; id: string }[] {
  const out: { stage: string; id: string }[] = [];
  for (const id of ids) {
    const stage = id ? index.get(id) : undefined;
    if (stage) out.push({ stage, id });
  }
  return out;
}

function daysTo(d: ScreenData, due: string | null): number | null {
  return due ? diffDays(d.today, due) : null;
}

/** Evidence that cannot be verified, or whose band is expired or critical (the `ev` chain item rule, UI 2.3). */
function evidenceOpen(e: Evidence): boolean {
  return isUnverifiable(e.integ) || e.fresh === 'expired' || e.fresh === 'critical';
}

function evidenceState(e: Evidence, lang: Lang): string {
  return `${pick(FRESHNESS_LABELS[e.fresh], lang)}, ${pick(INTEG_LABELS[e.integ], lang)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Module 1: implementation
// ---------------------------------------------------------------------------------------------------------------

/** `GET /ms/{ms}/implementation/summary`: the five cards, the two evidence counts, phases and maturity (UI 2.5, 2.6, 2.7). */
export function implementationSummary(d: ScreenData): ImplementationSummary {
  const { reqs, docs, evs, gates, phases, chain } = d.view.bundle;
  const gateLabel = d.gateName ? `${pick(CARD_LABELS.gateItems, d.lang)}, ${pick(d.gateName, d.lang)}` : pick(CARD_LABELS.gateItems, d.lang);
  const cards: SummaryCard[] = [
    { key: 'implemented', label: pick(CARD_LABELS.implemented[d.unit], d.lang), count: reqs.filter((r) => r.st === 'implemented').length, total: reqs.length },
    { key: 'partial', label: pick(CARD_LABELS.partial, d.lang), count: reqs.filter((r) => r.st === 'partial' || r.st === 'complete').length },
    { key: 'gate_items', label: gateLabel, count: gates.length },
    { key: 'documents_approved', label: pick(CARD_LABELS.documentsApproved, d.lang), count: docs.filter((x) => x.st === 'approved').length, total: docs.length },
    { key: 'documents_expired', label: pick(CARD_LABELS.documentsExpired, d.lang), count: docs.filter((x) => x.st === 'expired').length },
  ];
  const overviewClause = new Map(d.system.stages.map((s) => [s.key, s.overviewClause]));
  const openFindings = d.system.findings.filter((f) => f.status !== 'closed' && ['major', 'minor', 'ofi'].includes(f.classification)).length;
  const open = openPerClause(chain.items, (stage) => overviewClause.get(stage) ?? 8, openFindings);
  const maturity: ClauseMaturity[] = OVERVIEW_CLAUSES.map((clause) => {
    const readiness = Math.max(0, Math.min(100, Math.round(d.system.readiness.get(clause) ?? 0)));
    return { clause, readiness, dimensions: maturityValues(readiness, open[clause] ?? 0).map(maturityLevel) };
  });
  return {
    cards,
    criticalEvidence: evs.filter((e) => e.fresh === 'critical').length,
    unverifiableEvidence: evs.filter((e) => isUnverifiable(e.integ)).length,
    currentPhase: currentPhaseNo(phases),
    phases: phases.map((p) => ({ no: p.no, name: p.n, gate: p.gate, total: p.total, counts: { ...p.c }, text: phaseText(p.c, p.total, d.lang) })),
    maturity,
  };
}

/** Group code of a requirement for the `group` filter: the theme code (`A.8`) or the clause number (`8`). */
function groupOf(r: Requirement): string {
  const first = r.theme.split(' ')[0] ?? '';
  return first === 'Clause' ? (r.theme.split(' ')[1] ?? '') : first;
}

/** Evidence ids of the system by applicability entry id (`evidence_target`). */
export type EntryEvidence = ReadonlyMap<string, readonly string[]>;

/** `GET /ms/{ms}/applicability` (UI 1.5 fields plus ref, last evidence, freshness and integrity of E.3). */
export function applicabilityPage(d: ScreenData, query: ApplicabilityQuery, entryEvidence: EntryEvidence): Page<ApplicabilityItem> {
  const entryByUiId = new Map<string, (typeof d.system.bundle.entries)[number]>();
  for (const entry of d.system.bundle.entries) {
    const id = entry.targetType === 'catalogue_item' ? entry.code : `Cl. ${entry.code}`;
    if (!entryByUiId.has(id)) entryByUiId.set(id, entry);
  }
  const evidenceById = new Map(d.system.bundle.evidence.map((e) => [e.id, e]));
  const periods = new Map(d.system.frequencies.map((f) => [f.code, f.periodDays]));
  const rows = d.view.bundle.reqs.filter((r) => {
    if (query.status && r.st !== query.status) return false;
    if (query.group && groupOf(r) !== query.group) return false;
    if (query.owner && r.owner !== query.owner) return false;
    return !query.q || matchesQuery(query.q, [r.id, r.title, r.owner ? personName(d, r.owner) : '', r.note]);
  });
  const items: ApplicabilityItem[] = [];
  for (const r of rows) {
    const ref = refOf(d.view, `${d.ms}:req:${r.id}`);
    if (!ref) continue;
    const entry = entryByUiId.get(r.id);
    const evidence = (entry ? (entryEvidence.get(entry.id) ?? []) : []).flatMap((id) => {
      const e = evidenceById.get(id);
      if (!e) return [];
      return [{ producedAt: e.producedAt, periodDays: periods.get(e.frequency) ?? 0, thresholds: thresholdsFor(d.system.bundle.thresholds, d.system.id, e.frequency), object: e.object }];
    });
    const state = evidence.length > 0 ? entryEvidenceState(evidence, d.today, d.now) : null;
    items.push({ ...r, ref, lastEvidence: state?.lastEvidenceAt ?? null, freshness: state?.freshnessStatus ?? null, integrity: state?.integrityStatus ?? null });
  }
  return paginate(items, query.page, query.pageSize);
}

/** `GET /ms/{ms}/documents`: the register with the requirements implementing each document. */
export function documentsPage(d: ScreenData, query: DocumentsQuery): Page<DocumentItem> {
  const typeByCode = new Map(d.system.bundle.documents.map((x) => [x.code, x.docType]));
  const implementing = new Map<string, string[]>();
  const visibleReqs = new Set(d.view.bundle.reqs.map((r) => r.id));
  for (const entry of d.system.bundle.entries) {
    const id = entry.targetType === 'catalogue_item' ? entry.code : `Cl. ${entry.code}`;
    if (!visibleReqs.has(id)) continue;
    for (const code of entry.documentCodes) {
      const list = implementing.get(code) ?? [];
      if (!list.includes(id)) list.push(id);
      implementing.set(code, list);
    }
  }
  const rows = d.view.bundle.docs.filter((x) => {
    if (query.status && x.st !== query.status) return false;
    if (query.type && typeByCode.get(x.id) !== query.type) return false;
    if (query.owner && x.owner !== query.owner) return false;
    if (query.due_within !== undefined && (!x.rev || diffDays(d.today, x.rev) > query.due_within)) return false;
    return !query.q || matchesQuery(query.q, [x.id, x.title, x.owner ? personName(d, x.owner) : '', x.tier]);
  });
  const items: DocumentItem[] = [];
  for (const x of rows) {
    const ref = refOf(d.view, `${d.ms}:doc:${x.id}`);
    if (ref) items.push({ ...x, ref, requirements: implementing.get(x.id) ?? [] });
  }
  return paginate(items, query.page, query.pageSize);
}

/**
 * `GET /ms/{ms}/gates`: the caller's gate items (A-27) with the activities they hold back: activities blocked by the
 * item, then the activities of the next gate phase that are not verified (BR-12: the phase cannot be verified while
 * gate items are open).
 */
export function gateItems(d: ScreenData): GateItemView[] {
  const phases = d.view.bundle.phases;
  const nextGatePhase = d.full.bundle.phases.find((p) => p.gate && p.c.verified < p.total);
  const gatePhaseActs = phases.find((p) => p.no === nextGatePhase?.no)?.acts.filter((a) => a.st !== 'verified') ?? [];
  const out: GateItemView[] = [];
  for (const g of d.view.bundle.gates) {
    const ref = g.key.startsWith('req:') ? refOf(d.view, `${d.ms}:req:${g.id}`) : refOf(d.view, `${d.ms}:x:${g.id}`);
    if (!ref) continue;
    const affectedKeys: string[] = [];
    for (const phase of phases) for (const a of phase.acts) if (a.blocker === g.id) affectedKeys.push(a.key);
    for (const a of gatePhaseActs) if (!affectedKeys.includes(a.key)) affectedKeys.push(a.key);
    const affected = affectedKeys.flatMap((key) => {
      const r = refOf(d.view, key);
      return r ? [r] : [];
    });
    out.push({ id: g.id, type: pick(g.type, d.lang), why: pick(g.why, d.lang), holder: isAuditor(d) ? NONE : g.h, due: g.due, key: g.key, ref, affected });
  }
  return out;
}

/** Stored activity fields the snapshot does not carry (D-30 copies from the template). */
export interface ActivityDetail {
  phaseNo: number;
  activityNo: number;
  clauseRef: string | null;
  expectedOutcome: string | null;
}

/** `GET /ms/{ms}/phases/{n}/activities`: one phase's activities with derived status (D-13), output document and ref. */
export function phaseActivities(d: ScreenData, n: number, details: readonly ActivityDetail[]): ActivityItem[] {
  if (!d.full.bundle.phases.some((p) => p.no === n)) throw new NotFoundError('Unknown phase');
  const phase = d.view.bundle.phases.find((p) => p.no === n);
  if (!phase) return [];
  const docs = new Map(d.view.bundle.docs.map((x) => [x.id, x]));
  const detail = new Map(details.map((x) => [`${x.phaseNo}.${x.activityNo}`, x]));
  const out: ActivityItem[] = [];
  for (const a of phase.acts) {
    const ref = refOf(d.view, a.key);
    if (!ref) continue;
    const doc = a.docId ? docs.get(a.docId) : a.out ? docs.get(a.out) : undefined;
    out.push({
      ...a,
      ref,
      clauseRef: detail.get(a.no)?.clauseRef ?? null,
      expectedOutcome: detail.get(a.no)?.expectedOutcome ?? null,
      outputDocument: doc ? { code: doc.id, title: doc.title, st: doc.st } : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Module 2: audit process
// ---------------------------------------------------------------------------------------------------------------

/** Stored event fields the loader does not carry. */
export interface EventDetail {
  id: string;
  type: NextAuditEvent['type'];
  outcome: SurveillanceEvent['outcome'];
}

/** TS 9.4: the first event scheduled on or after today. */
export function nextEventOf(d: ScreenData): SystemData['events'][number] | null {
  return [...d.system.events].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).find((e) => e.scheduledAt >= d.today) ?? null;
}

/** The chain hero numbers (UI 2.5): open items, overdue or missing, after audit, ready records. */
export function heroNumbers(d: ScreenData): NextAuditEvent['numbers'] {
  const { items, recs } = d.view.bundle.chain;
  return {
    open: items.length,
    overdueOrMissing: items.filter((i) => i.st !== 'pending').length,
    afterAudit: items.filter((i) => i.after).length,
    ready: Math.max(0, sum(Object.values(recs)) - items.length),
  };
}

/** `GET /ms/{ms}/audit/event/next`, or null (204) when no event is planned. */
export function nextAuditEvent(d: ScreenData, details: readonly EventDetail[]): NextAuditEvent | null {
  const next = nextEventOf(d);
  if (!next) return null;
  const detail = details.find((x) => x.id === next.id);
  return {
    id: next.id,
    type: detail?.type ?? 'surveillance',
    name: pick([next.nameEn, next.nameId], d.lang),
    shortLabel: next.shortLabel,
    scheduledAt: next.scheduledAt,
    daysLeft: diffDays(d.today, next.scheduledAt),
    auditDays: next.auditDays,
    leadAuditor: next.leadAuditorName,
    certificationBody: d.system.certificationBody,
    prepWindowDays: next.prepWindowDays,
    numbers: heroNumbers(d),
  };
}

/** `GET /ms/{ms}/audit/stages`: readiness per chain stage (UI 2.5 stage tabs, UI 2.9 stage table). */
export function stageReadiness(d: ScreenData): StageReadiness[] {
  const { items, recs } = d.view.bundle.chain;
  return d.system.stages.map((stage) => {
    const own = items.filter((i) => i.stage === stage.key);
    const rec = recs[stage.key] ?? 0;
    const ready = Math.max(0, rec - own.length);
    const upcoming = own.map((i) => i.due).filter((due): due is string => !!due && due >= d.today).sort();
    return {
      key: stage.key,
      label: pick([stage.labelEn, stage.labelId], d.lang),
      rec,
      open: own.length,
      pending: own.filter((i) => i.st === 'pending').length,
      overdue: own.filter((i) => i.st !== 'pending').length,
      after: own.filter((i) => i.after).length,
      ready,
      pct: rec > 0 ? Math.round((ready / rec) * 100) : 0,
      next: upcoming[0] ?? null,
      question: stage.questionEn,
    };
  });
}

interface Sources {
  index: Map<string, string>;
  reqs: Map<string, Requirement>;
  docs: Map<string, Document>;
  evs: Map<string, Evidence>;
  objects: Map<string, { repository: string; linkStatus: NonNullable<PendingRecord['file']>['linkStatus'] }>;
}

/** Repository names by slug, for `PendingRecord.file`. */
export type RepositoryNames = ReadonlyMap<string, string>;

function sources(d: ScreenData, repositories: RepositoryNames): Sources {
  const objects: Sources['objects'] = new Map();
  if (!isAuditor(d)) {
    for (const e of d.system.bundle.evidence) {
      if (e.object) objects.set(`ev:${e.code}`, { repository: repositories.get(e.object.repositorySlug) ?? e.object.repositorySlug, linkStatus: e.object.linkStatus });
    }
    for (const x of d.system.bundle.documents) {
      if (x.object) objects.set(`doc:${x.code}`, { repository: repositories.get(x.object.repositorySlug) ?? x.object.repositorySlug, linkStatus: x.object.linkStatus });
    }
  }
  return {
    index: stageIndex(d),
    reqs: new Map(d.full.bundle.reqs.map((r) => [r.id, r])),
    docs: new Map(d.full.bundle.docs.map((x) => [x.id, x])),
    evs: new Map(d.full.bundle.evs.map((e) => [e.code, e])),
    objects,
  };
}

/** TS 9.3 record of an open chain item. */
function openRecord(d: ScreenData, s: Sources, item: ChainItem): PendingRecord | null {
  const ref = refOf(d.view, item.refKey ?? item.key) ?? refOf(d.view, item.key);
  if (!ref) return null;
  let state: string;
  switch (item.kind) {
    case 'req':
    case 'soa': {
      const r = s.reqs.get(item.id);
      state = r ? pick(REQ_STATUS_LABELS[r.st], d.lang) : pick(RECORD_STATE.open, d.lang);
      break;
    }
    case 'doc': {
      const x = s.docs.get(item.id);
      state = x ? pick(DOC_STATUS_LABELS[x.st], d.lang) : pick(RECORD_STATE.open, d.lang);
      break;
    }
    case 'ev': {
      const e = s.evs.get(item.id);
      state = e ? evidenceState(e, d.lang) : pick(RECORD_STATE.open, d.lang);
      break;
    }
    default:
      state = pick(RECORD_STATE.open, d.lang);
  }
  const record: PendingRecord = {
    ref: { ...ref, stage: item.stage },
    title: pick(item.title, d.lang),
    status: item.st,
    state,
    action: pick(item.act, d.lang),
    holder: holderOf(d, item.h),
    dueAt: isAuditor(d) ? null : item.due,
    daysToDue: isAuditor(d) ? null : daysTo(d, item.due),
    afterAudit: item.after,
    upstream: links(s.index, item.up),
    downstream: links(s.index, item.down),
  };
  const file = item.kind === 'ev' || item.kind === 'doc' ? s.objects.get(`${item.kind}:${item.id}`) : undefined;
  if (file) record.file = file;
  return record;
}

/** TS 9.3 records of a stage that need no action (`ready`), visible to the caller. */
function readyRecords(d: ScreenData, s: Sources, stage: StageDef): PendingRecord[] {
  const out: PendingRecord[] = [];
  const base = (ref: RecordRef | undefined, rest: Omit<PendingRecord, 'ref' | 'status' | 'action' | 'afterAudit'>) => {
    if (ref) out.push({ ref: { ...ref, stage: stage.key }, status: 'ready', action: null, afterAudit: false, ...rest });
  };
  switch (stage.source) {
    case 'applicability':
      for (const r of d.view.bundle.reqs) {
        if (r.st !== 'implemented' && r.st !== 'na') continue;
        base(refOf(d.view, `${d.ms}:req:${r.id}`), {
          title: r.title, state: pick(REQ_STATUS_LABELS[r.st], d.lang), holder: holderOf(d, r.owner), dueAt: null, daysToDue: null,
          upstream: links(s.index, r.risks), downstream: links(s.index, [r.doc]),
        });
      }
      break;
    case 'document':
      for (const x of d.view.bundle.docs) {
        if (x.st !== 'approved') continue;
        const due = isAuditor(d) ? null : x.rev || null;
        const record = {
          title: x.title, state: pick(DOC_STATUS_LABELS[x.st], d.lang), holder: holderOf(d, x.owner), dueAt: due, daysToDue: daysTo(d, due),
          upstream: links(s.index, d.view.bundle.reqs.filter((r) => r.doc === x.id).map((r) => r.id)), downstream: [],
        };
        const file = s.objects.get(`doc:${x.id}`);
        base(refOf(d.view, `${d.ms}:doc:${x.id}`), file ? { ...record, file } : record);
      }
      break;
    case 'evidence':
      for (const e of d.view.bundle.evs) {
        if (evidenceOpen(e)) continue;
        const due = isAuditor(d) ? null : e.next;
        const record = {
          title: e.title, state: evidenceState(e, d.lang), holder: holderOf(d, e.owner), dueAt: due, daysToDue: daysTo(d, due),
          upstream: links(s.index, [e.ctrl]), downstream: [],
        };
        const file = s.objects.get(`ev:${e.code}`);
        base(refOf(d.view, `${d.ms}:ev:${e.code}`), file ? { ...record, file } : record);
      }
      break;
    case 'entity':
      for (const r of stageRecords(d.system, stage)) {
        if (r.pendingAction !== null || !chainRecordVisible(d, r)) continue;
        base(chainRecordRef(r), {
          title: r.title, state: pick(RECORD_STATE.ready, d.lang), holder: holderOf(d, r.holder), dueAt: null, daysToDue: null,
          upstream: links(s.index, r.up), downstream: links(s.index, r.down),
        });
      }
      break;
    default:
      // Justification stage: an entry that holds no gate needs nothing (UI 2.5 "soa: none").
      break;
  }
  return out;
}

/** `GET /ms/{ms}/audit/stages/{key}/records`: open items of the stage first, then ready records. */
export function stageRecordsPage(d: ScreenData, key: string, query: StageRecordsQuery, repositories: RepositoryNames): Page<PendingRecord> {
  const stage = stageByKey(d, key);
  if (!stage) throw new NotFoundError('Unknown chain stage');
  const s = sources(d, repositories);
  const open = d.view.bundle.chain.items.filter((i) => i.stage === key).flatMap((i) => openRecord(d, s, i) ?? []);
  const all = [...open, ...readyRecords(d, s, stage)];
  const rows = all.filter((r) => {
    if (query.status && r.status !== query.status) return false;
    if (query.owner && r.holder?.handle !== query.owner) return false;
    return !query.q || matchesQuery(query.q, [r.ref.code, r.title, r.holder?.displayName, r.action, r.state]);
  });
  return paginate(rows, query.page, query.pageSize);
}

/** Filters of `GET /ms/{ms}/audit/pending`. */
export interface PendingFilter {
  stage?: string;
  overdueOnly?: boolean;
}

function pendingItems(d: ScreenData, filter: PendingFilter): ChainItem[] {
  if (filter.stage && !stageByKey(d, filter.stage)) throw new NotFoundError('Unknown chain stage');
  return d.view.bundle.chain.items.filter((i) => (!filter.stage || i.stage === filter.stage) && (!filter.overdueOnly || i.st !== 'pending'));
}

/** One person's open items (TS 9.3 records). */
export function pendingOf(d: ScreenData, owner: string, filter: PendingFilter, page: { page: number; pageSize: number }, repositories: RepositoryNames): Page<PendingRecord> {
  const s = sources(d, repositories);
  const rows = pendingItems(d, filter)
    .filter((i) => i.h === owner)
    .flatMap((i) => openRecord(d, s, i) ?? []);
  return paginate(rows, page.page, page.pageSize);
}

/** Everyone's open items per holder (UI 2.5 "Pending per person"): sorted by overdue, then open, then handle. */
export function pendingPerPerson(d: ScreenData, filter: PendingFilter): PendingPerson[] {
  const byHolder = new Map<string, ChainItem[]>();
  for (const i of pendingItems(d, filter)) {
    const list = byHolder.get(i.h) ?? [];
    list.push(i);
    byHolder.set(i.h, list);
  }
  const out: PendingPerson[] = [...byHolder].map(([holder, items]) => {
    const stages: Record<string, number> = {};
    for (const i of items) stages[i.stage] = (stages[i.stage] ?? 0) + 1;
    return {
      holder,
      displayName: personName(d, holder),
      jobTitle: holder === NONE ? '' : (d.people.get(holder)?.jobTitle ?? ''),
      open: items.length,
      overdue: items.filter((i) => i.st !== 'pending').length,
      afterAudit: items.filter((i) => i.after).length,
      stages,
    };
  });
  return out.sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.holder.localeCompare(b.holder));
}

/**
 * `aggregate=unit`: open and overdue counts per stage and business role, without names (Top Management). A holder
 * counts under the first of their roles in `BUSINESS_ROLES` order; unassigned items and holders without a role in
 * the system count under `null`.
 */
export function pendingAggregate(d: ScreenData, filter: PendingFilter, rolesByHandle: ReadonlyMap<string, readonly BusinessRole[]>): PendingAggregate[] {
  const roleOf = (handle: string): BusinessRole | null => {
    const roles = rolesByHandle.get(handle) ?? [];
    return BUSINESS_ROLES.find((r) => roles.includes(r)) ?? null;
  };
  const counts = new Map<string, PendingAggregate>();
  for (const i of pendingItems(d, filter)) {
    const role = i.h === NONE ? null : roleOf(i.h);
    const key = `${i.stage}|${role ?? ''}`;
    const row = counts.get(key) ?? { stage: i.stage, role, open: 0, overdue: 0 };
    row.open += 1;
    if (i.st !== 'pending') row.overdue += 1;
    counts.set(key, row);
  }
  const stageOrder = new Map(d.system.stages.map((s, n) => [s.key, n]));
  const roleOrder = (role: BusinessRole | null) => (role === null ? BUSINESS_ROLES.length : BUSINESS_ROLES.indexOf(role));
  return [...counts.values()].sort((a, b) => (stageOrder.get(a.stage) ?? 0) - (stageOrder.get(b.stage) ?? 0) || roleOrder(a.role) - roleOrder(b.role));
}

// ---------------------------------------------------------------------------------------------------------------
// Golden thread (`GET /ms/{ms}/audit/chain`)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Codes the caller may see on a chain: everything for full readers and Top Management; for own-scoped roles only the
 * records they own or hold (D-04: other people's records, also those an own record references, are hidden); for
 * external auditors the requirements, documents and evidence of their projection. Documents and evidence hidden by
 * classification are never visible.
 */
function visibleCodes(d: ScreenData): (code: string) => boolean {
  const docCodes = new Set(d.full.bundle.docs.map((x) => x.id));
  const evCodes = new Set(d.full.bundle.evs.map((e) => e.code));
  const classified = (code: string) => (docCodes.has(code) && !d.documentVisible(code)) || (evCodes.has(code) && !d.evidenceVisible(code));
  if (d.scope.kind === 'full' || d.scope.kind === 'top_management') return (code) => !classified(code);
  const codes = new Set<string>();
  const add = (list: readonly (string | null | undefined)[]) => list.forEach((c) => c && codes.add(c));
  if (d.scope.kind === 'external_auditor') {
    for (const r of d.view.bundle.reqs) add([r.id]);
    for (const x of d.view.bundle.docs) add([x.id]);
    for (const e of d.view.bundle.evs) add([e.code]);
    return (code) => codes.has(code) && !classified(code);
  }
  const me = d.scope.handle;
  for (const r of d.full.bundle.reqs) if (r.owner === me) add([r.id]);
  for (const x of d.full.bundle.docs) if (x.owner === me) add([x.id]);
  for (const e of d.full.bundle.evs) if (e.owner === me) add([e.code]);
  for (const i of d.full.bundle.chain.items) if (i.h === me) add([i.id]);
  for (const r of d.system.records) if (r.holder === me) add([r.code]);
  return (code) => codes.has(code) && !classified(code);
}

/** The nodes of a chain from an anchor code (UI 2.10 golden thread resolution over stored chains and records). */
function chainNodes(d: ScreenData, anchor: string): { id: string; nodes: [string, string | null][] } | null {
  const lc = anchor.toLowerCase();
  const chains = d.system.chains;
  const stored = chains.find((c) => c.id.toLowerCase() === lc) ?? chains.find((c) => c.nodes.some(([, code]) => code !== null && code.toLowerCase() === lc));
  if (stored) return { id: stored.id, nodes: stored.nodes.map(([stage, code]) => [stage, code] as [string, string | null]) };
  const reqStage = stageOfSource(d, 'applicability')?.key;
  const soaStage = stageOfSource(d, 'justification')?.key;
  const docStage = stageOfSource(d, 'document')?.key;
  const evStage = stageOfSource(d, 'evidence')?.key;
  const riskStage = d.system.stages.find((s) => s.source === 'entity' && s.entityType === 'risk')?.key;
  const nodes: [string, string | null][] = [];
  const push = (stage: string | undefined, code: string | null) => {
    if (stage) nodes.push([stage, code]);
  };
  const reqs = d.full.bundle.reqs;
  const evidence = d.full.bundle.evs.find((e) => e.code.toLowerCase() === lc);
  const req = reqs.find((r) => r.id.toLowerCase() === lc) ?? (evidence ? reqs.find((r) => r.id === evidence.ctrl) : undefined);
  if (req) {
    if (d.unit === 'ctrl') {
      push(riskStage, req.risks[0] ?? null);
      push(reqStage, req.id);
      push(soaStage, req.id);
    } else {
      push(reqStage, req.id);
    }
    push(docStage, req.doc || null);
    push(evStage, evidence ? evidence.code : `ev:${req.id}`);
    return { id: evidence?.code ?? req.id, nodes };
  }
  const doc = d.full.bundle.docs.find((x) => x.id.toLowerCase() === lc);
  if (doc) {
    push(docStage, doc.id);
    for (const r of reqs.filter((c) => c.doc === doc.id).slice(0, 4)) push(reqStage, r.id);
    return { id: doc.id, nodes };
  }
  const record = d.system.records.find((r) => r.code.toLowerCase() === lc);
  if (record) {
    const stage = d.system.stages.find((s) => stageRecords(d.system, s).some((r) => r.id === record.id));
    push(stage?.key, record.code);
    return { id: record.code, nodes };
  }
  return null;
}

/** `GET /ms/{ms}/audit/chain?anchor_id=`: one chain; nodes outside the caller's scope come as `{stage, hidden: true}`. */
export function chainFrom(d: ScreenData, anchor: string): ChainResponse {
  const found = chainNodes(d, anchor);
  if (!found) throw new NotFoundError('No chain contains this record');
  const visible = visibleCodes(d);
  const items = d.full.bundle.chain.items;
  const reqs = new Map(d.full.bundle.reqs.map((r) => [r.id, r]));
  const docs = new Map(d.full.bundle.docs.map((x) => [x.id, x]));
  const evs = new Map(d.full.bundle.evs.map((e) => [e.code, e]));
  const records = new Map(d.system.records.map((r) => [r.code, r]));
  const auditor = isAuditor(d);
  const nodes: ChainNode[] = found.nodes.map(([stageKey, raw]) => {
    const stage = stageByKey(d, stageKey);
    const label = stage ? pick([stage.labelEn, stage.labelId], d.lang) : stageKey;
    const clause = stage?.clauseAtRisk ?? null;
    let code = raw;
    if (code?.startsWith('ev:')) {
      const ctrl = code.slice(3);
      const e = d.full.bundle.evs.find((x) => x.ctrl === ctrl);
      if (!e) {
        return { stage: stageKey, label, id: null, title: pick(NODE_MISSING.evidence, d.lang), status: 'missing', holder: null, due: null, clauseAtRisk: clause };
      }
      code = e.code;
    }
    if (!code) return { stage: stageKey, label, id: null, title: pick(NODE_MISSING.record, d.lang), status: 'missing', holder: null, due: null, clauseAtRisk: clause };
    if (!visible(code)) return { stage: stageKey, hidden: true };
    const item = items.find((i) => i.id === code);
    const status: RecordDisplayStatus = item ? item.st : 'ready';
    const owner = item?.h ?? reqs.get(code)?.owner ?? docs.get(code)?.owner ?? evs.get(code)?.owner ?? records.get(code)?.holder ?? null;
    const title = reqs.get(code)?.title ?? docs.get(code)?.title ?? evs.get(code)?.title ?? records.get(code)?.title ?? (item ? pick(item.title, d.lang) : code);
    const node: ChainNode = {
      stage: stageKey,
      label,
      id: code,
      title,
      status,
      holder: auditor || !owner || owner === NONE ? null : owner,
      due: auditor ? null : (item?.due ?? null),
      clauseAtRisk: status === 'overdue' || status === 'missing' ? clause : null,
    };
    const ref = reqs.has(code)
      ? refOf(d.full, `${d.ms}:req:${code}`)
      : docs.has(code)
        ? refOf(d.full, `${d.ms}:doc:${code}`)
        : evs.has(code)
          ? refOf(d.full, `${d.ms}:ev:${code}`)
          : records.has(code)
            ? chainRecordRef(records.get(code)!)
            : undefined;
    if (ref) node.ref = ref;
    return node;
  });
  if (!nodes.some((n) => !('hidden' in n) && n.id !== null)) throw new NotFoundError('No chain contains this record');
  return { anchor: found.id, nodes };
}

// ---------------------------------------------------------------------------------------------------------------
// Module 3: surveillance
// ---------------------------------------------------------------------------------------------------------------

/** A preparation task of an event with the BR-43 flag. */
export interface PrepDetail {
  id: string;
  updatedAt: Date;
  title: string;
  owner: string | null;
  dueAt: string;
  status: SurveillanceEvent['prep'][number]['status'];
  violatesBr43: boolean;
}

/** A finding of the system with its event and owner. */
export interface FindingDetail {
  id: string;
  updatedAt: Date;
  code: string;
  classification: SurveillanceEvent['findings'][number]['classification'];
  clauseRef: string | null;
  title: string;
  status: SurveillanceEvent['findings'][number]['status'];
  statusNote: string | null;
  source: string;
  auditEventId: string | null;
  owner: string | null;
}

/**
 * `GET /ms/{ms}/surveillance/events/{id}`: the event with its preparation checklist (own tasks for own-scoped roles,
 * none for external auditors) and its findings: those raised at the event, and for the next event the open
 * certification audit findings still to close.
 */
export function surveillanceEvent(d: ScreenData, id: string, details: readonly EventDetail[], prep: readonly PrepDetail[], findings: readonly FindingDetail[]): SurveillanceEvent {
  const event = d.system.events.find((e) => e.id === id);
  if (!event) throw new NotFoundError('Unknown audit event');
  const next = nextEventOf(d);
  const isNext = next?.id === event.id;
  const own = d.scope.kind === 'own';
  const detail = details.find((x) => x.id === event.id);
  const prepRows = isAuditor(d)
    ? []
    : prep
        .filter((p) => !own || p.owner === d.scope.handle)
        .map((p) => ({
          ref: { module: 'audit' as const, entityType: 'audit_prep_task', id: p.id, code: p.title, etag: etagOf(p.updatedAt) },
          title: p.title,
          owner: p.owner ?? NONE,
          dueAt: p.dueAt,
          status: p.status,
          violatesBr43: p.violatesBr43,
        }));
  const findingRows = findings
    .filter((f) => f.auditEventId === event.id || (isNext && f.source === 'certification_audit' && f.status !== 'closed'))
    .filter((f) => !own || f.owner === d.scope.handle)
    .map((f) => ({
      ref: { module: 'audit' as const, entityType: 'finding', id: f.id, code: f.code, etag: etagOf(f.updatedAt) },
      code: f.code,
      classification: f.classification,
      clause: f.clauseRef,
      title: f.title,
      status: f.status,
      note: f.statusNote,
    }));
  return {
    id: event.id,
    type: detail?.type ?? 'surveillance',
    name: pick([event.nameEn, event.nameId], d.lang),
    shortLabel: event.shortLabel,
    scheduledAt: event.scheduledAt,
    auditDays: event.auditDays,
    leadAuditor: event.leadAuditorName,
    expectedFocus: event.expectedFocus,
    outcome: detail?.outcome ?? null,
    outcomeSummary: event.outcomeSummary,
    next: isNext,
    past: event.scheduledAt < d.today,
    prep: prepRows,
    findings: findingRows,
  };
}

/** `GET /ms/{ms}/surveillance/cycle`: items of the requested (default the latest) certification cycle. */
export function cycleItems(d: ScreenData, cycleId: string | undefined): CycleItem[] {
  const rows = d.system.bundle.cycleItems;
  const id = cycleId ?? d.system.bundle.latestCycleId;
  if (cycleId && !rows.some((r) => r.cycleId === cycleId)) throw new NotFoundError('Unknown certification cycle');
  if (!id || isAuditor(d)) return [];
  const own = d.scope.kind === 'own';
  return rows
    .filter((r) => r.cycleId === id && (!own || r.owner === d.scope.handle))
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      ref: { module: 'surveillance' as const, entityType: 'cycle_requirement_status', id: r.id, code: r.requirementCode, etag: etagOf(r.updatedAt) },
      requirementCode: r.requirementCode,
      title: r.title,
      owner: r.owner ?? NONE,
      dueAt: r.dueAt,
      status: r.status,
      conditionNote: r.conditionNote ?? '',
    }));
}

/** Stored drift rule fields the loader does not carry. */
export interface DriftRuleDetail {
  code: string;
  severity: DriftPattern['severity'];
  message: string;
}

/**
 * `GET /ms/{ms}/surveillance/drift`: drift patterns with rows (stored rows, or the live lists of A.4 5.15), only
 * active ones unless `rule` names one. External auditors get none (G.5 `EaProjection`).
 */
export function driftPatterns(d: ScreenData, rule: string | undefined, details: readonly DriftRuleDetail[]): DriftPattern[] {
  const defs = [...d.system.driftDefs].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  if (rule && !defs.some((x) => x.code === rule)) throw new NotFoundError('Unknown drift rule');
  if (isAuditor(d)) return [];
  const own = d.scope.kind === 'own';
  const detail = new Map(details.map((x) => [x.code, x]));
  const evs = d.view.bundle.evs;
  const xRows = (stage: string): DriftPattern['rows'] =>
    (d.view.X[stage] ?? []).map((x) => {
      const ref = refOf(d.view, `${d.ms}:x:${x.id}`);
      return { ...(ref ? { ref } : {}), code: x.id, title: x.t, holder: x.h, dueAt: x.due };
    });
  const evRows = (list: readonly Evidence[]): DriftPattern['rows'] =>
    list.map((e) => {
      const ref = refOf(d.view, `${d.ms}:ev:${e.code}`);
      return { ...(ref ? { ref } : {}), code: e.code, title: e.title, holder: e.owner ?? NONE, dueAt: e.next };
    });
  const out: DriftPattern[] = [];
  for (const def of defs) {
    if (rule && def.code !== rule) continue;
    let rows: DriftPattern['rows'];
    switch (def.sourceKind) {
      case 'unverif':
        rows = evRows(evs.filter((e) => isUnverifiable(e.integ)));
        break;
      case 'nohash':
        rows = evRows(evs.filter((e) => e.integ === 'nohash'));
        break;
      case 'metric':
      case 'exercise':
        rows = xRows(def.sourceStage ?? def.sourceKind);
        break;
      default:
        rows = d.system.bundle.driftResults
          .filter((r) => r.ruleCode === def.code && (!own || r.holder === d.scope.handle))
          .sort((a, b) => a.position - b.position)
          .map((r) => {
            const ref = refOf(d.full, `${d.ms}:drift:${r.id}`);
            return { ...(ref ? { ref } : {}), code: r.entityCode, title: r.title, holder: r.holder ?? NONE, dueAt: r.dueAt, detectedAt: r.detectedOn };
          });
    }
    if (!rule && rows.length === 0) continue;
    const info = detail.get(def.code);
    out.push({
      code: def.code,
      label: pick([def.labelEn, def.labelId], d.lang),
      severity: info?.severity ?? 'warn',
      sourceKind: def.sourceKind,
      message: info?.message ?? '',
      rows,
    });
  }
  return out;
}

/** `GET /ms/{ms}/evidence`: evidence with next due, freshness, the UI integrity code and the A-05 status. */
export function evidencePage(d: ScreenData, query: EvidenceQuery): Page<EvidenceItem> {
  const rows = new Map(d.system.bundle.evidence.map((e) => [e.code, e]));
  const list = d.view.bundle.evs.filter((e) => {
    if (query.freshness && e.fresh !== query.freshness) return false;
    if (query.frequency && e.freq !== query.frequency) return false;
    if (query.owner && e.owner !== query.owner) return false;
    return !query.q || matchesQuery(query.q, [e.code, e.title, e.ctrl, e.owner ? personName(d, e.owner) : '']);
  });
  const items: EvidenceItem[] = [];
  for (const e of list) {
    const ref = refOf(d.view, `${d.ms}:ev:${e.code}`);
    if (!ref) continue;
    const row = rows.get(e.code);
    items.push({ ...e, ref, integrity: row ? integrityStatus(row.object, d.now) : null });
  }
  return paginate(items, query.page, query.pageSize);
}
