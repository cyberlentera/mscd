CREATE TABLE context_issue (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  issue_type varchar(10) CHECK (issue_type IN ('internal', 'external')),
  description text,
  last_reviewed_at date
);
CREATE UNIQUE INDEX context_issue_code_uq ON context_issue (code) WHERE deleted_at IS NULL;

CREATE TABLE interested_party (
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
  requirements text,
  last_reviewed_at date,
  position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX interested_party_code_uq ON interested_party (code) WHERE deleted_at IS NULL;

CREATE TABLE asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  asset_type varchar(40),
  owner_user_id uuid REFERENCES platform.app_user(id),
  classification varchar(15) CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX asset_code_uq ON asset (code) WHERE deleted_at IS NULL;

CREATE TABLE risk (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  risk_profile_code varchar(30) NOT NULL,
  is_opportunity boolean NOT NULL DEFAULT false,
  description text,
  likelihood smallint,
  consequence smallint,
  impact_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  residual_likelihood smallint,
  residual_consequence smallint,
  treatment_option varchar(20),
  assessed_at date,
  next_review_at date,
  residual_accepted_at date
);
CREATE UNIQUE INDEX risk_code_uq ON risk (code) WHERE deleted_at IS NULL;
CREATE INDEX risk_title_trgm ON risk USING gin (title ext.gin_trgm_ops);

CREATE TABLE risk_treatment (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  risk_id uuid REFERENCES risk(id),
  target_type varchar(15) CHECK (target_type IN ('catalogue_item', 'requirement')),
  catalogue_item_id uuid REFERENCES ref.catalogue_item(id),
  requirement_id uuid REFERENCES ref.requirement(id),
  status varchar(20) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'in_progress', 'delayed',
    'implemented', 'residual_accepted', 'closed')),
  target_date date,
  implemented_at date,
  implemented_by_user_id uuid REFERENCES platform.app_user(id),
  closed_at date,
  CHECK (status NOT IN ('implemented', 'residual_accepted', 'closed') OR implemented_by_user_id IS NOT NULL),
  CHECK (target_type IS NULL
    OR (target_type = 'catalogue_item' AND catalogue_item_id IS NOT NULL AND requirement_id IS NULL)
    OR (target_type = 'requirement' AND requirement_id IS NOT NULL AND catalogue_item_id IS NULL)),
  CHECK (status = 'proposed' OR target_type IS NOT NULL)
);
CREATE UNIQUE INDEX risk_treatment_code_uq ON risk_treatment (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE residual_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  risk_id uuid NOT NULL REFERENCES risk(id),
  risk_treatment_id uuid REFERENCES risk_treatment(id),
  accepted_by_user_id uuid NOT NULL REFERENCES platform.app_user(id),
  -- Snapshot of the treatment implementer at acceptance (BR-04: the implementer never accepts).
  implemented_by_user_id uuid REFERENCES platform.app_user(id),
  accepted_at date NOT NULL,
  residual_score smallint,
  note text,
  CHECK (implemented_by_user_id IS NULL OR accepted_by_user_id <> implemented_by_user_id)
);

CREATE TABLE metric (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  unit varchar(20),
  target_value numeric(18,4),
  frequency_code varchar(20),
  last_measured_at date
);
CREATE UNIQUE INDEX metric_code_uq ON metric (code) WHERE deleted_at IS NULL;

CREATE TABLE metric_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  metric_id uuid NOT NULL REFERENCES metric(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  value numeric(18,4) NOT NULL,
  note text
);

CREATE TABLE quality_objective (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  statement text,
  metric_id uuid REFERENCES metric(id),
  target_text varchar(150),
  due_at date
);
CREATE UNIQUE INDEX quality_objective_code_uq ON quality_objective (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE process (
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
  inputs text,
  outputs text,
  position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX process_code_uq ON process (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE prioritized_activity (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  product_service varchar(150),
  mtpd_hours integer CHECK (mtpd_hours IS NULL OR mtpd_hours > 0),
  rto_hours integer CHECK (rto_hours IS NULL OR rto_hours > 0),
  rpo_hours integer CHECK (rpo_hours IS NULL OR rpo_hours >= 0),
  mbco_note text,
  CHECK (rto_hours IS NULL OR mtpd_hours IS NULL OR rto_hours <= mtpd_hours)
);
CREATE UNIQUE INDEX prioritized_activity_code_uq ON prioritized_activity (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE business_impact_analysis (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  prioritized_activity_id uuid REFERENCES prioritized_activity(id),
  impact_over_time jsonb,
  dependencies jsonb,
  resources_required jsonb,
  mtpd_hours integer,
  rto_hours integer,
  rpo_hours integer,
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  analysed_at date,
  next_review_at date,
  CHECK (rto_hours IS NULL OR mtpd_hours IS NULL OR rto_hours <= mtpd_hours)
);
CREATE UNIQUE INDEX business_impact_analysis_code_uq ON business_impact_analysis (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE bc_plan (
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
  document_id uuid,
  owner_user_id uuid REFERENCES platform.app_user(id),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'tested', 'untested')),
  position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bc_plan_code_uq ON bc_plan (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE exercise (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  bc_plan_id uuid REFERENCES bc_plan(id),
  exercise_type varchar(20),
  planned_at date,
  performed_at date,
  objectives_met boolean,
  lessons text
);
CREATE UNIQUE INDEX exercise_code_uq ON exercise (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE business_associate (
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
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  category varchar(40),
  jurisdiction varchar(60),
  bribery_risk_level varchar(20),
  relationship_owner_user_id uuid REFERENCES platform.app_user(id)
);
CREATE UNIQUE INDEX business_associate_code_uq ON business_associate (management_system_id, code) WHERE deleted_at IS NULL;

CREATE TABLE due_diligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  subject_type varchar(20) NOT NULL,
  subject_id uuid,
  performed_at date,
  valid_until date,
  outcome varchar(30),
  conditions text,
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'expired', 'superseded'))
);

-- Explicit chain records of stages without a typed table (for example the ISO 27001 SoA approval, SOA-01).
CREATE TABLE chain_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  stage_key varchar(20) NOT NULL,
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  pending_action text,
  action_due_at date,
  action_completed_at timestamptz,
  action_completed_by uuid REFERENCES platform.app_user(id),
  is_gate_item boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  related_entity_type varchar(40),
  related_entity_id uuid
);
CREATE UNIQUE INDEX chain_record_code_uq ON chain_record (management_system_id, stage_key, code) WHERE deleted_at IS NULL;

-- Up and down references as authored on each chain record (D-11). target_code is a business id in the same organisation.
CREATE TABLE record_reference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  entity_type varchar(40) NOT NULL,
  entity_id uuid NOT NULL,
  direction varchar(4) NOT NULL CHECK (direction IN ('up', 'down')),
  target_code varchar(40) NOT NULL,
  position smallint NOT NULL DEFAULT 0
);
CREATE INDEX record_reference_entity_idx ON record_reference (entity_type, entity_id, direction, position) WHERE deleted_at IS NULL;
CREATE INDEX record_reference_target_idx ON record_reference (target_code) WHERE deleted_at IS NULL;

SELECT platform.secure_tenant_schema(current_schema());
