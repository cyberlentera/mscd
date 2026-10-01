// Kysely row types of the tenant tables of migrations/tenant/0006_workflow.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns, type GeneratedJson, type NullableJson } from './index';

/** `reminder` */
export interface ReminderTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  created_by: string | null;
  management_system_id: string | null;
  record_key: string;
  entity_type: string;
  entity_id: string;
  recipient_user_id: string;
  sent_by_user_id: string;
  sent_at: Generated<Date>;
  channels: Generated<string[]>;
  bulk_id: string | null;
  notification_id: string | null;
}

/** `notification` */
export interface NotificationTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  recipient_user_id: string;
  management_system_id: string | null;
  kind: string;
  title_en: string;
  title_id: string;
  body_en: string;
  body_id: string;
  entity_ref: NullableJson;
  read_at: Date | null;
  email_status: Generated<'pending' | 'sent' | 'failed' | 'skipped'>;
  email_sent_at: Date | null;
  email_attempts: Generated<number>;
  last_error: string | null;
  digest: Generated<boolean>;
}

/** `background_task` */
export interface BackgroundTaskTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  kind: 'evidence_pack' | 'export' | 'link_health_run' | 'pack_install' | 'import';
  management_system_id: string | null;
  status: Generated<'queued' | 'running' | 'succeeded' | 'failed'>;
  progress: Generated<number>;
  params: GeneratedJson;
  result: NullableJson;
  error: string | null;
  job_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

/** `evidence_pack` */
export interface EvidencePackTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  audit_event_id: string | null;
  background_task_id: string | null;
  scope: GeneratedJson;
  status: Generated<'queued' | 'building' | 'ready' | 'failed'>;
  pack_folder: string | null;
  manifest_pdf_object_id: string | null;
  manifest_csv_object_id: string | null;
  archive_object_id: string | null;
  item_count: Generated<number>;
  exception_count: Generated<number>;
  built_at: Date | null;
}

/** `evidence_pack_item` */
export interface EvidencePackItemTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  evidence_pack_id: string;
  evidence_id: string;
  evidence_code: string;
  requirement_codes: string[];
  produced_at: string | null;
  external_version_id: string | null;
  hash_algorithm: string | null;
  hash_value: string | null;
  link_status: string | null;
  copy_location: string | null;
  copy_storage_object_id: string | null;
  is_deleted_record: Generated<boolean>;
  is_exception: Generated<boolean>;
  exception_reason: string | null;
}

/** `export_file` */
export interface ExportFileTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  kind: 'portfolio_board' | 'readiness' | 'soa' | 'document_register' | 'audit_trail';
  format: 'pdf' | 'xlsx' | 'csv';
  management_system_id: string | null;
  background_task_id: string | null;
  storage_object_id: string | null;
  file_name: string | null;
  expires_at: Date;
}

/** `auditor_access_grant` */
export interface AuditorAccessGrantTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  email: string;
  user_id: string | null;
  user_ms_role_id: string | null;
  token_hash: Buffer;
  link_used_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantWorkflowTables {
  reminder: ReminderTable;
  notification: NotificationTable;
  background_task: BackgroundTaskTable;
  evidence_pack: EvidencePackTable;
  evidence_pack_item: EvidencePackItemTable;
  export_file: ExportFileTable;
  auditor_access_grant: AuditorAccessGrantTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantWorkflowTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantWorkflowTables>()({
  reminder: [
    'id', 'organization_id', 'created_at', 'created_by', 'management_system_id', 'record_key', 'entity_type',
    'entity_id', 'recipient_user_id', 'sent_by_user_id', 'sent_at', 'channels', 'bulk_id', 'notification_id',
  ],
  notification: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'recipient_user_id',
    'management_system_id', 'kind', 'title_en', 'title_id', 'body_en', 'body_id', 'entity_ref', 'read_at',
    'email_status', 'email_sent_at', 'email_attempts', 'last_error', 'digest',
  ],
  background_task: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'kind',
    'management_system_id', 'status', 'progress', 'params', 'result', 'error', 'job_id', 'started_at', 'finished_at',
  ],
  evidence_pack: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'audit_event_id', 'background_task_id', 'scope', 'status', 'pack_folder',
    'manifest_pdf_object_id', 'manifest_csv_object_id', 'archive_object_id', 'item_count', 'exception_count',
    'built_at',
  ],
  evidence_pack_item: [
    'id', 'organization_id', 'created_at', 'evidence_pack_id', 'evidence_id', 'evidence_code', 'requirement_codes',
    'produced_at', 'external_version_id', 'hash_algorithm', 'hash_value', 'link_status', 'copy_location',
    'copy_storage_object_id', 'is_deleted_record', 'is_exception', 'exception_reason',
  ],
  export_file: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'kind', 'format',
    'management_system_id', 'background_task_id', 'storage_object_id', 'file_name', 'expires_at',
  ],
  auditor_access_grant: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'email', 'user_id', 'user_ms_role_id', 'token_hash', 'link_used_at', 'expires_at',
    'revoked_at', 'revoked_by', 'last_used_at',
  ],
});
