// State machines of build plan C.13 as transition tables. A command looks up the rows its route performs for the
// `(from, to)` pair (`transitionsVia`); a pair without a row answers 409 `transition-not-allowed`, or 422 with the rule
// of a `rejections` entry of the same route (`rejectionFor`; D.3 answers 422 BR-04 when a treatment is closed without
// residual acceptance, or when residual acceptance meets a treatment that is not `implemented`). Several rows for one
// pair are alternatives: the actor needs the permission of one of them (for example `activity.transition` on an own
// record, or `activity.verify`). A row or rejection with `via` belongs to that dedicated route only; the machine's
// transition route performs the rows without `via`. A row with `permission: null` is performed by the system only
// (jobs). The RBAC suite and the contract tests read the same tables (J.5).
import {
  ACTIVITY_STATUSES, APPROVAL_STATUSES, CORRECTIVE_ACTION_STATUSES, DOCUMENT_STATUSES, FINDING_STATUSES,
  IMPLEMENTATION_STATUSES, MANAGEMENT_REVIEW_STATUSES, MS_STATUSES, SELF_ASSESSMENT_STATUSES, TASK_PROGRESS_STATUSES,
  TREATMENT_STATUSES,
} from './enums.js';
import type { Permission, RuleId } from './enums.js';

export const MACHINE_ENTITIES = [
  'applicability_entry.implementation_status',
  'implementation_activity_progress.status',
  'document.status',
  'risk_treatment.status',
  'finding.status',
  'corrective_action.status',
  'management_review.status',
  'self_assessment.status',
  'audit_prep_task.status',
  'cycle_requirement_status.status',
  'user_ms_role.approval_status',
  'management_system.status',
] as const;
export type MachineEntity = (typeof MACHINE_ENTITIES)[number];

/** One row of a transition table (C.13). */
export interface Transition {
  entity: MachineEntity;
  /** Current state; null when the record is created in `to`. */
  from: string | null;
  to: string;
  /** Permission the actor needs (F.6); null when only the system performs the transition. */
  permission: Permission | null;
  /** Permissions the actor needs besides `permission` (D.3 "A and B"); the `via` route lists the same in `allOf`. */
  allOf?: readonly Permission[];
  /** An own-scoped grant of the permission is enough when the actor owns or holds the record (D.3 "(own)"). */
  own?: boolean;
  /** Rules evaluated on the transition. */
  rules: readonly RuleId[];
  /** Columns the transition sets besides the status. */
  sets: readonly string[];
  /** Request members that must be present (for example a note or a justification). */
  requires?: readonly string[];
  /** Route id when the transition is only reachable through a dedicated route. */
  via?: string;
  note?: string;
}

/**
 * A pair that has no transition row on a route and that the route's command rejects with a business rule (422
 * `business-rule`) instead of 409 `transition-not-allowed`, because D.3 names the rule for it. Not a transition: no
 * role may perform it.
 */
export interface Rejection {
  entity: MachineEntity;
  from: string;
  to: string;
  rule: RuleId;
  /** Route id when the rejection belongs to a dedicated route; absent for the machine's transition route. */
  via?: string;
  note: string;
}

/** A machine: its states, its owner work package, its rows and the pairs rejected with a rule. */
export interface Machine {
  entity: MachineEntity;
  owner: `WP-${string}`;
  states: readonly string[];
  transitions: readonly Transition[];
  rejections: readonly Rejection[];
}

interface RowOptions {
  own?: boolean;
  allOf?: readonly Permission[];
  rules?: readonly RuleId[];
  sets?: readonly string[];
  requires?: readonly string[];
  via?: string;
  note?: string;
}

