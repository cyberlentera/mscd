// Area `risk-registers` (owner from wave 9: WP-36): context issues, interested parties, assets, risks and metrics,
// metric values, risk treatments (C.13), residual acceptance (BR-04), evidence records and targets (BR-23), entity
// links (A-29) (D.2, D.3 "Registers and workflows: risk side").
import { z } from 'zod';
import { ApplicabilityTarget, Classification, IssueType, ShareableEntityType, TreatmentStatus } from '../enums.js';
import {
  Code, CommandResult, FreqId, Instant, IsoDate, MsId, MsParams, MsRecordParams, PersonId, ReasonBody, RecordRef, Uuid,
  defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { PermissionByMember, RouteDef } from './common.js';

export const REGISTER_KINDS = ['context-issues', 'interested-parties', 'assets', 'risks', 'metrics'] as const;
export const RegisterKind = z.enum(REGISTER_KINDS).meta({ id: 'RegisterKind', description: 'Path value of {register} (D.2)' });
export type RegisterKind = z.infer<typeof RegisterKind>;

/** Table behind each register kind. */
export const REGISTER_ENTITY_TYPES: Readonly<Record<RegisterKind, string>> = {
  'context-issues': 'context_issue',
  'interested-parties': 'interested_party',
  'assets': 'asset',
  'risks': 'risk',
  'metrics': 'metric',
};

const Title = z.string().trim().min(1).max(255);
const Text4000 = z.string().trim().max(4000);
const Score = z.int().min(1).max(100);

export const RegisterParams = named('RegisterParams', z.strictObject({ ms: MsId, register: RegisterKind }), 'Path parameters {ms} and {register}', {
  valid: [{ ms: 'isms', register: 'risks' }],
  invalid: [{ ms: 'isms', register: 'treatments' }],
});
export type RegisterParams = z.infer<typeof RegisterParams>;

export const RegisterItemParams = named('RegisterItemParams', z.strictObject({ ms: MsId, register: RegisterKind, id: Uuid }), 'Path parameters {ms}, {register} and {id}', {
  valid: [{ ms: 'isms', register: 'assets', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }],
  invalid: [{ ms: 'isms', register: 'assets', id: 'AS-01' }],
});
export type RegisterItemParams = z.infer<typeof RegisterItemParams>;

export const RegisterListQuery = named(
  'RegisterListQuery',
  z.strictObject({ ...pageQueryShape, q: z.string().trim().min(1).max(100).optional(), owner: PersonId.optional(), status: z.string().max(30).optional() }),
  'GET /ms/{ms}/registers/{register} query',
  { valid: [{}, { q: 'cloud', owner: 'rina' }], invalid: [{ sort: 'code' }] },
);
export type RegisterListQuery = z.infer<typeof RegisterListQuery>;

const kindFields = {
  issueType: IssueType.nullable().optional(),
  description: Text4000.nullable().optional(),
  lastReviewedAt: IsoDate.nullable().optional(),
  requirements: Text4000.nullable().optional(),
  assetType: z.string().trim().max(40).nullable().optional(),
  classification: Classification.nullable().optional(),
  riskProfileCode: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/).optional(),
  isOpportunity: z.boolean().optional(),
  likelihood: Score.nullable().optional(),
  consequence: Score.nullable().optional(),
  impactDimensions: z.record(z.string(), z.int().min(0).max(100)).optional(),
  residualLikelihood: Score.nullable().optional(),
  residualConsequence: Score.nullable().optional(),
  treatmentOption: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/).nullable().optional(),
  assessedAt: IsoDate.nullable().optional(),
  nextReviewAt: IsoDate.nullable().optional(),
  residualAcceptedAt: IsoDate.nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  targetValue: z.number().nullable().optional(),
  frequencyCode: FreqId.nullable().optional(),
  lastMeasuredAt: IsoDate.nullable().optional(),
};

