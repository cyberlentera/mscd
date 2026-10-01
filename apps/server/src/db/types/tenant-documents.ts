// Kysely row types of the tenant tables of migrations/tenant/0004_documents_applicability_evidence.sql (build plan C.6).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns } from './index';

/** `document` */
export interface DocumentTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  doc_code: string;
  title: string;
  doc_type: string;
  status: Generated<'draft' | 'in_review' | 'approved' | 'expired'>;
  classification: Generated<'public' | 'internal' | 'confidential' | 'restricted'>;
  owner_user_id: string | null;
  approver_user_id: string | null;
  current_version_id: string | null;
  approved_at: string | null;
  next_review_at: string | null;
  is_org_wide: Generated<boolean>;
  pending_holder_user_id: string | null;
  pending_due_at: string | null;
  review_started_at: string | null;
  position: Generated<number>;
}

/** `document_version` */
export interface DocumentVersionTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  document_id: string;
  version_label: string;
  storage_object_id: string;
  status: 'draft' | 'in_review' | 'approved' | 'rejected' | 'superseded';
  submitted_by: string | null;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_note: string | null;
}

/** `applicability_entry` */
export interface ApplicabilityEntryTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  target_type: 'catalogue_item' | 'requirement';
  catalogue_item_id: string | null;
  requirement_id: string | null;
  is_applicable: boolean | null;
  inclusion_justification: string | null;
  exclusion_justification: string | null;
  implementation_status: 'not_started' | 'planned' | 'partially_implemented' | 'complete' | 'implemented' | 'not_applicable' | null;
  owner_user_id: string | null;
  status_note: string | null;
  holds_gate: Generated<boolean>;
  gate_reason: string | null;
  action_due_at: string | null;
  justification_holder_user_id: string | null;
  justification_due_at: string | null;
  completed_by_user_id: string | null;
  completed_at: string | null;
  verified_by_user_id: string | null;
  verified_at: string | null;
  last_evidence_at: string | null;
  freshness_status: 'fresh' | 'aging' | 'expired' | 'critical' | null;
  integrity_status: 'ok' | 'degraded' | 'broken' | null;
  derived_at: Date | null;
  position: Generated<number>;
}

/** `applicability_entry_risk` */
export interface ApplicabilityEntryRiskTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  applicability_entry_id: string;
  risk_id: string;
  position: Generated<number>;
}

/** `applicability_entry_document` */
export interface ApplicabilityEntryDocumentTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  applicability_entry_id: string;
  document_id: string;
  position: Generated<number>;
}

/** `operating_criteria` */
export interface OperatingCriteriaTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  applicability_entry_id: string;
  frequency_code: string;
  description: string | null;
}

/** `evidence` */
export interface EvidenceTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  evidence_code: string;
  title: string;
  owner_user_id: string | null;
  produced_at: string | null;
  storage_object_id: string | null;
  external_ref: string | null;
  frequency_code: string;
  classification: Generated<'public' | 'internal' | 'confidential' | 'restricted'>;
  next_due_override: string | null;
  file_sequence: Generated<number>;
  freshness_status: 'fresh' | 'aging' | 'expired' | 'critical' | null;
  integrity_status: 'ok' | 'degraded' | 'broken' | null;
  derived_at: Date | null;
  position: Generated<number>;
}

/** `evidence_target` */
export interface EvidenceTargetTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  evidence_id: string;
  management_system_id: string;
  applicability_entry_id: string;
  target_type: 'catalogue_item' | 'requirement';
  catalogue_item_id: string | null;
  requirement_id: string | null;
  mapping_note: string | null;
  position: Generated<number>;
}

/** `freshness_threshold` */
export interface FreshnessThresholdTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string | null;
  frequency_code: string;
  fresh_grace_days: Generated<string>;
  aging_factor: Generated<string>;
  expired_factor: Generated<string>;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantDocumentTables {
  document: DocumentTable;
  document_version: DocumentVersionTable;
  applicability_entry: ApplicabilityEntryTable;
  applicability_entry_risk: ApplicabilityEntryRiskTable;
  applicability_entry_document: ApplicabilityEntryDocumentTable;
  operating_criteria: OperatingCriteriaTable;
  evidence: EvidenceTable;
  evidence_target: EvidenceTargetTable;
  freshness_threshold: FreshnessThresholdTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantDocumentTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantDocumentTables>()({
  document: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'doc_code', 'title',
    'doc_type', 'status', 'classification', 'owner_user_id', 'approver_user_id', 'current_version_id', 'approved_at',
    'next_review_at', 'is_org_wide', 'pending_holder_user_id', 'pending_due_at', 'review_started_at', 'position',
  ],
  document_version: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'document_id',
    'version_label', 'storage_object_id', 'status', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at',
    'rejection_note',
  ],
  applicability_entry: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'target_type', 'catalogue_item_id', 'requirement_id', 'is_applicable',
    'inclusion_justification', 'exclusion_justification', 'implementation_status', 'owner_user_id', 'status_note',
    'holds_gate', 'gate_reason', 'action_due_at', 'justification_holder_user_id', 'justification_due_at',
    'completed_by_user_id', 'completed_at', 'verified_by_user_id', 'verified_at', 'last_evidence_at',
    'freshness_status', 'integrity_status', 'derived_at', 'position',
  ],
  applicability_entry_risk: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'applicability_entry_id', 'risk_id', 'position',
  ],
  applicability_entry_document: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'applicability_entry_id', 'document_id', 'position',
  ],
  operating_criteria: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'applicability_entry_id', 'frequency_code', 'description',
  ],
  evidence: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'evidence_code',
    'title', 'owner_user_id', 'produced_at', 'storage_object_id', 'external_ref', 'frequency_code', 'classification',
    'next_due_override', 'file_sequence', 'freshness_status', 'integrity_status', 'derived_at', 'position',
  ],
  evidence_target: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'evidence_id',
    'management_system_id', 'applicability_entry_id', 'target_type', 'catalogue_item_id', 'requirement_id',
    'mapping_note', 'position',
  ],
  freshness_threshold: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    'management_system_id', 'frequency_code', 'fresh_grace_days', 'aging_factor', 'expired_factor',
  ],
});