/** Builds rows from one or more source states to one target state. */
function rows<S extends string>(
  entity: MachineEntity,
  from: S | null | readonly (S | null)[],
  to: S,
  permission: Permission | null,
  options: RowOptions = {},
): Transition[] {
  const sources = Array.isArray(from) ? (from as readonly (S | null)[]) : [from as S | null];
  return sources.map((source) => ({
    entity,
    from: source,
    to,
    permission,
    ...(options.allOf ? { allOf: options.allOf } : {}),
    ...(options.own ? { own: true } : {}),
    rules: options.rules ?? [],
    sets: options.sets ?? [],
    ...(options.requires ? { requires: options.requires } : {}),
    ...(options.via ? { via: options.via } : {}),
    ...(options.note ? { note: options.note } : {}),
  }));
}

/** Builds rejections from one or more source states to one target state, on the transition route or `via` a dedicated one. */
function rejections<S extends string>(entity: MachineEntity, from: readonly S[], to: S, rule: RuleId, note: string, via?: string): Rejection[] {
  return from.map((source) => ({ entity, from: source, to, rule, ...(via ? { via } : {}), note }));
}

type ImplementationState = (typeof IMPLEMENTATION_STATUSES)[number];
const APPLICABILITY = 'applicability_entry.implementation_status' as const;
const applicability: Machine = {
  entity: APPLICABILITY,
  owner: 'WP-20',
  states: IMPLEMENTATION_STATUSES,
  transitions: [
    ...rows<ImplementationState>(APPLICABILITY, null, 'not_started', 'applicability.manage'),
    ...rows<ImplementationState>(APPLICABILITY, 'not_started', 'planned', 'applicability.manage'),
    ...rows<ImplementationState>(APPLICABILITY, ['not_started', 'planned', 'partially_implemented'], 'complete', 'applicability.complete', {
      own: true, sets: ['completed_by_user_id', 'completed_at'],
    }),
    ...rows<ImplementationState>(APPLICABILITY, 'planned', 'partially_implemented', 'applicability.complete', { own: true }),
    ...rows<ImplementationState>(APPLICABILITY, 'complete', 'implemented', 'applicability.verify', {
      rules: ['BR-01', 'VERIFY-SELF'], sets: ['verified_by_user_id', 'verified_at'],
    }),
    ...rows<ImplementationState>(APPLICABILITY, 'complete', 'partially_implemented', 'applicability.verify', { note: 'Rejection of a completed entry' }),
    ...rows<ImplementationState>(APPLICABILITY, 'partially_implemented', 'implemented', 'applicability.verify', {
      rules: ['BR-01', 'VERIFY-SELF'], sets: ['verified_by_user_id', 'verified_at'],
      note: 'VERIFY-SELF applies to every requirement verification (A.4 5.4)',
    }),
    ...rows<ImplementationState>(APPLICABILITY, [null, 'not_started', 'planned', 'partially_implemented', 'complete', 'implemented'], 'not_applicable', 'applicability.manage', {
      requires: ['exclusionJustification'],
    }),
    ...rows<ImplementationState>(APPLICABILITY, 'implemented', 'partially_implemented', null, {
      rules: ['BR-11', 'BR-31'], note: 'Automatic downgrade by freshness.recompute when no valid evidence keeps the entry implemented (E.3, TS 6.1)',
    }),
  ],
  rejections: [],
};

