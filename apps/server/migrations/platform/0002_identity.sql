CREATE TABLE platform.organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(40) NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  name varchar(200) NOT NULL,
  schema_name varchar(63) NOT NULL CHECK (schema_name ~ '^org_[a-z0-9_]{1,59}$'),
  time_zone varchar(64) NOT NULL DEFAULT 'Asia/Jakarta',
  site_count smallint NOT NULL DEFAULT 1 CHECK (site_count >= 0),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'offboarding', 'archived')),
  local_login varchar(12) NOT NULL DEFAULT 'allowed' CHECK (local_login IN ('allowed', 'admins_only', 'disabled')),
  region varchar(40),
  demo_deploy_label varchar(10) CHECK (demo_deploy_label IN ('saas', 'onprem')),
  position smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX organization_slug_uq ON platform.organization (slug);
CREATE UNIQUE INDEX organization_schema_uq ON platform.organization (schema_name);

-- Email domains the platform operator verified for an organisation (CLI `tenant verify-domain`). JIT needs them (D-25).
CREATE TABLE platform.verified_domain (
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  domain varchar(253) NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  verified_by varchar(150) NOT NULL,
  PRIMARY KEY (organization_id, domain)
);

CREATE TABLE platform.app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle varchar(40) NOT NULL CHECK (handle ~ '^[a-z][a-z0-9._-]{1,39}$'),
  email varchar(254) NOT NULL,
  display_name varchar(150) NOT NULL,
  job_title varchar(150),
  kind varchar(10) NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'system', 'guest')),
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  password_hash text,
  password_changed_at timestamptz,
  failed_login_count smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  mfa_required boolean NOT NULL DEFAULT true,
  mfa_failed_count smallint NOT NULL DEFAULT 0,
  mfa_lock_level smallint NOT NULL DEFAULT 0,
  mfa_locked_until timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX app_user_handle_uq ON platform.app_user (handle);
-- Guest accounts are per grant (D-27) and never collide with a person's account.
CREATE UNIQUE INDEX app_user_email_uq ON platform.app_user (lower(email)) WHERE deleted_at IS NULL AND kind <> 'guest';
CREATE INDEX app_user_name_trgm ON platform.app_user USING gin (display_name ext.gin_trgm_ops);
INSERT INTO platform.app_user (id, handle, email, display_name, kind, status, mfa_required)
VALUES ('00000000-0000-0000-0000-000000000001', 'system', 'system@mscd.invalid', 'System', 'system', 'active', false);

