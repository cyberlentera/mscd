// Kysely row types of the tenant tables of migrations/tenant/0001_core.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated, GeneratedAlways } from 'kysely';
import { tableColumns, type GeneratedJson, type NullableJson } from './index';

/** `management_system` */
export interface ManagementSystemTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  slug: string;
  code: string;
  name: string;
  framework_version_id: string;
  transition_target_version_id: string | null;
  scope_statement: string;
  status: 'setup' | 'implementing' | 'certified' | 'transitioning' | 'archived';
  default_storage_repository_id: string;
  certification_body: string | null;
  color: Generated<string>;
  display: GeneratedJson;
  position: Generated<number>;
}

/** `management_system_version` */
export interface ManagementSystemVersionTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  framework_version_id: string;
  role: 'active' | 'transition_target' | 'previous';
  activated_at: string;
  ended_at: string | null;
}

/** `user_ms_role` */
export interface UserMsRoleTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  user_id: string;
  management_system_id: string;
  role: 'ms_manager' | 'programme_owner' | 'domain_owner' | 'risk_owner' | 'internal_auditor' | 'top_management' | 'external_auditor' | 'compliance_investigator';
  is_primary: Generated<boolean>;
  valid_until: Date | null;
  approval_status: Generated<'active' | 'pending_approval' | 'rejected'>;
  requested_by: string | null;
  approved_by: string | null;
}

/** `entity_ms_link` */
export interface EntityMsLinkTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  entity_type: 'context_issue' | 'interested_party' | 'asset' | 'document' | 'evidence' | 'risk' | 'audit_event' | 'management_review' | 'metric';
  entity_id: string;
  management_system_id: string;
  is_primary: Generated<boolean>;
  relevance_note: string | null;
}

/** `certification_cycle` */
export interface CertificationCycleTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  cycle_start: string;
  cycle_end: string;
  status: 'planned' | 'active' | 'certified' | 'suspended' | 'withdrawn' | 'expired' | 'closed';
  certified_at: string | null;
  certificate_no: string | null;
}

/** `ms_alert` */
export interface MsAlertTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  kind: 'connector' | 'transition' | 'beta' | 'withdrawn_edition' | 'licence' | 'other';
  tone: 'info' | 'warn' | 'bad';
  text_en: string;
  text_id: string;
  source_ref: NullableJson;
  raised_at: Generated<Date>;
  resolved_at: Date | null;
}

/** `clause_readiness` */
export interface ClauseReadinessTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  clause_group: number;
  readiness_pct: number;
  source: Generated<'seeded' | 'manual' | 'computed'>;
}

/** `audit_trail` */
export interface AuditTrailTable {
  /** Set by the chain_hash trigger (C.4); never written by the application. */
  seq: GeneratedAlways<string>;
  id: Generated<string>;
  occurred_at: Generated<Date>;
  organization_id: Generated<string>;
  management_system_id: string | null;
  actor_user_id: string | null;
  actor_kind: 'user' | 'system' | 'guest' | 'operator';
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_code: string | null;
  before_data: NullableJson;
  after_data: NullableJson;
  edition: string | null;
  request_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  prev_hash: GeneratedAlways<Buffer>;
  row_hash: GeneratedAlways<Buffer>;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantCoreTables {
  management_system: ManagementSystemTable;
  management_system_version: ManagementSystemVersionTable;
  user_ms_role: UserMsRoleTable;
  entity_ms_link: EntityMsLinkTable;
  certification_cycle: CertificationCycleTable;
  ms_alert: MsAlertTable;
  clause_readiness: ClauseReadinessTable;
  audit_trail: AuditTrailTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantCoreTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantCoreTables>()({
  management_system: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'slug', 'code',
    'name', 'framework_version_id', 'transition_target_version_id', 'scope_statement', 'status',
    'default_storage_repository_id', 'certification_body', 'color', 'display', 'position',
  ],
  management_system_version: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'framework_version_id', 'role', 'activated_at', 'ended_at',
  ],
  user_ms_role: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'user_id',
    'management_system_id', 'role', 'is_primary', 'valid_until', 'approval_status', 'requested_by', 'approved_by',
  ],
  entity_ms_link: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'entity_type',
    'entity_id', 'management_system_id', 'is_primary', 'relevance_note',
  ],
  certification_cycle: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'cycle_start', 'cycle_end', 'status', 'certified_at', 'certificate_no',
  ],
  ms_alert: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'kind', 'tone', 'text_en', 'text_id', 'source_ref', 'raised_at', 'resolved_at',
  ],
  clause_readiness: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'clause_group', 'readiness_pct', 'source',
  ],
  audit_trail: [
    'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action',
    'entity_type', 'entity_id', 'entity_code', 'before_data', 'after_data', 'edition', 'request_id', 'source_ip',
    'user_agent', 'prev_hash', 'row_hash',
  ],
});