const EXAMPLE_RISK_ITEM = {
  ref: { module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-014' }, code: 'R-014', title: 'Privileged credential misuse',
  owner: 'bagus', updatedAt: '2026-09-10T04:00:00Z', shared: false, ms: ['isms'], riskProfileCode: 'information_security', isOpportunity: false,
  likelihood: 3, consequence: 4, impactDimensions: { confidentiality: 4, integrity: 3, availability: 2 }, treatmentOption: 'modify', assessedAt: '2025-09-10', nextReviewAt: '2026-09-10',
} as const;

export const RegisterItem = named(
  'RegisterItem',
  z.object({
    ref: RecordRef,
    code: z.string(),
    title: z.string(),
    owner: PersonId,
    status: z.string().optional(),
    updatedAt: Instant,
    shared: z.boolean(),
    ms: z.array(MsId),
    ...kindFields,
  }),
  'Row of a register (D.2 RegisterItem) with the fields of its kind',
  {
    valid: [EXAMPLE_RISK_ITEM, { ref: { ...EXAMPLE_RISK_ITEM.ref, entityType: 'context_issue', code: 'CI-09' }, code: 'CI-09', title: 'Regulatory change', owner: 'lina', updatedAt: '2026-09-01T00:00:00Z', shared: true, ms: ['isms', 'qms'], issueType: 'external', lastReviewedAt: '2026-08-30' }],
    invalid: [{ ...EXAMPLE_RISK_ITEM, likelihood: 0 }, { ...EXAMPLE_RISK_ITEM, issueType: 'outside' }, { ...EXAMPLE_RISK_ITEM, ms: 'isms' }],
  },
);
export type RegisterItem = z.infer<typeof RegisterItem>;

export const RegisterCreate = named(
  'RegisterCreate',
  z.strictObject({ code: Code, title: Title, ownerHandle: PersonId.optional(), ...kindFields, linkedMs: z.array(MsId).min(1).optional(), confirm: z.boolean().optional() }),
  'POST /ms/{ms}/registers/{register} body: risks need an owner (BR-17); linkedMs for shareable kinds, the first is primary',
  {
    valid: [{ code: 'R-040', title: 'Loss of the backup site', ownerHandle: 'bagus', riskProfileCode: 'information_security', likelihood: 2, consequence: 5 }, { code: 'AS-12', title: 'Hypervisor cluster Surabaya', ownerHandle: 'bagus', assetType: 'infrastructure', classification: 'confidential', linkedMs: ['isms', 'bcms'] }],
    invalid: [{ title: 'No code' }, { code: 'R-040', title: 'x', likelihood: 101 }, { code: 'R-040', title: 'x', linkedMs: [] }],
  },
);
export type RegisterCreate = z.infer<typeof RegisterCreate>;

export const RegisterPatch = named(
  'RegisterPatch',
  z.strictObject({ code: Code.optional(), title: Title.optional(), ownerHandle: PersonId.optional(), ...kindFields, linkedMs: z.array(MsId).min(1).optional(), confirm: z.boolean().optional() })
    .refine((p) => Object.entries(p).some(([k, v]) => k !== 'confirm' && v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/registers/{register}/{id} body; confirm after 409 confirmation-required for shared records (BR-22)',
  { valid: [{ likelihood: 2, assessedAt: '2026-09-29' }, { title: 'Renamed', confirm: true }], invalid: [{}, { confirm: true }] },
);
export type RegisterPatch = z.infer<typeof RegisterPatch>;

export const MetricValueRequest = named(
  'MetricValueRequest',
  z.strictObject({ periodStart: IsoDate, periodEnd: IsoDate, value: z.number(), note: z.string().trim().max(1000).optional() })
    .refine((v) => v.periodEnd >= v.periodStart, { message: 'periodEnd is before periodStart', path: ['periodEnd'] }),
  'POST /ms/{ms}/metrics/{id}/values body (sets last_measured_at)',
  { valid: [{ periodStart: '2026-07-01', periodEnd: '2026-09-30', value: 97.5 }], invalid: [{ periodStart: '2026-09-30', periodEnd: '2026-07-01', value: 1 }, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }] },
);
export type MetricValueRequest = z.infer<typeof MetricValueRequest>;

export const TreatmentCreate = named(
  'TreatmentCreate',
  z.strictObject({ riskCode: Code, code: Code, title: Title, ownerHandle: PersonId, targetType: ApplicabilityTarget, targetCode: Code, targetDate: IsoDate }),
  'POST /ms/{ms}/risks/{id}/treatments body: the target is a catalogue item or requirement of the active edition',
  { valid: [{ riskCode: 'R-031', code: 'T-031', title: 'Patch hypervisors', ownerHandle: 'bagus', targetType: 'catalogue_item', targetCode: 'A.8.8', targetDate: '2026-12-15' }], invalid: [{ riskCode: 'R-031', code: 'T-031', title: 'x', ownerHandle: 'bagus', targetType: 'control', targetCode: 'A.8.8', targetDate: '2026-12-15' }] },
);
export type TreatmentCreate = z.infer<typeof TreatmentCreate>;

export const TreatmentPatch = named(
  'TreatmentPatch',
  z.strictObject({ title: Title.optional(), ownerHandle: PersonId.optional(), targetType: ApplicabilityTarget.optional(), targetCode: Code.optional(), targetDate: IsoDate.optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' })
    .refine((p) => (p.targetType === undefined) === (p.targetCode === undefined), { message: 'targetType and targetCode change together', path: ['targetCode'] }),
  'PATCH /ms/{ms}/treatments/{id} body',
  { valid: [{ targetDate: '2027-01-31' }, { targetType: 'requirement', targetCode: '8.1' }], invalid: [{}, { targetType: 'requirement' }] },
);
export type TreatmentPatch = z.infer<typeof TreatmentPatch>;

export const TreatmentTransition = named(
  'TreatmentTransition',
  z.strictObject({ to: TreatmentStatus, note: z.string().trim().min(1).max(1000).optional() }),
  'POST /ms/{ms}/treatments/{id}/transitions body (C.13); residual_accepted is reached only through residual acceptance',
  { valid: [{ to: 'approved' }, { to: 'delayed', note: 'Vendor patch late' }], invalid: [{ to: 'done' }, {}] },
);
export type TreatmentTransition = z.infer<typeof TreatmentTransition>;

export const ResidualAcceptanceRequest = named(
  'ResidualAcceptanceRequest',
  z.strictObject({ treatmentId: Uuid.optional(), residualLikelihood: Score, residualConsequence: Score, note: z.string().trim().min(1).max(2000) }),
  "POST /ms/{ms}/risks/{id}/residual-acceptance body: by the risk's owner, never the treatment implementer (BR-04)",
  { valid: [{ treatmentId: '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', residualLikelihood: 1, residualConsequence: 3, note: 'Accepted after PAM rollout' }], invalid: [{ residualLikelihood: 1, residualConsequence: 3 }, { residualLikelihood: 0, residualConsequence: 3, note: 'x' }] },
);
export type ResidualAcceptanceRequest = z.infer<typeof ResidualAcceptanceRequest>;

const EvidenceTarget = z.strictObject({ targetType: ApplicabilityTarget, code: Code });

export const EvidenceCreate = named(
  'EvidenceCreate',
  z.strictObject({ code: Code, title: Title, ownerHandle: PersonId, frequencyCode: FreqId, classification: Classification, targets: z.array(EvidenceTarget).min(1) }),
  'POST /ms/{ms}/evidence body: at least one target in the path system',
  { valid: [{ code: 'EV-0500', title: 'Quarterly firewall rule review', ownerHandle: 'bagus', frequencyCode: 'quarterly', classification: 'internal', targets: [{ targetType: 'catalogue_item', code: 'A.8.20' }] }], invalid: [{ code: 'EV-0500', title: 'x', ownerHandle: 'bagus', frequencyCode: 'quarterly', classification: 'internal', targets: [] }] },
);
export type EvidenceCreate = z.infer<typeof EvidenceCreate>;

export const EvidencePatch = named(
  'EvidencePatch',
  z.strictObject({
    title: Title.optional(), ownerHandle: PersonId.optional(), frequencyCode: FreqId.optional(), classification: Classification.optional(),
    nextDueOverride: IsoDate.nullable().optional(), confirm: z.boolean().optional(),
  }).refine((p) => Object.entries(p).some(([k, v]) => k !== 'confirm' && v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/evidence/{id} body (enqueues freshness.recompute; BR-22 confirmation for shared evidence)',
  { valid: [{ nextDueOverride: '2026-10-31' }, { frequencyCode: 'monthly', confirm: true }], invalid: [{}, { code: 'EV-1' }] },
);
export type EvidencePatch = z.infer<typeof EvidencePatch>;

export const EvidenceTargetRequest = named(
  'EvidenceTargetRequest',
  z.strictObject({ ms: MsId, targetType: ApplicabilityTarget, code: Code, mappingNote: z.string().trim().max(1000).optional() }),
  'POST /ms/{ms}/evidence/{id}/targets body: the target system may differ from the path system with integrated_mode (BR-23 warning)',
  { valid: [{ ms: 'qms', targetType: 'requirement', code: '7.5', mappingNote: 'Same document control process' }], invalid: [{ targetType: 'requirement', code: '7.5' }] },
);
export type EvidenceTargetRequest = z.infer<typeof EvidenceTargetRequest>;

export const EvidenceTargetParams = named('EvidenceTargetParams', z.strictObject({ ms: MsId, id: Uuid, targetId: Uuid }), 'Path parameters {ms}, {id} (evidence) and {targetId} (evidence_target)', {
  valid: [{ ms: 'isms', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', targetId: '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e' }],
  invalid: [{ ms: 'isms', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }],
});
export type EvidenceTargetParams = z.infer<typeof EvidenceTargetParams>;

export const EvidenceTargetRemoveRequest = named('EvidenceTargetRemoveRequest', z.strictObject({ reason: z.string().trim().min(1).max(500) }), 'POST /ms/{ms}/evidence/{id}/targets/{targetId}/remove body', {
  valid: [{ reason: 'Mapped to the wrong control' }],
  invalid: [{}, { reason: '' }],
});
export type EvidenceTargetRemoveRequest = z.infer<typeof EvidenceTargetRemoveRequest>;

export const EntityLinkRequest = named(
  'EntityLinkRequest',
  z.strictObject({ entityType: ShareableEntityType, entityCode: Code, isPrimary: z.boolean().optional(), relevanceNote: z.string().trim().max(1000).optional() }),
  'POST /ms/{ms}/entity-links body: link a shareable record to the path system (feature integrated_mode)',
  { valid: [{ entityType: 'risk', entityCode: 'R-014', relevanceNote: 'Also a continuity risk' }], invalid: [{ entityType: 'finding', entityCode: 'NC-1' }] },
);
export type EntityLinkRequest = z.infer<typeof EntityLinkRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const ms = { auth: 'session' as const, scope: 'ms' as const, msSource: 'path' as const, owner: 'WP-36' as const };

/** D.3: risks need `risk.manage`; the other register kinds need `register.manage` (own). */
const registerPermission = {
  source: 'path',
  member: 'register',
  cases: {
    'risks': { permission: 'risk.manage', scope: 'ms' },
    '*': { permission: 'register.manage', scope: 'ms' },
  },
} as const satisfies PermissionByMember;
const registerRoute = { auth: 'session' as const, msSource: 'path' as const, owner: 'WP-36' as const, permissionBy: registerPermission };

export const registersListRoute = defineRoute({
  ...ms, id: 'registers.list', method: 'GET', path: '/api/v1/ms/:ms/registers/:register',
  summary: 'Rows of a register (context issues, interested parties, assets, risks, metrics), filtered by ScopePolicy',
  permission: 'ms.read', params: RegisterParams, query: RegisterListQuery, response: pageOf(RegisterItem), errors: [404],
});

export const registersCreateRoute = defineRoute({
  ...registerRoute, id: 'registers.create', method: 'POST', path: '/api/v1/ms/:ms/registers/:register',
  summary: 'Add a register row: risks need risk.manage and an owner (BR-17); the other kinds need register.manage (own)',
  params: RegisterParams, body: RegisterCreate, response: CommandResult, status: 201,
  errors: [409, 422], idempotent: true,
});

export const registersUpdateRoute = defineRoute({
  ...registerRoute, id: 'registers.update', method: 'PATCH', path: '/api/v1/ms/:ms/registers/:register/:id',
  summary: "Change a register row: risks need risk.manage (the Risk Owner only for the assessment fields of own risks); others register.manage (own)",
  params: RegisterItemParams, body: RegisterPatch, response: CommandResult,
  errors: [404, 409, 412, 422], ifMatch: true,
});

export const metricValuesCreateRoute = defineRoute({
  ...ms, id: 'metrics.values.create', method: 'POST', path: '/api/v1/ms/:ms/metrics/:id/values',
  summary: 'Record a metric value for a period', permission: 'metric.record', params: MsRecordParams, body: MetricValueRequest,
  response: CommandResult, status: 201, errors: [404, 422], idempotent: true,
});

export const treatmentsCreateRoute = defineRoute({
  ...ms, id: 'treatments.create', method: 'POST', path: '/api/v1/ms/:ms/risks/:id/treatments',
  summary: 'Add a treatment to a risk', permission: 'risk.manage', params: MsRecordParams, body: TreatmentCreate,
  response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});

export const treatmentsUpdateRoute = defineRoute({
  ...ms, id: 'treatments.update', method: 'PATCH', path: '/api/v1/ms/:ms/treatments/:id',
  summary: 'Change a treatment', permission: 'risk.manage', params: MsRecordParams, body: TreatmentPatch,
  response: CommandResult, errors: [404, 412, 422], ifMatch: true,
});

export const treatmentsTransitionRoute = defineRoute({
  ...ms, id: 'treatments.transition', method: 'POST', path: '/api/v1/ms/:ms/treatments/:id/transitions',
  summary: 'Move a treatment along C.13 (closing without residual acceptance is rejected, BR-04)',
  machine: 'risk_treatment.status', params: MsRecordParams, body: TreatmentTransition, response: CommandResult,
  errors: [404, 409, 412, 422], ifMatch: true,
});

export const residualAcceptanceRoute = defineRoute({
  ...ms, id: 'risks.residual-acceptance', method: 'POST', path: '/api/v1/ms/:ms/risks/:id/residual-acceptance',
  summary: "Accept the residual risk (the risk's owner, never the implementer; moves the treatment to residual_accepted)",
  permission: 'risk.residual.accept', params: MsRecordParams, body: ResidualAcceptanceRequest, response: CommandResult, status: 201,
  errors: [404, 409, 422], idempotent: true,
});

export const evidenceCreateRoute = defineRoute({
  ...ms, id: 'evidence.create', method: 'POST', path: '/api/v1/ms/:ms/evidence',
  summary: 'Create an evidence record with its targets', permission: 'evidence.manage', params: MsParams, body: EvidenceCreate,
  response: CommandResult, status: 201, errors: [409, 422], idempotent: true,
});

export const evidenceUpdateRoute = defineRoute({
  ...ms, id: 'evidence.update', method: 'PATCH', path: '/api/v1/ms/:ms/evidence/:id',
  summary: 'Change an evidence record (enqueues freshness.recompute)', permission: 'evidence.manage', params: MsRecordParams,
  body: EvidencePatch, response: CommandResult, errors: [404, 409, 412], ifMatch: true,
});

export const evidenceTargetsCreateRoute = defineRoute({
  ...ms, id: 'evidence.targets.create', method: 'POST', path: '/api/v1/ms/:ms/evidence/:id/targets',
  summary: 'Add a target to an evidence record (integrated_mode for another system; warning BR-23)', permission: 'evidence.manage',
  params: MsRecordParams, body: EvidenceTargetRequest, response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});

export const evidenceTargetsRemoveRoute = defineRoute({
  ...ms, id: 'evidence.targets.remove', method: 'POST', path: '/api/v1/ms/:ms/evidence/:id/targets/:targetId/remove',
  summary: 'Remove a target of an evidence record (never the last one)', permission: 'evidence.manage',
  params: EvidenceTargetParams, body: EvidenceTargetRemoveRequest, response: CommandResult, errors: [404, 422],
});

export const entityLinksCreateRoute = defineRoute({
  ...ms, id: 'entity-links.create', method: 'POST', path: '/api/v1/ms/:ms/entity-links',
  summary: 'Link a shareable record to this system (feature integrated_mode)', permission: 'entity_link.manage', params: MsParams,
  body: EntityLinkRequest, response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});

export const entityLinksMakePrimaryRoute = defineRoute({
  ...ms, id: 'entity-links.make-primary', method: 'POST', path: '/api/v1/ms/:ms/entity-links/:id/make-primary',
  summary: 'Make this link the primary system of the record (A-29)', permission: 'entity_link.manage', params: MsRecordParams,
  body: ReasonBody, response: CommandResult, errors: [404, 422],
});

export const entityLinksRemoveRoute = defineRoute({
  ...ms, id: 'entity-links.remove', method: 'POST', path: '/api/v1/ms/:ms/entity-links/:id/remove',
  summary: 'Remove a link (never the only primary link)', permission: 'entity_link.manage', params: MsRecordParams,
  body: ReasonBody, response: CommandResult, errors: [404, 422],
});

export const routes: RouteDef[] = [
  registersListRoute, registersCreateRoute, registersUpdateRoute, metricValuesCreateRoute, treatmentsCreateRoute, treatmentsUpdateRoute,
  treatmentsTransitionRoute, residualAcceptanceRoute, evidenceCreateRoute, evidenceUpdateRoute, evidenceTargetsCreateRoute,
  evidenceTargetsRemoveRoute, entityLinksCreateRoute, entityLinksMakePrimaryRoute, entityLinksRemoveRoute,
];