type ActivityState = (typeof ACTIVITY_STATUSES)[number];
const ACTIVITY = 'implementation_activity_progress.status' as const;
const activity: Machine = {
  entity: ACTIVITY,
  owner: 'WP-20',
  states: ACTIVITY_STATUSES,
  transitions: [
    ...rows<ActivityState>(ACTIVITY, 'not_started', 'in_progress', 'activity.transition', { own: true, rules: ['BR-12'] }),
    ...rows<ActivityState>(ACTIVITY, 'not_started', 'complete', 'activity.transition', {
      own: true, rules: ['BR-12', 'BR-40'], sets: ['completed_by_user_id', 'completed_at'],
      note: 'Two steps in one command (A.4 5.12): not_started to in_progress (BR-12, the gate lock) then in_progress to complete (BR-40); two audit entries',
    }),
    ...rows<ActivityState>(ACTIVITY, 'in_progress', 'complete', 'activity.transition', {
      own: true, rules: ['BR-40'], sets: ['completed_by_user_id', 'completed_at'],
    }),
    ...rows<ActivityState>(ACTIVITY, 'complete', 'verified', 'activity.verify', {
      rules: ['VERIFY-SELF'], sets: ['verified_by_user_id', 'verified_at'],
      note: 'The verifier differs from the completer and the owner; another MS Manager or a Programme Owner verifies when the MS Manager owns the activity (A-48)',
    }),
    ...rows<ActivityState>(ACTIVITY, 'complete', 'in_progress', 'activity.verify', { requires: ['rejectReason'] }),
    ...rows<ActivityState>(ACTIVITY, ['not_started', 'in_progress', 'complete'], 'blocked', 'activity.transition', {
      own: true, rules: ['BR-39'], sets: ['blocker_gate_item_ref', 'blocker_reason'], requires: ['blockerGateItemRef', 'blockerReason'],
    }),
    ...rows<ActivityState>(ACTIVITY, ['not_started', 'in_progress', 'complete'], 'blocked', 'activity.verify', {
      rules: ['BR-39'], sets: ['blocker_gate_item_ref', 'blocker_reason'], requires: ['blockerGateItemRef', 'blockerReason'],
    }),
    ...rows<ActivityState>(ACTIVITY, 'blocked', 'in_progress', 'activity.transition', { own: true }),
  ],
  rejections: [],
};

type DocumentState = (typeof DOCUMENT_STATUSES)[number];
const DOCUMENT = 'document.status' as const;
const document: Machine = {
  entity: DOCUMENT,
  owner: 'WP-35',
  states: DOCUMENT_STATUSES,
  transitions: [
    ...rows<DocumentState>(DOCUMENT, ['draft', 'expired'], 'in_review', 'document.review', { own: true }),
    ...rows<DocumentState>(DOCUMENT, 'in_review', 'approved', 'document.approve', { rules: ['BR-16'] }),
    ...rows<DocumentState>(DOCUMENT, 'in_review', 'draft', 'document.approve', { requires: ['note'], note: 'Rejection of the version in review' }),
    ...rows<DocumentState>(DOCUMENT, 'approved', 'expired', null, { rules: ['BR-10'], note: 'tasks.overdue when next_review_at is past' }),
    ...rows<DocumentState>(DOCUMENT, ['draft', 'approved', 'expired'], 'in_review', 'document.version.create', {
      own: true, via: 'documents.versions',
      note: 'A new version puts the document in review (D.3; digest 5.10 "Upload new version (approved)"); a version already in review answers 409',
    }),
  ],
  rejections: [],
};

type TreatmentState = (typeof TREATMENT_STATUSES)[number];
const TREATMENT = 'risk_treatment.status' as const;
const treatment: Machine = {
  entity: TREATMENT,
  owner: 'WP-36',
  states: TREATMENT_STATUSES,
  transitions: [
    ...rows<TreatmentState>(TREATMENT, 'proposed', 'approved', 'risk.manage'),
    ...rows<TreatmentState>(TREATMENT, 'approved', 'in_progress', 'risk.treatment.update', { own: true }),
    ...rows<TreatmentState>(TREATMENT, 'in_progress', 'delayed', null, { note: 'Target date passed' }),
    ...rows<TreatmentState>(TREATMENT, 'in_progress', 'delayed', 'risk.treatment.update', { own: true }),
    ...rows<TreatmentState>(TREATMENT, 'delayed', 'in_progress', 'risk.treatment.update', { own: true }),
    ...rows<TreatmentState>(TREATMENT, ['in_progress', 'delayed'], 'implemented', 'risk.treatment.update', {
      own: true, sets: ['implemented_by_user_id', 'implemented_at'],
    }),
    ...rows<TreatmentState>(TREATMENT, 'implemented', 'residual_accepted', 'risk.residual.accept', {
      own: true, rules: ['BR-04'], via: 'risks.residual-acceptance',
      note: "Only through POST .../residual-acceptance by the risk's owner, never the implementer",
    }),
    ...rows<TreatmentState>(TREATMENT, 'residual_accepted', 'closed', 'risk.manage', { sets: ['closed_at'] }),
    ...rows<TreatmentState>(TREATMENT, ['approved', 'in_progress', 'delayed'], 'proposed', 'risk.manage', { note: 'Rework of an open treatment' }),
  ],
  rejections: [
    ...rejections<TreatmentState>(TREATMENT, ['proposed', 'approved', 'in_progress', 'delayed', 'implemented'], 'closed', 'BR-04',
      'Closing without residual acceptance (D.3 answers 422 BR-04); the risk owner accepts the residual risk first'),
    ...rejections<TreatmentState>(TREATMENT, ['proposed', 'approved', 'in_progress', 'delayed', 'residual_accepted', 'closed'], 'residual_accepted', 'BR-04',
      'Residual acceptance of a treatment that is not implemented (D.3 answers 422 BR-04)', 'risks.residual-acceptance'),
  ],
};

