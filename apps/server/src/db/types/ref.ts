// Kysely row types of the reference tables (migrations/ref/0001_framework_content.sql, build plan C.5).
// Hand-maintained (C.7): a migration that adds or changes these tables updates this file in the same change;
// test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database and fails on any difference.
// Conventions: columns with a database default are Generated<T>, columns only a trigger writes are
// GeneratedAlways<T>; timestamptz is Date; date is a 'YYYY-MM-DD' string; bigint and numeric are strings; jsonb is
// read parsed and written as a JSON string; CHECK-listed values are string literal unions.
import type { Generated } from 'kysely';
import { tableColumns, type GeneratedJson, type Json, type NullableJson } from './index';

/** `ref.framework` */
export interface FrameworkTable {
  id: Generated<string>;
  code: string;
  name: string;
  created_at: Generated<Date>;
}

/** `ref.framework_version` */
export interface FrameworkVersionTable {
  id: Generated<string>;
  framework_id: string;
  edition: string;
  pack_id: string;
  pack_version: string;
  status: 'current' | 'transition' | 'withdrawn';
  pre_release: Generated<boolean>;
  transition_ends_at: string | null;
  supersedes_version_id: string | null;
  applicability_target: 'catalogue_item' | 'requirement';
  pack_checksum: string;
  manifest: Json;
  installed_at: Generated<Date>;
}

/** `ref.requirement` */
export interface RequirementTable {
  id: Generated<string>;
  framework_version_id: string;
  requirement_code: string;
  parent_id: string | null;
  title_short: string;
  clause_group: '4' | '5' | '6' | '7' | '8' | '9' | '10';
  is_hs_common: Generated<boolean>;
  documented_info_mandatory: Generated<boolean>;
  applicability_assessable: Generated<boolean>;
  default_frequency_code: string | null;
  evidence_example: string | null;
  sort_order: number;
}

/** `ref.catalogue_item` */
export interface CatalogueItemTable {
  id: Generated<string>;
  framework_version_id: string;
  item_code: string;
  theme_code: string;
  title_short: string;
  requirement_id: string | null;
  flags: GeneratedJson;
  default_frequency_code: string | null;
  evidence_example: string | null;
  sort_order: number;
}

/** `ref.requirement_mapping` */
export interface RequirementMappingTable {
  id: Generated<string>;
  source_requirement_id: string;
  target_requirement_id: string;
  mapping_type: 'equivalent' | 'partial' | 'related' | 'split' | 'merged' | 'changed' | 'new' | 'removed';
  evidence_reusable: Generated<boolean>;
  note: string | null;
}

/** `ref.traceability_chain_def` */
export interface TraceabilityChainDefTable {
  id: Generated<string>;
  framework_version_id: string;
  stage_key: string;
  position: number;
  label_en: string;
  label_id: string;
  auditor_question_en: Generated<string>;
  auditor_question_id: Generated<string>;
  source: 'entity' | 'applicability' | 'justification' | 'document' | 'evidence';
  entity_type: string | null;
  risk_profile_code: string | null;
  is_mandatory: Generated<boolean>;
  clause_at_risk: string | null;
  overview_clause: number;
  gate_type_label_en: string | null;
  gate_type_label_id: string | null;
}

/** `ref.activity_template` */
export interface ActivityTemplateTable {
  id: Generated<string>;
  framework_version_id: string;
  phase_no: number;
  phase_name_en: string;
  phase_name_id: string;
  is_gate_phase: Generated<boolean>;
  activity_no: number;
  title: string;
  clause_ref: string | null;
  output_document_code: string | null;
  expected_outcome: string | null;
}

/** `ref.evidence_frequency_rule` */
export interface EvidenceFrequencyRuleTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  label_en: string;
  label_id: string;
  period_days: number;
  sort_order: number;
}

/** `ref.label` */
export interface LabelTable {
  id: Generated<string>;
  framework_version_id: string;
  key: string;
  lang: 'en' | 'id';
  value: string;
}

/** `ref.cycle_requirement_def` */
export interface CycleRequirementDefTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  requirement_code: string | null;
  title: string;
  derivation: NullableJson;
  sort_order: Generated<number>;
}

/** `ref.drift_rule_def` */
export interface DriftRuleDefTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  label_en: string;
  label_id: string;
  severity: 'crit' | 'risk' | 'warn';
  source_stage: string | null;
  source_kind: 'manual' | 'unverif' | 'nohash' | 'metric' | 'exercise' | 'stale_risk' | 'dd_expired';
  predicate: GeneratedJson;
  message: string;
  sort_order: Generated<number>;
}

/** `ref.prep_task_template` */
export interface PrepTaskTemplateTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  title: string;
  days_before_audit: number;
  skip_on_first_audit: Generated<boolean>;
  sort_order: Generated<number>;
}

/** `ref.review_input_def` */
export interface ReviewInputDefTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  title: string;
  mandatory: Generated<boolean>;
  sort_order: Generated<number>;
}

/** `ref.finding_condition` */
export interface FindingConditionTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  classification: 'major' | 'minor' | 'ofi' | 'signal' | 'not_a_finding';
  requirement_code: string | null;
  text: string;
}

/** `ref.document_template` */
export interface DocumentTemplateTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  title: string;
  doc_type: string;
}

