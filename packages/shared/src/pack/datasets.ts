// Pack dataset files (E.8) and their row schemas. CSV row schemas take the record a CSV parser produces with the
// header row as keys (every value a string: an empty field means null, booleans are `true` or `false`, numbers are
// decimal integers) and output typed rows. Lengths follow the `ref` columns of C.5. JSON datasets are parsed as is.
import { z } from 'zod';
import {
  AuditEventType, ChainSource, ClauseGroup, DriftSeverity, DriftSourceKind, FindingClassification, MappingType,
} from '../enums.js';
import { named } from '../api/common.js';
import { PackId } from './manifest.js';

// ---------------------------------------------------------------------------------------------------------------
// CSV field helpers
// ---------------------------------------------------------------------------------------------------------------

const SMALLINT_MAX = 32767;
const INT_MAX = 2147483647;

/** Required text of at most `max` characters. */
function csvRequired(max: number) {
  return z.string().min(1).max(max);
}
/** Optional text: empty means null. */
function csvOptional(max?: number) {
  const base = max === undefined ? z.string() : z.string().max(max);
  return base.transform((v) => (v === '' ? null : v));
}
/** Text that may be empty (NOT NULL columns with an empty default, such as chain questions). */
function csvText(max?: number) {
  return max === undefined ? z.string() : z.string().max(max);
}
const csvBool = z.enum(['true', 'false']).transform((v) => v === 'true');
function csvInt(min: number, max: number) {
  return z.string().regex(/^-?\d+$/, { message: 'must be a decimal integer' }).transform(Number).pipe(z.int().min(min).max(max));
}
/** Optional JSON object: empty means null. */
const csvJsonObject = z.string().transform((v, ctx) => {
  if (v === '') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON object' });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
    return z.NEVER;
  }
});

const CODE_20 = csvRequired(20);
const CODE_30 = csvRequired(30);

/** Lookup code rule of `ref.lookup_value.code`. */
export const LOOKUP_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

// ---------------------------------------------------------------------------------------------------------------
// CSV datasets
// ---------------------------------------------------------------------------------------------------------------

export const RequirementRow = named(
  'RequirementRow',
  z.strictObject({
    requirement_code: CODE_20,
    parent_code: csvOptional(20),
    title_short: csvRequired(255),
    clause_group: ClauseGroup,
    is_hs_common: csvBool,
    documented_info_mandatory: csvBool,
    applicability_assessable: csvBool,
    default_frequency_code: csvOptional(20),
    evidence_example: csvOptional(),
    sort_order: csvInt(-INT_MAX, INT_MAX),
  }),
  'requirements.csv row (ref.requirement)',
  {
    valid: [{ requirement_code: '4.1', parent_code: '', title_short: 'Understanding the organization and its context', clause_group: '4', is_hs_common: 'true', documented_info_mandatory: 'false', applicability_assessable: 'false', default_frequency_code: '', evidence_example: '', sort_order: '1' }],
    invalid: [
      { requirement_code: '4.1', parent_code: '', title_short: 'x', clause_group: '11', is_hs_common: 'true', documented_info_mandatory: 'false', applicability_assessable: 'false', default_frequency_code: '', evidence_example: '', sort_order: '1' },
      { requirement_code: '4.1', parent_code: '', title_short: 'x', clause_group: '4', is_hs_common: 'yes', documented_info_mandatory: 'false', applicability_assessable: 'false', default_frequency_code: '', evidence_example: '', sort_order: '1' },
    ],
  },
);
export type RequirementRow = z.output<typeof RequirementRow>;