CREATE TABLE platform.org_membership (
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  admin_roles text[] NOT NULL DEFAULT '{}' CHECK (admin_roles <@ ARRAY['tenant_admin', 'storage_admin']::text[]),
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  is_default boolean NOT NULL DEFAULT false,
  invited_by uuid REFERENCES platform.app_user(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX org_membership_user_idx ON platform.org_membership (user_id) WHERE deleted_at IS NULL;

CREATE TABLE platform.platform_role (
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  role varchar(30) NOT NULL CHECK (role IN ('platform_operator')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES platform.app_user(id),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE platform.identity_provider (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  slug varchar(40) NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,39}$'),
  kind varchar(10) NOT NULL CHECK (kind IN ('oidc', 'saml')),
  display_name varchar(100) NOT NULL,
  icon varchar(10) NOT NULL DEFAULT 'generic' CHECK (icon IN ('microsoft', 'google', 'generic')),
  enabled boolean NOT NULL DEFAULT true,
  oidc_issuer text,
  oidc_client_id varchar(200),
  oidc_client_secret_sealed text,
  oidc_scopes text NOT NULL DEFAULT 'openid email profile',
  subject_mode varchar(10) NOT NULL DEFAULT 'sub' CHECK (subject_mode IN ('sub', 'entra')),
  entra_tenant_id uuid,
  saml_entry_point text,
  saml_idp_issuer text,
  saml_idp_certs text[],
  saml_sp_entity_id text,
  saml_mfa_authn_contexts text[] NOT NULL DEFAULT ARRAY['https://refeds.org/profile/mfa',
    'http://schemas.microsoft.com/claims/multipleauthn']::text[],
  require_mfa_claim boolean NOT NULL DEFAULT true,
  accepted_amr text[] NOT NULL DEFAULT ARRAY['pwd', 'otp', 'hwk', 'swk', 'fpt', 'face', 'pin', 'sms', 'mca']::text[],
  mfa_fallback varchar(12) NOT NULL DEFAULT 'local_totp' CHECK (mfa_fallback IN ('local_totp', 'reject')),
  jit_provisioning boolean NOT NULL DEFAULT false,
  allowed_email_domains text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  CHECK (kind <> 'oidc' OR (oidc_issuer IS NOT NULL AND oidc_client_id IS NOT NULL)),
  CHECK (kind <> 'saml' OR (saml_entry_point IS NOT NULL AND saml_idp_certs IS NOT NULL)),
  CHECK (subject_mode <> 'entra' OR (kind = 'oidc' AND entra_tenant_id IS NOT NULL)),
  CHECK (NOT jit_provisioning OR cardinality(allowed_email_domains) > 0)
);
CREATE UNIQUE INDEX identity_provider_slug_uq ON platform.identity_provider (slug) WHERE deleted_at IS NULL;
CREATE INDEX identity_provider_org_idx ON platform.identity_provider (organization_id) WHERE deleted_at IS NULL;

-- subject is the OIDC `sub`, '<tid>:<oid>' for subject_mode entra, or the SAML persistent NameID.
CREATE TABLE platform.user_identity (
  identity_provider_id uuid NOT NULL REFERENCES platform.identity_provider(id),
  subject varchar(255) NOT NULL,
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  email_at_link varchar(254),
  link_method varchar(12) NOT NULL CHECK (link_method IN ('invitation', 'session', 'admin', 'jit')),
  linked_by uuid REFERENCES platform.app_user(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (identity_provider_id, subject)
);
CREATE INDEX user_identity_user_idx ON platform.user_identity (user_id);

CREATE TABLE platform.session (
  id_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  organization_id uuid REFERENCES platform.organization(id),
  auth_org_id uuid REFERENCES platform.organization(id),
  state varchar(15) NOT NULL CHECK (state IN ('mfa_pending', 'mfa_enrolment', 'active')),
  auth_method varchar(10) NOT NULL CHECK (auth_method IN ('local', 'oidc', 'saml', 'demo', 'guest', 'test')),
  identity_provider_id uuid REFERENCES platform.identity_provider(id),
  auth_grant_id uuid,
  amr text[] NOT NULL DEFAULT '{}',
  password_at timestamptz,
  mfa_at timestamptz,
  csrf_token_hash bytea NOT NULL,
  persistent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason varchar(40),
  ip inet,
  user_agent text
);
CREATE INDEX session_user_idx ON platform.session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX session_grant_idx ON platform.session (auth_grant_id) WHERE revoked_at IS NULL AND auth_grant_id IS NOT NULL;
CREATE INDEX session_expiry_idx ON platform.session (absolute_expires_at);

CREATE TABLE platform.mfa_factor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  kind varchar(10) NOT NULL DEFAULT 'totp' CHECK (kind IN ('totp')),
  secret_sealed text NOT NULL,
  label varchar(60),
  confirmed_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX mfa_factor_confirmed_uq ON platform.mfa_factor (user_id, kind)
  WHERE confirmed_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE platform.mfa_recovery_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX mfa_recovery_code_user_idx ON platform.mfa_recovery_code (user_id) WHERE used_at IS NULL AND deleted_at IS NULL;

-- One row per browser flow: OIDC and SAML sign-in, identity linking, repository OAuth consent, guest one-time code.
CREATE TABLE platform.auth_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(15) NOT NULL CHECK (kind IN ('oidc_login', 'oidc_link', 'saml_login', 'saml_link', 'repo_oauth', 'guest_otp')),
  identity_provider_id uuid REFERENCES platform.identity_provider(id),
  organization_id uuid REFERENCES platform.organization(id),
  user_id uuid REFERENCES platform.app_user(id),
  target_id uuid,
  state_hash bytea NOT NULL,
  browser_binding_hash bytea NOT NULL,
  nonce varchar(100),
  code_verifier_sealed text,
  saml_request_id varchar(100),
  otp_hash text,
  attempts smallint NOT NULL DEFAULT 0,
  return_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (kind NOT IN ('oidc_login', 'oidc_link', 'saml_login', 'saml_link') OR identity_provider_id IS NOT NULL),
  CHECK (kind <> 'repo_oauth' OR (organization_id IS NOT NULL AND user_id IS NOT NULL AND target_id IS NOT NULL))
);
CREATE UNIQUE INDEX auth_transaction_state_uq ON platform.auth_transaction (state_hash);

-- SAML assertion ids seen within their validity window (replay protection, F.9).
CREATE TABLE platform.saml_assertion_seen (
  identity_provider_id uuid NOT NULL REFERENCES platform.identity_provider(id),
  assertion_id_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (identity_provider_id, assertion_id_hash)
);

CREATE TABLE platform.password_reset_token (
  token_hash bytea PRIMARY KEY,
  kind varchar(12) NOT NULL DEFAULT 'reset' CHECK (kind IN ('reset', 'set_password')),
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- Invitation to an organisation; redeemed by setting a password or by signing in through one of its providers (D-25).
CREATE TABLE platform.invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL,
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  email varchar(254) NOT NULL,
  created_by uuid NOT NULL REFERENCES platform.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX invitation_token_uq ON platform.invitation (token_hash);

CREATE TABLE platform.user_preference (
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  key varchar(60) NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.organization FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.app_user FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.org_membership FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.identity_provider FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.mfa_factor FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
SELECT platform.secure_platform_schema();
