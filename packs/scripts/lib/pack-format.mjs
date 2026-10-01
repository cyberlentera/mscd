// Pack source file format (BUILD-PLAN E.8): the dataset files of a pack source folder,
// their CSV headers, and the CSV and JSON encoding rules shared by extract-from-sample.mjs
// and validate-sources.mjs.
//
// Encoding: UTF-8 without a byte order mark, LF line endings, a final newline.
// CSV: a header row, then one row per record; fields are quoted per RFC 4180 when they hold
// a comma, a double quote or a line break (inner quotes doubled). Booleans are `true` or
// `false`; an empty field means null. JSON: pretty-printed with two spaces.

/** CSV datasets of a pack source folder and their header rows, in E.8 order. */
export const CSV_HEADERS = Object.freeze({
  'requirements.csv': [
    'requirement_code', 'parent_code', 'title_short', 'clause_group', 'is_hs_common',
    'documented_info_mandatory', 'applicability_assessable', 'default_frequency_code',
    'evidence_example', 'sort_order',
  ],
  'catalogue.csv': [
    'item_code', 'theme_code', 'title_short', 'requirement_code', 'default_frequency_code',
    'evidence_example', 'sort_order',
  ],
  'chain.csv': [
    'stage_key', 'position', 'label_en', 'label_id', 'question_en', 'question_id', 'source',
    'entity_type', 'risk_profile_code', 'is_mandatory', 'clause_at_risk', 'overview_clause',
    'gate_type_label_en', 'gate_type_label_id',
  ],
  'activities.csv': [
    'phase_no', 'phase_name_en', 'phase_name_id', 'is_gate_phase', 'activity_no', 'title',
    'clause_ref', 'output_document_code', 'expected_outcome',
  ],
  'frequencies.csv': ['code', 'label_en', 'label_id', 'period_days', 'sort_order'],
  'cycle_requirements.csv': ['code', 'requirement_code', 'title', 'derivation', 'sort_order'],
  'prep_tasks.csv': ['code', 'title', 'days_before_audit', 'skip_on_first_audit', 'sort_order'],
  'review_inputs.csv': ['code', 'title', 'mandatory', 'sort_order'],
  'finding_conditions.csv': ['code', 'classification', 'requirement_code', 'text'],
  'document_templates.csv': ['code', 'title', 'doc_type'],
  'audit_activities.csv': [
    'code', 'event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions',
    'evidence_to_request', 'sort_order',
  ],
  'lookups.csv': ['domain', 'code', 'label_en', 'label_id', 'sort_order'],
});

/** Header of every optional `mappings/<target>.csv` file. */
export const MAPPING_HEADER = Object.freeze([
  'source_code', 'target_pack_id', 'target_code', 'mapping_type', 'evidence_reusable', 'note',
]);

/** JSON files of a pack source folder. */
export const JSON_FILES = Object.freeze([
  'manifest.json', 'labels.en.json', 'labels.id.json', 'drift_rules.json', 'rules.json',
  'risk_profiles.json',
]);

/** Every file a pack source folder must hold (the optional `mappings/` folder aside). */
export const REQUIRED_FILES = Object.freeze([
  'manifest.json',
  'requirements.csv',
  'catalogue.csv',
  'chain.csv',
  'activities.csv',
  'frequencies.csv',
  'labels.en.json',
  'labels.id.json',
  'cycle_requirements.csv',
  'drift_rules.json',
  'prep_tasks.csv',
  'review_inputs.csv',
  'finding_conditions.csv',
  'document_templates.csv',
  'audit_activities.csv',
  'lookups.csv',
  'rules.json',
  'risk_profiles.json',
]);

/** Label keys every pack carries in both languages (E.8); themes add `catalogue.theme.<n>`. */
export const REQUIRED_LABEL_KEYS = Object.freeze([
  'ms.name', 'ms.long_name', 'ms.manager_role', 'gate.name', 'applicability.artefact_name',
  'risk.object_name',
]);

/** Allowed values (C.5, C.9, C.10, E.8). */
export const ALLOWED = Object.freeze({
  packStatus: ['current', 'transition', 'withdrawn'],
  applicabilityTarget: ['catalogue_item', 'requirement'],
  chainSource: ['entity', 'applicability', 'justification', 'document', 'evidence'],
  // Tables that hold chain records (C.9 "Chain records", C.10).
  chainEntityType: [
    'context_issue', 'risk', 'risk_treatment', 'metric', 'quality_objective',
    'prioritized_activity', 'business_impact_analysis', 'exercise', 'business_associate',
    'chain_record',
  ],
  driftSeverity: ['crit', 'risk', 'warn'],
  driftSourceKind: ['manual', 'stale_risk', 'dd_expired', 'metric', 'exercise', 'unverif', 'nohash'],
  auditEventType: ['stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special'],
  findingClassification: ['major', 'minor', 'ofi', 'signal', 'not_a_finding'],
  mappingType: ['equivalent', 'partial', 'related', 'split', 'merged', 'changed', 'new', 'removed'],
  clauseGroup: ['4', '5', '6', '7', '8', '9', '10'],
  // Lookup domains every pack must carry (E.8).
  requiredLookupDomains: ['doc_type', 'treatment_option'],
});

export const LOOKUP_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const RULE_ID_RE = /^BR-[0-9]{2}$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Formats one CSV field: null and undefined become empty, booleans `true` or `false`. */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/**
 * Serialises records (objects keyed by header names) to CSV text with a header row.
 * A key that is not in the header is a programming error and throws.
 */
export function toCsv(header, records) {
  const known = new Set(header);
  const lines = [header.join(',')];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw new Error(`CSV column "${key}" is not in the header ${header.join(',')}`);
    }
    lines.push(header.map((h) => csvField(record[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Serialises a JSON value pretty-printed with two spaces and a final newline. */
export function toJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Parses RFC 4180 CSV text with LF line endings into an array of records (arrays of
 * strings). Throws an Error naming the line on a carriage return, a stray quote or an
 * unterminated quoted field.
 */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let atFieldStart = true;
  let inQuotes = false;
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        if (i < n && text[i] !== ',' && text[i] !== '\n') {
          throw new Error(`line ${line}: unexpected character after a closing quote`);
        }
        continue;
      }
      if (c === '\r') throw new Error(`line ${line}: carriage return found (LF line endings only)`);
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (!atFieldStart) throw new Error(`line ${line}: quote inside an unquoted field`);
      inQuotes = true;
      atFieldStart = false;
      i += 1;
      continue;
    }
    if (c === ',') {
      record.push(field);
      field = '';
      atFieldStart = true;
      i += 1;
      continue;
    }
    if (c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
      line += 1;
      i += 1;
      continue;
    }
    if (c === '\r') throw new Error(`line ${line}: carriage return found (LF line endings only)`);
    field += c;
    atFieldStart = false;
    i += 1;
  }
  if (inQuotes) throw new Error(`line ${line}: unterminated quoted field`);
  if (!atFieldStart || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Compares clause or control codes segment by segment (`8.2` before `8.10`, `A.5.9` before `A.5.10`). */
export function compareCodes(a, b) {
  const sa = String(a).split('.');
  const sb = String(b).split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    const na = Number(sa[i]);
    const nb = Number(sb[i]);
    const bothNumeric = sa[i] !== '' && sb[i] !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
    const d = bothNumeric ? na - nb : sa[i].localeCompare(sb[i]);
    if (d !== 0) return d;
  }
  return 0;
}