type FindingState = (typeof FINDING_STATUSES)[number];
const FINDING = 'finding.status' as const;
const finding: Machine = {
  entity: FINDING,
  owner: 'WP-37',
  states: FINDING_STATUSES,
  transitions: [
    ...rows<FindingState>(FINDING, 'open', 'in_progress', 'finding.manage'),
    ...rows<FindingState>(FINDING, ['open', 'in_progress'], 'closed', 'finding.manage', {
      rules: ['BR-06', 'BR-07', 'BR-08'], sets: ['closed_at', 'closed_by_user_id', 'close_note'],
      note: 'major: rca_text and systemic_check_text filled; major and minor: a linked corrective action closed with effective = true; ofi, signal and not_a_finding close with a close_note',
    }),
    ...rows<FindingState>(FINDING, 'closed', 'in_progress', 'finding.manage', { requires: ['note'], note: 'Reopen' }),
  ],
  rejections: [],
};

type CorrectiveActionState = (typeof CORRECTIVE_ACTION_STATUSES)[number];
const CORRECTIVE_ACTION = 'corrective_action.status' as const;
const CA_STEPS: readonly [CorrectiveActionState, CorrectiveActionState, string, string[]][] = [
  ['correction', 'rca', 'correction_text', ['correction_text']],
  ['rca', 'systemic_check', 'rca_text', ['rca_text']],
  ['systemic_check', 'action', 'systemic_check_text', ['systemic_check_text']],
  ['action', 'effectiveness_verification', 'action_text', ['action_text', 'implemented_by_user_id', 'implemented_at']],
];
const correctiveAction: Machine = {
  entity: CORRECTIVE_ACTION,
  owner: 'WP-37',
  states: CORRECTIVE_ACTION_STATUSES,
  transitions: [
    ...CA_STEPS.flatMap(([from, to, , sets]) => [
      ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, from, to, 'corrective_action.update', { own: true, sets, requires: ['text'] }),
      ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, from, to, 'corrective_action.manage', { sets, requires: ['text'] }),
    ]),
    ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, 'effectiveness_verification', 'closed', 'corrective_action.verify', {
      rules: ['BR-09', 'BR-08'], sets: ['verified_by_user_id', 'verified_at', 'effective', 'verification_note'], requires: ['effective'],
      note: 'effective = true; the verifier differs from the implementer and the owner, on another day than the implementation',
    }),
    ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, 'effectiveness_verification', 'action', 'corrective_action.verify', {
      rules: ['BR-09'], sets: ['verification_note'], requires: ['effective'], note: 'effective = false returns the action to the action step',
    }),
    ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, ['correction', 'rca', 'systemic_check', 'action', 'effectiveness_verification'], 'cancelled', 'corrective_action.manage', {
      requires: ['note'],
    }),
  ],
  rejections: [],
};

