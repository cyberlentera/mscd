// Kysely row types of the tenant tables of migrations/tenant/0003_registers.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns, type GeneratedJson, type JsonDocument, type NullableJson } from './index';

/** `context_issue` */
export interface ContextIssueTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  issue_type: 'internal' | 'external' | null;
  description: string | null;
  last_reviewed_at: string | null;
}

/** `interested_party` */
export interface InterestedPartyTable {
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
  requirements: string | null;
  last_reviewed_at: string | null;
  position: Generated<number>;
}

/** `asset` */
export interface AssetTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  code: string;
  title: string;
  asset_type: string | null;
  owner_user_id: string | null;
  classification: 'public' | 'internal' | 'confidential' | 'restricted' | null;
  position: Generated<number>;
}

/** `risk` */
export interface RiskTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  risk_profile_code: string;
  is_opportunity: Generated<boolean>;
  description: string | null;
  likelihood: number | null;
  consequence: number | null;
  impact_dimensions: GeneratedJson;
  residual_likelihood: number | null;
  residual_consequence: number | null;
  treatment_option: string | null;
  assessed_at: string | null;
  next_review_at: string | null;
  residual_accepted_at: string | null;
}

/** `risk_treatment` */
export interface RiskTreatmentTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  risk_id: string | null;
  target_type: 'catalogue_item' | 'requirement' | null;
  catalogue_item_id: string | null;
  requirement_id: string | null;
  status: Generated<'proposed' | 'approved' | 'in_progress' | 'delayed' | 'implemented' | 'residual_accepted' | 'closed'>;
  target_date: string | null;
  implemented_at: string | null;
  implemented_by_user_id: string | null;
  closed_at: string | null;
}

/** `residual_acceptance` */
export interface ResidualAcceptanceTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  risk_id: string;
  risk_treatment_id: string | null;
  accepted_by_user_id: string;
  implemented_by_user_id: string | null;
  accepted_at: string;
  residual_score: number | null;
  note: string | null;
}

/** `metric` */
export interface MetricTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  unit: string | null;
  target_value: string | null;
  frequency_code: string | null;
  last_measured_at: string | null;
}

/** `metric_value` */
export interface MetricValueTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  metric_id: string;
  period_start: string;
  period_end: string;
  value: string;
  note: string | null;
}

/** `quality_objective` */
export interface QualityObjectiveTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  statement: string | null;
  metric_id: string | null;
  target_text: string | null;
  due_at: string | null;
}

/** `process` */
export interface ProcessTable {
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
  inputs: string | null;
  outputs: string | null;
  position: Generated<number>;
}

/** `prioritized_activity` */
export interface PrioritizedActivityTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  product_service: string | null;
  mtpd_hours: number | null;
  rto_hours: number | null;
  rpo_hours: number | null;
  mbco_note: string | null;
}

/** `business_impact_analysis` */
export interface BusinessImpactAnalysisTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  prioritized_activity_id: string | null;
  impact_over_time: NullableJson<JsonDocument>;
  dependencies: NullableJson<JsonDocument>;
  resources_required: NullableJson<JsonDocument>;
  mtpd_hours: number | null;
  rto_hours: number | null;
  rpo_hours: number | null;
  status: Generated<'draft' | 'approved'>;
  analysed_at: string | null;
  next_review_at: string | null;
}

/** `bc_plan` */
export interface BcPlanTable {
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
  document_id: string | null;
  owner_user_id: string | null;
  status: Generated<'draft' | 'approved' | 'tested' | 'untested'>;
  position: Generated<number>;
}

/** `exercise` */
export interface ExerciseTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  bc_plan_id: string | null;
  exercise_type: string | null;
  planned_at: string | null;
  performed_at: string | null;
  objectives_met: boolean | null;
  lessons: string | null;
}

/** `business_associate` */
export interface BusinessAssociateTable {
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
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  category: string | null;
  jurisdiction: string | null;
  bribery_risk_level: string | null;
  relationship_owner_user_id: string | null;
}

/** `due_diligence` */
export interface DueDiligenceTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  subject_type: string;
  subject_id: string | null;
  performed_at: string | null;
  valid_until: string | null;
  outcome: string | null;
  conditions: string | null;
  status: Generated<'draft' | 'completed' | 'expired' | 'superseded'>;
}