export const CatalogueRow = named(
  'CatalogueRow',
  z.strictObject({
    item_code: CODE_20,
    theme_code: CODE_20,
    title_short: csvRequired(255),
    requirement_code: csvOptional(20),
    default_frequency_code: csvOptional(20),
    evidence_example: csvOptional(),
    sort_order: csvInt(-INT_MAX, INT_MAX),
  }),
  'catalogue.csv row (ref.catalogue_item)',
  {
    valid: [{ item_code: 'A.5.1', theme_code: 'A.5', title_short: 'Policies for information security', requirement_code: '', default_frequency_code: 'annual', evidence_example: '', sort_order: '1' }],
    invalid: [{ item_code: '', theme_code: 'A.5', title_short: 'x', requirement_code: '', default_frequency_code: '', evidence_example: '', sort_order: '1' }, { item_code: 'A.5.1', theme_code: 'A.5', title_short: 'x', requirement_code: '', default_frequency_code: '', evidence_example: '', sort_order: 'one' }],
  },
);
export type CatalogueRow = z.output<typeof CatalogueRow>;

export const ChainRow = named(
  'ChainRow',
  z.strictObject({
    stage_key: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
    position: csvInt(0, SMALLINT_MAX),
    label_en: csvRequired(80),
    label_id: csvRequired(80),
    question_en: csvText(),
    question_id: csvText(),
    source: ChainSource,
    entity_type: csvOptional(40),
    risk_profile_code: csvOptional(30),
    is_mandatory: csvBool,
    clause_at_risk: csvOptional(20),
    overview_clause: csvInt(4, 10),
    gate_type_label_en: csvOptional(40),
    gate_type_label_id: csvOptional(40),
  }).refine((r) => r.source !== 'entity' || r.entity_type !== null, { message: 'entity stages need an entity_type', path: ['entity_type'] }),
  'chain.csv row (ref.traceability_chain_def)',
  {
    valid: [{ stage_key: 'risk', position: '2', label_en: 'Risk', label_id: 'Risiko', question_en: 'Show me how this risk was identified and assessed.', question_id: 'Tunjukkan bagaimana risiko ini diidentifikasi dan dinilai.', source: 'entity', entity_type: 'risk', risk_profile_code: 'information_security', is_mandatory: 'true', clause_at_risk: '6.1.2', overview_clause: '6', gate_type_label_en: 'Risk', gate_type_label_id: 'Risiko' }],
    invalid: [
      { stage_key: 'risk', position: '2', label_en: 'Risk', label_id: 'Risiko', question_en: '', question_id: '', source: 'entity', entity_type: '', risk_profile_code: '', is_mandatory: 'true', clause_at_risk: '', overview_clause: '6', gate_type_label_en: '', gate_type_label_id: '' },
      { stage_key: 'risk', position: '2', label_en: 'Risk', label_id: 'Risiko', question_en: '', question_id: '', source: 'entity', entity_type: 'risk', risk_profile_code: '', is_mandatory: 'true', clause_at_risk: '', overview_clause: '11', gate_type_label_en: '', gate_type_label_id: '' },
    ],
  },
);
export type ChainRow = z.output<typeof ChainRow>;

export const ActivityRow = named(
  'ActivityRow',
  z.strictObject({
    phase_no: csvInt(1, SMALLINT_MAX),
    phase_name_en: csvRequired(120),
    phase_name_id: csvRequired(120),
    is_gate_phase: csvBool,
    activity_no: csvInt(1, SMALLINT_MAX),
    title: csvRequired(255),
    clause_ref: csvOptional(20),
    output_document_code: csvOptional(30),
    expected_outcome: csvOptional(),
  }),
  'activities.csv row (ref.activity_template)',
  {
    valid: [{ phase_no: '1', phase_name_en: 'Initiation & mandate', phase_name_id: 'Inisiasi & mandat', is_gate_phase: 'false', activity_no: '1', title: 'Secure top management mandate', clause_ref: '', output_document_code: '', expected_outcome: 'Secure top management mandate: approved and recorded in the register' }],
    invalid: [{ phase_no: '0', phase_name_en: 'x', phase_name_id: 'x', is_gate_phase: 'false', activity_no: '1', title: 'x', clause_ref: '', output_document_code: '', expected_outcome: '' }],
  },
);
export type ActivityRow = z.output<typeof ActivityRow>;

