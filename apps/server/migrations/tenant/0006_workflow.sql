CREATE TABLE reminder (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  management_system_id uuid REFERENCES management_system(id),
  record_key varchar(120) NOT NULL,
  entity_type varchar(40) NOT NULL,
  entity_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES platform.app_user(id),
  sent_by_user_id uuid NOT NULL REFERENCES platform.app_user(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  channels text[] NOT NULL DEFAULT ARRAY['email', 'in_app'],
  bulk_id uuid,
  notification_id uuid
);
CREATE INDEX reminder_throttle_idx ON reminder (recipient_user_id, record_key, sent_at DESC);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  recipient_user_id uuid NOT NULL REFERENCES platform.app_user(id),
  management_system_id uuid REFERENCES management_system(id),
  kind varchar(40) NOT NULL,
  title_en text NOT NULL,
  title_id text NOT NULL,
  body_en text NOT NULL,
  body_id text NOT NULL,
  entity_ref jsonb,
  read_at timestamptz,
  email_status varchar(10) NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_sent_at timestamptz,
  email_attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  digest boolean NOT NULL DEFAULT false
);
CREATE INDEX notification_recipient_idx ON notification (recipient_user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX notification_email_pending_idx ON notification (created_at) WHERE email_status = 'pending';

CREATE TABLE background_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  kind varchar(20) NOT NULL CHECK (kind IN ('evidence_pack', 'export', 'link_health_run', 'pack_install', 'import')),
  management_system_id uuid REFERENCES management_system(id),
  status varchar(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  job_id varchar(80),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX background_task_creator_idx ON background_task (created_by, created_at DESC);

CREATE TABLE evidence_pack (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  audit_event_id uuid REFERENCES audit_event(id),
  background_task_id uuid REFERENCES background_task(id),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'ready', 'failed')),
  pack_folder text,
  manifest_pdf_object_id uuid REFERENCES storage_object(id),
  manifest_csv_object_id uuid REFERENCES storage_object(id),
  archive_object_id uuid REFERENCES storage_object(id),
  item_count integer NOT NULL DEFAULT 0,
  exception_count integer NOT NULL DEFAULT 0,
  built_at timestamptz
);

CREATE TABLE evidence_pack_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  evidence_pack_id uuid NOT NULL REFERENCES evidence_pack(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  evidence_code varchar(30) NOT NULL,
  requirement_codes text[] NOT NULL,
  produced_at date,
  external_version_id varchar(200),
  hash_algorithm varchar(10),
  hash_value varchar(128),
  link_status varchar(20),
  copy_location text,
  -- The copy made by copy-within (or the vault archive member); external auditors open only these (D-34).
  copy_storage_object_id uuid REFERENCES storage_object(id),
  is_deleted_record boolean NOT NULL DEFAULT false,
  is_exception boolean NOT NULL DEFAULT false,
  exception_reason text
);
CREATE INDEX evidence_pack_item_pack_idx ON evidence_pack_item (evidence_pack_id);

CREATE TABLE export_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  kind varchar(20) NOT NULL CHECK (kind IN ('portfolio_board', 'readiness', 'soa', 'document_register', 'audit_trail')),
  format varchar(5) NOT NULL CHECK (format IN ('pdf', 'xlsx', 'csv')),
  management_system_id uuid REFERENCES management_system(id),
  background_task_id uuid REFERENCES background_task(id),
  storage_object_id uuid REFERENCES storage_object(id),
  file_name varchar(200),
  expires_at timestamptz NOT NULL
);

CREATE TABLE auditor_access_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  email varchar(254) NOT NULL,
  -- The guest account created for this grant (kind guest, D-27); never an existing person's account.
  user_id uuid REFERENCES platform.app_user(id),
  user_ms_role_id uuid REFERENCES user_ms_role(id),
  token_hash bytea NOT NULL,
  link_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES platform.app_user(id),
  last_used_at timestamptz
);
CREATE UNIQUE INDEX auditor_access_grant_token_uq ON auditor_access_grant (token_hash);

SELECT platform.secure_tenant_schema(current_schema());
