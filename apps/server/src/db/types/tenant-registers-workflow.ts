// Kysely row types of the tenant tables of migrations/tenant/0007_registers_workflow.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns } from './index';

/** `corrective_action_finding` */
export interface CorrectiveActionFindingTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  corrective_action_id: string;
  finding_id: string;
}

/** `self_assessment` */
export interface SelfAssessmentTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  finding_condition_id: string;
  status: Generated<'not_assessed' | 'conforming' | 'gap' | 'not_applicable'>;
  owner_user_id: string | null;
  target_fix_at: string | null;
  note: string | null;
  assessed_at: string | null;
  finding_id: string | null;
}

/** `self_assessment_evidence` */
export interface SelfAssessmentEvidenceTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  self_assessment_id: string;
  evidence_id: string;
}

/** `audit_activity` */
export interface AuditActivityTable {
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
  clause_ref: string | null;
  key_questions: string | null;
  evidence_to_request: string | null;
  auditee_user_id: string | null;
  scheduled_at: string | null;
  status: Generated<'planned' | 'done' | 'cancelled'>;
  note: string | null;
  position: Generated<number>;
}

/** `task` */
export interface TaskTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string | null;
  source_rule: 'BR-10' | 'BR-11' | 'BR-15' | 'BR-31' | 'manual';
  entity_type: string;
  entity_id: string;
  entity_code: string | null;
  title_en: string;
  title_id: string;
  owner_user_id: string | null;
  due_at: string | null;
  status: Generated<'open' | 'done' | 'cancelled'>;
  closed_by: string | null;
  closed_at: Date | null;
}

/** `calendar_feed_token` */
export interface CalendarFeedTokenTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  user_id: string;
  management_system_id: string;
  token_hash: Buffer;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantRegisterWorkflowTables {
  corrective_action_finding: CorrectiveActionFindingTable;
  self_assessment: SelfAssessmentTable;
  self_assessment_evidence: SelfAssessmentEvidenceTable;
  audit_activity: AuditActivityTable;
  task: TaskTable;
  calendar_feed_token: CalendarFeedTokenTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantRegisterWorkflowTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantRegisterWorkflowTables>()({
  corrective_action_finding: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'corrective_action_id', 'finding_id',
  ],
  self_assessment: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'finding_condition_id', 'status', 'owner_user_id', 'target_fix_at', 'note', 'assessed_at',
    'finding_id',
  ],
  self_assessment_evidence: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'self_assessment_id',
    'evidence_id',
  ],
  audit_activity: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'audit_event_id',
    'management_system_id', 'template_code', 'title', 'clause_ref', 'key_questions', 'evidence_to_request',
    'auditee_user_id', 'scheduled_at', 'status', 'note', 'position',
  ],
  task: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'source_rule', 'entity_type', 'entity_id', 'entity_code', 'title_en', 'title_id',
    'owner_user_id', 'due_at', 'status', 'closed_by', 'closed_at',
  ],
  calendar_feed_token: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'user_id',
    'management_system_id', 'token_hash', 'revoked_at', 'last_used_at',
  ],
});