export const FrequencyRow = named(
  'FrequencyRow',
  z.strictObject({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
    label_en: csvRequired(40),
    label_id: csvRequired(40),
    period_days: csvInt(0, INT_MAX),
    sort_order: csvInt(-SMALLINT_MAX, SMALLINT_MAX),
  }),
  'frequencies.csv row (ref.evidence_frequency_rule)',
  {
    valid: [{ code: 'monthly', label_en: 'Monthly', label_id: 'Bulanan', period_days: '30', sort_order: '3' }],
    invalid: [{ code: 'Monthly', label_en: 'Monthly', label_id: 'Bulanan', period_days: '30', sort_order: '3' }, { code: 'monthly', label_en: 'Monthly', label_id: 'Bulanan', period_days: '-1', sort_order: '3' }],
  },
);
export type FrequencyRow = z.output<typeof FrequencyRow>;

export const CycleRequirementRow = named(
  'CycleRequirementRow',
  z.strictObject({
    code: CODE_30,
    requirement_code: csvOptional(20),
    title: csvRequired(255),
    derivation: csvJsonObject,
    sort_order: csvInt(-SMALLINT_MAX, SMALLINT_MAX),
  }),
  'cycle_requirements.csv row (ref.cycle_requirement_def); derivation is a JSON object with a kind (E.2 cycle.derive), or empty',
  {
    valid: [
      { code: 'RISK_ASSESSMENT', requirement_code: '6.1.2', title: 'Risk assessment reviewed this cycle', derivation: '', sort_order: '1' },
      { code: 'MGMT_REVIEW', requirement_code: '9.3', title: 'Management review', derivation: '{"kind":"management_review_closed"}', sort_order: '2' },
    ],
    invalid: [{ code: 'X', requirement_code: '', title: 'x', derivation: '[1]', sort_order: '1' }, { code: 'X', requirement_code: '', title: 'x', derivation: '{bad', sort_order: '1' }],
  },
);
export type CycleRequirementRow = z.output<typeof CycleRequirementRow>;

export const PrepTaskRow = named(
  'PrepTaskRow',
  z.strictObject({
    code: CODE_30,
    title: csvRequired(255),
    days_before_audit: csvInt(1, SMALLINT_MAX),
    skip_on_first_audit: csvBool,
    sort_order: csvInt(-SMALLINT_MAX, SMALLINT_MAX),
  }),
  'prep_tasks.csv row (ref.prep_task_template)',
  {
    valid: [{ code: 'PREP-01', title: 'Confirm audit plan and auditee schedule with certifier', days_before_audit: '33', skip_on_first_audit: 'false', sort_order: '1' }],
    invalid: [{ code: 'PREP-01', title: 'x', days_before_audit: '0', skip_on_first_audit: 'false', sort_order: '1' }],
  },
);
export type PrepTaskRow = z.output<typeof PrepTaskRow>;

export const ReviewInputRow = named(
  'ReviewInputRow',
  z.strictObject({ code: CODE_30, title: csvRequired(255), mandatory: csvBool, sort_order: csvInt(-SMALLINT_MAX, SMALLINT_MAX) }),
  'review_inputs.csv row (ref.review_input_def)',
  {
    valid: [{ code: 'MRI-01', title: 'Status of actions from previous management reviews', mandatory: 'true', sort_order: '1' }],
    invalid: [{ code: 'MRI-01', title: 'x', mandatory: 'TRUE', sort_order: '1' }],
  },
);
export type ReviewInputRow = z.output<typeof ReviewInputRow>;

export const FindingConditionRow = named(
  'FindingConditionRow',
  z.strictObject({ code: CODE_30, classification: FindingClassification, requirement_code: csvOptional(20), text: z.string().min(1) }),
  'finding_conditions.csv row (ref.finding_condition)',
  {
    valid: [{ code: 'FC-01', classification: 'major', requirement_code: '8.2', text: 'No information security risk assessment performed for the scope' }],
    invalid: [{ code: 'FC-01', classification: 'Major', requirement_code: '', text: 'x' }, { code: 'FC-01', classification: 'major', requirement_code: '', text: '' }],
  },
);
export type FindingConditionRow = z.output<typeof FindingConditionRow>;

