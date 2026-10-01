CREATE TABLE audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  certification_cycle_id uuid REFERENCES certification_cycle(id),
  event_type varchar(20) NOT NULL CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special')),
  name_en varchar(200) NOT NULL,
  name_id varchar(200) NOT NULL,
  short_label varchar(80) NOT NULL,
  scheduled_at date NOT NULL,
  audit_days smallint CHECK (audit_days IS NULL OR audit_days > 0),
  lead_auditor_name varchar(150),
  expected_focus text,
  prep_window_days smallint NOT NULL DEFAULT 60 CHECK (prep_window_days BETWEEN 0 AND 365),
  outcome varchar(30) CHECK (outcome IN ('recommended', 'recommended_with_conditions', 'not_recommended')),
  outcome_summary text
);
CREATE INDEX audit_event_next_idx ON audit_event (management_system_id, scheduled_at) WHERE deleted_at IS NULL;

CREATE TABLE audit_prep_task (
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
  owner_user_id uuid REFERENCES platform.app_user(id),
  due_at date NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'done', 'blocked', 'overdue')),
  note text,
  violates_br43 boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  CHECK (status <> 'blocked' OR note IS NOT NULL)
);
CREATE INDEX audit_prep_task_event_idx ON audit_prep_task (audit_event_id, position) WHERE deleted_at IS NULL;
CREATE TRIGGER audit_prep_task_br43 BEFORE INSERT OR UPDATE OF due_at, audit_event_id ON audit_prep_task
  FOR EACH ROW EXECUTE FUNCTION platform.prep_task_before_audit();

CREATE TABLE finding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  framework_version_id uuid REFERENCES ref.framework_version(id),
  audit_event_id uuid REFERENCES audit_event(id),
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  classification varchar(15) NOT NULL CHECK (classification IN ('major', 'minor', 'ofi', 'signal', 'not_a_finding')),
  clause_ref varchar(40),
  source varchar(20) NOT NULL CHECK (source IN ('certification_audit', 'internal_audit', 'self_assessment', 'other')),
  status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  status_note text,
  owner_user_id uuid REFERENCES platform.app_user(id),
  raised_at date,
  due_at date,
  rca_text text,
  systemic_check_text text,
  closed_at date,
  closed_by_user_id uuid REFERENCES platform.app_user(id),
  close_note text,
  position integer NOT NULL DEFAULT 0,
  CHECK (status <> 'closed' OR closed_at IS NOT NULL),
  CHECK (status <> 'closed' OR classification <> 'major' OR (rca_text IS NOT NULL AND systemic_check_text IS NOT NULL))
);
CREATE UNIQUE INDEX finding_code_uq ON finding (management_system_id, code) WHERE deleted_at IS NULL;
CREATE INDEX finding_open_idx ON finding (management_system_id, status, classification) WHERE deleted_at IS NULL;

