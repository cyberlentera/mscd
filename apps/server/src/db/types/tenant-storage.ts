// Kysely row types of the tenant tables of migrations/tenant/0002_storage.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns, type GeneratedJson, type NullableJson } from './index';

/** `storage_repository` */
export interface StorageRepositoryTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  slug: string;
  name: string;
  adapter: 'managed_vault' | 'm365' | 'google_drive' | 'smb' | 's3' | 'webdav';
  modes: ('stored' | 'pass_through' | 'link' | 'zero_transit')[];
  config: GeneratedJson;
  credential_ref: string | null;
  ownership_type: Generated<'organizational' | 'personal'>;
  retention_confirmed: Generated<boolean>;
  connection_status: Generated<'ok' | 'degraded' | 'failed' | 'revoked'>;
  connection_message_en: string | null;
  connection_message_id: string | null;
  connection_status_since: Generated<Date>;
  last_checked_at: Date | null;
  metadata_minimization: Generated<boolean>;
  read_only: Generated<boolean>;
  display: GeneratedJson;
  position: Generated<number>;
}

/** `storage_credential` */
export interface StorageCredentialTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  storage_repository_id: string;
  credential_ref: string;
  kind: 'm365_certificate' | 'google_service_account' | 'oauth_refresh_token' | 's3_access_key' | 'smb_account' | 'webdav_account';
  sealed_blob: string;
  key_id: string;
  config_sha256: string;
  external_account: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

/** `storage_routing_rule` */
export interface StorageRoutingRuleTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string | null;
  classification: 'public' | 'internal' | 'confidential' | 'restricted' | null;
  object_kind: 'document' | 'evidence' | null;
  storage_repository_id: string;
  mode: 'stored' | 'pass_through' | 'link' | 'zero_transit';
  priority: Generated<number>;
  note: string | null;
  approval_status: Generated<'active' | 'pending_approval' | 'rejected' | 'superseded'>;
  requested_by: string | null;
  approved_by: string | null;
}

/** `storage_object` */
export interface StorageObjectTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  storage_repository_id: string;
  external_item_id: string;
  external_version_id: string | null;
  version_label: string | null;
  display_name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  hash_algorithm: Generated<'sha256' | 'sha1' | 'md5' | 'quickxor' | 'none'>;
  hash_value: string | null;
  hash_source: 'computed' | 'provider' | 'none';
  provider_created_at: Date | null;
  provider_modified_at: Date | null;
  provider_modified_by: string | null;
  folder_path: string | null;
  folder_id: string | null;
  link_status: Generated<'intact' | 'moved' | 'version_changed' | 'verification_pending' | 'hash_mismatch' | 'pinned_version_lost' | 'missing' | 'access_denied'>;
  link_status_since: Generated<Date>;
  link_status_reason: 'unreachable' | 'credential_invalid' | null;
  last_verified_at: Date | null;
  last_good_check_at: Date | null;
  next_check_at: Date | null;
  web_url: string | null;
  encryption: NullableJson;
}

/** `link_health_result` */
export interface LinkHealthResultTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  storage_object_id: string;
  checked_at: Generated<Date>;
  outcome: 'found' | 'not_found' | 'forbidden' | 'unreachable' | 'rate_limited' | 'error';
  status_before: string;
  status_after: string;
  observed_version_id: string | null;
  observed_hash: string | null;
  observed_folder_path: string | null;
  detail: NullableJson;
  job_id: string | null;
}

/** `upload_intent` */
export interface UploadIntentTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  object_kind: 'evidence' | 'document';
  target_id: string;
  storage_repository_id: string;
  mode: 'stored' | 'pass_through' | 'zero_transit';
  folder_path: string;
  stored_name: string;
  original_name: string | null;
  max_bytes: string;
  correlation_code: string;
  status: Generated<'open' | 'uploaded' | 'completed' | 'expired' | 'failed'>;
  storage_object_id: string | null;
  expires_at: Date;
}

/** `repository_move_request` */
export interface RepositoryMoveRequestTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  storage_repository_id: string;
  target_repository_id: string | null;
  status: Generated<'open' | 'done' | 'rejected'>;
  note: string | null;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantStorageTables {
  storage_repository: StorageRepositoryTable;
  storage_credential: StorageCredentialTable;
  storage_routing_rule: StorageRoutingRuleTable;
  storage_object: StorageObjectTable;
  link_health_result: LinkHealthResultTable;
  upload_intent: UploadIntentTable;
  repository_move_request: RepositoryMoveRequestTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantStorageTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantStorageTables>()({
  storage_repository: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'slug', 'name',
    'adapter', 'modes', 'config', 'credential_ref', 'ownership_type', 'retention_confirmed', 'connection_status',
    'connection_message_en', 'connection_message_id', 'connection_status_since', 'last_checked_at',
    'metadata_minimization', 'read_only', 'display', 'position',
  ],
  storage_credential: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'storage_repository_id', 'credential_ref', 'kind', 'sealed_blob', 'key_id', 'config_sha256', 'external_account',
    'expires_at', 'revoked_at',
  ],
  storage_routing_rule: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'classification', 'object_kind', 'storage_repository_id', 'mode', 'priority', 'note',
    'approval_status', 'requested_by', 'approved_by',
  ],
  storage_object: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'storage_repository_id', 'external_item_id', 'external_version_id', 'version_label', 'display_name', 'mime_type',
    'size_bytes', 'hash_algorithm', 'hash_value', 'hash_source', 'provider_created_at', 'provider_modified_at',
    'provider_modified_by', 'folder_path', 'folder_id', 'link_status', 'link_status_since', 'link_status_reason',
    'last_verified_at', 'last_good_check_at', 'next_check_at', 'web_url', 'encryption',
  ],
  link_health_result: [
    'id', 'organization_id', 'storage_object_id', 'checked_at', 'outcome', 'status_before', 'status_after',
    'observed_version_id', 'observed_hash', 'observed_folder_path', 'detail', 'job_id',
  ],
  upload_intent: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'object_kind', 'target_id', 'storage_repository_id', 'mode', 'folder_path', 'stored_name',
    'original_name', 'max_bytes', 'correlation_code', 'status', 'storage_object_id', 'expires_at',
  ],
  repository_move_request: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'storage_repository_id', 'target_repository_id', 'status', 'note',
  ],
});
