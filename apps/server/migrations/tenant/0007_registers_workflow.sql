-- One corrective action may close several findings of a joint audit (PRD 8.2).
CREATE TABLE corrective_action_finding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  corrective_action_id uuid NOT NULL REFERENCES corrective_action(id),
  finding_id uuid NOT NULL REFERENCES finding(id)
);
CREATE UNIQUE INDEX corrective_action_finding_uq ON corrective_action_finding (corrective_action_id, finding_id) WHERE deleted_at IS NULL;
CREATE INDEX corrective_action_finding_finding_idx ON corrective_action_finding (finding_id) WHERE deleted_at IS NULL;

-- Self-Assessment Workbench (PRD 8.1): one row per finding condition of the system's active framework version.
CREATE TABLE self_assessment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  finding_condition_id uuid NOT NULL REFERENCES ref.finding_condition(id),
  status varchar(20) NOT NULL DEFAULT 'not_assessed' CHECK (status IN ('not_assessed', 'conforming', 'gap', 'not_applicable')),
  owner_user_id uuid REFERENCES platform.app_user(id),
  target_fix_at date,
  note text,
  assessed_at date,
  finding_id uuid REFERENCES finding(id),
  CHECK (status <> 'gap' OR owner_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX self_assessment_uq ON self_assessment (management_system_id, finding_condition_id) WHERE deleted_at IS NULL;

CREATE TABLE self_assessment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  self_assessment_id uuid NOT NULL REFERENCES self_assessment(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id)
);
CREATE UNIQUE INDEX self_assessment_evidence_uq ON self_assessment_evidence (self_assessment_id, evidence_id) WHERE deleted_at IS NULL;

-- Audit Activity Planner (PRD 8.1): activities of one audit event, generated from ref.audit_activity_template.
CREATE TABLE audit_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  audit_event_id uuid NOT NULL REFERENCES audit_event(id),
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  template_code varchar(30),
  title varchar(255) NOT NULL,
  clause_ref varchar(40),
  key_questions text,
  evidence_to_request text,
  auditee_user_id uuid REFERENCES platform.app_user(id),
  scheduled_at date,
  status varchar(12) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'cancelled')),
  note text,
  position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX audit_activity_template_uq ON audit_activity (audit_event_id, template_code)
  WHERE deleted_at IS NULL AND template_code IS NOT NULL;

-- Tasks opened by business rules and closed when the condition clears (D-29). One open task per rule and entity.
CREATE TABLE task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid REFERENCES management_system(id),
  source_rule varchar(12) NOT NULL CHECK (source_rule IN ('BR-10', 'BR-11', 'BR-15', 'BR-31', 'manual')),
  entity_type varchar(40) NOT NULL,
  entity_id uuid NOT NULL,
  entity_code varchar(80),
  title_en text NOT NULL,
  title_id text NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  due_at date,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  closed_by uuid REFERENCES platform.app_user(id),
  closed_at timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX task_open_uq ON task (source_rule, entity_type, entity_id) WHERE status = 'open' AND deleted_at IS NULL;
CREATE INDEX task_owner_idx ON task (owner_user_id, status) WHERE deleted_at IS NULL;

-- Review calendar feed tokens (D.3), stored hashed, revocable, checked against ms.read on every fetch.
CREATE TABLE calendar_feed_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  token_hash bytea NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE UNIQUE INDEX calendar_feed_token_hash_uq ON calendar_feed_token (token_hash);
CREATE UNIQUE INDEX calendar_feed_token_active_uq ON calendar_feed_token (user_id, management_system_id)
  WHERE revoked_at IS NULL AND deleted_at IS NULL;

SELECT platform.secure_tenant_schema(current_schema());
