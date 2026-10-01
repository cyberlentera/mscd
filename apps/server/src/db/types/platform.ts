// Kysely row types of the platform tables (migrations/platform/0001 to 0004, build plan C.4).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated, GeneratedAlways } from 'kysely';
import { tableColumns, type Json, type JsonColumn, type NullableJson } from './index';

/** `platform.organization` */
export interface OrganizationTable {
  id: Generated<string>;
  slug: string;
  name: string;
  schema_name: string;
  time_zone: Generated<string>;
  site_count: Generated<number>;
  status: Generated<'active' | 'suspended' | 'offboarding' | 'archived'>;
  local_login: Generated<'allowed' | 'admins_only' | 'disabled'>;
  region: string | null;
  demo_deploy_label: 'saas' | 'onprem' | null;
  position: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

/** `platform.verified_domain` */
export interface VerifiedDomainTable {
  organization_id: string;
  domain: string;
  verified_at: Generated<Date>;
  verified_by: string;
}

/** `platform.app_user` */
export interface AppUserTable {
  id: Generated<string>;
  handle: string;
  email: string;
  display_name: string;
  job_title: string | null;
  kind: Generated<'person' | 'system' | 'guest'>;
  status: Generated<'active' | 'invited' | 'disabled'>;
  password_hash: string | null;
  password_changed_at: Date | null;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  mfa_required: Generated<boolean>;
  mfa_failed_count: Generated<number>;
  mfa_lock_level: Generated<number>;
  mfa_locked_until: Date | null;
  is_demo: Generated<boolean>;
  last_login_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
}

/** `platform.org_membership` */
export interface OrgMembershipTable {
  organization_id: string;
  user_id: string;
  admin_roles: Generated<('tenant_admin' | 'storage_admin')[]>;
  status: Generated<'active' | 'invited' | 'disabled'>;
  is_default: Generated<boolean>;
  invited_by: string | null;
  accepted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

/** `platform.platform_role` */
export interface PlatformRoleTable {
  user_id: string;
  role: 'platform_operator';
  granted_at: Generated<Date>;
  granted_by: string | null;
  revoked_at: Date | null;
}

/** `platform.identity_provider` */
export interface IdentityProviderTable {
  id: Generated<string>;
  organization_id: string;
  slug: string;
  kind: 'oidc' | 'saml';
  display_name: string;
  icon: Generated<'microsoft' | 'google' | 'generic'>;
  enabled: Generated<boolean>;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_sealed: string | null;
  oidc_scopes: Generated<string>;
  subject_mode: Generated<'sub' | 'entra'>;
  entra_tenant_id: string | null;
  saml_entry_point: string | null;
  saml_idp_issuer: string | null;
  saml_idp_certs: string[] | null;
  saml_sp_entity_id: string | null;
  saml_mfa_authn_contexts: Generated<string[]>;
  require_mfa_claim: Generated<boolean>;
  accepted_amr: Generated<string[]>;
  mfa_fallback: Generated<'local_totp' | 'reject'>;
  jit_provisioning: Generated<boolean>;
  allowed_email_domains: Generated<string[]>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
}

/** `platform.user_identity` */
export interface UserIdentityTable {
  identity_provider_id: string;
  subject: string;
  user_id: string;
  email_at_link: string | null;
  link_method: 'invitation' | 'session' | 'admin' | 'jit';
  linked_by: string | null;
  linked_at: Generated<Date>;
  last_login_at: Date | null;
}

/** `platform.session` */
export interface SessionTable {
  id_hash: Buffer;
  user_id: string;
  organization_id: string | null;
  auth_org_id: string | null;
  state: 'mfa_pending' | 'mfa_enrolment' | 'active';
  auth_method: 'local' | 'oidc' | 'saml' | 'demo' | 'guest' | 'test';
  identity_provider_id: string | null;
  auth_grant_id: string | null;
  amr: Generated<string[]>;
  password_at: Date | null;
  mfa_at: Date | null;
  csrf_token_hash: Buffer;
  persistent: Generated<boolean>;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

/** `platform.mfa_factor` */
export interface MfaFactorTable {
  id: Generated<string>;
  user_id: string;
  kind: Generated<'totp'>;
  secret_sealed: string;
  label: string | null;
  confirmed_at: Date | null;
  last_used_step: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

/** `platform.mfa_recovery_code` */
export interface MfaRecoveryCodeTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Date | null;
  created_at: Generated<Date>;
  deleted_at: Date | null;
}

/** `platform.auth_transaction` */
export interface AuthTransactionTable {
  id: Generated<string>;
  kind: 'oidc_login' | 'oidc_link' | 'saml_login' | 'saml_link' | 'repo_oauth' | 'guest_otp';
  identity_provider_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  target_id: string | null;
  state_hash: Buffer;
  browser_binding_hash: Buffer;
  nonce: string | null;
  code_verifier_sealed: string | null;
  saml_request_id: string | null;
  otp_hash: string | null;
  attempts: Generated<number>;
  return_to: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
}

/** `platform.saml_assertion_seen` */
export interface SamlAssertionSeenTable {
  identity_provider_id: string;
  assertion_id_hash: Buffer;
  expires_at: Date;
}

/** `platform.password_reset_token` */
export interface PasswordResetTokenTable {
  token_hash: Buffer;
  kind: Generated<'reset' | 'set_password'>;
  user_id: string;
  created_at: Generated<Date>;
  expires_at: Date;
  used_at: Date | null;
}

/** `platform.invitation` */
export interface InvitationTable {
  id: Generated<string>;
  token_hash: Buffer;
  organization_id: string;
  user_id: string;
  email: string;
  created_by: string;
  created_at: Generated<Date>;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

/** `platform.user_preference` */
export interface UserPreferenceTable {
  user_id: string;
  key: string;
  value: JsonColumn;
  updated_at: Generated<Date>;
}

/** `platform.installation` */
export interface InstallationTable {
  id: Generated<string>;
  singleton: Generated<boolean>;
  created_at: Generated<Date>;
}

/** `platform.clock_mark` */
export interface ClockMarkTable {
  singleton: Generated<boolean>;
  high_water: Date;
}

/** `platform.licence` */
export interface LicenceTable {
  id: Generated<string>;
  organization_id: string;
  license_id: string;
  document: Json;
  document_sha256: string;
  key_id: string;
  installed_at: Generated<Date>;
  installed_by: string | null;
  superseded_at: Date | null;
}

/** `platform.pack_install` */
export interface PackInstallTable {
  id: Generated<string>;
  pack_id: string;
  pack_version: string;
  framework_code: string;
  edition: string;
  framework_version_id: string | null;
  status: 'validating' | 'installed' | 'failed' | 'superseded';
  pre_release: Generated<boolean>;
  manifest: Json;
  archive_sha256: string;
  signature_key_id: string;
  error: string | null;
  installed_at: Date | null;
  installed_by: string | null;
  created_at: Generated<Date>;
}

/** `platform.pack_catalog` */
export interface PackCatalogTable {
  pack_id: string;
  pack_version: string;
  channel: 'managed' | 'online' | 'offline';
  note_en: string;
  note_id: string;
  published_at: string | null;
  retrieved_at: Generated<Date>;
}

/** `platform.tenant_key` */
export interface TenantKeyTable {
  organization_id: string;
  wrapped_dek: string;
  kek_id: string;
  created_at: Generated<Date>;
  rotated_at: Date | null;
}

/** `platform.audit_log` */
export interface AuditLogTable {
  /** Set by the chain_hash trigger (C.4); never written by the application. */
  seq: GeneratedAlways<string>;
  id: Generated<string>;
  occurred_at: Generated<Date>;
  organization_id: string | null;
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

/** `platform.audit_anchor` */
export interface AuditAnchorTable {
  id: Generated<string>;
  chain: string;
  seq: string;
  row_hash: Buffer;
  anchored_at: Generated<Date>;
  payload: Json;
  signature: string;
  key_id: string;
  exported_to: Generated<string[]>;
}

/** `platform.rate_limit_bucket` */
export interface RateLimitBucketTable {
  key: string;
  window_start: Date;
  hits: number;
  expires_at: Date;
}

/** `platform.idempotency_key` */
export interface IdempotencyKeyTable {
  organization_id: string;
  user_id: string;
  key: string;
  route: string;
  request_hash: string;
  status: number | null;
  response: NullableJson;
  created_at: Generated<Date>;
  expires_at: Date;
}

/** `platform.job_outbox` */
export interface JobOutboxTable {
  id: Generated<string>;
  queue: string;
  payload: Json;
  singleton_key: string | null;
  run_at: Generated<Date>;
  created_at: Generated<Date>;
  dispatched_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
}

/** `platform.system_setting` */
export interface SystemSettingTable {
  key: string;
  value: JsonColumn;
  updated_at: Generated<Date>;
}

/** Tables of this group as Kysely table keys. */
export interface PlatformTables {
  'platform.organization': OrganizationTable;
  'platform.verified_domain': VerifiedDomainTable;
  'platform.app_user': AppUserTable;
  'platform.org_membership': OrgMembershipTable;
  'platform.platform_role': PlatformRoleTable;
  'platform.identity_provider': IdentityProviderTable;
  'platform.user_identity': UserIdentityTable;
  'platform.session': SessionTable;
  'platform.mfa_factor': MfaFactorTable;
  'platform.mfa_recovery_code': MfaRecoveryCodeTable;
  'platform.auth_transaction': AuthTransactionTable;
  'platform.saml_assertion_seen': SamlAssertionSeenTable;
  'platform.password_reset_token': PasswordResetTokenTable;
  'platform.invitation': InvitationTable;
  'platform.user_preference': UserPreferenceTable;
  'platform.installation': InstallationTable;
  'platform.clock_mark': ClockMarkTable;
  'platform.licence': LicenceTable;
  'platform.pack_install': PackInstallTable;
  'platform.pack_catalog': PackCatalogTable;
  'platform.tenant_key': TenantKeyTable;
  'platform.audit_log': AuditLogTable;
  'platform.audit_anchor': AuditAnchorTable;
  'platform.rate_limit_bucket': RateLimitBucketTable;
  'platform.idempotency_key': IdempotencyKeyTable;
  'platform.job_outbox': JobOutboxTable;
  'platform.system_setting': SystemSettingTable;
}

/**
 * `kysely_migration` of the Kysely Migrator (C.3), one per migration table schema (`platform`, `ref`, every
 * tenant schema). Kysely creates it, not a migration file, so it is not part of TABLE_COLUMNS. The readiness check
 * compares the platform one with MIGRATIONS_EXPECTED of the build.
 */
export interface KyselyMigrationTable {
  name: string;
  /** ISO timestamp text written by Kysely. */
  timestamp: string;
}

declare module './index' {
  interface DB extends PlatformTables {
    'platform.kysely_migration': KyselyMigrationTable;
  }
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<PlatformTables>()({
  'platform.organization': [
    'id', 'slug', 'name', 'schema_name', 'time_zone', 'site_count', 'status', 'local_login', 'region',
    'demo_deploy_label', 'position', 'created_at', 'updated_at', 'deleted_at',
  ],
  'platform.verified_domain': ['organization_id', 'domain', 'verified_at', 'verified_by'],
  'platform.app_user': [
    'id', 'handle', 'email', 'display_name', 'job_title', 'kind', 'status', 'password_hash', 'password_changed_at',
    'failed_login_count', 'locked_until', 'mfa_required', 'mfa_failed_count', 'mfa_lock_level', 'mfa_locked_until',
    'is_demo', 'last_login_at', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
  ],
  'platform.org_membership': [
    'organization_id', 'user_id', 'admin_roles', 'status', 'is_default', 'invited_by', 'accepted_at', 'created_at',
    'updated_at', 'deleted_at',
  ],
  'platform.platform_role': ['user_id', 'role', 'granted_at', 'granted_by', 'revoked_at'],
  'platform.identity_provider': [
    'id', 'organization_id', 'slug', 'kind', 'display_name', 'icon', 'enabled', 'oidc_issuer', 'oidc_client_id',
    'oidc_client_secret_sealed', 'oidc_scopes', 'subject_mode', 'entra_tenant_id', 'saml_entry_point',
    'saml_idp_issuer', 'saml_idp_certs', 'saml_sp_entity_id', 'saml_mfa_authn_contexts', 'require_mfa_claim',
    'accepted_amr', 'mfa_fallback', 'jit_provisioning', 'allowed_email_domains', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'deleted_at',
  ],
  'platform.user_identity': [
    'identity_provider_id', 'subject', 'user_id', 'email_at_link', 'link_method', 'linked_by', 'linked_at',
    'last_login_at',
  ],
  'platform.session': [
    'id_hash', 'user_id', 'organization_id', 'auth_org_id', 'state', 'auth_method', 'identity_provider_id',
    'auth_grant_id', 'amr', 'password_at', 'mfa_at', 'csrf_token_hash', 'persistent', 'created_at', 'last_seen_at',
    'idle_expires_at', 'absolute_expires_at', 'revoked_at', 'revoke_reason', 'ip', 'user_agent',
  ],
  'platform.mfa_factor': [
    'id', 'user_id', 'kind', 'secret_sealed', 'label', 'confirmed_at', 'last_used_step', 'created_at', 'updated_at',
    'deleted_at',
  ],
  'platform.mfa_recovery_code': ['id', 'user_id', 'code_hash', 'used_at', 'created_at', 'deleted_at'],
  'platform.auth_transaction': [
    'id', 'kind', 'identity_provider_id', 'organization_id', 'user_id', 'target_id', 'state_hash',
    'browser_binding_hash', 'nonce', 'code_verifier_sealed', 'saml_request_id', 'otp_hash', 'attempts', 'return_to',
    'created_at', 'expires_at',
  ],
  'platform.saml_assertion_seen': ['identity_provider_id', 'assertion_id_hash', 'expires_at'],
  'platform.password_reset_token': ['token_hash', 'kind', 'user_id', 'created_at', 'expires_at', 'used_at'],
  'platform.invitation': [
    'id', 'token_hash', 'organization_id', 'user_id', 'email', 'created_by', 'created_at', 'expires_at', 'used_at',
    'revoked_at',
  ],
  'platform.user_preference': ['user_id', 'key', 'value', 'updated_at'],
  'platform.installation': ['id', 'singleton', 'created_at'],
  'platform.clock_mark': ['singleton', 'high_water'],
  'platform.licence': [
    'id', 'organization_id', 'license_id', 'document', 'document_sha256', 'key_id', 'installed_at', 'installed_by',
    'superseded_at',
  ],
  'platform.pack_install': [
    'id', 'pack_id', 'pack_version', 'framework_code', 'edition', 'framework_version_id', 'status', 'pre_release',
    'manifest', 'archive_sha256', 'signature_key_id', 'error', 'installed_at', 'installed_by', 'created_at',
  ],
  'platform.pack_catalog': ['pack_id', 'pack_version', 'channel', 'note_en', 'note_id', 'published_at', 'retrieved_at'],
  'platform.tenant_key': ['organization_id', 'wrapped_dek', 'kek_id', 'created_at', 'rotated_at'],
  'platform.audit_log': [
    'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action',
    'entity_type', 'entity_id', 'entity_code', 'before_data', 'after_data', 'edition', 'request_id', 'source_ip',
    'user_agent', 'prev_hash', 'row_hash',
  ],
  'platform.audit_anchor': [
    'id', 'chain', 'seq', 'row_hash', 'anchored_at', 'payload', 'signature', 'key_id', 'exported_to',
  ],
  'platform.rate_limit_bucket': ['key', 'window_start', 'hits', 'expires_at'],
  'platform.idempotency_key': [
    'organization_id', 'user_id', 'key', 'route', 'request_hash', 'status', 'response', 'created_at', 'expires_at',
  ],
  'platform.job_outbox': [
    'id', 'queue', 'payload', 'singleton_key', 'run_at', 'created_at', 'dispatched_at', 'attempts', 'last_error',
  ],
  'platform.system_setting': ['key', 'value', 'updated_at'],
});