export const DocumentTemplateRow = named(
  'DocumentTemplateRow',
  z.strictObject({ code: CODE_30, title: csvRequired(255), doc_type: csvRequired(20) }),
  'document_templates.csv row (ref.document_template)',
  {
    valid: [{ code: 'TPL-POL', title: 'Information security policy', doc_type: 'policy' }],
    invalid: [{ code: 'TPL-POL', title: 'x', doc_type: '' }],
  },
);
export type DocumentTemplateRow = z.output<typeof DocumentTemplateRow>;

export const AuditActivityRow = named(
  'AuditActivityRow',
  z.strictObject({
    code: CODE_30,
    event_type: AuditEventType,
    clause_ref: csvOptional(40),
    title: csvRequired(255),
    auditee_role: csvOptional(40),
    key_questions: csvOptional(),
    evidence_to_request: csvOptional(),
    sort_order: csvInt(-SMALLINT_MAX, SMALLINT_MAX),
  }),
  'audit_activities.csv row (ref.audit_activity_template)',
  {
    valid: [{ code: 'AA-S1-01', event_type: 'stage1', clause_ref: '4.3', title: 'Review ISMS scope and context', auditee_role: 'ISMS Manager', key_questions: 'Are the scope, boundaries and interfaces documented?', evidence_to_request: 'Scope statement', sort_order: '1' }],
    invalid: [{ code: 'AA-S1-01', event_type: 'stage3', clause_ref: '', title: 'x', auditee_role: '', key_questions: '', evidence_to_request: '', sort_order: '1' }],
  },
);
export type AuditActivityRow = z.output<typeof AuditActivityRow>;

export const LookupRow = named(
  'LookupRow',
  z.strictObject({
    domain: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    code: z.string().regex(LOOKUP_CODE_RE),
    label_en: csvRequired(120),
    label_id: csvRequired(120),
    sort_order: csvInt(-SMALLINT_MAX, SMALLINT_MAX),
  }),
  'lookups.csv row (ref.lookup_value)',
  {
    valid: [{ domain: 'doc_type', code: 'policy', label_en: 'Policy', label_id: 'Kebijakan', sort_order: '1' }],
    invalid: [{ domain: 'doc_type', code: 'Policy', label_en: 'Policy', label_id: 'Kebijakan', sort_order: '1' }, { domain: 'doc type', code: 'policy', label_en: 'Policy', label_id: 'Kebijakan', sort_order: '1' }],
  },
);
export type LookupRow = z.output<typeof LookupRow>;

export const MappingRow = named(
  'MappingRow',
  z.strictObject({
    source_code: CODE_20,
    target_pack_id: PackId,
    target_code: CODE_20,
    mapping_type: MappingType,
    evidence_reusable: csvBool,
    note: csvOptional(),
  }),
  'mappings/<target>.csv row (ref.requirement_mapping)',
  {
    valid: [{ source_code: '6.1', target_pack_id: 'ISO9001-2015', target_code: '6.1', mapping_type: 'equivalent', evidence_reusable: 'true', note: '' }],
    invalid: [{ source_code: '6.1', target_pack_id: 'ISO9001-2015', target_code: '6.1', mapping_type: 'same', evidence_reusable: 'true', note: '' }],
  },
);
export type MappingRow = z.output<typeof MappingRow>;

// ---------------------------------------------------------------------------------------------------------------
// JSON datasets
// ---------------------------------------------------------------------------------------------------------------

/** Label keys every pack carries in both languages (E.8); catalogue packs add `catalogue.theme.<n>`. */
export const REQUIRED_LABEL_KEYS = [
  'ms.name', 'ms.long_name', 'ms.manager_role', 'gate.name', 'applicability.artefact_name', 'risk.object_name',
] as const;

