// Area `audit-registers` (owner from wave 10: WP-37): findings, corrective actions, self-assessment, the audit activity
// planner and management reviews (D.2, D.3 "Registers and workflows: audit side", C.13).
import { z } from 'zod';
import {
  AuditActivityStatus, CorrectiveActionStatus, FindingClassification, FindingSource, FindingStatus, ManagementReviewStatus,
  SelfAssessmentStatus,
} from '../enums.js';
import {
  Code, CommandResult, IsoDate, MsId, MsParams, MsRecordParams, PersonId, RecordRef, Uuid, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

const Title = z.string().trim().min(1).max(255);
const Text = z.string().trim().min(1).max(8000);
const Note = z.string().trim().min(1).max(2000);
const Search = z.string().trim().min(1).max(100);

const REF = { module: 'audit', entityType: 'finding', id: '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f', code: 'NC-2025-02' } as const;
const CA_REF = { module: 'audit', entityType: 'corrective_action', id: '1d2e3f4a-5b6c-4d7e-9f8a-9b0c1d2e3f4a', code: 'CA-2025-02' } as const;

// ---------------------------------------------------------------------------------------------------------------
// Findings and corrective actions
// ---------------------------------------------------------------------------------------------------------------

export const FindingListQuery = named(
  'FindingListQuery',
  z.strictObject({ ...pageQueryShape, status: FindingStatus.optional(), classification: FindingClassification.optional(), source: FindingSource.optional(), q: Search.optional() }),
  'GET /ms/{ms}/findings query',
  { valid: [{}, { status: 'open', classification: 'major', source: 'internal_audit' }], invalid: [{ classification: 'Major' }] },
);
export type FindingListQuery = z.infer<typeof FindingListQuery>;

const EXAMPLE_FINDING = {
  ref: REF, code: 'NC-2025-02', title: 'Remediation SLA missed for 3 critical vulnerabilities', classification: 'minor', source: 'certification_audit',
  clauseRef: '8.8 / A.8.8', status: 'open', owner: 'bagus', raisedAt: '2025-03-12', dueAt: '2026-10-20',
  auditEvent: { id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', shortLabel: 'Stage 2, certification' },
  correctiveActions: [{ ref: CA_REF, code: 'CA-2025-02', status: 'effectiveness_verification' }],
} as const;

export const FindingItem = named(
  'FindingItem',
  z.object({
    ref: RecordRef,
    code: z.string(),
    title: z.string(),
    classification: FindingClassification,
    source: FindingSource,
    clauseRef: z.string().nullable(),
    status: FindingStatus,
    owner: PersonId,
    raisedAt: IsoDate.nullable(),
    dueAt: IsoDate.nullable(),
    auditEvent: z.object({ id: Uuid, shortLabel: z.string() }).nullable(),
    correctiveActions: z.array(z.object({ ref: RecordRef, code: z.string(), status: CorrectiveActionStatus })),
  }),
  'Finding register row with its linked corrective actions',
  { valid: [EXAMPLE_FINDING, { ...EXAMPLE_FINDING, auditEvent: null, correctiveActions: [] }], invalid: [{ ...EXAMPLE_FINDING, classification: 'Minor' }] },
);
export type FindingItem = z.infer<typeof FindingItem>;

export const FindingCreate = named(
  'FindingCreate',
  z.strictObject({
    code: Code, title: Title, classification: FindingClassification, clauseRef: z.string().trim().min(1).max(40).optional(), source: FindingSource,
    auditEventId: Uuid.optional(), ownerHandle: PersonId, dueAt: IsoDate.optional(),
  }),
  'POST /ms/{ms}/findings body',
  { valid: [{ code: 'IA-2026-04', title: 'Access reviews not documented for Q2', classification: 'minor', clauseRef: 'A.5.18', source: 'internal_audit', ownerHandle: 'bagus', dueAt: '2026-12-01' }], invalid: [{ code: 'IA-2026-04', title: 'x', classification: 'minor', source: 'customer', ownerHandle: 'bagus' }] },
);
export type FindingCreate = z.infer<typeof FindingCreate>;

export const FindingPatch = named(
  'FindingPatch',
  z.strictObject({
    title: Title.optional(), classification: FindingClassification.optional(), clauseRef: z.string().trim().min(1).max(40).nullable().optional(),
    ownerHandle: PersonId.optional(), dueAt: IsoDate.nullable().optional(), rcaText: Text.nullable().optional(),
    systemicCheckText: Text.nullable().optional(), statusNote: Note.nullable().optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/findings/{id} body',
  { valid: [{ rcaText: 'Patch window not aligned with SLA', systemicCheckText: 'Other platforms checked' }], invalid: [{}, { status: 'closed' }] },
);
export type FindingPatch = z.infer<typeof FindingPatch>;

export const FindingTransition = named(
  'FindingTransition',
  z.strictObject({ to: z.enum(['in_progress', 'closed']), note: Note.optional() }),
  'POST /ms/{ms}/findings/{id}/transitions body; note is the close note of findings closed without a corrective action and the reason of a reopen (C.13)',
  { valid: [{ to: 'in_progress' }, { to: 'closed', note: 'Addressed in measurement plan v2' }], invalid: [{ to: 'open' }, {}] },
);
export type FindingTransition = z.infer<typeof FindingTransition>;

export const CorrectiveActionListQuery = named('CorrectiveActionListQuery', z.strictObject({ ...pageQueryShape, status: CorrectiveActionStatus.optional() }), 'GET /ms/{ms}/corrective-actions query', {
  valid: [{}, { status: 'action' }],
  invalid: [{ status: 'open' }],
});
export type CorrectiveActionListQuery = z.infer<typeof CorrectiveActionListQuery>;

const EXAMPLE_CA = {
  ref: CA_REF, code: 'CA-2025-02', title: 'Automate critical patch deployment', status: 'effectiveness_verification', owner: 'bagus', dueAt: '2026-10-20',
  correctionText: 'Patched the three hosts', rcaText: 'Manual patch scheduling', systemicCheckText: 'All hypervisors reviewed', actionText: 'Automated weekly patch window',
  implementedAt: '2026-08-30', implementedBy: 'bagus', verifiedAt: null, verifiedBy: null, effective: null, findings: [{ ref: REF, code: 'NC-2025-02' }],
} as const;

export const CorrectiveActionItem = named(
  'CorrectiveActionItem',
  z.object({
    ref: RecordRef, code: z.string(), title: z.string(), status: CorrectiveActionStatus, owner: PersonId, dueAt: IsoDate.nullable(),
    correctionText: z.string().nullable(), rcaText: z.string().nullable(), systemicCheckText: z.string().nullable(), actionText: z.string().nullable(),
    implementedAt: IsoDate.nullable(), implementedBy: PersonId.nullable(), verifiedAt: IsoDate.nullable(), verifiedBy: PersonId.nullable(),
    effective: z.boolean().nullable(), findings: z.array(z.object({ ref: RecordRef, code: z.string() })),
  }),
  'Corrective action with its step texts, implementation, verification and findings (PRD 8.2)',
  { valid: [EXAMPLE_CA], invalid: [{ ...EXAMPLE_CA, status: 'open' }, { ...EXAMPLE_CA, findings: undefined }] },
);
export type CorrectiveActionItem = z.infer<typeof CorrectiveActionItem>;

export const CorrectiveActionCreate = named(
  'CorrectiveActionCreate',
  z.strictObject({ findingIds: z.array(Uuid).min(1), code: Code, title: Title, ownerHandle: PersonId, dueAt: IsoDate.optional() }),
  'POST /ms/{ms}/corrective-actions body: one or more findings of the path system (a joint audit may share one action)',
  { valid: [{ findingIds: ['0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f'], code: 'CA-2026-01', title: 'Document access reviews', ownerHandle: 'bagus' }], invalid: [{ findingIds: [], code: 'CA-2026-01', title: 'x', ownerHandle: 'bagus' }] },
);
export type CorrectiveActionCreate = z.infer<typeof CorrectiveActionCreate>;

export const CorrectiveActionPatch = named(
  'CorrectiveActionPatch',
  z.strictObject({ title: Title.optional(), ownerHandle: PersonId.optional(), dueAt: IsoDate.nullable().optional(), findingIds: z.array(Uuid).min(1).optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/corrective-actions/{id} body',
  { valid: [{ dueAt: '2026-11-30' }], invalid: [{}, { findingIds: [] }] },
);
export type CorrectiveActionPatch = z.infer<typeof CorrectiveActionPatch>;

export const CorrectiveActionTransition = named(
  'CorrectiveActionTransition',
  z.strictObject({ to: CorrectiveActionStatus, text: Text.optional(), effective: z.boolean().optional(), note: Note.optional() }),
  'POST /ms/{ms}/corrective-actions/{id}/transitions body (C.13): text is the step text; effective and note record the verification',
  { valid: [{ to: 'rca', text: 'Patched the three hosts' }, { to: 'closed', effective: true, note: 'No overdue critical patches in Q3' }, { to: 'cancelled', note: 'Merged into CA-2026-01' }], invalid: [{ to: 'done' }, { to: 'closed', effective: 'yes' }] },
);
export type CorrectiveActionTransition = z.infer<typeof CorrectiveActionTransition>;

// ---------------------------------------------------------------------------------------------------------------
// Self-assessment and audit activities
// ---------------------------------------------------------------------------------------------------------------

export const SelfAssessmentListQuery = named('SelfAssessmentListQuery', z.strictObject({ ...pageQueryShape, status: SelfAssessmentStatus.optional(), q: Search.optional() }), 'GET /ms/{ms}/self-assessments query', {
  valid: [{}, { status: 'gap' }],
  invalid: [{ status: 'open' }],
});
export type SelfAssessmentListQuery = z.infer<typeof SelfAssessmentListQuery>;

const EXAMPLE_SA = {
  ref: { module: 'audit', entityType: 'self_assessment', id: '2e3f4a5b-6c7d-4e8f-8a9b-0c1d2e3f4a5b', code: 'FC-01' }, conditionCode: 'FC-01', classification: 'major',
  requirementCode: '8.2', text: 'No information security risk assessment performed for the scope', status: 'conforming', owner: 'rina', targetFixAt: null,
  note: 'Risk assessment 2026 approved', assessedAt: '2026-09-01', evidence: ['EV-0130'], findingCode: null,
} as const;

export const SelfAssessmentItem = named(
  'SelfAssessmentItem',
  z.object({
    ref: RecordRef.nullable(), conditionCode: z.string(), classification: FindingClassification, requirementCode: z.string().nullable(), text: z.string(),
    status: SelfAssessmentStatus, owner: PersonId.nullable(), targetFixAt: IsoDate.nullable(), note: z.string().nullable(), assessedAt: IsoDate.nullable(),
    evidence: z.array(z.string()), findingCode: z.string().nullable(),
  }),
  'One finding condition of the active edition with its assessment; rows without a stored assessment read not_assessed and have no ref',
  { valid: [EXAMPLE_SA, { ...EXAMPLE_SA, ref: null, status: 'not_assessed', owner: null, note: null, assessedAt: null, evidence: [] }], invalid: [{ ...EXAMPLE_SA, status: 'ok' }] },
);
export type SelfAssessmentItem = z.infer<typeof SelfAssessmentItem>;

export const SelfAssessmentParams = named('SelfAssessmentParams', z.strictObject({ ms: MsId, conditionCode: Code }), 'Path parameters {ms} and {conditionCode} (ref.finding_condition.code)', {
  valid: [{ ms: 'isms', conditionCode: 'FC-01' }],
  invalid: [{ ms: 'isms' }],
});
export type SelfAssessmentParams = z.infer<typeof SelfAssessmentParams>;

export const SelfAssessmentUpdate = named(
  'SelfAssessmentUpdate',
  z.strictObject({ status: SelfAssessmentStatus, ownerHandle: PersonId.optional(), targetFixAt: IsoDate.optional(), note: Note.optional(), evidenceCodes: z.array(Code) })
    .refine((u) => u.status !== 'gap' || (u.ownerHandle !== undefined && u.ownerHandle !== 'none' && u.targetFixAt !== undefined), { message: 'gap needs an owner and a target date', path: ['ownerHandle'] }),
  'PUT /ms/{ms}/self-assessments/{conditionCode} body (C.13 self_assessment.status)',
  { valid: [{ status: 'conforming', evidenceCodes: ['EV-0130'] }, { status: 'gap', ownerHandle: 'rina', targetFixAt: '2026-12-01', evidenceCodes: [] }], invalid: [{ status: 'gap', evidenceCodes: [] }, { status: 'conforming' }] },
);
export type SelfAssessmentUpdate = z.infer<typeof SelfAssessmentUpdate>;

export const RaiseFindingRequest = named('RaiseFindingRequest', z.strictObject({ classification: FindingClassification, title: Title.optional() }), 'POST /ms/{ms}/self-assessments/{id}/raise-finding body', {
  valid: [{ classification: 'minor' }, { classification: 'ofi', title: 'Improve the risk method' }],
  invalid: [{}, { classification: 'gap' }],
});
export type RaiseFindingRequest = z.infer<typeof RaiseFindingRequest>;

const EXAMPLE_ACTIVITY = {
  ref: { module: 'audit', entityType: 'audit_activity', id: '3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c', code: 'AA-S1-01' }, templateCode: 'AA-S1-01',
  title: 'Review ISMS scope and context', clauseRef: '4.3', keyQuestions: 'Are the scope, boundaries and interfaces documented?', evidenceToRequest: 'Scope statement',
  auditee: 'rina', scheduledAt: '2027-02-10', status: 'planned', note: null,
} as const;

export const AuditActivityItem = named(
  'AuditActivityItem',
  z.object({
    ref: RecordRef, templateCode: z.string().nullable(), title: z.string(), clauseRef: z.string().nullable(), keyQuestions: z.string().nullable(),
    evidenceToRequest: z.string().nullable(), auditee: PersonId.nullable(), scheduledAt: IsoDate.nullable(), status: AuditActivityStatus, note: z.string().nullable(),
  }),
  'Audit Activity Planner row of one audit event (PRD 8.1)',
  { valid: [EXAMPLE_ACTIVITY], invalid: [{ ...EXAMPLE_ACTIVITY, status: 'open' }] },
);
export type AuditActivityItem = z.infer<typeof AuditActivityItem>;

export const AuditActivityPatch = named(
  'AuditActivityPatch',
  z.strictObject({ auditeeHandle: PersonId.optional(), scheduledAt: IsoDate.nullable().optional(), status: AuditActivityStatus.optional(), note: Note.nullable().optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/audit-activities/{id} body',
  { valid: [{ auditeeHandle: 'bagus', scheduledAt: '2027-02-10' }, { status: 'done' }], invalid: [{}, { status: 'open' }] },
);
export type AuditActivityPatch = z.infer<typeof AuditActivityPatch>;

// ---------------------------------------------------------------------------------------------------------------
// Management reviews
// ---------------------------------------------------------------------------------------------------------------

const EXAMPLE_REVIEW = {
  ref: { module: 'audit', entityType: 'management_review', id: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d', code: 'MR-2026' }, code: 'MR-2026',
  title: 'Management review 2026', owner: 'hendra', plannedAt: '2026-10-28', heldAt: null, status: 'planned', decisionsRecorded: false, decisionsText: null,
  linkedMs: ['isms', 'qms'],
  inputs: [{ defCode: 'MRI-01', title: 'Status of actions from previous reviews', mandatory: true, ms: 'isms', complete: true, content: 'All closed' }],
} as const;

export const ManagementReviewItem = named(
  'ManagementReviewItem',
  z.object({
    ref: RecordRef, code: z.string(), title: z.string(), owner: PersonId, plannedAt: IsoDate.nullable(), heldAt: IsoDate.nullable(),
    status: ManagementReviewStatus, decisionsRecorded: z.boolean(), decisionsText: z.string().nullable(), linkedMs: z.array(MsId),
    inputs: z.array(z.object({ defCode: z.string(), title: z.string(), mandatory: z.boolean(), ms: MsId, complete: z.boolean(), content: z.string().nullable() })),
  }),
  'Management review with its inputs per linked system and their completeness',
  { valid: [EXAMPLE_REVIEW], invalid: [{ ...EXAMPLE_REVIEW, status: 'open' }] },
);
export type ManagementReviewItem = z.infer<typeof ManagementReviewItem>;

export const ManagementReviewCreate = named(
  'ManagementReviewCreate',
  z.strictObject({ code: Code, title: Title, plannedAt: IsoDate, ownerHandle: PersonId, linkedMs: z.array(MsId).min(1) }),
  'POST /ms/{ms}/management-reviews body: the path system first, as primary; a joint review needs integrated_mode',
  { valid: [{ code: 'MR-2027', title: 'Management review 2027', plannedAt: '2027-10-27', ownerHandle: 'hendra', linkedMs: ['isms', 'qms'] }], invalid: [{ code: 'MR-2027', title: 'x', plannedAt: '2027-10-27', ownerHandle: 'hendra', linkedMs: [] }] },
);
export type ManagementReviewCreate = z.infer<typeof ManagementReviewCreate>;

export const ManagementReviewInputParams = named('ManagementReviewInputParams', z.strictObject({ ms: MsId, id: Uuid, defCode: Code }), 'Path parameters {ms}, {id} (management review) and {defCode} (ref.review_input_def.code)', {
  valid: [{ ms: 'isms', id: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d', defCode: 'MRI-01' }],
  invalid: [{ ms: 'isms', id: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d' }],
});
export type ManagementReviewInputParams = z.infer<typeof ManagementReviewInputParams>;

export const ManagementReviewInputRequest = named(
  'ManagementReviewInputRequest',
  z.strictObject({ content: z.string().trim().min(1).max(20000), sourceRefs: z.array(RecordRef).optional() }),
  'PUT /ms/{ms}/management-reviews/{id}/inputs/{defCode} body: the input of the path system',
  { valid: [{ content: 'Two nonconformities closed', sourceRefs: [REF] }], invalid: [{ content: '' }, {}] },
);
export type ManagementReviewInputRequest = z.infer<typeof ManagementReviewInputRequest>;

export const ManagementReviewTransition = named(
  'ManagementReviewTransition',
  z.strictObject({ to: z.enum(['held', 'closed']), heldAt: IsoDate.optional(), decisionsText: Text.optional() }),
  'POST /ms/{ms}/management-reviews/{id}/transitions body (C.13, BR-13, BR-14)',
  { valid: [{ to: 'held', heldAt: '2026-10-28' }, { to: 'closed', decisionsText: 'Budget approved for PAM' }], invalid: [{ to: 'planned' }, {}] },
);
export type ManagementReviewTransition = z.infer<typeof ManagementReviewTransition>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const ms = { auth: 'session' as const, scope: 'ms' as const, msSource: 'path' as const, owner: 'WP-37' as const };

export const findingsListRoute = defineRoute({
  ...ms, id: 'findings.list', method: 'GET', path: '/api/v1/ms/:ms/findings', summary: 'Finding register',
  permission: 'ms.read', params: MsParams, query: FindingListQuery, response: pageOf(FindingItem), errors: [404],
});
export const findingsCreateRoute = defineRoute({
  ...ms, id: 'findings.create', method: 'POST', path: '/api/v1/ms/:ms/findings', summary: 'Raise a finding',
  permission: 'finding.raise', params: MsParams, body: FindingCreate, response: CommandResult, status: 201, errors: [409, 422], idempotent: true,
});
export const findingsUpdateRoute = defineRoute({
  ...ms, id: 'findings.update', method: 'PATCH', path: '/api/v1/ms/:ms/findings/:id', summary: 'Change a finding, including its RCA and systemic check texts',
  permission: 'finding.manage', params: MsRecordParams, body: FindingPatch, response: CommandResult, errors: [404, 412, 422], ifMatch: true,
});
export const findingsTransitionRoute = defineRoute({
  ...ms, id: 'findings.transition', method: 'POST', path: '/api/v1/ms/:ms/findings/:id/transitions', summary: 'Move a finding along C.13 (closing checks BR-06, BR-07, BR-08)',
  machine: 'finding.status', params: MsRecordParams, body: FindingTransition, response: CommandResult, errors: [404, 409, 412, 422], ifMatch: true,
});
export const correctiveActionsListRoute = defineRoute({
  ...ms, id: 'corrective-actions.list', method: 'GET', path: '/api/v1/ms/:ms/corrective-actions', summary: 'Corrective actions of the system',
  permission: 'ms.read', params: MsParams, query: CorrectiveActionListQuery, response: pageOf(CorrectiveActionItem), errors: [404],
});
export const correctiveActionsCreateRoute = defineRoute({
  ...ms, id: 'corrective-actions.create', method: 'POST', path: '/api/v1/ms/:ms/corrective-actions', summary: 'Create a corrective action for one or more findings',
  permission: 'corrective_action.manage', params: MsParams, body: CorrectiveActionCreate, response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});
export const correctiveActionsUpdateRoute = defineRoute({
  ...ms, id: 'corrective-actions.update', method: 'PATCH', path: '/api/v1/ms/:ms/corrective-actions/:id', summary: 'Change a corrective action and its findings',
  permission: 'corrective_action.manage', params: MsRecordParams, body: CorrectiveActionPatch, response: CommandResult, errors: [404, 412, 422], ifMatch: true,
});
export const correctiveActionsTransitionRoute = defineRoute({
  ...ms, id: 'corrective-actions.transition', method: 'POST', path: '/api/v1/ms/:ms/corrective-actions/:id/transitions',
  summary: 'Move a corrective action one step along C.13; verification checks BR-08 and BR-09',
  machine: 'corrective_action.status', params: MsRecordParams, body: CorrectiveActionTransition, response: CommandResult, errors: [404, 409, 412, 422], ifMatch: true,
});
export const selfAssessmentsListRoute = defineRoute({
  ...ms, id: 'self-assessments.list', method: 'GET', path: '/api/v1/ms/:ms/self-assessments', summary: 'Self-assessment: one row per finding condition of the active edition',
  permission: 'ms.read', params: MsParams, query: SelfAssessmentListQuery, response: pageOf(SelfAssessmentItem), errors: [404],
});
export const selfAssessmentsUpdateRoute = defineRoute({
  ...ms, id: 'self-assessments.update', method: 'PUT', path: '/api/v1/ms/:ms/self-assessments/:conditionCode', summary: 'Record the assessment of one finding condition',
  permission: 'self_assessment.manage', machine: 'self_assessment.status', params: SelfAssessmentParams, body: SelfAssessmentUpdate, response: CommandResult,
  errors: [404, 409, 422],
});
export const selfAssessmentsRaiseFindingRoute = defineRoute({
  ...ms, id: 'self-assessments.raise-finding', method: 'POST', path: '/api/v1/ms/:ms/self-assessments/:id/raise-finding',
  summary: 'Raise a finding (source self_assessment) from a gap', permission: 'finding.raise', params: MsRecordParams, body: RaiseFindingRequest,
  response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});
export const auditActivitiesListRoute = defineRoute({
  ...ms, id: 'audit-activities.list', method: 'GET', path: '/api/v1/ms/:ms/audit-events/:id/activities', summary: 'Audit activities of an audit event',
  permission: 'ms.read', params: MsRecordParams, response: z.array(AuditActivityItem), errors: [404],
});
export const auditActivitiesGenerateRoute = defineRoute({
  ...ms, id: 'audit-activities.generate', method: 'POST', path: '/api/v1/ms/:ms/audit-events/:id/activities/generate',
  summary: 'Create the audit activities of the event type from the pack templates (existing codes skipped)', permission: 'audit_event.manage',
  params: MsRecordParams, response: CommandResult, errors: [404],
});
export const auditActivitiesUpdateRoute = defineRoute({
  ...ms, id: 'audit-activities.update', method: 'PATCH', path: '/api/v1/ms/:ms/audit-activities/:id', summary: 'Plan or update an audit activity',
  permission: 'audit_event.manage', params: MsRecordParams, body: AuditActivityPatch, response: CommandResult, errors: [404, 422],
});
export const managementReviewsListRoute = defineRoute({
  ...ms, id: 'management-reviews.list', method: 'GET', path: '/api/v1/ms/:ms/management-reviews', summary: 'Management reviews linked to the system with input completeness',
  permission: 'ms.read', params: MsParams, response: z.array(ManagementReviewItem), errors: [404],
});
export const managementReviewsCreateRoute = defineRoute({
  ...ms, id: 'management-reviews.create', method: 'POST', path: '/api/v1/ms/:ms/management-reviews', summary: 'Plan a management review (one input row per mandatory input and linked system)',
  permission: 'management_review.manage', params: MsParams, body: ManagementReviewCreate, response: CommandResult, status: 201, errors: [409, 422], idempotent: true,
});
export const managementReviewsInputRoute = defineRoute({
  ...ms, id: 'management-reviews.input', method: 'PUT', path: '/api/v1/ms/:ms/management-reviews/:id/inputs/:defCode', summary: 'Record the input of the path system',
  permission: 'management_review.manage', params: ManagementReviewInputParams, body: ManagementReviewInputRequest, response: CommandResult, errors: [404, 422],
});
export const managementReviewsTransitionRoute = defineRoute({
  ...ms, id: 'management-reviews.transition', method: 'POST', path: '/api/v1/ms/:ms/management-reviews/:id/transitions',
  summary: 'Hold or close a management review (closing checks BR-13, BR-14 and enqueues cycle.derive)', machine: 'management_review.status',
  params: MsRecordParams, body: ManagementReviewTransition, response: CommandResult, errors: [404, 409, 422],
});

export const routes: RouteDef[] = [
  findingsListRoute, findingsCreateRoute, findingsUpdateRoute, findingsTransitionRoute,
  correctiveActionsListRoute, correctiveActionsCreateRoute, correctiveActionsUpdateRoute, correctiveActionsTransitionRoute,
  selfAssessmentsListRoute, selfAssessmentsUpdateRoute, selfAssessmentsRaiseFindingRoute,
  auditActivitiesListRoute, auditActivitiesGenerateRoute, auditActivitiesUpdateRoute,
  managementReviewsListRoute, managementReviewsCreateRoute, managementReviewsInputRoute, managementReviewsTransitionRoute,
];
