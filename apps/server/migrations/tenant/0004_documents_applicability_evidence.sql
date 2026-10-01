CREATE TABLE document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  doc_code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  doc_type varchar(20) NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'expired')),
  classification varchar(15) NOT NULL DEFAULT 'internal' CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  owner_user_id uuid REFERENCES platform.app_user(id),
  approver_user_id uuid REFERENCES platform.app_user(id),
  current_version_id uuid,
  approved_at date,
  next_review_at date,
  is_org_wide boolean NOT NULL DEFAULT false,
  pending_holder_user_id uuid REFERENCES platform.app_user(id),
  pending_due_at date,
  review_started_at date,
  position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX document_code_uq ON document (doc_code) WHERE deleted_at IS NULL;
CREATE INDEX document_title_trgm ON document USING gin (title ext.gin_trgm_ops);
CREATE INDEX document_review_idx ON document (next_review_at) WHERE deleted_at IS NULL;

CREATE TABLE document_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  document_id uuid NOT NULL REFERENCES document(id),
  version_label varchar(20) NOT NULL,
  storage_object_id uuid NOT NULL REFERENCES storage_object(id),
  status varchar(12) NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'superseded')),
  submitted_by uuid REFERENCES platform.app_user(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES platform.app_user(id),
  approved_at date,
  rejection_note text,
  CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by)
);
CREATE UNIQUE INDEX document_version_label_uq ON document_version (document_id, version_label) WHERE deleted_at IS NULL;
ALTER TABLE document ADD CONSTRAINT document_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_version(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE bc_plan ADD CONSTRAINT bc_plan_document_fk FOREIGN KEY (document_id) REFERENCES document(id);

CREATE TABLE applicability_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  target_type varchar(15) NOT NULL CHECK (target_type IN ('catalogue_item', 'requirement')),
  catalogue_item_id uuid REFERENCES ref.catalogue_item(id),
  requirement_id uuid REFERENCES ref.requirement(id),
  is_applicable boolean,
  inclusion_justification text,
  exclusion_justification text,
  implementation_status varchar(25) CHECK (implementation_status IN ('not_started', 'planned', 'partially_implemented',
    'complete', 'implemented', 'not_applicable')),
  owner_user_id uuid REFERENCES platform.app_user(id),
  status_note text,
  holds_gate boolean NOT NULL DEFAULT false,
  gate_reason text,
  action_due_at date,
  justification_holder_user_id uuid REFERENCES platform.app_user(id),
  justification_due_at date,
  completed_by_user_id uuid REFERENCES platform.app_user(id),
  completed_at date,
  verified_by_user_id uuid REFERENCES platform.app_user(id),
  verified_at date,
  last_evidence_at date,
  freshness_status varchar(10) CHECK (freshness_status IN ('fresh', 'aging', 'expired', 'critical')),
  integrity_status varchar(10) CHECK (integrity_status IN ('ok', 'degraded', 'broken')),
  derived_at timestamptz,
  position integer NOT NULL DEFAULT 0,
  CHECK ((target_type = 'catalogue_item') = (catalogue_item_id IS NOT NULL)),
  CHECK ((target_type = 'requirement') = (requirement_id IS NOT NULL)),
  CHECK (implementation_status IS DISTINCT FROM 'not_applicable' OR exclusion_justification IS NOT NULL),
  CHECK (verified_by_user_id IS NULL OR verified_by_user_id IS DISTINCT FROM completed_by_user_id)
);
CREATE UNIQUE INDEX applicability_entry_target_uq
  ON applicability_entry (management_system_id, target_type, catalogue_item_id, requirement_id) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
