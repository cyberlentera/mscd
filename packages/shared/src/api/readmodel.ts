// Area `readmodel` (owner from wave 10: WP-32): the per-screen read endpoints of TS 9.2 (D.3 "Read model per screen").
// Every endpoint is a projection of the WP-17 derivation functions, filtered by ScopePolicy; texts are one string
// in the language of Accept-Language (D.1 Language), and records carry a ref (A-21, TS 9.3).
import { z } from 'zod';
import {
  AuditEventType, AuditOutcome, BusinessRole, DocStatus, DriftSeverity, DriftSourceKind, FindingClassification,
  FindingStatus, FreshnessStatus, IntegrityStatus, LinkStatus, ReqStatus, TaskProgressStatus,
} from '../enums.js';
import { Activity, Document, Evidence, Requirement } from '../ui/records.js';
import {
  EXAMPLE_ACTIVITY, EXAMPLE_DOCUMENT, EXAMPLE_EVIDENCE, EXAMPLE_REF, EXAMPLE_REQUIREMENT,
} from '../examples.js';
import {
  FreqId, IsoDate, MsParams, MsRecordParams, PersonId, QueryBoolean, RecordRef, StageKey, Uuid, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

/** Chain record display status of TS 6.9: the chain item statuses plus `ready`. */
export const RECORD_DISPLAY_STATUSES = ['ready', 'pending', 'overdue', 'missing'] as const;
export const RecordDisplayStatus = z.enum(RECORD_DISPLAY_STATUSES).meta({ id: 'RecordDisplayStatus', description: 'Chain record display status (TS 6.9)' });
export type RecordDisplayStatus = z.infer<typeof RecordDisplayStatus>;

const Search = z.string().trim().min(1).max(100);
const Count = z.int().min(0);

// ---------------------------------------------------------------------------------------------------------------
// Implementation (Module 1)
// ---------------------------------------------------------------------------------------------------------------

export const SUMMARY_CARD_KEYS = ['implemented', 'partial', 'gate_items', 'documents_approved', 'documents_expired'] as const;

export const SummaryCard = named(
  'SummaryCard',
  z.object({ key: z.enum(SUMMARY_CARD_KEYS), label: z.string(), count: Count, total: Count.optional() }),
  'One of the five summary cards of the implementation overview',
  { valid: [{ key: 'implemented', label: 'Controls implemented', count: 61, total: 93 }], invalid: [{ key: 'other', label: 'x', count: 1 }, { key: 'partial', label: 'x', count: -1 }] },
);
export type SummaryCard = z.infer<typeof SummaryCard>;

const PhaseCounts = z.object({ verified: Count, complete: Count, progress: Count, blocked: Count, ns: Count, locked: Count });

export const PhaseSummary = named(
  'PhaseSummary',
  z.object({ no: z.int().min(1), name: z.string(), gate: z.boolean(), total: Count, counts: PhaseCounts, text: z.string() }),
  'One phase of the implementation overview with its derived text',
  { valid: [{ no: 4, name: 'Risk assessment & SoA', gate: true, total: 9, counts: { verified: 5, complete: 1, progress: 1, blocked: 1, ns: 1, locked: 0 }, text: '5 of 9 verified, 1 blocked' }], invalid: [{ no: 4, name: 'x', gate: true, total: 9, counts: {}, text: '' }] },
);
export type PhaseSummary = z.infer<typeof PhaseSummary>;

export const ClauseMaturity = named(
  'ClauseMaturity',
  z.object({ clause: z.int().min(4).max(10), readiness: z.int().min(0).max(100), dimensions: z.array(z.int().min(0).max(4)).length(4) }),
  'Readiness of one Harmonized Structure clause and its four maturity values (A.4 5.14)',
  { valid: [{ clause: 6, readiness: 88, dimensions: [4, 3, 3, 4] }], invalid: [{ clause: 11, readiness: 88, dimensions: [4, 3, 3, 4] }, { clause: 6, readiness: 88, dimensions: [4] }] },
);
export type ClauseMaturity = z.infer<typeof ClauseMaturity>;

export const GateConsistency = named(
  'GateConsistency',
  z.object({
    gatePhases: z.array(z.int().min(1)),
    blockedActivities: Count,
    openGateItems: Count,
    flagged: z.boolean(),
    messages: z.object({ en: z.string(), id: z.string() }).optional(),
  }),
  'BR-46 consistency of the critical gate phases: blocked activities against open gate items; flagged when they differ and the rule is active',
  {
    valid: [
      { gatePhases: [4], blockedActivities: 4, openGateItems: 4, flagged: false },
      { gatePhases: [4], blockedActivities: 3, openGateItems: 4, flagged: true, messages: { en: 'The number of blocked activities does not match the open blocking items. Check the blocking references.', id: 'Jumlah aktivitas yang terblokir tidak sesuai dengan item penghambat yang terbuka. Periksa rujukan pemblokirannya.' } },
    ],
    invalid: [{ gatePhases: [4], blockedActivities: -1, openGateItems: 4, flagged: false }, { gatePhases: [4], blockedActivities: 1, openGateItems: 4 }],
  },
);
export type GateConsistency = z.infer<typeof GateConsistency>;

export const ImplementationSummary = named(
  'ImplementationSummary',
  z.object({
    cards: z.array(SummaryCard).length(5),
    criticalEvidence: Count,
    unverifiableEvidence: Count,
    currentPhase: z.int().min(1).nullable(),
    phases: z.array(PhaseSummary),
    maturity: z.array(ClauseMaturity),
    gateConsistency: GateConsistency.optional(),
  }),
  'GET /ms/{ms}/implementation/summary: five cards, the two evidence counts of A.4 5.13, phases with derived text, maturity per clause and, for readers with the full view of the system, the BR-46 gate consistency flag',
  {
    valid: [{
      cards: [
        { key: 'implemented', label: 'Controls implemented', count: 61, total: 93 }, { key: 'partial', label: 'Partially implemented', count: 18 },
        { key: 'gate_items', label: 'Blocking items, Risk & SoA', count: 4 }, { key: 'documents_approved', label: 'Documents approved', count: 14, total: 22 },
        { key: 'documents_expired', label: 'Documents expired', count: 5 },
      ],
      criticalEvidence: 3, unverifiableEvidence: 3, currentPhase: 9, phases: [], maturity: [{ clause: 4, readiness: 100, dimensions: [4, 4, 4, 4] }],
      gateConsistency: { gatePhases: [4], blockedActivities: 4, openGateItems: 4, flagged: false },
    }],
    invalid: [{ cards: [], criticalEvidence: 0, unverifiableEvidence: 0, currentPhase: null, phases: [], maturity: [] }],
  },
);
export type ImplementationSummary = z.infer<typeof ImplementationSummary>;

export const ApplicabilityQuery = named(
  'ApplicabilityQuery',
  z.strictObject({ ...pageQueryShape, status: ReqStatus.optional(), group: z.string().max(20).optional(), q: Search.optional(), owner: PersonId.optional() }),
  'GET /ms/{ms}/applicability query',
  { valid: [{}, { status: 'partial', group: 'A.8', q: 'backup', owner: 'bagus', page: '1' }], invalid: [{ status: 'partially_implemented' }, { frequency: 'monthly' }] },
);
export type ApplicabilityQuery = z.infer<typeof ApplicabilityQuery>;

export const ApplicabilityItem = named(
  'ApplicabilityItem',
  z.object({
    ...Requirement.shape,
    ref: RecordRef,
    lastEvidence: IsoDate.nullable(),
    freshness: FreshnessStatus.nullable(),
    integrity: IntegrityStatus.nullable(),
  }),
  'Applicability item: requirement fields of UI 1.5 plus ref, last evidence date, freshness and integrity',
  {
    valid: [{ ...EXAMPLE_REQUIREMENT, ref: { ...EXAMPLE_REF, module: 'implementation', entityType: 'applicability_entry', code: 'A.8.13' }, lastEvidence: '2026-05-31', freshness: 'critical', integrity: 'broken' }],
    invalid: [{ ...EXAMPLE_REQUIREMENT, lastEvidence: null, freshness: null, integrity: null }, { ...EXAMPLE_REQUIREMENT, ref: EXAMPLE_REF, lastEvidence: null, freshness: null, integrity: 'fine' }],
  },
);
export type ApplicabilityItem = z.infer<typeof ApplicabilityItem>;

export const DocumentsQuery = named(
  'DocumentsQuery',
  z.strictObject({
    ...pageQueryShape, status: DocStatus.optional(), type: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(), q: Search.optional(),
    owner: PersonId.optional(), due_within: z.coerce.number().int().min(0).max(3660).optional(),
  }),
  'GET /ms/{ms}/documents query; due_within is a number of days',
  { valid: [{}, { status: 'expired', type: 'procedure', due_within: '30' }], invalid: [{ status: 'in_review' }, { due_within: '-1' }] },
);
export type DocumentsQuery = z.infer<typeof DocumentsQuery>;

export const DocumentItem = named(
  'DocumentItem',
  z.object({ ...Document.shape, ref: RecordRef, requirements: z.array(z.string()) }),
  'Document register row: document fields of UI 1.6 plus ref and the requirements it implements',
  {
    valid: [{ ...EXAMPLE_DOCUMENT, ref: { ...EXAMPLE_REF, module: 'implementation', entityType: 'document', code: 'PRC-07' }, requirements: ['A.5.15', 'A.8.2'] }],
    invalid: [{ ...EXAMPLE_DOCUMENT, requirements: [] }],
  },
);
export type DocumentItem = z.infer<typeof DocumentItem>;

export const GateItemView = named(
  'GateItemView',
  z.object({
    id: z.string(), type: z.string(), why: z.string(), holder: PersonId, due: IsoDate.nullable(), key: z.string(), ref: RecordRef, affected: z.array(RecordRef),
  }),
  'Gate item with the records it holds back (activities of the gate phase)',
  {
    valid: [{ id: 'A.8.12', type: 'Control', why: 'Justification missing', holder: 'dewi', due: null, key: 'req:A.8.12', ref: { ...EXAMPLE_REF, entityType: 'applicability_entry', code: 'A.8.12' }, affected: [] }],
    invalid: [{ id: 'A.8.12', type: ['Control', 'Kontrol'], why: 'x', holder: 'dewi', due: null, key: 'req:A.8.12', ref: EXAMPLE_REF, affected: [] }],
  },
);
export type GateItemView = z.infer<typeof GateItemView>;

export const PhaseParams = named('PhaseParams', z.strictObject({ ms: MsParams.shape.ms, n: z.coerce.number().int().min(1).max(99) }), 'Path parameters {ms} and phase number {n}', {
  valid: [{ ms: 'isms', n: '4' }, { ms: 'isms', n: 4 }],
  invalid: [{ ms: 'isms', n: '0' }, { ms: 'isms', n: 'four' }],
});
export type PhaseParams = z.infer<typeof PhaseParams>;

export const ActivityItem = named(
  'ActivityItem',
  z.object({
    ...Activity.shape,
    ref: RecordRef,
    clauseRef: z.string().nullable(),
    expectedOutcome: z.string().nullable(),
    outputDocument: z.object({ code: z.string(), title: z.string(), st: DocStatus }).nullable(),
  }),
  'Phase activity with derived status (locked per D-13), output document and ref',
  {
    valid: [{ ...EXAMPLE_ACTIVITY, ref: { ...EXAMPLE_REF, module: 'implementation', entityType: 'implementation_activity_progress', code: '4.5' }, clauseRef: null, expectedOutcome: 'Select Annex A controls: approved and recorded in the register', outputDocument: { code: 'SOA-01', title: 'Statement of Applicability', st: 'review' } }],
    invalid: [{ ...EXAMPLE_ACTIVITY, clauseRef: null, expectedOutcome: null, outputDocument: null }],
  },
);
export type ActivityItem = z.infer<typeof ActivityItem>;

// ---------------------------------------------------------------------------------------------------------------
// Audit process (Module 2)
// ---------------------------------------------------------------------------------------------------------------

export const NextAuditEvent = named(
  'NextAuditEvent',
  z.object({
    id: Uuid, type: AuditEventType, name: z.string(), shortLabel: z.string(), scheduledAt: IsoDate, daysLeft: z.int(), auditDays: Count.nullable(),
    leadAuditor: z.string().nullable(), certificationBody: z.string().nullable(), prepWindowDays: Count,
    numbers: z.object({ open: Count, overdueOrMissing: Count, afterAudit: Count, ready: Count }),
  }),
  'Next audit event (TS 9.4) and the four readiness numbers of the audit hero',
  {
    valid: [{ id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', type: 'surveillance', name: 'Surveillance audit 1', shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', daysLeft: 44, auditDays: 2, leadAuditor: 'Ir. Dwi Hartanto, IRCA LA', certificationBody: 'PT Sertifikasi Nusantara', prepWindowDays: 60, numbers: { open: 63, overdueOrMissing: 21, afterAudit: 4, ready: 120 } }],
    invalid: [{ id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', type: 'audit', name: 'x', shortLabel: 'x', scheduledAt: '2026-11-12', daysLeft: 1, auditDays: 1, leadAuditor: null, certificationBody: null, prepWindowDays: 60, numbers: { open: 0, overdueOrMissing: 0, afterAudit: 0, ready: 0 } }],
  },
);
export type NextAuditEvent = z.infer<typeof NextAuditEvent>;

export const StageReadiness = named(
  'StageReadiness',
  z.object({
    key: StageKey, label: z.string(), rec: Count, open: Count, pending: Count, overdue: Count, after: Count, ready: Count,
    pct: z.int().min(0).max(100), next: IsoDate.nullable(), question: z.string(),
  }),
  'Readiness of one chain stage (D.3: rec, open, pending, overdue, after, ready, pct, next, question)',
  { valid: [{ key: 'risk', label: 'Risk', rec: 38, open: 5, pending: 3, overdue: 1, after: 1, ready: 33, pct: 87, next: '2026-09-10', question: 'Show me how this risk was identified and assessed.' }], invalid: [{ key: 'risk', label: 'Risk', rec: 38, open: 5, pending: 3, overdue: 1, after: 1, ready: 33, pct: 101, next: null, question: '' }] },
);
export type StageReadiness = z.infer<typeof StageReadiness>;

export const StageParams = named('StageParams', z.strictObject({ ms: MsParams.shape.ms, key: StageKey }), 'Path parameters {ms} and stage {key}', {
  valid: [{ ms: 'isms', key: 'risk' }],
  invalid: [{ ms: 'isms', key: 'Risk' }],
});
export type StageParams = z.infer<typeof StageParams>;

export const StageRecordsQuery = named(
  'StageRecordsQuery',
  z.strictObject({ ...pageQueryShape, status: RecordDisplayStatus.optional(), q: Search.optional(), owner: PersonId.optional() }),
  'GET /ms/{ms}/audit/stages/{key}/records query',
  { valid: [{}, { status: 'overdue', owner: 'bagus' }], invalid: [{ status: 'late' }] },
);
export type StageRecordsQuery = z.infer<typeof StageRecordsQuery>;

const StageLink = z.object({ stage: StageKey, id: z.string() });

export const PendingRecord = named(
  'PendingRecord',
  z.object({
    ref: RecordRef.extend({ stage: StageKey }),
    title: z.string(),
    status: RecordDisplayStatus,
    state: z.string(),
    action: z.string().nullable(),
    holder: z.object({ handle: PersonId, displayName: z.string(), roleLabel: z.string() }).nullable(),
    dueAt: IsoDate.nullable(),
    daysToDue: z.int().nullable(),
    afterAudit: z.boolean(),
    upstream: z.array(StageLink),
    downstream: z.array(StageLink),
    file: z.object({ repository: z.string(), linkStatus: LinkStatus }).optional(),
  }),
  'Pending record contract of TS 9.3 (camelCase), with ref.code as the business id (A-21)',
  {
    valid: [{
      ref: { ...EXAMPLE_REF, stage: 'risk' }, title: 'Unpatched hypervisor in Surabaya DC', status: 'missing', state: 'No treatment linked',
      action: 'Select a treatment', holder: { handle: 'rina', displayName: 'Rina Kusuma', roleLabel: 'ISMS Manager' }, dueAt: null, daysToDue: null,
      afterAudit: false, upstream: [{ stage: 'context', id: 'CI-03' }], downstream: [],
    }],
    invalid: [{ ref: EXAMPLE_REF, title: 'x', status: 'missing', state: '', action: null, holder: null, dueAt: null, daysToDue: null, afterAudit: false, upstream: [], downstream: [] }],
  },
);
export type PendingRecord = z.infer<typeof PendingRecord>;

export const ChainQuery = named('ChainQuery', z.strictObject({ anchor_id: z.string().min(1).max(40) }), 'GET /ms/{ms}/audit/chain query: the anchor record code', {
  valid: [{ anchor_id: 'R-014' }],
  invalid: [{}, { anchor_id: '' }],
});
export type ChainQuery = z.infer<typeof ChainQuery>;

export const ChainNode = named(
  'ChainNode',
  z.union([
    z.object({
      stage: StageKey, label: z.string(), id: z.string().nullable(), title: z.string(), status: RecordDisplayStatus, holder: PersonId.nullable(),
      due: IsoDate.nullable(), clauseAtRisk: z.string().nullable(), ref: RecordRef.optional(),
    }),
    z.strictObject({ stage: StageKey, hidden: z.literal(true) }),
  ]),
  'One node of a traceability chain; nodes outside the user scope come as {stage, hidden: true} (D.3)',
  {
    valid: [{ stage: 'risk', label: 'Risk', id: 'R-014', title: 'Privileged credential misuse', status: 'overdue', holder: 'bagus', due: '2026-09-10', clauseAtRisk: '6.1.2' }, { stage: 'treatment', hidden: true }],
    invalid: [{ stage: 'treatment', hidden: false }, { stage: 'risk', label: 'Risk' }],
  },
);
export type ChainNode = z.infer<typeof ChainNode>;

export const ChainResponse = named('ChainResponse', z.object({ anchor: z.string(), nodes: z.array(ChainNode) }), 'GET /ms/{ms}/audit/chain: one complete chain from the chosen node', {
  valid: [{ anchor: 'R-014', nodes: [{ stage: 'treatment', hidden: true }] }],
  invalid: [{ anchor: 'R-014' }],
});
export type ChainResponse = z.infer<typeof ChainResponse>;

export const PendingQuery = named(
  'PendingQuery',
  z.strictObject({
    ...pageQueryShape, owner: PersonId.optional(), stage: StageKey.optional(), overdue_only: QueryBoolean.optional(), aggregate: z.literal('unit').optional(),
  }),
  'GET /ms/{ms}/audit/pending query: owner gives one person\'s records; aggregate=unit gives counts without names',
  { valid: [{}, { owner: 'bagus', overdue_only: 'true' }, { aggregate: 'unit' }], invalid: [{ aggregate: 'team' }, { overdue_only: 'yes' }] },
);
export type PendingQuery = z.infer<typeof PendingQuery>;

export const PendingPerson = named(
  'PendingPerson',
  z.object({ holder: PersonId, displayName: z.string(), jobTitle: z.string(), open: Count, overdue: Count, afterAudit: Count, stages: z.record(StageKey, Count) }),
  'Pending items of one holder, across stages (audit.pending.all)',
  { valid: [{ holder: 'bagus', displayName: 'Bagus Prasetyo', jobTitle: 'IT Infrastructure Lead', open: 31, overdue: 9, afterAudit: 2, stages: { risk: 1, control: 20 } }], invalid: [{ holder: 'bagus', open: 1 }] },
);
export type PendingPerson = z.infer<typeof PendingPerson>;

export const PendingAggregate = named(
  'PendingAggregate',
  z.object({ stage: StageKey, role: BusinessRole.nullable(), open: Count, overdue: Count }),
  'Pending counts per stage and business role without names (audit.pending.aggregate); role is null for unassigned items and holders without a role in the system',
  { valid: [{ stage: 'risk', role: 'domain_owner', open: 4, overdue: 1 }, { stage: 'risk', role: null, open: 2, overdue: 2 }], invalid: [{ stage: 'risk', role: 'owner', open: 4, overdue: 1 }] },
);
export type PendingAggregate = z.infer<typeof PendingAggregate>;

// ---------------------------------------------------------------------------------------------------------------
// Surveillance (Module 3)
// ---------------------------------------------------------------------------------------------------------------

export const SurveillanceEvent = named(
  'SurveillanceEvent',
  z.object({
    id: Uuid, type: AuditEventType, name: z.string(), shortLabel: z.string(), scheduledAt: IsoDate, auditDays: Count.nullable(),
    leadAuditor: z.string().nullable(), expectedFocus: z.string().nullable(), outcome: AuditOutcome.nullable(), outcomeSummary: z.string().nullable(),
    next: z.boolean(), past: z.boolean(),
    prep: z.array(z.object({ ref: RecordRef, title: z.string(), owner: PersonId, dueAt: IsoDate, status: TaskProgressStatus, violatesBr43: z.boolean() })),
    findings: z.array(z.object({ ref: RecordRef, code: z.string(), classification: FindingClassification, clause: z.string().nullable(), title: z.string(), status: FindingStatus, note: z.string().nullable() })),
  }),
  'Event detail: preparation checklist and findings to close or results (TS 9.2)',
  {
    valid: [{ id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', type: 'surveillance', name: 'Surveillance audit 1', shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', auditDays: 2, leadAuditor: null, expectedFocus: null, outcome: null, outcomeSummary: null, next: true, past: false, prep: [], findings: [] }],
    invalid: [{ id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', type: 'surveillance' }],
  },
);
export type SurveillanceEvent = z.infer<typeof SurveillanceEvent>;

export const CycleQuery = named('CycleQuery', z.strictObject({ cycle_id: Uuid.optional() }), 'GET /ms/{ms}/surveillance/cycle query (default the current cycle)', {
  valid: [{}, { cycle_id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e' }],
  invalid: [{ cycle_id: '2026' }],
});
export type CycleQuery = z.infer<typeof CycleQuery>;

export const CycleItem = named(
  'CycleItem',
  z.object({ ref: RecordRef, requirementCode: z.string(), title: z.string(), owner: PersonId, dueAt: IsoDate, status: TaskProgressStatus, conditionNote: z.string() }),
  'Cycle requirement of the certification cycle (TS 6.8)',
  { valid: [{ ref: { ...EXAMPLE_REF, entityType: 'cycle_requirement_status', code: '9.3', module: 'surveillance' }, requirementCode: '9.3', title: 'Management review with all mandatory inputs', owner: 'hendra', dueAt: '2026-10-28', status: 'not_started', conditionNote: '2 of 7 inputs not yet prepared' }], invalid: [{ requirementCode: '9.3' }] },
);
export type CycleItem = z.infer<typeof CycleItem>;

export const DriftQuery = named('DriftQuery', z.strictObject({ rule: z.string().min(1).max(30).optional() }), 'GET /ms/{ms}/surveillance/drift query: one rule code', {
  valid: [{}, { rule: 'risk12' }],
  invalid: [{ rule: '' }],
});
export type DriftQuery = z.infer<typeof DriftQuery>;

export const DriftPattern = named(
  'DriftPattern',
  z.object({
    code: z.string(), label: z.string(), severity: DriftSeverity, sourceKind: DriftSourceKind, message: z.string(),
    rows: z.array(z.object({ ref: RecordRef.optional(), code: z.string(), title: z.string(), holder: PersonId, dueAt: IsoDate.nullable(), detectedAt: z.string().optional() })),
  }),
  'Active drift pattern with the records it affects (TS 4.9, BR-48)',
  { valid: [{ code: 'risk12', label: 'Risks not reassessed in 12 months', severity: 'risk', sourceKind: 'stale_risk', message: 'Reassess them.', rows: [{ code: 'R-005', title: 'Data centre power failure', holder: 'bagus', dueAt: '2026-10-30' }] }], invalid: [{ code: 'risk12', label: 'x', severity: 'high', sourceKind: 'stale_risk', message: '', rows: [] }] },
);
export type DriftPattern = z.infer<typeof DriftPattern>;

export const EvidenceQuery = named(
  'EvidenceQuery',
  z.strictObject({ ...pageQueryShape, freshness: FreshnessStatus.optional(), frequency: FreqId.optional(), q: Search.optional(), owner: PersonId.optional() }),
  'GET /ms/{ms}/evidence query',
  { valid: [{}, { freshness: 'critical', frequency: 'monthly' }], invalid: [{ freshness: 'old' }] },
);
export type EvidenceQuery = z.infer<typeof EvidenceQuery>;

export const EvidenceItem = named(
  'EvidenceItem',
  z.object({ ...Evidence.shape, ref: RecordRef, integrity: IntegrityStatus.nullable() }),
  'Evidence row: UI 1.7 fields with next due, freshness, integrity code and status, and ref',
  { valid: [{ ...EXAMPLE_EVIDENCE, ref: { ...EXAMPLE_REF, entityType: 'evidence', code: 'EV-0313', module: 'surveillance' }, integrity: 'broken' }], invalid: [{ ...EXAMPLE_EVIDENCE, integrity: 'broken' }] },
);
export type EvidenceItem = z.infer<typeof EvidenceItem>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const read = {
  owner: 'WP-32' as const,
  method: 'GET' as const,
  auth: 'session' as const,
  permission: 'ms.read' as const,
  scope: 'ms' as const,
  msSource: 'path' as const,
};

export const readImplementationSummaryRoute = defineRoute({
  ...read, id: 'readmodel.implementation.summary', path: '/api/v1/ms/:ms/implementation/summary',
  summary: 'Implementation overview: five cards, phases with derived text, maturity per clause',
  params: MsParams, response: ImplementationSummary, errors: [404],
});

export const readApplicabilityRoute = defineRoute({
  ...read, id: 'readmodel.applicability.list', path: '/api/v1/ms/:ms/applicability',
  summary: 'Applicability items with documents, evidence and integrity',
  params: MsParams, query: ApplicabilityQuery, response: pageOf(ApplicabilityItem), errors: [404],
});

export const readDocumentsRoute = defineRoute({
  ...read, id: 'readmodel.documents.list', path: '/api/v1/ms/:ms/documents',
  summary: 'Document register with shared documents and item links',
  params: MsParams, query: DocumentsQuery, response: pageOf(DocumentItem), errors: [404],
});

export const readGatesRoute = defineRoute({
  ...read, id: 'readmodel.gates', path: '/api/v1/ms/:ms/gates',
  summary: 'Blocking items with the records they hold back',
  params: MsParams, response: z.array(GateItemView), errors: [404],
});

export const readPhaseActivitiesRoute = defineRoute({
  ...read, id: 'readmodel.phase.activities', path: '/api/v1/ms/:ms/phases/:n/activities',
  summary: 'Activities of one phase with derived status and output',
  params: PhaseParams, response: z.array(ActivityItem), errors: [404],
});

export const readNextAuditEventRoute = defineRoute({
  ...read, id: 'readmodel.audit.next-event', path: '/api/v1/ms/:ms/audit/event/next',
  summary: 'Next audit event and its readiness numbers; 204 when no event is planned',
  // The 204 answer has no body, so the 200 schema accepts an absent body too.
  params: MsParams, response: NextAuditEvent.optional(), errors: [204, 404],
});

export const readAuditStagesRoute = defineRoute({
  ...read, id: 'readmodel.audit.stages', path: '/api/v1/ms/:ms/audit/stages',
  summary: 'Readiness per chain stage',
  params: MsParams, response: z.array(StageReadiness), errors: [404],
});

export const readStageRecordsRoute = defineRoute({
  ...read, id: 'readmodel.audit.stage-records', path: '/api/v1/ms/:ms/audit/stages/:key/records',
  summary: 'Records of one stage with action, holder, due date, upstream and downstream (TS 9.3)',
  params: StageParams, query: StageRecordsQuery, response: pageOf(PendingRecord), errors: [404],
});

export const readChainRoute = defineRoute({
  ...read, id: 'readmodel.audit.chain', path: '/api/v1/ms/:ms/audit/chain',
  summary: 'One complete traceability chain from the chosen anchor',
  params: MsParams, query: ChainQuery, response: ChainResponse, errors: [404],
});

export const readPendingRoute = defineRoute({
  ...read, id: 'readmodel.audit.pending', path: '/api/v1/ms/:ms/audit/pending',
  summary: 'Pending items: one person\'s records with owner; everyone per person needs audit.pending.all; aggregate=unit needs audit.pending.aggregate and returns counts per stage and role',
  params: MsParams, query: PendingQuery,
  response: z.union([z.array(PendingPerson), pageOf(PendingRecord), z.array(PendingAggregate)]),
  errors: [404],
});

export const readSurveillanceEventRoute = defineRoute({
  ...read, id: 'readmodel.surveillance.event', path: '/api/v1/ms/:ms/surveillance/events/:id',
  summary: 'Event detail, preparation checklist and findings',
  params: MsRecordParams, response: SurveillanceEvent, errors: [404],
});

export const readCycleRoute = defineRoute({
  ...read, id: 'readmodel.surveillance.cycle', path: '/api/v1/ms/:ms/surveillance/cycle',
  summary: 'Completeness of the certification cycle',
  params: MsParams, query: CycleQuery, response: z.array(CycleItem), errors: [404],
});

export const readDriftRoute = defineRoute({
  ...read, id: 'readmodel.surveillance.drift', path: '/api/v1/ms/:ms/surveillance/drift',
  summary: 'Active drift patterns with affected records',
  params: MsParams, query: DriftQuery, response: z.array(DriftPattern), errors: [404],
});

export const readEvidenceRoute = defineRoute({
  ...read, id: 'readmodel.evidence.list', path: '/api/v1/ms/:ms/evidence',
  summary: 'Evidence with next due date, freshness and integrity',
  params: MsParams, query: EvidenceQuery, response: pageOf(EvidenceItem), errors: [404],
});

export const routes: RouteDef[] = [
  readImplementationSummaryRoute, readApplicabilityRoute, readDocumentsRoute, readGatesRoute, readPhaseActivitiesRoute,
  readNextAuditEventRoute, readAuditStagesRoute, readStageRecordsRoute, readChainRoute, readPendingRoute,
  readSurveillanceEventRoute, readCycleRoute, readDriftRoute, readEvidenceRoute,
];