export const PackLabels = named(
  'PackLabels',
  z.record(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/), z.string()).refine(
    (labels) => REQUIRED_LABEL_KEYS.every((k) => typeof labels[k] === 'string' && labels[k] !== ''),
    { message: `labels must define ${REQUIRED_LABEL_KEYS.join(', ')}` },
  ),
  'labels.en.json or labels.id.json: flat key to text (E.8, ref.label)',
  {
    valid: [{ 'ms.name': 'ISMS', 'ms.long_name': 'Information security management system', 'ms.manager_role': 'ISMS Manager', 'gate.name': 'Risk & SoA', 'applicability.artefact_name': 'Statement of Applicability', 'risk.object_name': 'Information security risk', 'catalogue.theme.5': 'Organizational' }],
    invalid: [{ 'ms.name': 'ISMS' }, { 'MS.NAME': 'x' }],
  },
);
export type PackLabels = z.output<typeof PackLabels>;

export const DriftRuleDef = named(
  'DriftRuleDef',
  z.strictObject({
    code: z.string().min(1).max(30),
    label_en: z.string().min(1).max(150),
    label_id: z.string().min(1).max(150),
    severity: DriftSeverity,
    source_stage: z.string().max(20).nullable().optional(),
    source_kind: DriftSourceKind,
    predicate: z.record(z.string(), z.unknown()),
    message: z.string().min(1),
    sort_order: z.int().min(-SMALLINT_MAX).max(SMALLINT_MAX),
  }),
  'One drift_rules.json entry (ref.drift_rule_def)',
  {
    valid: [{ code: 'risk12', label_en: 'Risks not reassessed in 12 months', label_id: 'Risiko tidak dinilai ulang 12 bulan', severity: 'risk', source_stage: 'risk', source_kind: 'stale_risk', predicate: { months: 12 }, message: 'Reassess them.', sort_order: 1 }],
    invalid: [{ code: 'risk12', label_en: 'x', label_id: 'x', severity: 'high', source_kind: 'stale_risk', predicate: {}, message: 'x', sort_order: 1 }, { code: 'risk12', label_en: 'x', label_id: 'x', severity: 'risk', source_kind: 'rows', predicate: {}, message: 'x', sort_order: 1 }],
  },
);
export type DriftRuleDef = z.output<typeof DriftRuleDef>;

export const DriftRulesFile = named('DriftRulesFile', z.array(DriftRuleDef), 'drift_rules.json', {
  valid: [[], [{ code: 'mr', label_en: 'Management review inputs missing', label_id: 'Input tinjauan manajemen hilang', severity: 'risk', source_stage: 'management_review', source_kind: 'manual', predicate: {}, message: 'Prepare them.', sort_order: 4 }]],
  invalid: [{}, [{ code: 'x' }]],
});

export const RuleActivation = named(
  'RuleActivation',
  z.strictObject({ rule_id: z.string().regex(/^BR-[0-9]{2}$/), active: z.boolean(), params: z.record(z.string(), z.unknown()) }),
  'One rules.json entry (ref.rule_activation); BR-03 carries {phrases: {en, id}} in params',
  {
    valid: [{ rule_id: 'BR-01', active: true, params: {} }, { rule_id: 'BR-03', active: true, params: { phrases: { en: ['n/a', 'tbd'], id: ['t/a'] } } }],
    invalid: [{ rule_id: 'BR-1', active: true, params: {} }, { rule_id: 'LIC-MS', active: true, params: {} }, { rule_id: 'BR-01', active: 'yes', params: {} }],
  },
);
export type RuleActivation = z.output<typeof RuleActivation>;

export const RulesFile = named('RulesFile', z.array(RuleActivation), 'rules.json', {
  valid: [[{ rule_id: 'BR-01', active: true, params: {} }]],
  invalid: [{ rule_id: 'BR-01' }],
});

export const RiskProfileDef = named(
  'RiskProfileDef',
  z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), definition: z.record(z.string(), z.unknown()) }),
  'One risk_profiles.json entry (ref.risk_profile); the definition format is open (A-33)',
  {
    valid: [{ code: 'information_security', definition: { label_en: 'Information security risk', likelihood_scale: { min: 1, max: 5 } } }],
    invalid: [{ code: 'Information Security', definition: {} }, { code: 'x', definition: [] }],
  },
);
export type RiskProfileDef = z.output<typeof RiskProfileDef>;

