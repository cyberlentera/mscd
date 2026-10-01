// Area `records` (owner from wave 9: WP-35): commands that apply to many record types through `{entityType}`:
// assignment, completing a pending action, soft delete (BR-19, BR-22), and completing a stored task (D-29).
import { z } from 'zod';
import { CommandResult, IdParams, IsoDate, MsId, PersonId, RequiredReason, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

/**
 * Entity types a `{entityType}` path segment accepts (D.1): the chain and register tables. Anything else answers
 * 404 before a query runs.
 */
export const RECORD_ENTITY_TYPES = [
  'applicability_entry', 'document', 'evidence', 'implementation_activity_progress', 'context_issue', 'interested_party',
  'asset', 'risk', 'risk_treatment', 'metric', 'quality_objective', 'process', 'prioritized_activity',
  'business_impact_analysis', 'bc_plan', 'exercise', 'business_associate', 'chain_record', 'audit_prep_task',
  'cycle_requirement_status', 'drift_result', 'finding', 'corrective_action', 'management_review', 'self_assessment',
  'audit_activity',
] as const;
export const RecordEntityType = z.enum(RECORD_ENTITY_TYPES).meta({ id: 'RecordEntityType', description: 'Entity type of a {entityType} path segment (D.1 RECORD_ENTITY_TYPES)' });
export type RecordEntityType = z.infer<typeof RecordEntityType>;

/** Tables that hold the explicit chain records of entity stages (C.10), the `x` assignment kind. */
export const STAGE_RECORD_ENTITY_TYPES = [
  'context_issue', 'risk', 'risk_treatment', 'metric', 'quality_objective', 'prioritized_activity', 'business_impact_analysis',
  'exercise', 'business_associate', 'chain_record',
] as const satisfies readonly RecordEntityType[];

/** Assignment kinds: the RecordKey kind of the item being reassigned (D.2 `AssignmentRequest`). */
export const ASSIGNMENT_KINDS = ['req', 'soa', 'doc', 'ev', 'act', 'x', 'prep', 'cycle', 'drift'] as const;
export const AssignmentKind = z.enum(ASSIGNMENT_KINDS).meta({ id: 'AssignmentKind', description: 'RecordKey kind of the assigned item (D.2 AssignmentRequest.kind)' });
export type AssignmentKind = z.infer<typeof AssignmentKind>;

/** Entity types each assignment kind applies to (WP-35 assignment table); another pair answers 422. */
export const ASSIGNMENT_KIND_ENTITY_TYPES: Readonly<Record<AssignmentKind, readonly RecordEntityType[]>> = {
  req: ['applicability_entry'],
  soa: ['applicability_entry'],
  doc: ['document'],
  ev: ['evidence'],
  act: ['implementation_activity_progress'],
  x: STAGE_RECORD_ENTITY_TYPES,
  prep: ['audit_prep_task'],
  cycle: ['cycle_requirement_status'],
  drift: ['drift_result'],
};

export const RecordParams = named(
  'RecordParams',
  z.strictObject({ ms: MsId, entityType: RecordEntityType, id: Uuid }),
  'Path parameters {ms}, {entityType} and {id}',
  { valid: [{ ms: 'isms', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }], invalid: [{ ms: 'isms', entityType: 'app_user', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }, { ms: 'isms', entityType: 'risk', id: 'R-031' }] },
);
export type RecordParams = z.infer<typeof RecordParams>;

export const AssignmentRequest = named(
  'AssignmentRequest',
  z.strictObject({ kind: AssignmentKind, holder: PersonId, dueAt: IsoDate.nullable() }),
  'POST /ms/{ms}/records/{entityType}/{id}/assignment body: the kind selects the fields (a SoA gate item never changes the control owner); holder none unassigns',
  { valid: [{ kind: 'x', holder: 'bagus', dueAt: '2026-10-20' }, { kind: 'soa', holder: 'none', dueAt: null }], invalid: [{ kind: 'task', holder: 'bagus', dueAt: null }, { kind: 'x', holder: 'bagus' }] },
);
export type AssignmentRequest = z.infer<typeof AssignmentRequest>;

export const CompleteActionRequest = named('CompleteActionRequest', z.strictObject({ note: z.string().trim().min(1).max(1000).optional() }), 'Body of complete-action and task completion: an optional note', {
  valid: [{}, { note: 'Reviewed with the owner' }],
  invalid: [{ note: '' }, { done: true }],
});
export type CompleteActionRequest = z.infer<typeof CompleteActionRequest>;

export const SoftDeleteRequest = named(
  'SoftDeleteRequest',
  z.strictObject({ reason: RequiredReason, confirm: z.boolean().optional() }),
  'POST .../delete body: a reason of 10 to 500 characters; confirm after 409 confirmation-required (BR-22)',
  { valid: [{ reason: 'Duplicate of R-014, merged' }, { reason: 'Shared document no longer used', confirm: true }], invalid: [{ reason: 'dup' }, { confirm: true }] },
);
export type SoftDeleteRequest = z.infer<typeof SoftDeleteRequest>;

export const recordsAssignRoute = defineRoute({
  id: 'records.assign',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/records/:entityType/:id/assignment',
  summary: 'Reassign the holder and due date of an item (BR-43 for preparation tasks; warnings BR-41, BR-17)',
  auth: 'session',
  permission: 'record.assign',
  scope: 'ms',
  msSource: 'path',
  params: RecordParams,
  body: AssignmentRequest,
  response: CommandResult,
  errors: [404, 412, 422],
  ifMatch: true,
});

export const recordsCompleteActionRoute = defineRoute({
  id: 'records.complete-action',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/records/:entityType/:id/complete-action',
  summary: 'Mark the pending action of a chain record or drift row done',
  auth: 'session',
  permission: 'record.complete_action',
  scope: 'ms',
  msSource: 'path',
  params: RecordParams,
  body: CompleteActionRequest,
  response: CommandResult,
  errors: [404, 409],
});

export const recordsDeleteRoute = defineRoute({
  id: 'records.delete',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/records/:entityType/:id/delete',
  summary: 'Soft delete a record with a reason (BR-19, BR-22 confirmation, open dependants rejected)',
  auth: 'session',
  permission: 'record.delete',
  scope: 'ms',
  msSource: 'path',
  params: RecordParams,
  body: SoftDeleteRequest,
  response: CommandResult,
  errors: [404, 409, 422],
});

export const tasksCompleteRoute = defineRoute({
  id: 'tasks.complete',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/tasks/:id/complete',
  summary: "Complete a stored task (the task's owner only)",
  auth: 'session',
  params: IdParams,
  body: CompleteActionRequest,
  response: CommandResult,
  errors: [404, 409],
});

export const routes: RouteDef[] = [recordsAssignRoute, recordsCompleteActionRoute, recordsDeleteRoute, tasksCompleteRoute];
