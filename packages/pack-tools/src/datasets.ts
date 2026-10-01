// Dataset validation for pack sources and pack archives (E.8): every file of the dataset set, the exact CSV
// headers, every row and JSON document against the schemas of `@mscd/shared`, and the references between
// datasets that a pack can check on its own (codes unique, catalogue and finding conditions to requirements,
// frequencies, labels in both languages, lookups, risk profiles, phases). References to tables outside the pack
// (chain entity types, engine version, installed versions) are checked by the server's pack installer.
import type { z } from 'zod';
import {
  MAPPING_CSV_HEADER, MAPPING_FILE_RE, MappingRow, PACK_CSV_HEADERS, PACK_CSV_ROW_SCHEMAS, PACK_DATASET_FILES, PACK_JSON_SCHEMAS,
  REQUIRED_LOOKUP_DOMAINS,
  type ActivityRow, type AuditActivityRow, type CatalogueRow, type ChainRow, type CycleRequirementRow, type DocumentTemplateRow,
  type DriftRuleDef, type FindingConditionRow, type FrequencyRow, type LookupRow, type PackCsvFile, type PackJsonFile, type PackLabels,
  type PackSourceManifest, type PrepTaskRow, type RequirementRow, type ReviewInputRow, type RiskProfileDef, type RuleActivation,
} from '@mscd/shared';
import { decodeDatasetText, parseCsvRecords } from './csv.js';
import { PackError } from './errors.js';

/** Every dataset of a pack, typed as the schemas of `@mscd/shared` output them. */
export interface PackDatasets {
  readonly requirements: readonly RequirementRow[];
  readonly catalogue: readonly CatalogueRow[];
  readonly chain: readonly ChainRow[];
  readonly activities: readonly ActivityRow[];
  readonly frequencies: readonly FrequencyRow[];
  readonly labels: { readonly en: PackLabels; readonly id: PackLabels };
  readonly cycleRequirements: readonly CycleRequirementRow[];
  readonly driftRules: readonly DriftRuleDef[];
  readonly prepTasks: readonly PrepTaskRow[];
  readonly reviewInputs: readonly ReviewInputRow[];
  readonly findingConditions: readonly FindingConditionRow[];
  readonly documentTemplates: readonly DocumentTemplateRow[];
  readonly auditActivities: readonly AuditActivityRow[];
  readonly lookups: readonly LookupRow[];
  readonly rules: readonly RuleActivation[];
  readonly riskProfiles: readonly RiskProfileDef[];
  /** Rows of each `mappings/<target>.csv` file, keyed by the file name. */
  readonly mappings: Readonly<Record<string, readonly MappingRow[]>>;
}

/** The manifest fields the dataset checks need (a source manifest or a built manifest). */
export type DatasetManifestFields = Pick<PackSourceManifest, 'pack_id' | 'edition' | 'catalogue' | 'applicability_target' | 'supersedes'>;

const ISSUE_LIMIT = 500;

class Issues {
  readonly list: string[] = [];