export const RiskProfilesFile = named('RiskProfilesFile', z.array(RiskProfileDef), 'risk_profiles.json', {
  valid: [[], [{ code: 'bribery', definition: {} }]],
  invalid: [[{ code: 'bribery' }]],
});

// ---------------------------------------------------------------------------------------------------------------
// File table
// ---------------------------------------------------------------------------------------------------------------

/** CSV header row of every CSV dataset (E.8), in column order. */
export const PACK_CSV_HEADERS = {
  'requirements.csv': ['requirement_code', 'parent_code', 'title_short', 'clause_group', 'is_hs_common', 'documented_info_mandatory', 'applicability_assessable', 'default_frequency_code', 'evidence_example', 'sort_order'],
  'catalogue.csv': ['item_code', 'theme_code', 'title_short', 'requirement_code', 'default_frequency_code', 'evidence_example', 'sort_order'],
  'chain.csv': ['stage_key', 'position', 'label_en', 'label_id', 'question_en', 'question_id', 'source', 'entity_type', 'risk_profile_code', 'is_mandatory', 'clause_at_risk', 'overview_clause', 'gate_type_label_en', 'gate_type_label_id'],
  'activities.csv': ['phase_no', 'phase_name_en', 'phase_name_id', 'is_gate_phase', 'activity_no', 'title', 'clause_ref', 'output_document_code', 'expected_outcome'],
  'frequencies.csv': ['code', 'label_en', 'label_id', 'period_days', 'sort_order'],
  'cycle_requirements.csv': ['code', 'requirement_code', 'title', 'derivation', 'sort_order'],
  'prep_tasks.csv': ['code', 'title', 'days_before_audit', 'skip_on_first_audit', 'sort_order'],
  'review_inputs.csv': ['code', 'title', 'mandatory', 'sort_order'],
  'finding_conditions.csv': ['code', 'classification', 'requirement_code', 'text'],
  'document_templates.csv': ['code', 'title', 'doc_type'],
  'audit_activities.csv': ['code', 'event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions', 'evidence_to_request', 'sort_order'],
  'lookups.csv': ['domain', 'code', 'label_en', 'label_id', 'sort_order'],
} as const;
export type PackCsvFile = keyof typeof PACK_CSV_HEADERS;

/** Header of every `mappings/<target>.csv` file. */
export const MAPPING_CSV_HEADER = ['source_code', 'target_pack_id', 'target_code', 'mapping_type', 'evidence_reusable', 'note'] as const;

/** Row schema of every CSV dataset. */
export const PACK_CSV_ROW_SCHEMAS = {
  'requirements.csv': RequirementRow,
  'catalogue.csv': CatalogueRow,
  'chain.csv': ChainRow,
  'activities.csv': ActivityRow,
  'frequencies.csv': FrequencyRow,
  'cycle_requirements.csv': CycleRequirementRow,
  'prep_tasks.csv': PrepTaskRow,
  'review_inputs.csv': ReviewInputRow,
  'finding_conditions.csv': FindingConditionRow,
  'document_templates.csv': DocumentTemplateRow,
  'audit_activities.csv': AuditActivityRow,
  'lookups.csv': LookupRow,
} as const satisfies Record<PackCsvFile, z.ZodType>;

/** Schema of every JSON dataset (the parsed file). */
export const PACK_JSON_SCHEMAS = {
  'labels.en.json': PackLabels,
  'labels.id.json': PackLabels,
  'drift_rules.json': DriftRulesFile,
  'rules.json': RulesFile,
  'risk_profiles.json': RiskProfilesFile,
} as const;
export type PackJsonFile = keyof typeof PACK_JSON_SCHEMAS;

/** Lookup domains every pack carries (E.8). */
export const REQUIRED_LOOKUP_DOMAINS = ['doc_type', 'treatment_option'] as const;
