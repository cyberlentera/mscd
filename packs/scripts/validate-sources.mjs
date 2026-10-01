#!/usr/bin/env node
// Validates the pack source folders under packs/sources (BUILD-PLAN E.8): every file
// exists and is UTF-8 with LF line endings, CSV headers match E.8, JSON is pretty-printed,
// values fit the ref columns of C.5, codes are unique, and references resolve (catalogue
// and finding conditions to requirement codes, chain entity types to the record tables of
// C.10, risk profiles, frequencies, lookups, contiguous phase and activity numbers).
// Prints the dataset counts per pack and exits 1 on any error.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED, CSV_HEADERS, ISO_DATE_RE, JSON_FILES, LOOKUP_CODE_RE, MAPPING_HEADER, REQUIRED_FILES,
  REQUIRED_LABEL_KEYS, RULE_ID_RE, SEMVER_RE, parseCsv, toJson,
} from './lib/pack-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIR = path.join(ROOT, 'packs', 'sources');

const USAGE = `Usage: node packs/scripts/validate-sources.mjs [--dir <sources dir>]

Validates every pack source folder under packs/sources (or <sources dir>) against the
pack file format and prints the dataset counts per pack. Exits 1 on any error.
`;

const SNAKE_RE = /^[a-z][a-z0-9_]*$/;
const CLAUSE_CODE_RE = /^[0-9]+(\.[0-9]+)*$/;
const SMALLINT_MAX = 32767;
const MANIFEST_REQUIRED = [
  'pack_id', 'pack_version', 'framework_code', 'framework_name', 'edition', 'status', 'pre_release',
  'engine_min_version', 'modules', 'applicability_target', 'catalogue',
];
const MANIFEST_OPTIONAL = ['supersedes'];
// Record tables a drift rule may name besides the chain stages of its pack.
const DRIFT_EXTRA_SOURCES = ['management_review'];

// ---------------------------------------------------------------------------------------
// Error collection and typed field readers
// ---------------------------------------------------------------------------------------

class Report {
  constructor() {
    this.errors = [];
  }

  error(where, message) {
    this.errors.push(`${where}: ${message}`);
  }
}

/** Reads the fields of one CSV record with the type and length rules of its ref column. */
class Row {
  constructor(report, where, record) {
    this.report = report;
    this.where = where;
    this.record = record;
  }

  fail(column, message) {
    this.report.error(this.where, `${column}: ${message}`);
  }

  /** Text; empty gives null. Options: required, max (characters), re (pattern). */
  text(column, { required = false, max, re } = {}) {
    const v = this.record[column];
    if (v === '') {
      if (required) this.fail(column, 'is empty');
      return null;
    }
    if (v.trim() !== v) this.fail(column, 'has leading or trailing spaces');
    if (max !== undefined && [...v].length > max) this.fail(column, `is longer than ${max} characters`);
    if (re && !re.test(v)) this.fail(column, `"${v}" does not match ${re}`);
    return v;
  }

  /** Integer; empty gives null. Options: required, min, max. */
  int(column, { required = true, min = -SMALLINT_MAX - 1, max = 2147483647 } = {}) {
    const v = this.record[column];
    if (v === '') {
      if (required) this.fail(column, 'is empty');
      return null;
    }
    if (!/^-?(0|[1-9][0-9]*)$/.test(v)) {
      this.fail(column, `"${v}" is not an integer`);
      return null;
    }
    const n = Number(v);
    if (n < min || n > max) this.fail(column, `${n} is outside ${min} to ${max}`);
    return n;
  }

  /** Boolean written as `true` or `false` (never empty). */
  bool(column) {
    const v = this.record[column];
    if (v !== 'true' && v !== 'false') {
      this.fail(column, `"${v}" is not true or false`);
      return null;
    }
    return v === 'true';
  }

  /** One of the allowed values; empty gives null unless required. */
  oneOf(column, values, { required = true } = {}) {
    const v = this.record[column];
    if (v === '') {
      if (required) this.fail(column, 'is empty');
      return null;
    }
    if (!values.includes(v)) this.fail(column, `"${v}" is not one of ${values.join(', ')}`);
    return v;
  }
}