  add(where: string, message: string): void {
    if (this.list.length < ISSUE_LIMIT) this.list.push(`${where}: ${message}`);
  }
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

function text(name: string, bytes: Buffer, issues: Issues): string | undefined {
  try {
    return decodeDatasetText(bytes);
  } catch (error) {
    issues.add(name, (error as Error).message);
    return undefined;
  }
}

function csvDataset<T>(name: string, bytes: Buffer | undefined, header: readonly string[], schema: z.ZodType<T>, issues: Issues): T[] {
  if (!bytes) return [];
  const content = text(name, bytes, issues);
  if (content === undefined) return [];
  let records;
  try {
    records = parseCsvRecords(content);
  } catch (error) {
    issues.add(name, `is not valid CSV (${(error as Error).message})`);
    return [];
  }
  const [head, ...rows] = records;
  if (!head) {
    issues.add(name, 'has no header row');
    return [];
  }
  if (head.fields.join(',') !== header.join(',')) {
    issues.add(name, `header is "${head.fields.join(',')}", expected "${header.join(',')}"`);
    return [];
  }
  const out: T[] = [];
  for (const row of rows) {
    const where = `${name}:${row.line}`;
    if (row.fields.length !== header.length) {
      issues.add(where, `has ${row.fields.length} fields, expected ${header.length}`);
      continue;
    }
    const record = Object.fromEntries(header.map((column, i) => [column, row.fields[i]]));
    const result = schema.safeParse(record);
    if (result.success) out.push(result.data);
    else for (const message of zodIssues(result.error)) issues.add(where, message);
  }
  return out;
}

function jsonDataset<T>(name: string, bytes: Buffer | undefined, schema: z.ZodType<T>, issues: Issues): T | undefined {
  if (!bytes) return undefined;
  const content = text(name, bytes, issues);
  if (content === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    issues.add(name, `is not valid JSON (${(error as Error).message})`);
    return undefined;
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const message of zodIssues(result.error)) issues.add(name, message);
  return undefined;
}

function csvFile<F extends PackCsvFile>(files: ReadonlyMap<string, Buffer>, name: F, issues: Issues): z.output<(typeof PACK_CSV_ROW_SCHEMAS)[F]>[] {
  const schema = PACK_CSV_ROW_SCHEMAS[name] as unknown as z.ZodType<z.output<(typeof PACK_CSV_ROW_SCHEMAS)[F]>>;
  return csvDataset(name, files.get(name), PACK_CSV_HEADERS[name], schema, issues);
}

function jsonFile<F extends PackJsonFile>(files: ReadonlyMap<string, Buffer>, name: F, issues: Issues): z.output<(typeof PACK_JSON_SCHEMAS)[F]> | undefined {
  const schema = PACK_JSON_SCHEMAS[name] as unknown as z.ZodType<z.output<(typeof PACK_JSON_SCHEMAS)[F]>>;
  return jsonDataset(name, files.get(name), schema, issues);
}

/** Reports values that occur more than once. */
function unique(issues: Issues, where: string, label: string, values: Iterable<string | number>): void {
  const seen = new Set<string | number>();
  const repeated = new Set<string | number>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  if (repeated.size > 0) issues.add(where, `duplicate ${label}: ${[...repeated].slice(0, 10).join(', ')}`);
}

function checkReferences(d: PackDatasets, manifest: DatasetManifestFields, issues: Issues): void {
  const requirementCodes = new Set(d.requirements.map((r) => r.requirement_code));
  const frequencyCodes = new Set(d.frequencies.map((f) => f.code));

  unique(issues, 'requirements.csv', 'requirement_code', d.requirements.map((r) => r.requirement_code));
  d.requirements.forEach((r) => {
    if (r.parent_code !== null && (r.parent_code === r.requirement_code || !requirementCodes.has(r.parent_code))) {
      issues.add('requirements.csv', `requirement ${r.requirement_code}: parent_code ${r.parent_code} is not another requirement of the pack`);
    }
    if (r.default_frequency_code !== null && !frequencyCodes.has(r.default_frequency_code)) {
      issues.add('requirements.csv', `requirement ${r.requirement_code}: default_frequency_code ${r.default_frequency_code} is not in frequencies.csv`);
    }
  });

  unique(issues, 'catalogue.csv', 'item_code', d.catalogue.map((c) => c.item_code));
  for (const c of d.catalogue) {
    if (c.requirement_code !== null && !requirementCodes.has(c.requirement_code)) {
      issues.add('catalogue.csv', `item ${c.item_code}: requirement_code ${c.requirement_code} is not in requirements.csv`);
    }
    if (c.default_frequency_code !== null && !frequencyCodes.has(c.default_frequency_code)) {
      issues.add('catalogue.csv', `item ${c.item_code}: default_frequency_code ${c.default_frequency_code} is not in frequencies.csv`);
    }
  }
  if (manifest.catalogue !== d.catalogue.length > 0) {
    issues.add('manifest.json', `catalogue is ${manifest.catalogue} but catalogue.csv has ${d.catalogue.length} rows`);
  }
  if (manifest.applicability_target === 'catalogue_item' && !manifest.catalogue) {
    issues.add('manifest.json', 'applicability_target catalogue_item needs a catalogue');
  }
  if (manifest.supersedes && manifest.supersedes.edition === manifest.edition) {
    issues.add('manifest.json', 'supersedes names the pack\'s own edition');
  }

  // Labels: the same keys in both languages, a theme label for every catalogue theme.
  const en = Object.keys(d.labels.en);
  const id = Object.keys(d.labels.id);
  const onlyEn = en.filter((k) => !(k in d.labels.id));
  const onlyId = id.filter((k) => !(k in d.labels.en));
  if (onlyEn.length > 0 || onlyId.length > 0) {
    issues.add('labels.id.json', `keys differ from labels.en.json (only en: ${onlyEn.join(', ') || 'none'}; only id: ${onlyId.join(', ') || 'none'})`);
  }
  for (const theme of new Set(d.catalogue.map((c) => c.theme_code))) {
    const key = `catalogue.theme.${theme.split('.').pop() ?? theme}`;
    if (!(key in d.labels.en) || !(key in d.labels.id)) issues.add('labels', `label ${key} for catalogue theme ${theme} is missing`);
  }

  // Lookups: required domains, unique codes per domain; document template types.
  unique(issues, 'lookups.csv', 'domain and code', d.lookups.map((l) => `${l.domain}/${l.code}`));
  const domains = new Map<string, Set<string>>();
  for (const l of d.lookups) {
    const codes = domains.get(l.domain) ?? new Set<string>();
    codes.add(l.code);
    domains.set(l.domain, codes);
  }
  for (const domain of REQUIRED_LOOKUP_DOMAINS) if (!domains.has(domain)) issues.add('lookups.csv', `domain ${domain} is missing`);
  unique(issues, 'document_templates.csv', 'code', d.documentTemplates.map((t) => t.code));
  for (const t of d.documentTemplates) {
    if (!domains.get('doc_type')?.has(t.doc_type)) issues.add('document_templates.csv', `template ${t.code}: doc_type ${t.doc_type} is not a doc_type in lookups.csv`);
  }

  // Chain: unique stage keys and positions, risk profiles of risk stages.
  const profileCodes = new Set(d.riskProfiles.map((p) => p.code));
  unique(issues, 'risk_profiles.json', 'code', d.riskProfiles.map((p) => p.code));
  unique(issues, 'chain.csv', 'stage_key', d.chain.map((s) => s.stage_key));
  unique(issues, 'chain.csv', 'position', d.chain.map((s) => s.position));
  for (const s of d.chain) {
    if (s.risk_profile_code !== null && !profileCodes.has(s.risk_profile_code)) {
      issues.add('chain.csv', `stage ${s.stage_key}: risk_profile_code ${s.risk_profile_code} is not in risk_profiles.json`);
    }
  }

  // Activities: unique numbers, one name and gate flag per phase.
  unique(issues, 'activities.csv', 'phase and activity number', d.activities.map((a) => `${a.phase_no}.${a.activity_no}`));
  const phases = new Map<number, ActivityRow>();
  for (const a of d.activities) {
    const first = phases.get(a.phase_no);
    if (!first) phases.set(a.phase_no, a);
    else if (first.phase_name_en !== a.phase_name_en || first.phase_name_id !== a.phase_name_id || first.is_gate_phase !== a.is_gate_phase) {
      issues.add('activities.csv', `phase ${a.phase_no} has differing names or gate flags`);
    }
  }

  unique(issues, 'frequencies.csv', 'code', d.frequencies.map((f) => f.code));
  unique(issues, 'cycle_requirements.csv', 'code', d.cycleRequirements.map((c) => c.code));
  unique(issues, 'prep_tasks.csv', 'code', d.prepTasks.map((p) => p.code));
  unique(issues, 'review_inputs.csv', 'code', d.reviewInputs.map((r) => r.code));
  unique(issues, 'finding_conditions.csv', 'code', d.findingConditions.map((f) => f.code));
  for (const f of d.findingConditions) {
    if (f.requirement_code !== null && !requirementCodes.has(f.requirement_code)) {
      issues.add('finding_conditions.csv', `condition ${f.code}: requirement_code ${f.requirement_code} is not in requirements.csv`);
    }
  }
  unique(issues, 'audit_activities.csv', 'code', d.auditActivities.map((a) => a.code));
  unique(issues, 'drift_rules.json', 'code', d.driftRules.map((r) => r.code));
  unique(issues, 'rules.json', 'rule_id', d.rules.map((r) => r.rule_id));

  // Mappings: sources are requirements or catalogue items of this pack, targets are other packs.
  const sourceCodes = new Set([...requirementCodes, ...d.catalogue.map((c) => c.item_code)]);
  for (const [file, rows] of Object.entries(d.mappings)) {
    unique(issues, file, 'mapping', rows.map((m) => `${m.source_code} ${m.target_pack_id} ${m.target_code}`));
    for (const m of rows) {
      if (!sourceCodes.has(m.source_code)) issues.add(file, `source_code ${m.source_code} is not a requirement or catalogue item of the pack`);
      if (m.target_pack_id === manifest.pack_id) issues.add(file, `mapping ${m.source_code} targets the pack itself`);
    }
  }
}

/**
 * Validates the dataset files of a pack (every file except `manifest.json` and `signature`) and returns the typed
 * rows. Throws `PackError` with code `dataset` listing every problem: a missing or unknown dataset file, a header
 * that differs from E.8, a row or document that breaks its schema, or a broken reference between datasets.
 */
export function parsePackDatasets(files: ReadonlyMap<string, Buffer>, manifest: DatasetManifestFields): PackDatasets {
  const issues = new Issues();
  const known = new Set<string>(PACK_DATASET_FILES);
  for (const name of PACK_DATASET_FILES) if (!files.has(name)) issues.add(name, 'is missing');
  const mappingFiles = [...files.keys()].filter((name) => MAPPING_FILE_RE.test(name)).sort();
  for (const name of files.keys()) {
    if (!known.has(name) && !MAPPING_FILE_RE.test(name)) issues.add(name, 'is not a pack dataset (E.8)');
  }

  const mappings: Record<string, MappingRow[]> = {};
  for (const name of mappingFiles) {
    mappings[name] = csvDataset(name, files.get(name), MAPPING_CSV_HEADER, MappingRow as unknown as z.ZodType<MappingRow>, issues);
  }
  const labelsEn = jsonFile(files, 'labels.en.json', issues);
  const labelsId = jsonFile(files, 'labels.id.json', issues);
  const datasets: PackDatasets = {
    requirements: csvFile(files, 'requirements.csv', issues),
    catalogue: csvFile(files, 'catalogue.csv', issues),
    chain: csvFile(files, 'chain.csv', issues),
    activities: csvFile(files, 'activities.csv', issues),
    frequencies: csvFile(files, 'frequencies.csv', issues),
    labels: { en: labelsEn ?? {}, id: labelsId ?? {} },
    cycleRequirements: csvFile(files, 'cycle_requirements.csv', issues),
    driftRules: jsonFile(files, 'drift_rules.json', issues) ?? [],
    prepTasks: csvFile(files, 'prep_tasks.csv', issues),
    reviewInputs: csvFile(files, 'review_inputs.csv', issues),
    findingConditions: csvFile(files, 'finding_conditions.csv', issues),
    documentTemplates: csvFile(files, 'document_templates.csv', issues),
    auditActivities: csvFile(files, 'audit_activities.csv', issues),
    lookups: csvFile(files, 'lookups.csv', issues),
    rules: jsonFile(files, 'rules.json', issues) ?? [],
    riskProfiles: jsonFile(files, 'risk_profiles.json', issues) ?? [],
    mappings,
  };
  // Reference checks only make sense on data that parsed; with schema problems they would add noise.
  if (issues.list.length === 0) checkReferences(datasets, manifest, issues);
  if (issues.list.length > 0) {
    throw new PackError('dataset', `pack ${manifest.pack_id} has invalid datasets`, issues.list);
  }
  return datasets;
}

/** Row counts of every dataset (for CLI output and install summaries). */
export function datasetCounts(d: PackDatasets): Record<string, number> {
  return {
    requirements: d.requirements.length,
    catalogue: d.catalogue.length,
    chain: d.chain.length,
    activities: d.activities.length,
    frequencies: d.frequencies.length,
    labels: Object.keys(d.labels.en).length,
    cycle_requirements: d.cycleRequirements.length,
    drift_rules: d.driftRules.length,
    prep_tasks: d.prepTasks.length,
    review_inputs: d.reviewInputs.length,
    finding_conditions: d.findingConditions.length,
    document_templates: d.documentTemplates.length,
    audit_activities: d.auditActivities.length,
    lookups: d.lookups.length,
    rules: d.rules.length,
    risk_profiles: d.riskProfiles.length,
    mappings: Object.values(d.mappings).reduce((sum, rows) => sum + rows.length, 0),
  };
}