type ManagementReviewState = (typeof MANAGEMENT_REVIEW_STATUSES)[number];
const MANAGEMENT_REVIEW = 'management_review.status' as const;
const managementReview: Machine = {
  entity: MANAGEMENT_REVIEW,
  owner: 'WP-37',
  states: MANAGEMENT_REVIEW_STATUSES,
  transitions: [
    ...rows<ManagementReviewState>(MANAGEMENT_REVIEW, 'planned', 'held', 'management_review.manage', { sets: ['held_at'] }),
    ...rows<ManagementReviewState>(MANAGEMENT_REVIEW, 'held', 'closed', 'management_review.manage', {
      rules: ['BR-13', 'BR-14'], sets: ['closed_at', 'closed_by_user_id', 'decisions_recorded', 'decisions_text'],
    }),
  ],
  rejections: [],
};

type SelfAssessmentState = (typeof SELF_ASSESSMENT_STATUSES)[number];
const SELF_ASSESSMENT = 'self_assessment.status' as const;
const selfAssessment: Machine = {
  entity: SELF_ASSESSMENT,
  owner: 'WP-37',
  states: SELF_ASSESSMENT_STATUSES,
  transitions: SELF_ASSESSMENT_STATUSES.flatMap((to) =>
    rows<SelfAssessmentState>(
      SELF_ASSESSMENT,
      [null, ...SELF_ASSESSMENT_STATUSES.filter((s) => s !== to)],
      to,
      'self_assessment.manage',
      to === 'gap' ? { requires: ['ownerHandle', 'targetFixAt'], sets: ['assessed_at'] } : { sets: ['assessed_at'] },
    ),
  ),
  rejections: [],
};

type ProgressState = (typeof TASK_PROGRESS_STATUSES)[number];
function progressMachine(entity: MachineEntity, permission: Permission): Machine {
  return {
    entity,
    owner: 'WP-35',
    states: TASK_PROGRESS_STATUSES,
    transitions: [
      ...rows<ProgressState>(entity, 'not_started', 'in_progress', permission, { own: true }),
      ...rows<ProgressState>(entity, 'in_progress', 'done', permission, { own: true }),
      ...rows<ProgressState>(entity, ['not_started', 'in_progress', 'done', 'overdue'], 'blocked', permission, { own: true, requires: ['note'] }),
      ...rows<ProgressState>(entity, 'blocked', 'in_progress', permission, { own: true }),
      ...rows<ProgressState>(entity, 'overdue', 'in_progress', permission, { own: true, note: 'A-23' }),
      ...rows<ProgressState>(entity, 'overdue', 'done', permission, { own: true, note: 'A-23' }),
      ...rows<ProgressState>(entity, ['not_started', 'in_progress'], 'overdue', null, { note: 'tasks.overdue when due_at is past (TS 6.7, 6.8)' }),
    ],
    rejections: [],
  };
}

type ApprovalState = (typeof APPROVAL_STATUSES)[number];
const ROLE_APPROVAL = 'user_ms_role.approval_status' as const;
const roleApproval: Machine = {
  entity: ROLE_APPROVAL,
  owner: 'WP-39',
  states: APPROVAL_STATUSES,
  transitions: [
    ...rows<ApprovalState>(ROLE_APPROVAL, 'pending_approval', 'active', 'user.manage', {
      rules: ['SOD-SELF-GRANT'], sets: ['approved_by'], note: 'The actor differs from requested_by and from the grantee',
    }),
    ...rows<ApprovalState>(ROLE_APPROVAL, 'pending_approval', 'rejected', 'user.manage', {
      rules: ['SOD-SELF-GRANT'], sets: ['approved_by'], note: 'The actor differs from requested_by and from the grantee',
    }),
  ],
  rejections: [],
};