/** Reports duplicates of a key over a list, naming the first repeated values. */
function unique(report, where, label, values) {
  const seen = new Set();
  const dup = new Set();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  if (dup.size) report.error(where, `duplicate ${label}: ${[...dup].slice(0, 10).join(', ')}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validDate(s) {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------------------------------------------------------------------------------------
// File level checks
// ---------------------------------------------------------------------------------------

/** Lists the files of a pack folder relative to it, failing on anything but regular files. */
function listPackFiles(report, packDir, packId) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) out.push(rel);
      else report.error(`${packId}/${rel}`, 'is not a regular file');
    }
  };
  walk(packDir, '');
  return out;
}

/** Reads a file as UTF-8 text, checking the encoding rules; returns null when unusable. */
function readText(report, file, where) {
  const bytes = readFileSync(file);
  if (bytes.length === 0) {
    report.error(where, 'is empty');
    return null;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) report.error(where, 'starts with a byte order mark');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    report.error(where, 'is not valid UTF-8');
    return null;
  }
  if (text.includes('\r')) report.error(where, 'has carriage returns (LF line endings only)');
  if (!text.endsWith('\n')) report.error(where, 'does not end with a newline');
  return text;
}

/** Parses a CSV dataset, checks its header and returns the records as objects. */
function readCsv(report, file, where, header) {
  const text = readText(report, file, where);
  // Carriage returns are already reported by readText and would stop the parser anyway.
  if (text === null || text.includes('\r')) return [];
  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    report.error(where, err.message);
    return [];
  }
  const head = records[0] ?? [];
  if (head.join(',') !== header.join(',')) {
    report.error(where, `header is "${head.join(',')}", expected "${header.join(',')}"`);
    return [];
  }
  const rows = [];
  records.slice(1).forEach((rec, i) => {
    const line = i + 2;
    if (rec.length !== header.length) {
      report.error(`${where}:${line}`, `has ${rec.length} fields, expected ${header.length}`);
      return;
    }
    const obj = {};
    header.forEach((h, j) => { obj[h] = rec[j]; });
    rows.push({ line, obj });
  });
  return rows;
}

/** Parses a JSON file and checks that it is written pretty-printed with two spaces. */
function readJson(report, file, where) {
  const text = readText(report, file, where);
  if (text === null) return undefined;
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    report.error(where, `is not valid JSON (${err.message})`);
    return undefined;
  }
  if (toJson(value) !== text) report.error(where, 'is not pretty-printed JSON with two-space indentation and a final newline');
  return value;
}

// ---------------------------------------------------------------------------------------
// Pack validation
// ---------------------------------------------------------------------------------------

function validatePack(report, sourcesDir, packId) {
  const dir = path.join(sourcesDir, packId);
  const at = (file, line) => `${packId}/${file}${line ? ':' + line : ''}`;
  const files = listPackFiles(report, dir, packId);
  const mappingFiles = files.filter((f) => /^mappings\/[^/]+\.csv$/.test(f));
  for (const f of REQUIRED_FILES) if (!files.includes(f)) report.error(at(f), 'is missing');
  for (const f of files) {
    if (!REQUIRED_FILES.includes(f) && !mappingFiles.includes(f)) report.error(at(f), 'is not a pack dataset (E.8)');
  }
  const has = (f) => files.includes(f);
  const csv = (f) => {
    if (!CSV_HEADERS[f]) throw new Error(`${f} is not a CSV dataset of the format table`);
    return has(f) ? readCsv(report, path.join(dir, f), at(f), CSV_HEADERS[f]) : [];
  };
  const json = (f) => {
    if (!JSON_FILES.includes(f)) throw new Error(`${f} is not a JSON file of the format table`);
    return has(f) ? readJson(report, path.join(dir, f), at(f)) : undefined;
  };
  const row = (f, r) => new Row(report, at(f, r.line), r.obj);

  const counts = {};

  // Frequencies first: requirements and catalogue reference them.
  const freqRows = csv('frequencies.csv');
  const freqCodes = new Set();
  for (const r of freqRows) {
    const x = row('frequencies.csv', r);
    const code = x.text('code', { required: true, max: 20, re: SNAKE_RE });
    x.text('label_en', { required: true, max: 40 });
    x.text('label_id', { required: true, max: 40 });
    x.int('period_days', { min: 0 });
    x.int('sort_order', { max: SMALLINT_MAX });
    if (code) freqCodes.add(code);
  }
  unique(report, at('frequencies.csv'), 'code', freqRows.map((r) => r.obj.code));
  unique(report, at('frequencies.csv'), 'sort_order', freqRows.map((r) => r.obj.sort_order));
  counts.frequencies = freqRows.length;

  // Lookups: doc_type and treatment_option are required in every pack.
  const lookupRows = csv('lookups.csv');
  const lookups = new Map();
  for (const r of lookupRows) {
    const x = row('lookups.csv', r);
    const domain = x.text('domain', { required: true, max: 40, re: SNAKE_RE });
    const code = x.text('code', { required: true, max: 40, re: LOOKUP_CODE_RE });
    x.text('label_en', { required: true, max: 120 });
    x.text('label_id', { required: true, max: 120 });
    x.int('sort_order', { max: SMALLINT_MAX });
    if (domain && code) {
      if (!lookups.has(domain)) lookups.set(domain, new Set());
      lookups.get(domain).add(code);
    }
  }
  unique(report, at('lookups.csv'), 'domain and code', lookupRows.map((r) => `${r.obj.domain}/${r.obj.code}`));
  if (has('lookups.csv')) {
    for (const d of ALLOWED.requiredLookupDomains) if (!lookups.has(d)) report.error(at('lookups.csv'), `domain ${d} is missing`);
  }
  counts.lookups = lookupRows.length;

  // Requirements.
  const reqRows = csv('requirements.csv');
  const reqCodes = new Set(reqRows.map((r) => r.obj.requirement_code).filter(Boolean));
  for (const r of reqRows) {
    const x = row('requirements.csv', r);
    const code = x.text('requirement_code', { required: true, max: 20, re: CLAUSE_CODE_RE });
    const parent = x.text('parent_code', { max: 20 });
    if (parent && (parent === code || !reqCodes.has(parent))) x.fail('parent_code', `"${parent}" is not another requirement of the pack`);
    x.text('title_short', { required: true, max: 255 });
    const group = x.oneOf('clause_group', ALLOWED.clauseGroup);
    if (code && group && code.split('.')[0] !== group) x.fail('clause_group', `${group} does not match requirement ${code}`);
    x.bool('is_hs_common');
    x.bool('documented_info_mandatory');
    x.bool('applicability_assessable');
    const freq = x.text('default_frequency_code', { max: 20 });
    if (freq && !freqCodes.has(freq)) x.fail('default_frequency_code', `"${freq}" is not in frequencies.csv`);
    x.text('evidence_example');
    x.int('sort_order', { min: 1 });
  }
  unique(report, at('requirements.csv'), 'requirement_code', reqRows.map((r) => r.obj.requirement_code));
  unique(report, at('requirements.csv'), 'sort_order', reqRows.map((r) => r.obj.sort_order));
  counts.requirements = reqRows.length;

  // Labels, both languages with the same keys.
  const labelsEn = json('labels.en.json');
  const labelsId = json('labels.id.json');
  for (const [file, labels] of [['labels.en.json', labelsEn], ['labels.id.json', labelsId]]) {
    if (labels === undefined) continue;
    if (!isPlainObject(labels)) {
      report.error(at(file), 'is not a JSON object of key to text');
      continue;
    }
    for (const [k, v] of Object.entries(labels)) {
      if (k.length > 100) report.error(at(file), `key ${k} is longer than 100 characters`);
      if (typeof v !== 'string' || v.trim() === '') report.error(at(file), `key ${k} has no text`);
    }
    for (const k of REQUIRED_LABEL_KEYS) if (!(k in labels)) report.error(at(file), `key ${k} is missing`);
  }
  if (isPlainObject(labelsEn) && isPlainObject(labelsId)) {
    const en = Object.keys(labelsEn);
    const id = Object.keys(labelsId);
    const onlyEn = en.filter((k) => !id.includes(k));
    const onlyId = id.filter((k) => !en.includes(k));
    if (onlyEn.length || onlyId.length) report.error(at('labels.id.json'), `keys differ from labels.en.json (only en: ${onlyEn.join(', ') || 'none'}; only id: ${onlyId.join(', ') || 'none'})`);
  }
  counts.labels = isPlainObject(labelsEn) ? Object.keys(labelsEn).length : 0;

  // Catalogue: requirement codes where given, frequencies, theme labels.
  const catRows = csv('catalogue.csv');
  for (const r of catRows) {
    const x = row('catalogue.csv', r);
    x.text('item_code', { required: true, max: 20 });
    const theme = x.text('theme_code', { required: true, max: 20 });
    if (theme) {
      const key = `catalogue.theme.${theme.split('.').pop()}`;
      for (const [file, labels] of [['labels.en.json', labelsEn], ['labels.id.json', labelsId]]) {
        if (isPlainObject(labels) && !(key in labels)) x.fail('theme_code', `label ${key} is missing from ${file}`);
      }
    }
    x.text('title_short', { required: true, max: 255 });
    const req = x.text('requirement_code', { max: 20 });
    if (req && !reqCodes.has(req)) x.fail('requirement_code', `"${req}" is not in requirements.csv`);
    const freq = x.text('default_frequency_code', { max: 20 });
    if (freq && !freqCodes.has(freq)) x.fail('default_frequency_code', `"${freq}" is not in frequencies.csv`);
    x.text('evidence_example');
    x.int('sort_order', { min: 1 });
  }
  unique(report, at('catalogue.csv'), 'item_code', catRows.map((r) => r.obj.item_code));
  unique(report, at('catalogue.csv'), 'sort_order', catRows.map((r) => r.obj.sort_order));
  counts.catalogue = catRows.length;

  // Risk profiles (referenced by risk stages of the chain).
  const profiles = json('risk_profiles.json');
  const profileCodes = new Set();
  if (profiles !== undefined) {
    if (!Array.isArray(profiles)) report.error(at('risk_profiles.json'), 'is not a JSON array');
    else {
      profiles.forEach((p, i) => {
        const where = at('risk_profiles.json') + `[${i}]`;
        if (!isPlainObject(p)) return report.error(where, 'is not an object');
        const keys = Object.keys(p).sort().join(',');
        if (keys !== 'code,definition') report.error(where, `has keys ${keys}, expected code, definition`);
        if (typeof p.code !== 'string' || !SNAKE_RE.test(p.code) || p.code.length > 30) report.error(where, `code ${JSON.stringify(p.code)} is not a snake_case code of up to 30 characters`);
        else profileCodes.add(p.code);
        if (!isPlainObject(p.definition)) report.error(where, 'definition is not an object');
      });
      unique(report, at('risk_profiles.json'), 'code', profiles.map((p) => p?.code));
    }
  }
  counts.risk_profiles = Array.isArray(profiles) ? profiles.length : 0;

  // Chain: sources, entity types of C.10, risk profiles, contiguous positions.
  const chainRows = csv('chain.csv');
  const stageKeys = new Set();
  const sourceCount = {};
  for (const r of chainRows) {
    const x = row('chain.csv', r);
    const key = x.text('stage_key', { required: true, max: 20, re: SNAKE_RE });
    if (key) stageKeys.add(key);
    x.int('position', { min: 1, max: SMALLINT_MAX });
    x.text('label_en', { required: true, max: 80 });
    x.text('label_id', { required: true, max: 80 });
    x.text('question_en');
    x.text('question_id');
    const source = x.oneOf('source', ALLOWED.chainSource);
    if (source) sourceCount[source] = (sourceCount[source] ?? 0) + 1;
    const entity = x.oneOf('entity_type', ALLOWED.chainEntityType, { required: source === 'entity' });
    if (entity && ['applicability', 'document', 'evidence'].includes(source)) x.fail('entity_type', `must be empty for source ${source}`);
    if (entity && source === 'justification' && entity !== 'chain_record') x.fail('entity_type', 'must be chain_record or empty for source justification');
    const profile = x.text('risk_profile_code', { max: 30 });
    if (entity === 'risk' && !profile) x.fail('risk_profile_code', 'is required for a risk stage');
    if (profile && entity !== 'risk') x.fail('risk_profile_code', 'is only allowed on a risk stage');
    if (profile && !profileCodes.has(profile)) x.fail('risk_profile_code', `"${profile}" is not in risk_profiles.json`);
    x.bool('is_mandatory');
    x.text('clause_at_risk', { max: 20 });
    x.int('overview_clause', { min: 4, max: 10 });
    const gEn = x.text('gate_type_label_en', { max: 40 });
    const gId = x.text('gate_type_label_id', { max: 40 });
    if (!gEn !== !gId) x.fail('gate_type_label_id', 'gate type labels must be given in both languages or neither');
  }
  unique(report, at('chain.csv'), 'stage_key', chainRows.map((r) => r.obj.stage_key));
  for (const s of ['applicability', 'justification', 'document', 'evidence']) {
    if ((sourceCount[s] ?? 0) > 1) report.error(at('chain.csv'), `more than one stage with source ${s}`);
  }
  const positions = chainRows.map((r) => Number(r.obj.position)).sort((a, b) => a - b);
  if (positions.some((p, i) => p !== i + 1)) report.error(at('chain.csv'), 'positions are not 1 to n without gaps');
  counts.chain = chainRows.length;

  // Activities: contiguous phase numbers and activity numbers, consistent phase fields.
  const actRows = csv('activities.csv');
  const phases = new Map();
  for (const r of actRows) {
    const x = row('activities.csv', r);
    const no = x.int('phase_no', { min: 1, max: SMALLINT_MAX });
    const nameEn = x.text('phase_name_en', { required: true, max: 120 });
    const nameId = x.text('phase_name_id', { required: true, max: 120 });
    const gate = x.bool('is_gate_phase');
    const act = x.int('activity_no', { min: 1, max: SMALLINT_MAX });
    x.text('title', { required: true, max: 255 });
    x.text('clause_ref', { max: 20 });
    x.text('output_document_code', { max: 30 });
    x.text('expected_outcome');
    if (no === null) continue;
    if (!phases.has(no)) phases.set(no, { nameEn, nameId, gate, acts: [] });
    const ph = phases.get(no);
    if (ph.nameEn !== nameEn || ph.nameId !== nameId || ph.gate !== gate) x.fail('phase_no', `phase ${no} has differing names or gate flags`);
    if (act !== null) ph.acts.push(act);
  }
  const phaseNos = [...phases.keys()].sort((a, b) => a - b);
  if (phaseNos.some((p, i) => p !== i + 1)) report.error(at('activities.csv'), `phase numbers are not contiguous from 1 (${phaseNos.join(', ')})`);
  for (const [no, ph] of phases) {
    const acts = [...ph.acts].sort((a, b) => a - b);
    if (acts.some((a, i) => a !== i + 1)) report.error(at('activities.csv'), `phase ${no} activity numbers are not contiguous from 1 (${acts.join(', ')})`);
  }
  counts.phases = phases.size;
  counts.activities = actRows.length;

  // Cycle requirements (requirement codes may name subclauses, so they are not resolved).
  const cycleRows = csv('cycle_requirements.csv');
  for (const r of cycleRows) {
    const x = row('cycle_requirements.csv', r);
    x.text('code', { required: true, max: 30 });
    x.text('requirement_code', { max: 20 });
    x.text('title', { required: true, max: 255 });
    const derivation = x.text('derivation');
    if (derivation) {
      try {
        const d = JSON.parse(derivation);
        if (!isPlainObject(d) || typeof d.kind !== 'string') x.fail('derivation', 'is not a JSON object with a kind');
      } catch {
        x.fail('derivation', 'is not valid JSON');
      }
    }
    x.int('sort_order', { max: SMALLINT_MAX });
  }
  unique(report, at('cycle_requirements.csv'), 'code', cycleRows.map((r) => r.obj.code));
  counts.cycle_requirements = cycleRows.length;

  // Drift rules.
  const drift = json('drift_rules.json');
  const driftKeys = ['code', 'label_en', 'label_id', 'severity', 'source_stage', 'source_kind', 'predicate', 'message', 'sort_order'];
  const driftSources = new Set([...stageKeys, ...ALLOWED.chainEntityType, ...DRIFT_EXTRA_SOURCES]);
  if (drift !== undefined) {
    if (!Array.isArray(drift)) report.error(at('drift_rules.json'), 'is not a JSON array');
    else {
      drift.forEach((d, i) => {
        const where = at('drift_rules.json') + `[${i}]`;
        if (!isPlainObject(d)) return report.error(where, 'is not an object');
        const keys = Object.keys(d).sort().join(',');
        if (keys !== [...driftKeys].sort().join(',')) report.error(where, `has keys ${keys}, expected ${driftKeys.join(', ')}`);
        const str = (k, max, required = true) => {
          const v = d[k];
          if (v === null && !required) return;
          if (typeof v !== 'string' || (required && v.trim() === '') || (max && v.length > max)) report.error(where, `${k} is not a text of 1 to ${max ?? 'any'} characters`);
        };
        str('code', 30);
        str('label_en', 150);
        str('label_id', 150);
        str('message');
        str('source_stage', 20, false);
        if (!ALLOWED.driftSeverity.includes(d.severity)) report.error(where, `severity ${JSON.stringify(d.severity)} is not one of ${ALLOWED.driftSeverity.join(', ')}`);
        if (!ALLOWED.driftSourceKind.includes(d.source_kind)) report.error(where, `source_kind ${JSON.stringify(d.source_kind)} is not one of ${ALLOWED.driftSourceKind.join(', ')}`);
        if (typeof d.source_stage === 'string' && !driftSources.has(d.source_stage)) report.error(where, `source_stage ${d.source_stage} is not a chain stage or record table of the pack`);
        if (!isPlainObject(d.predicate)) report.error(where, 'predicate is not an object');
        else if (d.source_kind === 'stale_risk' && d.predicate.months !== undefined && !(Number.isInteger(d.predicate.months) && d.predicate.months > 0)) report.error(where, 'predicate.months is not a positive integer');
        if (!Number.isInteger(d.sort_order) || d.sort_order < 0 || d.sort_order > SMALLINT_MAX) report.error(where, 'sort_order is not a small integer');
      });
      unique(report, at('drift_rules.json'), 'code', drift.map((d) => d?.code));
    }
  }
  counts.drift_rules = Array.isArray(drift) ? drift.length : 0;

  // Preparation task templates.
  const prepRows = csv('prep_tasks.csv');
  for (const r of prepRows) {
    const x = row('prep_tasks.csv', r);
    x.text('code', { required: true, max: 30 });
    x.text('title', { required: true, max: 255 });
    x.int('days_before_audit', { min: 1, max: SMALLINT_MAX });
    x.bool('skip_on_first_audit');
    x.int('sort_order', { max: SMALLINT_MAX });
  }
  unique(report, at('prep_tasks.csv'), 'code', prepRows.map((r) => r.obj.code));
  counts.prep_tasks = prepRows.length;

  // Management review inputs.
  const reviewRows = csv('review_inputs.csv');
  for (const r of reviewRows) {
    const x = row('review_inputs.csv', r);
    x.text('code', { required: true, max: 30 });
    x.text('title', { required: true, max: 255 });
    x.bool('mandatory');
    x.int('sort_order', { max: SMALLINT_MAX });
  }
  unique(report, at('review_inputs.csv'), 'code', reviewRows.map((r) => r.obj.code));
  counts.review_inputs = reviewRows.length;

  // Finding conditions: requirement codes resolve.
  const findingRows = csv('finding_conditions.csv');
  for (const r of findingRows) {
    const x = row('finding_conditions.csv', r);
    x.text('code', { required: true, max: 30 });
    x.oneOf('classification', ALLOWED.findingClassification);
    const req = x.text('requirement_code', { max: 20 });
    if (req && !reqCodes.has(req)) x.fail('requirement_code', `"${req}" is not in requirements.csv`);
    x.text('text', { required: true });
  }
  unique(report, at('finding_conditions.csv'), 'code', findingRows.map((r) => r.obj.code));
  counts.finding_conditions = findingRows.length;

  // Document templates: doc_type from the doc_type lookup.
  const templateRows = csv('document_templates.csv');
  for (const r of templateRows) {
    const x = row('document_templates.csv', r);
    x.text('code', { required: true, max: 30 });
    x.text('title', { required: true, max: 255 });
    const type = x.text('doc_type', { required: true, max: 20 });
    if (type && !(lookups.get('doc_type') ?? new Set()).has(type)) x.fail('doc_type', `"${type}" is not a doc_type in lookups.csv`);
  }
  unique(report, at('document_templates.csv'), 'code', templateRows.map((r) => r.obj.code));
  counts.document_templates = templateRows.length;

  // Audit activity templates.
  const auditRows = csv('audit_activities.csv');
  for (const r of auditRows) {
    const x = row('audit_activities.csv', r);
    x.text('code', { required: true, max: 30 });
    x.oneOf('event_type', ALLOWED.auditEventType);
    x.text('clause_ref', { max: 40 });
    x.text('title', { required: true, max: 255 });
    x.text('auditee_role', { max: 40 });
    x.text('key_questions');
    x.text('evidence_to_request');
    x.int('sort_order', { max: SMALLINT_MAX });
  }
  unique(report, at('audit_activities.csv'), 'code', auditRows.map((r) => r.obj.code));
  counts.audit_activities = auditRows.length;

  // Rule activation.
  const rules = json('rules.json');
  if (rules !== undefined) {
    if (!Array.isArray(rules)) report.error(at('rules.json'), 'is not a JSON array');
    else {
      rules.forEach((rule, i) => {
        const where = at('rules.json') + `[${i}]`;
        if (!isPlainObject(rule)) return report.error(where, 'is not an object');
        const keys = Object.keys(rule).sort().join(',');
        if (keys !== 'active,params,rule_id') report.error(where, `has keys ${keys}, expected rule_id, active, params`);
        if (typeof rule.rule_id !== 'string' || !RULE_ID_RE.test(rule.rule_id)) report.error(where, `rule_id ${JSON.stringify(rule.rule_id)} is not BR-nn`);
        if (typeof rule.active !== 'boolean') report.error(where, 'active is not a boolean');
        if (!isPlainObject(rule.params)) report.error(where, 'params is not an object');
      });
      unique(report, at('rules.json'), 'rule_id', rules.map((r) => r?.rule_id));
    }
  }
  counts.rules = Array.isArray(rules) ? rules.filter((r) => r?.active === true).length : 0;

  // Mappings to other packs (optional).
  let mappingCount = 0;
  const sourceCodes = new Set([...reqCodes, ...catRows.map((r) => r.obj.item_code)]);
  for (const f of mappingFiles) {
    const rows = readCsv(report, path.join(dir, f), at(f), MAPPING_HEADER);
    for (const r of rows) {
      const x = new Row(report, at(f, r.line), r.obj);
      const src = x.text('source_code', { required: true, max: 20 });
      if (src && !sourceCodes.has(src)) x.fail('source_code', `"${src}" is not a requirement or catalogue item of the pack`);
      x.text('target_pack_id', { required: true, max: 40, re: /^[A-Z0-9]+-[A-Za-z0-9]+$/ });
      x.text('target_code', { required: true, max: 20 });
      x.oneOf('mapping_type', ALLOWED.mappingType);
      x.bool('evidence_reusable');
      x.text('note');
    }
    mappingCount += rows.length;
  }
  counts.mappings = mappingCount;

  // Manifest last: it is checked against the datasets.
  const m = json('manifest.json');
  if (m !== undefined) validateManifest(report, at('manifest.json'), packId, m, catRows.length);

  return counts;
}

function validateManifest(report, where, packId, m, catalogueRows) {
  if (!isPlainObject(m)) return report.error(where, 'is not a JSON object');
  if ('datasets' in m) report.error(where, 'datasets must be absent (the pack builder writes the checksums)');
  for (const k of MANIFEST_REQUIRED) if (!(k in m)) report.error(where, `${k} is missing`);
  for (const k of Object.keys(m)) {
    if (!MANIFEST_REQUIRED.includes(k) && !MANIFEST_OPTIONAL.includes(k) && k !== 'datasets') report.error(where, `${k} is not a manifest field`);
  }
  const str = (k, max, re) => {
    if (typeof m[k] !== 'string' || m[k] === '' || m[k].length > max || (re && !re.test(m[k]))) {
      report.error(where, `${k} ${JSON.stringify(m[k])} is not valid`);
      return false;
    }
    return true;
  };
  if (str('pack_id', 40, /^[A-Z0-9]+-[A-Za-z0-9]+$/) && m.pack_id !== packId) report.error(where, `pack_id ${m.pack_id} does not match the folder name ${packId}`);
  str('pack_version', 20, SEMVER_RE);
  str('engine_min_version', 20, SEMVER_RE);
  str('framework_code', 20, /^[A-Z0-9]+$/);
  str('framework_name', 150);
  str('edition', 20, /^[A-Za-z0-9.]+$/);
  if (typeof m.framework_code === 'string' && typeof m.edition === 'string' && m.pack_id !== `${m.framework_code}-${m.edition}`) {
    report.error(where, `pack_id ${m.pack_id} is not <framework_code>-<edition>`);
  }
  if (!ALLOWED.packStatus.includes(m.status)) report.error(where, `status ${JSON.stringify(m.status)} is not one of ${ALLOWED.packStatus.join(', ')}`);
  if (typeof m.pre_release !== 'boolean') report.error(where, 'pre_release is not a boolean');
  if (!Array.isArray(m.modules) || m.modules.some((x) => typeof x !== 'string' || !SNAKE_RE.test(x))) report.error(where, 'modules is not an array of snake_case names');
  if (!ALLOWED.applicabilityTarget.includes(m.applicability_target)) report.error(where, `applicability_target ${JSON.stringify(m.applicability_target)} is not one of ${ALLOWED.applicabilityTarget.join(', ')}`);
  if (typeof m.catalogue !== 'boolean') report.error(where, 'catalogue is not a boolean');
  else {
    if (m.catalogue !== catalogueRows > 0) report.error(where, `catalogue is ${m.catalogue} but catalogue.csv has ${catalogueRows} rows`);
    if (m.applicability_target === 'catalogue_item' && !m.catalogue) report.error(where, 'applicability_target catalogue_item needs a catalogue');
  }
  if ('supersedes' in m) {
    const s = m.supersedes;
    if (!isPlainObject(s) || Object.keys(s).sort().join(',') !== 'edition,transition_ends') report.error(where, 'supersedes is not {edition, transition_ends}');
    else {
      if (typeof s.edition !== 'string' || s.edition === '' || s.edition === m.edition) report.error(where, 'supersedes.edition is not another edition');
      if (typeof s.transition_ends !== 'string' || !validDate(s.transition_ends)) report.error(where, 'supersedes.transition_ends is not a YYYY-MM-DD date');
    }
  }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const COUNT_COLUMNS = [
  ['requirements', 'req'], ['catalogue', 'cat'], ['chain', 'chain'], ['phases', 'phases'],
  ['activities', 'acts'], ['frequencies', 'freq'], ['labels', 'labels'], ['cycle_requirements', 'cycle'],
  ['drift_rules', 'drift'], ['prep_tasks', 'prep'], ['review_inputs', 'review'],
  ['finding_conditions', 'findc'], ['document_templates', 'doctpl'], ['audit_activities', 'audit'],
  ['lookups', 'lookups'], ['rules', 'rules'], ['risk_profiles', 'riskp'], ['mappings', 'maps'],
];

function printCounts(results) {
  const width = Math.max(4, ...results.map(([id]) => id.length));
  const head = ['pack'.padEnd(width), ...COUNT_COLUMNS.map(([, h]) => h.padStart(Math.max(h.length, 4)))].join(' ');
  console.log(head);
  for (const [id, counts] of results) {
    console.log([id.padEnd(width), ...COUNT_COLUMNS.map(([k, h]) => String(counts[k] ?? 0).padStart(Math.max(h.length, 4)))].join(' '));
  }
}

function main(argv) {
  let dir = DEFAULT_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === '--dir') {
      if (!argv[i + 1]) {
        process.stderr.write(`--dir needs a folder\n\n${USAGE}`);
        return 2;
      }
      dir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    process.stderr.write(`Unknown option: ${arg}\n\n${USAGE}`);
    return 2;
  }
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    console.error(`validate-sources: ${dir} is not a folder; run node packs/scripts/extract-from-sample.mjs first`);
    return 1;
  }
  const report = new Report();
  const results = [];
  const packIds = readdirSync(dir).sort();
  for (const id of packIds) {
    if (!lstatSync(path.join(dir, id)).isDirectory()) {
      report.error(id, 'is not a pack folder');
      continue;
    }
    results.push([id, validatePack(report, dir, id)]);
  }
  if (!results.length) report.error(path.basename(dir), 'holds no pack folder');
  printCounts(results);
  if (report.errors.length) {
    console.error(`\n${report.errors.length} error${report.errors.length === 1 ? '' : 's'}:`);
    for (const e of report.errors) console.error('  ' + e);
    return 1;
  }
  console.log(`\n${results.length} pack source folders valid`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
