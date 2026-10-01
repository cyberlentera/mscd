CREATE TABLE ref.framework (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL UNIQUE,
  name varchar(150) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ref.framework_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_id uuid NOT NULL REFERENCES ref.framework(id),
  edition varchar(20) NOT NULL,
  pack_id varchar(40) NOT NULL,
  pack_version varchar(20) NOT NULL,
  status varchar(15) NOT NULL CHECK (status IN ('current', 'transition', 'withdrawn')),
  pre_release boolean NOT NULL DEFAULT false,
  transition_ends_at date,
  supersedes_version_id uuid REFERENCES ref.framework_version(id),
  applicability_target varchar(15) NOT NULL CHECK (applicability_target IN ('catalogue_item', 'requirement')),
  pack_checksum char(64) NOT NULL,
  manifest jsonb NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (framework_id, edition)
);

CREATE TABLE ref.requirement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  requirement_code varchar(20) NOT NULL,
  parent_id uuid REFERENCES ref.requirement(id),
  title_short varchar(255) NOT NULL,
  clause_group varchar(3) NOT NULL CHECK (clause_group IN ('4', '5', '6', '7', '8', '9', '10')),
  is_hs_common boolean NOT NULL DEFAULT false,
  documented_info_mandatory boolean NOT NULL DEFAULT false,
  applicability_assessable boolean NOT NULL DEFAULT false,
  default_frequency_code varchar(20),
  evidence_example text,
  sort_order integer NOT NULL,
  UNIQUE (framework_version_id, requirement_code)
);

CREATE TABLE ref.catalogue_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  item_code varchar(20) NOT NULL,
  theme_code varchar(20) NOT NULL,
  title_short varchar(255) NOT NULL,
  requirement_id uuid REFERENCES ref.requirement(id),
  flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_frequency_code varchar(20),
  evidence_example text,
  sort_order integer NOT NULL,
  UNIQUE (framework_version_id, item_code)
);

CREATE TABLE ref.requirement_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_requirement_id uuid NOT NULL REFERENCES ref.requirement(id),
  target_requirement_id uuid NOT NULL REFERENCES ref.requirement(id),
  mapping_type varchar(15) NOT NULL CHECK (mapping_type IN ('equivalent', 'partial', 'related', 'split', 'merged', 'changed', 'new', 'removed')),
  evidence_reusable boolean NOT NULL DEFAULT false,
  note text
);
CREATE INDEX requirement_mapping_source_idx ON ref.requirement_mapping (source_requirement_id);
CREATE INDEX requirement_mapping_target_idx ON ref.requirement_mapping (target_requirement_id);

CREATE TABLE ref.traceability_chain_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  stage_key varchar(20) NOT NULL,
  position smallint NOT NULL,
  label_en varchar(80) NOT NULL,
  label_id varchar(80) NOT NULL,
  auditor_question_en text NOT NULL DEFAULT '',
  auditor_question_id text NOT NULL DEFAULT '',
  source varchar(15) NOT NULL CHECK (source IN ('entity', 'applicability', 'justification', 'document', 'evidence')),
  entity_type varchar(40),
  risk_profile_code varchar(30),
  is_mandatory boolean NOT NULL DEFAULT true,
  clause_at_risk varchar(20),
  overview_clause smallint NOT NULL CHECK (overview_clause BETWEEN 4 AND 10),
  gate_type_label_en varchar(40),
  gate_type_label_id varchar(40),
  UNIQUE (framework_version_id, stage_key),
  CHECK (source <> 'entity' OR entity_type IS NOT NULL)
);

CREATE TABLE ref.activity_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  phase_no smallint NOT NULL,
  phase_name_en varchar(120) NOT NULL,
  phase_name_id varchar(120) NOT NULL,
  is_gate_phase boolean NOT NULL DEFAULT false,
  activity_no smallint NOT NULL,
  title varchar(255) NOT NULL,
  clause_ref varchar(20),
  output_document_code varchar(30),
  expected_outcome text,
  UNIQUE (framework_version_id, phase_no, activity_no)
);

CREATE TABLE ref.evidence_frequency_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(20) NOT NULL,
  label_en varchar(40) NOT NULL,
  label_id varchar(40) NOT NULL,
  period_days integer NOT NULL CHECK (period_days >= 0),
  sort_order smallint NOT NULL,
  UNIQUE (framework_version_id, code)
);

CREATE TABLE ref.label (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  key varchar(100) NOT NULL,
  lang varchar(2) NOT NULL CHECK (lang IN ('en', 'id')),
  value text NOT NULL,
  UNIQUE (framework_version_id, key, lang)
);

CREATE TABLE ref.cycle_requirement_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  requirement_code varchar(20),
  title varchar(255) NOT NULL,
  derivation jsonb,
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, code)
);

CREATE TABLE ref.drift_rule_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  label_en varchar(150) NOT NULL,
  label_id varchar(150) NOT NULL,
  severity varchar(5) NOT NULL CHECK (severity IN ('crit', 'risk', 'warn')),
  source_stage varchar(20),
  source_kind varchar(15) NOT NULL CHECK (source_kind IN ('manual', 'unverif', 'nohash', 'metric', 'exercise', 'stale_risk', 'dd_expired')),
  predicate jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, code)
);

CREATE TABLE ref.prep_task_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  days_before_audit smallint NOT NULL CHECK (days_before_audit > 0),
  skip_on_first_audit boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, code)
);

CREATE TABLE ref.review_input_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  mandatory boolean NOT NULL DEFAULT true,
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, code)
);

CREATE TABLE ref.finding_condition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  classification varchar(15) NOT NULL CHECK (classification IN ('major', 'minor', 'ofi', 'signal', 'not_a_finding')),
  requirement_code varchar(20),
  text text NOT NULL,
  UNIQUE (framework_version_id, code)
);

CREATE TABLE ref.document_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  doc_type varchar(20) NOT NULL,
  UNIQUE (framework_version_id, code)
);

-- Audit Activity Planner templates (PRD 8.1, pack file audit_activities.csv).
CREATE TABLE ref.audit_activity_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  event_type varchar(20) NOT NULL CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special')),
  clause_ref varchar(40),
  title varchar(255) NOT NULL,
  auditee_role varchar(40),
  key_questions text,
  evidence_to_request text,
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, code)
);

-- Framework-specific enumerations (TS 1.1): domains doc_type, treatment_option, exercise_type,
-- bribery_risk_level, due_diligence_subject, risk_profile, plus any domain a pack adds.
CREATE TABLE ref.lookup_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  domain varchar(40) NOT NULL,
  code varchar(40) NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  label_en varchar(120) NOT NULL,
  label_id varchar(120) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, domain, code)
);

CREATE TABLE ref.rule_activation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  rule_id varchar(10) NOT NULL CHECK (rule_id ~ '^BR-[0-9]{2}$'),
  active boolean NOT NULL DEFAULT true,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (framework_version_id, rule_id)
);

CREATE TABLE ref.risk_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  definition jsonb NOT NULL,
  UNIQUE (framework_version_id, code)
);

GRANT SELECT ON ALL TABLES IN SCHEMA ref TO mscd_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ref TO mscd_pack_installer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    GRANT USAGE ON SCHEMA ref TO mscd_report;
    GRANT SELECT ON ALL TABLES IN SCHEMA ref TO mscd_report;
  END IF;
END $$;
