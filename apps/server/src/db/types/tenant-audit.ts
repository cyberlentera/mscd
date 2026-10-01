// Kysely row types of the tenant tables of migrations/tenant/0005_audit_cycle_phases.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns, type JsonDocument, type NullableJson } from './index';

/** `audit_event` */
export interface AuditEventTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  certification_cycle_id: string | null;
  event_type: 'stage1' | 'stage2' | 'surveillance' | 'recertification' | 'transition' | 'special';
  name_en: string;
  name_id: string;
  short_label: string;
  scheduled_at: string;
  audit_days: number | null;
  lead_auditor_name: string | null;
  expected_focus: string | null;
  prep_window_days: Generated<number>;
  outcome: 'recommended' | 'recommended_with_conditions' | 'not_recommended' | null;
  outcome_summary: string | null;
}

/** `audit_prep_task` */
export interface AuditPrepTaskTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  audit_event_id: string;
  management_system_id: string;
  template_code: string | null;
  title: string;
  owner_user_id: string | null;
  due_at: string;
  status: Generated<'not_started' | 'in_progress' | 'done' | 'blocked' | 'overdue'>;
  note: string | null;
  violates_br43: Generated<boolean>;
  position: Generated<number>;
}

/** `finding` */
export interface FindingTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  framework_version_id: string | null;
  audit_event_id: string | null;
  code: string;
  title: string;
  classification: 'major' | 'minor' | 'ofi' | 'signal' | 'not_a_finding';
  clause_ref: string | null;
  source: 'certification_audit' | 'internal_audit' | 'self_assessment' | 'other';
  status: Generated<'open' | 'in_progress' | 'closed'>;
  status_note: string | null;
  owner_user_id: string | null;
  raised_at: string | null;
  due_at: string | null;
  rca_text: string | null;
  systemic_check_text: string | null;
  closed_at: string | null;
  closed_by_user_id: string | null;
  close_note: string | null;
  position: Generated<number>;
}

/** `corrective_action` */
export interface CorrectiveActionTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  code: string;
  title: string;
  owner_user_id: string | null;
  status: Generated<'correction' | 'rca' | 'systemic_check' | 'action' | 'effectiveness_verification' | 'closed' | 'cancelled'>;
  correction_text: string | null;
  rca_text: string | null;
  systemic_check_text: string | null;
  action_text: string | null;
  due_at: string | null;
  implemented_at: string | null;
  implemented_by_user_id: string | null;
  verified_by_user_id: string | null;
  verified_at: string | null;
  effective: boolean | null;
  verification_note: string | null;
}

/** `management_review` */
export interface ManagementReviewTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  code: string;
  title: string;
  owner_user_id: string | null;
  planned_at: string | null;
  held_at: string | null;
  status: Generated<'planned' | 'held' | 'closed'>;
  decisions_recorded: Generated<boolean>;
  decisions_text: string | null;
  closed_at: string | null;
  closed_by_user_id: string | null;
}

/** `management_review_input` */
export interface ManagementReviewInputTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_review_id: string;
  review_input_def_id: string;
  management_system_id: string;
  content: string | null;
  source_refs: NullableJson<JsonDocument>;
}

/** `cycle_requirement_status` */
export interface CycleRequirementStatusTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  certification_cycle_id: string;
  cycle_requirement_def_id: string | null;
  requirement_code: Generated<string>;
  title: string;
  owner_user_id: string | null;
  status: Generated<'not_started' | 'in_progress' | 'done' | 'blocked' | 'overdue'>;
  due_at: string;
  condition_note: string | null;
  position: Generated<number>;
}

/** `drift_result` */
export interface DriftResultTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  drift_rule_def_id: string;
  rule_code: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_code: string;
  title: string;
  holder_user_id: string | null;
  due_at: string | null;
  detected_at: Generated<Date>;
  resolved_at: Date | null;
  position: Generated<number>;
}

