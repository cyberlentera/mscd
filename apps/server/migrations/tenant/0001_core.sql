CREATE TABLE management_system (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  slug varchar(20) NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,19}$'),
  code varchar(20) NOT NULL,
  name varchar(150) NOT NULL,
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  transition_target_version_id uuid REFERENCES ref.framework_version(id),
  scope_statement text NOT NULL,
  status varchar(15) NOT NULL CHECK (status IN ('setup', 'implementing', 'certified', 'transitioning', 'archived')),
  default_storage_repository_id uuid NOT NULL,
  certification_body varchar(150),
  color varchar(7) NOT NULL DEFAULT '#e8731a' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  display jsonb NOT NULL DEFAULT '{}'::jsonb,
  position smallint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX management_system_slug_uq ON management_system (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX management_system_code_uq ON management_system (code) WHERE deleted_at IS NULL;

CREATE TABLE management_system_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  role varchar(20) NOT NULL CHECK (role IN ('active', 'transition_target', 'previous')),
  activated_at date NOT NULL,
  ended_at date
);
CREATE UNIQUE INDEX management_system_version_role_uq ON management_system_version (management_system_id, role)
  WHERE ended_at IS NULL AND deleted_at IS NULL AND role <> 'previous';

CREATE TABLE user_ms_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  role varchar(30) NOT NULL CHECK (role IN ('ms_manager', 'programme_owner', 'domain_owner', 'risk_owner',
    'internal_auditor', 'top_management', 'external_auditor', 'compliance_investigator')),
  is_primary boolean NOT NULL DEFAULT false,
  valid_until timestamptz,
  -- Grants to a Tenant or Storage Admin, and every self-grant, wait for a second Tenant Admin (F.6, TS 7.2).
  approval_status varchar(20) NOT NULL DEFAULT 'active' CHECK (approval_status IN ('active', 'pending_approval', 'rejected')),
  requested_by uuid REFERENCES platform.app_user(id),
  approved_by uuid REFERENCES platform.app_user(id),
  CHECK (role <> 'external_auditor' OR valid_until IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM user_id)
);
CREATE UNIQUE INDEX user_ms_role_uq ON user_ms_role (user_id, management_system_id, role) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX user_ms_role_primary_uq ON user_ms_role (management_system_id, role) WHERE is_primary AND deleted_at IS NULL;
CREATE INDEX user_ms_role_ms_idx ON user_ms_role (management_system_id) WHERE deleted_at IS NULL;

CREATE TABLE entity_ms_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  entity_type varchar(30) NOT NULL CHECK (entity_type IN ('context_issue', 'interested_party', 'asset', 'document',
    'evidence', 'risk', 'audit_event', 'management_review', 'metric')),
  entity_id uuid NOT NULL,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  is_primary boolean NOT NULL DEFAULT false,
  relevance_note text
);
CREATE UNIQUE INDEX entity_ms_link_uq ON entity_ms_link (entity_type, entity_id, management_system_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX entity_ms_link_primary_uq ON entity_ms_link (entity_type, entity_id) WHERE is_primary AND deleted_at IS NULL;
CREATE INDEX entity_ms_link_ms_idx ON entity_ms_link (management_system_id, entity_type) WHERE deleted_at IS NULL;
CREATE INDEX entity_ms_link_entity_idx ON entity_ms_link (entity_type, entity_id);
CREATE CONSTRAINT TRIGGER entity_ms_link_has_primary AFTER INSERT OR UPDATE ON entity_ms_link
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform.entity_link_has_primary();

CREATE TABLE certification_cycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  cycle_start date NOT NULL,
  cycle_end date NOT NULL,
  status varchar(15) NOT NULL CHECK (status IN ('planned', 'active', 'certified', 'suspended', 'withdrawn', 'expired', 'closed')),
  certified_at date,
  certificate_no varchar(60),
  CHECK (cycle_end > cycle_start)
);
CREATE INDEX certification_cycle_ms_idx ON certification_cycle (management_system_id, cycle_start DESC) WHERE deleted_at IS NULL;

CREATE TABLE ms_alert (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  kind varchar(20) NOT NULL CHECK (kind IN ('connector', 'transition', 'beta', 'withdrawn_edition', 'licence', 'other')),
  tone varchar(5) NOT NULL CHECK (tone IN ('info', 'warn', 'bad')),
  text_en text NOT NULL,
  text_id text NOT NULL,
  source_ref jsonb,
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX ms_alert_open_idx ON ms_alert (management_system_id) WHERE resolved_at IS NULL AND deleted_at IS NULL;

CREATE TABLE clause_readiness (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  clause_group smallint NOT NULL CHECK (clause_group BETWEEN 4 AND 10),
  readiness_pct smallint NOT NULL CHECK (readiness_pct BETWEEN 0 AND 100),
  source varchar(10) NOT NULL DEFAULT 'seeded' CHECK (source IN ('seeded', 'manual', 'computed'))
);
CREATE UNIQUE INDEX clause_readiness_uq ON clause_readiness (management_system_id, clause_group) WHERE deleted_at IS NULL;

CREATE TABLE audit_trail (
  seq bigint NOT NULL PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  management_system_id uuid,
  actor_user_id uuid,
  actor_kind varchar(10) NOT NULL CHECK (actor_kind IN ('user', 'system', 'guest', 'operator')),
  action varchar(60) NOT NULL,
  entity_type varchar(40),
  entity_id uuid,
  entity_code varchar(80),
  before_data jsonb,
  after_data jsonb,
  edition varchar(40),
  request_id varchar(64),
  source_ip inet,
  user_agent text,
  prev_hash bytea NOT NULL,
  row_hash bytea NOT NULL
);
CREATE UNIQUE INDEX audit_trail_id_uq ON audit_trail (id);
CREATE INDEX audit_trail_entity_idx ON audit_trail (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_trail_ms_time_idx ON audit_trail (management_system_id, occurred_at DESC);
CREATE TRIGGER audit_trail_chain BEFORE INSERT ON audit_trail FOR EACH ROW EXECUTE FUNCTION platform.chain_hash();
CREATE TRIGGER audit_trail_append_only BEFORE UPDATE OR DELETE ON audit_trail FOR EACH ROW EXECUTE FUNCTION platform.forbid_change();
CREATE TRIGGER audit_trail_no_truncate BEFORE TRUNCATE ON audit_trail FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_change();

SELECT platform.secure_tenant_schema(current_schema());