/** `ref.audit_activity_template` */
export interface AuditActivityTemplateTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  event_type: 'stage1' | 'stage2' | 'surveillance' | 'recertification' | 'transition' | 'special';
  clause_ref: string | null;
  title: string;
  auditee_role: string | null;
  key_questions: string | null;
  evidence_to_request: string | null;
  sort_order: Generated<number>;
}

/** `ref.lookup_value` */
export interface LookupValueTable {
  id: Generated<string>;
  framework_version_id: string;
  domain: string;
  code: string;
  label_en: string;
  label_id: string;
  sort_order: Generated<number>;
}

/** `ref.rule_activation` */
export interface RuleActivationTable {
  id: Generated<string>;
  framework_version_id: string;
  rule_id: string;
  active: Generated<boolean>;
  params: GeneratedJson;
}

/** `ref.risk_profile` */
export interface RiskProfileTable {
  id: Generated<string>;
  framework_version_id: string;
  code: string;
  definition: Json;
}

/** Tables of this group as Kysely table keys. */
export interface RefTables {
  'ref.framework': FrameworkTable;
  'ref.framework_version': FrameworkVersionTable;
  'ref.requirement': RequirementTable;
  'ref.catalogue_item': CatalogueItemTable;
  'ref.requirement_mapping': RequirementMappingTable;
  'ref.traceability_chain_def': TraceabilityChainDefTable;
  'ref.activity_template': ActivityTemplateTable;
  'ref.evidence_frequency_rule': EvidenceFrequencyRuleTable;
  'ref.label': LabelTable;
  'ref.cycle_requirement_def': CycleRequirementDefTable;
  'ref.drift_rule_def': DriftRuleDefTable;
  'ref.prep_task_template': PrepTaskTemplateTable;
  'ref.review_input_def': ReviewInputDefTable;
  'ref.finding_condition': FindingConditionTable;
  'ref.document_template': DocumentTemplateTable;
  'ref.audit_activity_template': AuditActivityTemplateTable;
  'ref.lookup_value': LookupValueTable;
  'ref.rule_activation': RuleActivationTable;
  'ref.risk_profile': RiskProfileTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends RefTables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<RefTables>()({
  'ref.framework': ['id', 'code', 'name', 'created_at'],
  'ref.framework_version': [
    'id', 'framework_id', 'edition', 'pack_id', 'pack_version', 'status', 'pre_release', 'transition_ends_at',
    'supersedes_version_id', 'applicability_target', 'pack_checksum', 'manifest', 'installed_at',
  ],
  'ref.requirement': [
    'id', 'framework_version_id', 'requirement_code', 'parent_id', 'title_short', 'clause_group', 'is_hs_common',
    'documented_info_mandatory', 'applicability_assessable', 'default_frequency_code', 'evidence_example', 'sort_order',
  ],
  'ref.catalogue_item': [
    'id', 'framework_version_id', 'item_code', 'theme_code', 'title_short', 'requirement_id', 'flags',
    'default_frequency_code', 'evidence_example', 'sort_order',
  ],
  'ref.requirement_mapping': [
    'id', 'source_requirement_id', 'target_requirement_id', 'mapping_type', 'evidence_reusable', 'note',
  ],
  'ref.traceability_chain_def': [
    'id', 'framework_version_id', 'stage_key', 'position', 'label_en', 'label_id', 'auditor_question_en',
    'auditor_question_id', 'source', 'entity_type', 'risk_profile_code', 'is_mandatory', 'clause_at_risk',
    'overview_clause', 'gate_type_label_en', 'gate_type_label_id',
  ],
  'ref.activity_template': [
    'id', 'framework_version_id', 'phase_no', 'phase_name_en', 'phase_name_id', 'is_gate_phase', 'activity_no', 'title',
    'clause_ref', 'output_document_code', 'expected_outcome',
  ],
  'ref.evidence_frequency_rule': [
    'id', 'framework_version_id', 'code', 'label_en', 'label_id', 'period_days', 'sort_order',
  ],
  'ref.label': ['id', 'framework_version_id', 'key', 'lang', 'value'],
  'ref.cycle_requirement_def': [
    'id', 'framework_version_id', 'code', 'requirement_code', 'title', 'derivation', 'sort_order',
  ],
  'ref.drift_rule_def': [
    'id', 'framework_version_id', 'code', 'label_en', 'label_id', 'severity', 'source_stage', 'source_kind',
    'predicate', 'message', 'sort_order',
  ],
  'ref.prep_task_template': [
    'id', 'framework_version_id', 'code', 'title', 'days_before_audit', 'skip_on_first_audit', 'sort_order',
  ],
  'ref.review_input_def': ['id', 'framework_version_id', 'code', 'title', 'mandatory', 'sort_order'],
  'ref.finding_condition': ['id', 'framework_version_id', 'code', 'classification', 'requirement_code', 'text'],
  'ref.document_template': ['id', 'framework_version_id', 'code', 'title', 'doc_type'],
  'ref.audit_activity_template': [
    'id', 'framework_version_id', 'code', 'event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions',
    'evidence_to_request', 'sort_order',
  ],
  'ref.lookup_value': ['id', 'framework_version_id', 'domain', 'code', 'label_en', 'label_id', 'sort_order'],
  'ref.rule_activation': ['id', 'framework_version_id', 'rule_id', 'active', 'params'],
  'ref.risk_profile': ['id', 'framework_version_id', 'code', 'definition'],
});