/** `implementation_activity_progress` */
export interface ImplementationActivityProgressTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  activity_template_id: string;
  phase_no: number;
  activity_no: number;
  title: string;
  clause_ref: string | null;
  output_document_code: string | null;
  expected_outcome: string | null;
  is_gate_phase: Generated<boolean>;
  template_pack_version: string;
  owner_user_id: string | null;
  status: Generated<'not_started' | 'in_progress' | 'complete' | 'verified' | 'blocked'>;
  output_document_id: string | null;
  blocker_gate_item_ref: string | null;
  blocker_reason: string | null;
  due_at: string | null;
  completed_at: string | null;
  completed_by_user_id: string | null;
  verified_at: string | null;
  verified_by_user_id: string | null;
}

/** `trace_chain_instance` */
export interface TraceChainInstanceTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  anchor_code: string;
  position: Generated<number>;
}

/** `trace_chain_node` */
export interface TraceChainNodeTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  trace_chain_instance_id: string;
  position: number;
  stage_key: string;
  record_code: string | null;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantAuditTables {
  audit_event: AuditEventTable;
  audit_prep_task: AuditPrepTaskTable;
  finding: FindingTable;
  corrective_action: CorrectiveActionTable;
  management_review: ManagementReviewTable;
  management_review_input: ManagementReviewInputTable;
  cycle_requirement_status: CycleRequirementStatusTable;
  drift_result: DriftResultTable;
  implementation_activity_progress: ImplementationActivityProgressTable;
  trace_chain_instance: TraceChainInstanceTable;
  trace_chain_node: TraceChainNodeTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantAuditTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantAuditTables>()({
  audit_event: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'certification_cycle_id', 'event_type', 'name_en', 'name_id', 'short_label', 'scheduled_at',
    'audit_days', 'lead_auditor_name', 'expected_focus', 'prep_window_days', 'outcome', 'outcome_summary',
  ],
  audit_prep_task: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'audit_event_id',
    'management_system_id', 'template_code', 'title', 'owner_user_id', 'due_at', 'status', 'note', 'violates_br43',
    'position',
  ],
  finding: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'framework_version_id', 'audit_event_id', 'code', 'title', 'classification', 'clause_ref',
    'source', 'status', 'status_note', 'owner_user_id', 'raised_at', 'due_at', 'rca_text', 'systemic_check_text',
    'closed_at', 'closed_by_user_id', 'close_note', 'position',
  ],
  corrective_action: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'status', 'correction_text', 'rca_text',
    'systemic_check_text', 'action_text', 'due_at', 'implemented_at', 'implemented_by_user_id', 'verified_by_user_id',
    'verified_at', 'effective', 'verification_note',
  ],
  management_review: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'code', 'title',
    'owner_user_id', 'planned_at', 'held_at', 'status', 'decisions_recorded', 'decisions_text', 'closed_at',
    'closed_by_user_id',
  ],
  management_review_input: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_review_id', 'review_input_def_id', 'management_system_id', 'content', 'source_refs',
  ],
  cycle_requirement_status: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'certification_cycle_id', 'cycle_requirement_def_id', 'requirement_code', 'title',
    'owner_user_id', 'status', 'due_at', 'condition_note', 'position',
  ],
  drift_result: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'drift_rule_def_id', 'rule_code', 'entity_type', 'entity_id', 'entity_code', 'title',
    'holder_user_id', 'due_at', 'detected_at', 'resolved_at', 'position',
  ],
  implementation_activity_progress: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'activity_template_id', 'phase_no', 'activity_no', 'title', 'clause_ref',
    'output_document_code', 'expected_outcome', 'is_gate_phase', 'template_pack_version', 'owner_user_id', 'status',
    'output_document_id', 'blocker_gate_item_ref', 'blocker_reason', 'due_at', 'completed_at', 'completed_by_user_id',
    'verified_at', 'verified_by_user_id',
  ],
  trace_chain_instance: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'anchor_code', 'position',
  ],
  trace_chain_node: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'trace_chain_instance_id', 'position', 'stage_key', 'record_code',
  ],
});