/** `chain_record` */
export interface ChainRecordTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  stage_key: string;
  code: string;
  title: string;
  owner_user_id: string | null;
  pending_action: string | null;
  action_due_at: string | null;
  action_completed_at: Date | null;
  action_completed_by: string | null;
  is_gate_item: Generated<boolean>;
  position: Generated<number>;
  related_entity_type: string | null;
  related_entity_id: string | null;
}

/** `record_reference` */
export interface RecordReferenceTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  entity_type: string;
  entity_id: string;
  direction: 'up' | 'down';
  target_code: string;
  position: Generated<number>;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantRegisterTables {
  context_issue: ContextIssueTable;
  interested_party: InterestedPartyTable;
  asset: AssetTable;
  risk: RiskTable;
  risk_treatment: RiskTreatmentTable;
  residual_acceptance: ResidualAcceptanceTable;
  metric: MetricTable;
  metric_value: MetricValueTable;
  quality_objective: QualityObjectiveTable;
  process: ProcessTable;
  prioritized_activity: PrioritizedActivityTable;
  business_impact_analysis: BusinessImpactAnalysisTable;
  bc_plan: BcPlanTable;
  exercise: ExerciseTable;
  business_associate: BusinessAssociateTable;
  due_diligence: DueDiligenceTable;
  chain_record: ChainRecordTable;
  record_reference: RecordReferenceTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantRegisterTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantRegisterTables>()({
  context_issue: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'code', 'title',
    'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at', 'action_completed_by', 'is_gate_item',
    'position', 'issue_type', 'description', 'last_reviewed_at',
  ],
  interested_party: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'code', 'title',
    'owner_user_id', 'requirements', 'last_reviewed_at', 'position',
  ],
  asset: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'code', 'title',
    'asset_type', 'owner_user_id', 'classification', 'position',
  ],
  risk: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'code', 'title',
    'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at', 'action_completed_by', 'is_gate_item',
    'position', 'risk_profile_code', 'is_opportunity', 'description', 'likelihood', 'consequence', 'impact_dimensions',
    'residual_likelihood', 'residual_consequence', 'treatment_option', 'assessed_at', 'next_review_at',
    'residual_accepted_at',
  ],
  risk_treatment: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at',
    'action_completed_by', 'is_gate_item', 'position', 'risk_id', 'target_type', 'catalogue_item_id', 'requirement_id',
    'status', 'target_date', 'implemented_at', 'implemented_by_user_id', 'closed_at',
  ],
  residual_acceptance: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'risk_id',
    'risk_treatment_id', 'accepted_by_user_id', 'implemented_by_user_id', 'accepted_at', 'residual_score', 'note',
  ],
  metric: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'code', 'title',
    'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at', 'action_completed_by', 'is_gate_item',
    'position', 'unit', 'target_value', 'frequency_code', 'last_measured_at',
  ],
  metric_value: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'metric_id',
    'period_start', 'period_end', 'value', 'note',
  ],
  quality_objective: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at',
    'action_completed_by', 'is_gate_item', 'position', 'statement', 'metric_id', 'target_text', 'due_at',
  ],
  process: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'inputs', 'outputs', 'position',
  ],
  prioritized_activity: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at',
    'action_completed_by', 'is_gate_item', 'position', 'product_service', 'mtpd_hours', 'rto_hours', 'rpo_hours',
    'mbco_note',
  ],
  business_impact_analysis: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at',
    'action_completed_by', 'is_gate_item', 'position', 'prioritized_activity_id', 'impact_over_time', 'dependencies',
    'resources_required', 'mtpd_hours', 'rto_hours', 'rpo_hours', 'status', 'analysed_at', 'next_review_at',
  ],
  bc_plan: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'document_id', 'owner_user_id', 'status', 'position',
  ],
  exercise: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at',
    'action_completed_by', 'is_gate_item', 'position', 'bc_plan_id', 'exercise_type', 'planned_at', 'performed_at',
    'objectives_met', 'lessons',
  ],
  business_associate: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at', 'action_completed_at',
    'action_completed_by', 'is_gate_item', 'position', 'category', 'jurisdiction', 'bribery_risk_level',
    'relationship_owner_user_id',
  ],
  due_diligence: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'subject_type', 'subject_id', 'performed_at', 'valid_until', 'outcome', 'conditions',
    'status',
  ],
  chain_record: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'stage_key', 'code', 'title', 'owner_user_id', 'pending_action', 'action_due_at',
    'action_completed_at', 'action_completed_by', 'is_gate_item', 'position', 'related_entity_type',
    'related_entity_id',
  ],
  record_reference: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'entity_type', 'entity_id', 'direction', 'target_code', 'position',
  ],
});