CREATE TABLE corrective_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  status varchar(30) NOT NULL DEFAULT 'correction' CHECK (status IN ('correction', 'rca', 'systemic_check', 'action',
    'effectiveness_verification', 'closed', 'cancelled')),
  correction_text text,
  rca_text text,
  systemic_check_text text,
  action_text text,
  due_at date,
  implemented_at date,
  implemented_by_user_id uuid REFERENCES platform.app_user(id),
  verified_by_user_id uuid REFERENCES platform.app_user(id),
  verified_at date,
  effective boolean,
  verification_note text,
  -- BR-09: neither the implementer nor the owner verifies. BR-08: verification on a different day.
  CHECK (verified_by_user_id IS NULL OR verified_by_user_id IS DISTINCT FROM implemented_by_user_id),
  CHECK (verified_by_user_id IS NULL OR verified_by_user_id IS DISTINCT FROM owner_user_id),
  CHECK (verified_at IS NULL OR implemented_at IS NULL OR verified_at <> implemented_at),
  CHECK (status <> 'closed' OR (verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND effective IS NOT NULL))
);
CREATE UNIQUE INDEX corrective_action_code_uq ON corrective_action (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE management_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  planned_at date,
  held_at date,
  status varchar(10) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'held', 'closed')),
  decisions_recorded boolean NOT NULL DEFAULT false,
  decisions_text text,
  closed_at date,
  closed_by_user_id uuid REFERENCES platform.app_user(id),
  CHECK (status <> 'closed' OR (decisions_recorded AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX management_review_code_uq ON management_review (code) WHERE deleted_at IS NULL;

CREATE TABLE management_review_input (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_review_id uuid NOT NULL REFERENCES management_review(id),
  review_input_def_id uuid NOT NULL REFERENCES ref.review_input_def(id),
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  content text,
  source_refs jsonb
);
CREATE UNIQUE INDEX management_review_input_uq ON management_review_input (management_review_id, review_input_def_id, management_system_id)
  WHERE deleted_at IS NULL;

CREATE TABLE cycle_requirement_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  certification_cycle_id uuid NOT NULL REFERENCES certification_cycle(id),
  cycle_requirement_def_id uuid REFERENCES ref.cycle_requirement_def(id),
  requirement_code varchar(20) NOT NULL DEFAULT '-',
  title varchar(255) NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  status varchar(12) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'done', 'blocked', 'overdue')),
  due_at date NOT NULL,
  condition_note text,
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX cycle_requirement_status_ms_idx ON cycle_requirement_status (management_system_id, position) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX cycle_requirement_status_def_uq ON cycle_requirement_status (certification_cycle_id, cycle_requirement_def_id)
  WHERE deleted_at IS NULL AND cycle_requirement_def_id IS NOT NULL;

CREATE TABLE drift_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  drift_rule_def_id uuid NOT NULL REFERENCES ref.drift_rule_def(id),
  rule_code varchar(30) NOT NULL,
  entity_type varchar(40),
  entity_id uuid,
  entity_code varchar(40) NOT NULL,
  title text NOT NULL,
  holder_user_id uuid REFERENCES platform.app_user(id),
  due_at date,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX drift_result_open_idx ON drift_result (management_system_id, rule_code, position) WHERE resolved_at IS NULL AND deleted_at IS NULL;

CREATE TABLE implementation_activity_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  activity_template_id uuid NOT NULL REFERENCES ref.activity_template(id),
  phase_no smallint NOT NULL,
  activity_no smallint NOT NULL,
  -- Copied from the template at activation (D-30); a pack minor update never rewrites them.
  title varchar(255) NOT NULL,
  clause_ref varchar(20),
  output_document_code varchar(30),
  expected_outcome text,
  is_gate_phase boolean NOT NULL DEFAULT false,
  template_pack_version varchar(20) NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  status varchar(12) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'complete', 'verified', 'blocked')),
  output_document_id uuid REFERENCES document(id),
  blocker_gate_item_ref varchar(60),
  blocker_reason text,
  due_at date,
  completed_at date,
  completed_by_user_id uuid REFERENCES platform.app_user(id),
  verified_at date,
  verified_by_user_id uuid REFERENCES platform.app_user(id),
  CHECK (status <> 'blocked' OR (blocker_gate_item_ref IS NOT NULL AND blocker_reason IS NOT NULL)),
  CHECK (verified_by_user_id IS NULL OR verified_by_user_id IS DISTINCT FROM owner_user_id),
  CHECK (verified_by_user_id IS NULL OR verified_by_user_id IS DISTINCT FROM completed_by_user_id)
);
CREATE UNIQUE INDEX implementation_activity_progress_uq ON implementation_activity_progress (management_system_id, phase_no, activity_no)
  WHERE deleted_at IS NULL;

CREATE TABLE trace_chain_instance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  anchor_code varchar(40) NOT NULL,
  position smallint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX trace_chain_instance_uq ON trace_chain_instance (management_system_id, anchor_code) WHERE deleted_at IS NULL;

CREATE TABLE trace_chain_node (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  trace_chain_instance_id uuid NOT NULL REFERENCES trace_chain_instance(id),
  position smallint NOT NULL,
  stage_key varchar(20) NOT NULL,
  record_code varchar(40)
);
CREATE UNIQUE INDEX trace_chain_node_uq ON trace_chain_node (trace_chain_instance_id, position) WHERE deleted_at IS NULL;

SELECT platform.secure_tenant_schema(current_schema());
