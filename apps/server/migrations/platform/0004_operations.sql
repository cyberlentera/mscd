CREATE TABLE platform.audit_log (
  seq bigint NOT NULL PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  organization_id uuid,
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
CREATE UNIQUE INDEX audit_log_id_uq ON platform.audit_log (id);
CREATE INDEX audit_log_org_time_idx ON platform.audit_log (organization_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON platform.audit_log (entity_type, entity_id, occurred_at DESC);
CREATE TRIGGER audit_log_chain BEFORE INSERT ON platform.audit_log FOR EACH ROW EXECUTE FUNCTION platform.chain_hash();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON platform.audit_log FOR EACH ROW EXECUTE FUNCTION platform.forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON platform.audit_log FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_change();

-- Daily anchors of every chain head, signed by the worker's anchor key (D-33, F.11). The signed copy also leaves the database.
CREATE TABLE platform.audit_anchor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain varchar(80) NOT NULL,
  seq bigint NOT NULL,
  row_hash bytea NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  signature text NOT NULL,
  key_id varchar(40) NOT NULL,
  exported_to text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_anchor_chain_idx ON platform.audit_anchor (chain, anchored_at DESC);
CREATE TRIGGER audit_anchor_append_only BEFORE UPDATE OR DELETE ON platform.audit_anchor FOR EACH ROW EXECUTE FUNCTION platform.forbid_change();

CREATE TABLE platform.rate_limit_bucket (
  key varchar(200) PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limit_bucket_expiry_idx ON platform.rate_limit_bucket (expires_at);

CREATE TABLE platform.idempotency_key (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key varchar(100) NOT NULL,
  route varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  status smallint,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, user_id, key)
);

CREATE TABLE platform.job_outbox (
  id bigserial PRIMARY KEY,
  queue varchar(80) NOT NULL,
  payload jsonb NOT NULL,
  singleton_key varchar(200),
  run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX job_outbox_pending_idx ON platform.job_outbox (run_at) WHERE dispatched_at IS NULL;

CREATE TABLE platform.system_setting (
  key varchar(80) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_platform_schema();
