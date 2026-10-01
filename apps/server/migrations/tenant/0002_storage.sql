CREATE TABLE storage_repository (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  slug varchar(20) NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,19}$'),
  name varchar(150) NOT NULL,
  adapter varchar(15) NOT NULL CHECK (adapter IN ('managed_vault', 'm365', 'google_drive', 'smb', 's3', 'webdav')),
  modes text[] NOT NULL CHECK (cardinality(modes) >= 1
    AND modes <@ ARRAY['stored', 'pass_through', 'link', 'zero_transit']::text[]),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_ref varchar(200),
  ownership_type varchar(15) NOT NULL DEFAULT 'organizational' CHECK (ownership_type IN ('organizational', 'personal')),
  retention_confirmed boolean NOT NULL DEFAULT false,
  connection_status varchar(10) NOT NULL DEFAULT 'ok' CHECK (connection_status IN ('ok', 'degraded', 'failed', 'revoked')),
  connection_message_en text,
  connection_message_id text,
  connection_status_since timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  metadata_minimization boolean NOT NULL DEFAULT false,
  read_only boolean NOT NULL DEFAULT false,
  display jsonb NOT NULL DEFAULT '{}'::jsonb,
  position smallint NOT NULL DEFAULT 0,
  CHECK (adapter = 'managed_vault' OR NOT ('stored' = ANY (modes))),
  CHECK (adapter <> 'managed_vault' OR modes = ARRAY['stored']::text[])
);
CREATE UNIQUE INDEX storage_repository_slug_uq ON storage_repository (slug) WHERE deleted_at IS NULL;
ALTER TABLE management_system ADD CONSTRAINT management_system_default_repository_fk
  FOREIGN KEY (default_storage_repository_id) REFERENCES storage_repository(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE storage_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  storage_repository_id uuid NOT NULL REFERENCES storage_repository(id),
  credential_ref varchar(200) NOT NULL,
  kind varchar(30) NOT NULL CHECK (kind IN ('m365_certificate', 'google_service_account', 'oauth_refresh_token',
    's3_access_key', 'smb_account', 'webdav_account')),
  sealed_blob text NOT NULL,
  key_id varchar(40) NOT NULL,
  -- SHA-256 of the canonical repository config the blob is bound to (D-08); a config change needs a new seal.
  config_sha256 char(64) NOT NULL,
  external_account varchar(254),
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX storage_credential_ref_uq ON storage_credential (credential_ref);

CREATE TABLE storage_routing_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid REFERENCES management_system(id),
  classification varchar(15) CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  object_kind varchar(10) CHECK (object_kind IN ('document', 'evidence')),
  storage_repository_id uuid NOT NULL REFERENCES storage_repository(id),
  mode varchar(15) NOT NULL CHECK (mode IN ('stored', 'pass_through', 'link', 'zero_transit')),
  priority smallint NOT NULL DEFAULT 100,
  note text,
  approval_status varchar(20) NOT NULL DEFAULT 'active' CHECK (approval_status IN ('active', 'pending_approval', 'rejected', 'superseded')),
  requested_by uuid REFERENCES platform.app_user(id),
  approved_by uuid REFERENCES platform.app_user(id),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by)
);
CREATE INDEX storage_routing_rule_ms_idx ON storage_routing_rule (management_system_id, priority)
  WHERE deleted_at IS NULL AND approval_status = 'active';

CREATE TABLE storage_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  storage_repository_id uuid NOT NULL REFERENCES storage_repository(id),
  external_item_id varchar(300) NOT NULL,
  external_version_id varchar(200),
  version_label varchar(30),
  display_name varchar(255),
  -- Type detected by the gateway from the first bytes (vault, pass-through) or reported by the provider (link);
  -- never the type a client declared (F.13).
  mime_type varchar(100),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  hash_algorithm varchar(10) NOT NULL DEFAULT 'none' CHECK (hash_algorithm IN ('sha256', 'sha1', 'md5', 'quickxor', 'none')),
  hash_value varchar(128),
  hash_source varchar(10) NOT NULL CHECK (hash_source IN ('computed', 'provider', 'none')),
  provider_created_at timestamptz,
  provider_modified_at timestamptz,
  provider_modified_by varchar(150),
  folder_path text,
  folder_id varchar(300),
  link_status varchar(20) NOT NULL DEFAULT 'intact' CHECK (link_status IN ('intact', 'moved', 'version_changed',
    'verification_pending', 'hash_mismatch', 'pinned_version_lost', 'missing', 'access_denied')),
  link_status_since timestamptz NOT NULL DEFAULT now(),
  -- 'credential_invalid' shortens the validity of verification_pending from 7 days to 72 hours (E.3, TS 5.7).
  link_status_reason varchar(20) CHECK (link_status_reason IN ('unreachable', 'credential_invalid')),
  last_verified_at timestamptz,
  last_good_check_at timestamptz,
  next_check_at timestamptz,
  web_url text,
  encryption jsonb,
  CHECK ((hash_algorithm = 'none') = (hash_value IS NULL)),
  CHECK (hash_source <> 'none' OR hash_algorithm = 'none')
);
CREATE INDEX storage_object_health_idx ON storage_object (link_status, last_verified_at);
CREATE INDEX storage_object_item_idx ON storage_object (storage_repository_id, external_item_id);
CREATE INDEX storage_object_next_check_idx ON storage_object (next_check_at) WHERE deleted_at IS NULL;

CREATE TABLE link_health_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  storage_object_id uuid NOT NULL REFERENCES storage_object(id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  outcome varchar(15) NOT NULL CHECK (outcome IN ('found', 'not_found', 'forbidden', 'unreachable', 'rate_limited', 'error')),
  status_before varchar(20) NOT NULL,
  status_after varchar(20) NOT NULL,
  observed_version_id varchar(200),
  observed_hash varchar(128),
  observed_folder_path text,
  detail jsonb,
  job_id varchar(80)
);
CREATE INDEX link_health_result_object_idx ON link_health_result (storage_object_id, checked_at DESC);

CREATE TABLE upload_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  object_kind varchar(10) NOT NULL CHECK (object_kind IN ('evidence', 'document')),
  target_id uuid NOT NULL,
  storage_repository_id uuid NOT NULL REFERENCES storage_repository(id),
  mode varchar(15) NOT NULL CHECK (mode IN ('stored', 'pass_through', 'zero_transit')),
  folder_path text NOT NULL,
  -- Name written to the repository. With metadata_minimization it is the evidence or document code based name
  -- and original_name is null (TS 4.5).
  stored_name varchar(255) NOT NULL,
  original_name varchar(255),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  correlation_code varchar(40) NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'uploaded', 'completed', 'expired', 'failed')),
  storage_object_id uuid REFERENCES storage_object(id),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX upload_intent_correlation_uq ON upload_intent (correlation_code);

CREATE TABLE repository_move_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  storage_repository_id uuid NOT NULL REFERENCES storage_repository(id),
  target_repository_id uuid REFERENCES storage_repository(id),
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'rejected')),
  note text
);

SELECT platform.secure_tenant_schema(current_schema());
