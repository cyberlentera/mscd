// Area `implementation` (owner from wave 8: WP-20; the operating criteria route: WP-36): applicability entries,
// activities and phases (D.2, D.3 "Commands from the UI", C.13).
import { z } from 'zod';
import { ApplicabilityTarget, ImplementationStatus } from '../enums.js';
import { Code, CommandResult, FreqId, MsParams, MsRecordParams, PersonId, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { PhaseParams } from './readmodel.js';

const Justification = z.string().trim().min(1).max(4000);
const Note = z.string().trim().min(1).max(1000);

export const ApplicabilityTransitionRequest = named(
  'ApplicabilityTransitionRequest',
  z.strictObject({ to: ImplementationStatus, exclusionJustification: Justification.optional(), reason: Note.optional() })
    .refine((r) => r.to !== 'not_applicable' || r.exclusionJustification !== undefined, { message: 'not_applicable needs exclusionJustification', path: ['exclusionJustification'] }),
  'POST /ms/{ms}/applicability/{id}/transitions body (C.13): the target status, the exclusion justification for not_applicable, an optional reason',
  {
    valid: [{ to: 'complete' }, { to: 'implemented' }, { to: 'not_applicable', exclusionJustification: 'No development activities in scope' }, { to: 'partially_implemented', reason: 'Evidence does not cover Q3' }],
    invalid: [{ to: 'not_applicable' }, { to: 'blocked' }, { to: 'complete', note: 'x' }],
  },
);
export type ApplicabilityTransitionRequest = z.infer<typeof ApplicabilityTransitionRequest>;

export const ApplicabilityPatch = named(
  'ApplicabilityPatch',
  z.strictObject({
    isApplicable: z.boolean().optional(),
    inclusionJustification: Justification.nullable().optional(),
    exclusionJustification: Justification.nullable().optional(),
    holdsGate: z.boolean().optional(),
    gateReason: Note.nullable().optional(),
    statusNote: Note.nullable().optional(),
    frequencyCode: FreqId.optional(),
    ownerHandle: PersonId.optional(),
    riskCodes: z.array(Code).optional(),
    documentCodes: z.array(Code).optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/applicability/{id} body; ownerHandle none leaves the entry unassigned (BR-45); warning BR-03',
  {
    valid: [{ holdsGate: true, gateReason: 'No risk-based justification' }, { ownerHandle: 'bagus', riskCodes: ['R-014', 'R-031'], documentCodes: ['PRC-11'] }, { inclusionJustification: null }],
    invalid: [{}, { ownerHandle: 'Bagus' }, { riskCodes: 'R-014' }],
  },
);
export type ApplicabilityPatch = z.infer<typeof ApplicabilityPatch>;

export const ApplicabilityCreateRequest = named(
  'ApplicabilityCreateRequest',
  z.strictObject({
    targetType: ApplicabilityTarget,
    code: Code,
    isApplicable: z.boolean(),
    inclusionJustification: Justification.optional(),
    exclusionJustification: Justification.optional(),
    ownerHandle: PersonId,
    frequencyCode: FreqId,
  }).refine((r) => r.isApplicable || r.exclusionJustification !== undefined, { message: 'Entries that are not applicable need exclusionJustification', path: ['exclusionJustification'] }),
  'POST /ms/{ms}/applicability body: a catalogue item or requirement code of the active edition',
  {
    valid: [{ targetType: 'catalogue_item', code: 'A.5.7', isApplicable: true, inclusionJustification: 'Required by R-022', ownerHandle: 'rina', frequencyCode: 'quarterly' }],
    invalid: [{ targetType: 'catalogue_item', code: 'A.5.7', isApplicable: false, ownerHandle: 'rina', frequencyCode: 'quarterly' }, { targetType: 'control', code: 'A.5.7', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'quarterly' }],
  },
);
export type ApplicabilityCreateRequest = z.infer<typeof ApplicabilityCreateRequest>;

export const OperatingCriteriaRequest = named(
  'OperatingCriteriaRequest',
  z.strictObject({ frequencyCode: FreqId, description: z.string().trim().max(2000).optional() }),
  'PUT /ms/{ms}/applicability/{id}/operating-criteria body: frequency from ref.evidence_frequency_rule',
  { valid: [{ frequencyCode: 'monthly' }, { frequencyCode: 'event', description: 'After every change' }], invalid: [{}, { frequencyCode: 'Monthly' }] },
);
export type OperatingCriteriaRequest = z.infer<typeof OperatingCriteriaRequest>;

export const ActivityTransitionRequest = named(
  'ActivityTransitionRequest',
  z.strictObject({
    to: z.enum(['in_progress', 'complete', 'verified', 'blocked']),
    blockerGateItemRef: z.string().trim().min(1).max(60).optional(),
    blockerReason: Note.optional(),
    outputDocumentCode: Code.optional(),
    rejectReason: Note.optional(),
  }).refine((r) => r.to !== 'blocked' || (r.blockerGateItemRef !== undefined && r.blockerReason !== undefined), { message: 'blocked needs blockerGateItemRef and blockerReason', path: ['blockerGateItemRef'] }),
  'POST /ms/{ms}/activities/{id}/transitions body (C.13); rejectReason when a verifier returns a completed activity to in_progress',
  {
    valid: [{ to: 'complete', outputDocumentCode: 'SOA-01' }, { to: 'blocked', blockerGateItemRef: 'A.8.12', blockerReason: 'Blocked by gate item A.8.12' }, { to: 'in_progress', rejectReason: 'Output not approved' }],
    invalid: [{ to: 'blocked' }, { to: 'locked' }, { to: 'not_started' }],
  },
);
export type ActivityTransitionRequest = z.infer<typeof ActivityTransitionRequest>;

export const applicabilityTransitionRoute = defineRoute({
  id: 'applicability.transition',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/applicability/:id/transitions',
  summary: 'Change the implementation status of an entry (C.13: complete, verify, reject, not applicable)',
  auth: 'session',
  machine: 'applicability_entry.implementation_status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: ApplicabilityTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const applicabilityUpdateRoute = defineRoute({
  id: 'applicability.update',
  owner: 'WP-20',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/applicability/:id',
  summary: 'Change justifications, gate flag, note, frequency, owner, linked risks and documents of an entry',
  auth: 'session',
  permission: 'applicability.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: ApplicabilityPatch,
  response: CommandResult,
  errors: [404, 412, 422],
  ifMatch: true,
});

export const applicabilityCreateRoute = defineRoute({
  id: 'applicability.create',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/applicability',
  summary: 'Add an applicability entry for a catalogue item or requirement of the active edition',
  auth: 'session',
  permission: 'applicability.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: ApplicabilityCreateRequest,
  response: CommandResult,
  status: 201,
  errors: [409, 422],
  idempotent: true,
});

export const applicabilityOperatingCriteriaRoute = defineRoute({
  id: 'applicability.operating-criteria',
  owner: 'WP-36',
  method: 'PUT',
  path: '/api/v1/ms/:ms/applicability/:id/operating-criteria',
  summary: 'Set the operating frequency of an entry (enqueues freshness.recompute)',
  auth: 'session',
  permission: 'applicability.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: OperatingCriteriaRequest,
  response: CommandResult,
  errors: [404, 422],
});

export const activityTransitionRoute = defineRoute({
  id: 'activity.transition',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/activities/:id/transitions',
  summary: 'Change the status of an implementation activity (C.13: start, complete, verify, block)',
  auth: 'session',
  machine: 'implementation_activity_progress.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: ActivityTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const phaseVerifyRoute = defineRoute({
  id: 'phase.verify',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/phases/:n/verify',
  summary: 'Verify a phase once all its activities are verified (BR-12)',
  auth: 'session',
  permission: 'phase.verify',
  scope: 'ms',
  msSource: 'path',
  params: PhaseParams,
  response: CommandResult,
  errors: [404, 422],
});

export const routes: RouteDef[] = [
  applicabilityTransitionRoute, applicabilityUpdateRoute, applicabilityCreateRoute, applicabilityOperatingCriteriaRoute,
  activityTransitionRoute, phaseVerifyRoute,
];