CREATE INDEX applicability_entry_status_idx ON applicability_entry (management_system_id, implementation_status) WHERE deleted_at IS NULL;
CREATE INDEX applicability_entry_owner_idx ON applicability_entry (owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE applicability_entry_risk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  applicability_entry_id uuid NOT NULL REFERENCES applicability_entry(id),
  risk_id uuid NOT NULL REFERENCES risk(id),
  position smallint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX applicability_entry_risk_uq ON applicability_entry_risk (applicability_entry_id, risk_id) WHERE deleted_at IS NULL;

CREATE TABLE applicability_entry_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  applicability_entry_id uuid NOT NULL REFERENCES applicability_entry(id),
  document_id uuid NOT NULL REFERENCES document(id),
  position smallint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX applicability_entry_document_uq ON applicability_entry_document (applicability_entry_id, document_id) WHERE deleted_at IS NULL;
CREATE INDEX applicability_entry_document_doc_idx ON applicability_entry_document (document_id) WHERE deleted_at IS NULL;

CREATE TABLE operating_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  applicability_entry_id uuid NOT NULL REFERENCES applicability_entry(id),
  frequency_code varchar(20) NOT NULL,
  description text
);
CREATE UNIQUE INDEX operating_criteria_entry_uq ON operating_criteria (applicability_entry_id) WHERE deleted_at IS NULL;

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  evidence_code varchar(30) NOT NULL,
  title varchar(255) NOT NULL,
  owner_user_id uuid REFERENCES platform.app_user(id),
  produced_at date,
  storage_object_id uuid REFERENCES storage_object(id),
  external_ref text,
  frequency_code varchar(20) NOT NULL,
  classification varchar(15) NOT NULL DEFAULT 'internal' CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  next_due_override date,
  file_sequence integer NOT NULL DEFAULT 0,
  freshness_status varchar(10) CHECK (freshness_status IN ('fresh', 'aging', 'expired', 'critical')),
  integrity_status varchar(10) CHECK (integrity_status IN ('ok', 'degraded', 'broken')),
  derived_at timestamptz,
  position integer NOT NULL DEFAULT 0,
  CHECK (produced_at IS NULL OR storage_object_id IS NOT NULL OR external_ref IS NOT NULL)
);
CREATE UNIQUE INDEX evidence_code_uq ON evidence (evidence_code) WHERE deleted_at IS NULL;
CREATE INDEX evidence_produced_idx ON evidence (organization_id, produced_at DESC);
CREATE INDEX evidence_owner_idx ON evidence (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX evidence_title_trgm ON evidence USING gin (title ext.gin_trgm_ops);

CREATE TABLE evidence_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  applicability_entry_id uuid NOT NULL REFERENCES applicability_entry(id),
  target_type varchar(15) NOT NULL CHECK (target_type IN ('catalogue_item', 'requirement')),
  catalogue_item_id uuid REFERENCES ref.catalogue_item(id),
  requirement_id uuid REFERENCES ref.requirement(id),
  mapping_note text,
  position smallint NOT NULL DEFAULT 0,
  CHECK ((target_type = 'catalogue_item') = (catalogue_item_id IS NOT NULL)),
  CHECK ((target_type = 'requirement') = (requirement_id IS NOT NULL))
);
CREATE UNIQUE INDEX evidence_target_uq ON evidence_target (evidence_id, applicability_entry_id) WHERE deleted_at IS NULL;
CREATE INDEX evidence_target_target_idx ON evidence_target (target_type, catalogue_item_id, requirement_id);
CREATE INDEX evidence_target_evidence_idx ON evidence_target (evidence_id);
CREATE INDEX evidence_target_entry_idx ON evidence_target (applicability_entry_id);

CREATE TABLE freshness_threshold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid REFERENCES management_system(id),
  frequency_code varchar(20) NOT NULL,
  fresh_grace_days numeric(6,2) NOT NULL DEFAULT 1,
  aging_factor numeric(6,3) NOT NULL DEFAULT 1.25,
  expired_factor numeric(6,3) NOT NULL DEFAULT 2,
  CHECK (aging_factor >= 1 AND expired_factor >= aging_factor)
);
CREATE UNIQUE INDEX freshness_threshold_uq ON freshness_threshold (management_system_id, frequency_code) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;

SELECT platform.secure_tenant_schema(current_schema());