type MsState = (typeof MS_STATUSES)[number];
const MANAGEMENT_SYSTEM = 'management_system.status' as const;
const managementSystem: Machine = {
  entity: MANAGEMENT_SYSTEM,
  owner: 'WP-12',
  states: MS_STATUSES,
  transitions: [
    ...rows<MsState>(MANAGEMENT_SYSTEM, null, 'setup', 'ms.admin', {
      allOf: ['pack.activate'], rules: ['BR-21', 'LIC-MS'], via: 'admin.ms.create', note: 'Creation needs ms.admin and pack.activate (D.3)',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'setup', 'implementing', 'ms.admin', {
      via: 'admin.ms.update', note: 'PATCH /admin/management-systems/{id} with status implementing',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, ['setup', 'implementing', 'certified', 'transitioning'], 'archived', 'ms.admin', {
      via: 'admin.ms.update', note: 'PATCH /admin/management-systems/{id} with status archived',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'certified', 'transitioning', 'ms.transition', {
      rules: ['LIC-FEATURE'], requires: ['targetEdition'], sets: ['transition_target_version_id'], note: 'Feature edition_transition',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'transitioning', 'certified', 'ms.transition', {
      rules: ['LIC-FEATURE'], note: 'After the transition audit recommended certification; feature edition_transition',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'implementing', 'certified', null, { note: 'When the certification cycle is certified' }),
  ],
  rejections: [],
};

/** Every machine of C.13, keyed by entity. */
export const MACHINES: Readonly<Record<MachineEntity, Machine>> = {
  'applicability_entry.implementation_status': applicability,
  'implementation_activity_progress.status': activity,
  'document.status': document,
  'risk_treatment.status': treatment,
  'finding.status': finding,
  'corrective_action.status': correctiveAction,
  'management_review.status': managementReview,
  'self_assessment.status': selfAssessment,
  'audit_prep_task.status': progressMachine('audit_prep_task.status', 'prep_task.update'),
  'cycle_requirement_status.status': progressMachine('cycle_requirement_status.status', 'cycle_item.update'),
  'user_ms_role.approval_status': roleApproval,
  'management_system.status': managementSystem,
};

/** Every transition row of every machine. */
export const TRANSITIONS: readonly Transition[] = MACHINE_ENTITIES.flatMap((entity) => MACHINES[entity].transitions);

/** Every rejection of every machine. */
export const REJECTIONS: readonly Rejection[] = MACHINE_ENTITIES.flatMap((entity) => MACHINES[entity].rejections);

/** Every row for one `(from, to)` pair, whatever route performs it. Commands use `transitionsVia` instead. */
export function transitionsFor(entity: MachineEntity, from: string | null, to: string): Transition[] {
  return MACHINES[entity].transitions.filter((t) => t.from === from && t.to === to);
}

/**
 * The rows of a pair that one route performs: `via` null for the machine's transition route (the rows without
 * `via`), or the id of a dedicated route (the rows whose `via` is that id). Commands look up their rows with this; an
 * empty list means 409 `transition-not-allowed`, unless `rejectionFor` with the same `via` names a rule (422).
 */
export function transitionsVia(entity: MachineEntity, from: string | null, to: string, via: string | null): Transition[] {
  return transitionsFor(entity, from, to).filter((t) => (t.via ?? null) === via);
}

/**
 * The rejection of a pair that has no rows on one route (`via` as for `transitionsVia`): the command answers 422 with
 * its rule instead of 409.
 */
export function rejectionFor(entity: MachineEntity, from: string | null, to: string, via: string | null): Rejection | undefined {
  return MACHINES[entity].rejections.find((r) => r.from === from && r.to === to && (r.via ?? null) === via);
}

/**
 * Permissions of the rows one route performs (`via` as for `transitionsVia`; the default null is the machine's
 * transition route): what that route's guard accepts. Rows of dedicated routes do not count for the transition route.
 */
export function machinePermissions(entity: MachineEntity, via: string | null = null): Permission[] {
  const out = new Set<Permission>();
  for (const t of MACHINES[entity].transitions) if (t.permission && (t.via ?? null) === via) out.add(t.permission);
  return [...out];
}
