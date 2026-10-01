#!/usr/bin/env node
// Writes the framework pack sources (packs/sources/<pack_id>/) from the web sample data
// (apps/web/src/data/mscd-data.js), in the file layout of BUILD-PLAN E.8 and with the
// content rules of G.7. The output is deterministic: running the script twice gives the
// same bytes. `--check` regenerates in memory and exits 1 on any difference with the files
// on disk. Packs hold numbering and short titles only, never ISO text (PRD 3.3).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CSV_HEADERS, compareCodes, toCsv, toJson } from './lib/pack-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_FILE = path.join(ROOT, 'apps', 'web', 'src', 'data', 'mscd-data.js');
const SOURCES_DIR = path.join(ROOT, 'packs', 'sources');

const USAGE = `Usage: node packs/scripts/extract-from-sample.mjs [--check]

Writes packs/sources/<pack_id>/ for the six demo packs from apps/web/src/data/mscd-data.js.

  --check   regenerate in memory and exit 1 when any file under packs/sources differs,
            is missing or is not produced by this script (nothing is written)
  --help    show this text
`;

// ---------------------------------------------------------------------------------------
// Pack set (D-14). Versions, editions and statuses are cross-checked against the sample's
// PACKS and MS records below, so a change on either side stops the script.
// ---------------------------------------------------------------------------------------

/**
 * Minimum MSCD engine version for this pack format. The installer (WP-12) compares it with
 * the server version; raise it when the pack format changes in a way older engines cannot read.
 */
const ENGINE_MIN_VERSION = '0.1.0';

const PACK_DEFS = [
  { packId: 'ISO27001-2022', version: '1.2.0', ms: 'isms', frameworkCode: 'ISO27001', edition: '2022', status: 'current', preRelease: false },
  { packId: 'ISO9001-2026', version: '0.9.0', ms: 'qms', frameworkCode: 'ISO9001', edition: '2026', status: 'current', preRelease: false, supersedes: { edition: '2015', transition_ends: '2029-09-15' } },
  { packId: 'ISO9001-2015', version: '1.4.2', ms: 'qms', frameworkCode: 'ISO9001', edition: '2015', status: 'current', preRelease: false },
  { packId: 'ISO22301-2019', version: '1.0.0', ms: 'bcms', frameworkCode: 'ISO22301', edition: '2019', status: 'current', preRelease: false },
  { packId: 'ISO37001-2025', version: '0.6.0', ms: 'abms', frameworkCode: 'ISO37001', edition: '2025', status: 'current', preRelease: true },
  { packId: 'ISO37001-2016', version: '1.0.0', ms: 'abms', frameworkCode: 'ISO37001', edition: '2016', status: 'withdrawn', preRelease: false },
];

// ---------------------------------------------------------------------------------------
// Content written for this build. Everything else comes from the sample module.
// ---------------------------------------------------------------------------------------

/** ISO 27001 clause 8 entries added to the Harmonized Structure list (WP-04 brief). */
const ISO27001_CLAUSE_8 = [
  ['8.1', 'Operational planning and control'],
  ['8.2', 'Information security risk assessment'],
  ['8.3', 'Information security risk treatment'],
];

/**
 * Requirements whose clause asks for documented information to be kept or retained: the
 * Harmonized Structure set for every pack, plus ISO 27001 6.1, 8.2 and 8.3. Other
 * framework-specific clause 8 flags belong to the pack content work-stream (Appendix 1).
 */
const DOCUMENTED_INFO_HS = new Set(['4.3', '5.2', '6.2', '7.2', '8.1', '9.1', '9.2', '9.3', '10.2']);
const DOCUMENTED_INFO_EXTRA = { isms: new Set(['6.1', '8.2', '8.3']) };

/** Systems whose clause 8 requirements may be declared not applicable (ISO 9001). */
const CLAUSE_8_ASSESSABLE = new Set(['qms']);

/** Harmonized Structure clause 8 entry that is common to every management system standard. */
const HS_CLAUSE_8 = ['8.1', 'Operational planning and control'];

/** Labels that the sample keeps in the controller or does not hold in Indonesian (UI 2.14). */
const LABELS = {
  isms: {
    managerRoleId: 'Manajer ISMS',
    gate: ['Risk & SoA', 'Risiko & SoA'],
    artefact: ['Statement of Applicability', 'Pernyataan Keberlakuan'],
    riskObject: ['Information security risk', 'Risiko keamanan informasi'],
  },
  qms: {
    managerRoleId: 'Manajer QMS',
    gate: ['Risk & Opportunity + Process Map', 'Risiko & Peluang + Peta Proses'],
    artefact: ['Requirement Applicability', 'Keberlakuan Persyaratan'],
    riskObject: ['Risk or opportunity', 'Risiko atau peluang'],
  },
  bcms: {
    managerRoleId: 'Manajer BCMS',
    gate: ['BIA & Risk Assessment', 'BIA & Penilaian Risiko'],
    artefact: ['BCMS Scope Determination', 'Penetapan Ruang Lingkup BCMS'],
    riskObject: ['Disruption risk', 'Risiko gangguan'],
  },
  abms: {
    managerRoleId: 'Fungsi Kepatuhan Anti-Penyuapan',
    gate: ['Bribery Risk Assessment', 'Penilaian Risiko Penyuapan'],
    artefact: ['Control Proportionality', 'Proporsionalitas Kontrol'],
    riskObject: ['Bribery risk', 'Risiko penyuapan'],
  },
};

/** Indonesian names of the Annex A themes (English from the sample's `MS.theme`). */
const THEME_ID = {
  Organizational: 'Organisasional',
  People: 'Orang',
  Physical: 'Fisik',
  Technological: 'Teknologi',
};

/** Chain stage key to record table and risk profile (G.7, C.10). */
const STAGE_ENTITY = {
  context: { entityType: 'context_issue' },
  risk: { entityType: 'risk', riskProfile: { isms: 'information_security', qms: 'quality' } },
  treatment: { entityType: 'risk_treatment' },
  action: { entityType: 'risk_treatment' },
  objective: { entityType: 'quality_objective' },
  metric: { entityType: 'metric' },
  product: { entityType: 'prioritized_activity' },
  bia: { entityType: 'business_impact_analysis' },
  drisk: { entityType: 'risk', riskProfile: { bcms: 'disruption' } },
  exercise: { entityType: 'exercise' },
  brisk: { entityType: 'risk', riskProfile: { abms: 'bribery' } },
  associate: { entityType: 'business_associate' },
};

/** Sample stage `src` to `traceability_chain_def.source`; stages without `src` are entities. */
const STAGE_SOURCE = { req: 'applicability', soa: 'justification', doc: 'document', ev: 'evidence' };

/** Overview clause per stage key (UI 2.6, G.7); every other stage is clause 8. */
const OVERVIEW_CLAUSE = { context: 4, brisk: 4, risk: 6, treatment: 6, soa: 6, action: 6, objective: 6, document: 7, metric: 9 };

/** Gate item type labels of the sample's chain records (UI 2.4); other stages show their key. */
const GATE_TYPE_LABEL = {
  risk: ['Risk', 'Risiko'],
  treatment: ['Treatment', 'Perlakuan'],
  soa: ['SoA', 'SoA'],
  bia: ['BIA', 'BIA'],
};

/** Indonesian auditor questions for the sample's English chain stage questions. */
const QUESTION_ID = {
  'How do you know which internal and external issues affect the ISMS?': 'Bagaimana Anda mengetahui isu internal dan eksternal yang memengaruhi ISMS?',
  'Show me how this risk was identified and assessed.': 'Tunjukkan bagaimana risiko ini diidentifikasi dan dinilai.',
  'What was done about it, and is it complete?': 'Apa yang dilakukan terhadapnya, dan apakah sudah selesai?',
  'Which Annex A control implements the treatment?': 'Kontrol Annex A mana yang menerapkan perlakuan ini?',
  'Why is this control applicable, and is the justification risk-based?': 'Mengapa kontrol ini berlaku, dan apakah justifikasinya berbasis risiko?',
  'Where is it written down, and is that version current?': 'Di mana hal ini didokumentasikan, dan apakah versinya masih berlaku?',
  'Prove it operated this cycle, not at implementation.': 'Buktikan bahwa ini berjalan pada siklus ini, bukan hanya saat implementasi.',
  'How do you know it is effective?': 'Bagaimana Anda mengetahui bahwa ini efektif?',
  'Which issues and interested parties drive the QMS?': 'Isu dan pihak berkepentingan mana yang mendorong QMS?',
  'How were risks and opportunities determined?': 'Bagaimana risiko dan peluang ditentukan?',
  'What actions were planned and were they effective?': 'Tindakan apa yang direncanakan, dan apakah tindakan itu efektif?',
  'Show the process and its operational controls.': 'Tunjukkan prosesnya beserta kendali operasionalnya.',
  'Are objectives measurable and monitored?': 'Apakah sasaran dapat diukur dan dipantau?',
  'Is this the current controlled version?': 'Apakah ini versi terkendali yang berlaku?',
  'Show records from the current cycle.': 'Tunjukkan rekaman dari siklus berjalan.',
  'How is performance evaluated?': 'Bagaimana kinerja dievaluasi?',
  'Which issues affect continuity of prioritised activities?': 'Isu apa yang memengaruhi keberlangsungan aktivitas prioritas?',
  'Which products and activities are in scope and prioritised?': 'Produk dan aktivitas mana yang masuk ruang lingkup dan diprioritaskan?',
  'Show MTPD, RTO and RPO for each prioritised activity.': 'Tunjukkan MTPD, RTO dan RPO untuk setiap aktivitas prioritas.',
  'How were disruption risks assessed?': 'Bagaimana risiko gangguan dinilai?',
  'Which strategies and solutions were selected?': 'Strategi dan solusi mana yang dipilih?',
  'Are plans approved and current?': 'Apakah rencana sudah disetujui dan masih berlaku?',
  'When was this plan last exercised?': 'Kapan rencana ini terakhir diuji melalui latihan?',
  'Show exercise and operating records.': 'Tunjukkan rekaman latihan dan rekaman operasional.',
};

/** Indonesian phase names for the sample's English phase names. */
const PHASE_NAME_ID = {
  'Initiation & mandate': 'Inisiasi & mandat',
  'Context & scope': 'Konteks & ruang lingkup',
  'Leadership & policy': 'Kepemimpinan & kebijakan',
  'Risk assessment & SoA': 'Penilaian risiko & SoA',
  'Risk treatment & controls': 'Perlakuan risiko & kontrol',
  'Documentation': 'Dokumentasi',
  'Operation & awareness': 'Operasi & kepedulian',
  'Performance evaluation': 'Evaluasi kinerja',
  'Improvement & audit readiness': 'Peningkatan & kesiapan audit',
  'Performance evaluation & improvement': 'Evaluasi kinerja & peningkatan',
  'Risk & opportunity + process map': 'Risiko & peluang + peta proses',
  'Process controls & design': 'Kendali proses & desain',
  'ISO 9001:2026 transition': 'Transisi ISO 9001:2026',
  'BIA & risk assessment': 'BIA & penilaian risiko',
  'BC strategies & plans': 'Strategi & rencana BC',
  'Bribery risk assessment': 'Penilaian risiko penyuapan',
  'Anti-bribery controls': 'Kontrol anti-penyuapan',
};

/** Expected outcome text the sample shows for every activity (activity detail panel). */
const EXPECTED_OUTCOME_SUFFIX = ': approved and recorded in the register';

/** Cycle requirement codes per system and sample clause (`-` marks a non-clause item). */
const CYCLE_CODES = {
  isms: { '6.1.2': 'RISK_ASSESSMENT', '9.2': 'INTERNAL_AUDIT', '9.3': 'MGMT_REVIEW', '10.2': 'CORRECTIVE_ACTION', '9.1': 'PERFORMANCE_EVALUATION', '7.5.2': 'DOCUMENT_REVIEW' },
  qms: { '6.1': 'RISK_ASSESSMENT', '9.1.2': 'CUSTOMER_SATISFACTION', '9.2': 'INTERNAL_AUDIT', '9.3': 'MGMT_REVIEW', '10.2': 'CORRECTIVE_ACTION', '-': 'EDITION_TRANSITION' },
  bcms: { '8.2.2': 'BIA', '8.2.3': 'RISK_ASSESSMENT', '8.5': 'EXERCISE_PROGRAMME', '9.2': 'INTERNAL_AUDIT', '9.3': 'MGMT_REVIEW' },
  abms: { '4.5': 'RISK_ASSESSMENT', '5.1.1': 'GOVERNING_BODY_OVERSIGHT', '8.2': 'DUE_DILIGENCE', '9.4': 'COMPLIANCE_FUNCTION_REPORT' },
};

/** Drift rule kinds (G.7): row rules get a stored kind, `src` rules keep their own kind. */
const DRIFT_RULES = {
  risk12: {
    sourceKind: 'stale_risk', predicate: { months: 12 }, severity: 'risk', sourceStage: 'risk',
    message: 'Risks whose last assessment is more than 12 months old. Reassess them so the risk register reflects the current situation.',
  },
  dd: {
    sourceKind: 'dd_expired', predicate: {}, severity: 'risk', sourceStage: 'associate',
    message: 'Business associates whose due diligence has expired or was never done. Complete a new due diligence check.',
  },
  mr: {
    sourceKind: 'manual', predicate: {}, severity: 'risk', sourceStage: 'management_review',
    message: 'Mandatory management review inputs that are not prepared yet. Prepare them before the review is held.',
  },
  csat: {
    sourceKind: 'manual', predicate: {}, severity: 'warn', sourceStage: 'objective',
    message: 'Customer satisfaction results that have not been analysed in this cycle. Analyse them and record the outcome.',
  },
  unverif: {
    sourceKind: 'unverif', predicate: {}, severity: 'crit', sourceStage: 'evidence',
    message: 'Evidence files whose link can no longer be verified (changed, moved, missing or access revoked). Re-link the file or upload the correct version.',
  },
  metric: {
    sourceKind: 'metric', predicate: {}, severity: 'warn', sourceStage: 'metric',
    message: 'Metrics that have not been updated within their measurement period. Enter the missing values or review the metric.',
  },
  exercise: {
    sourceKind: 'exercise', predicate: {}, severity: 'risk', sourceStage: 'exercise',
    message: 'Business continuity plans without a scheduled exercise. Schedule an exercise within the programme period.',
  },
  nohash: {
    sourceKind: 'nohash', predicate: {}, severity: 'warn', sourceStage: 'evidence',
    message: 'Google-native evidence files without a content hash, so later changes cannot be detected. Store a fixed export or accept the limitation.',
  },
};

/**
 * Document tiers (lookup domain `doc_type`) in the order the document register groups
 * them, with the Indonesian names the sample uses. Every tier used by the sample documents
 * must be listed here.
 */
const DOC_TYPES = [
  ['Policy', 'Kebijakan'],
  ['Standard', 'Standar'],
  ['Procedure', 'Prosedur'],
  ['Plan', 'Rencana'],
  ['Register', 'Register'],
  ['Record', 'Rekaman'],
  ['Form', 'Formulir'],
];

/** Lookup domains (G.7): every pack, then the framework-specific ones. */
const LOOKUPS_COMMON = {
  treatment_option: [
    ['modify', 'Modify', 'Modifikasi'],
    ['retain', 'Retain', 'Pertahankan'],
    ['avoid', 'Avoid', 'Hindari'],
    ['share', 'Share', 'Berbagi'],
  ],
};
const LOOKUPS_BY_SYSTEM = {
  bcms: {
    exercise_type: [
      ['tabletop', 'Tabletop', 'Latihan meja'],
      ['walkthrough', 'Walkthrough', 'Penelusuran'],
      ['simulation', 'Simulation', 'Simulasi'],
      ['full', 'Full exercise', 'Latihan penuh'],
    ],
  },
  abms: {
    bribery_risk_level: [
      ['low', 'Low', 'Rendah'],
      ['medium', 'Medium', 'Sedang'],
      ['high', 'High', 'Tinggi'],
      ['very_high', 'Very high', 'Sangat tinggi'],
    ],
    due_diligence_subject: [
      ['associate', 'Business associate', 'Mitra bisnis'],
      ['position', 'Position', 'Posisi'],
      ['transaction', 'Transaction', 'Transaksi'],
      ['project', 'Project', 'Proyek'],
    ],
  },
};

/**
 * Rule activation. G.7 lists BR-01, BR-02 (ISO 27001 and ISO 37001 only), BR-10, BR-12,
 * BR-16, BR-21 to BR-23, BR-29 to BR-32 and BR-34 to BR-50. The rules of digest 6.2 that
 * A.5 (A-01) implements with scope ALL and that later work packages register (BR-03, BR-04,
 * BR-06 to BR-09, BR-11, BR-13 to BR-15, BR-17) are activated as well, so the rule engine
 * evaluates them; see the WP-04 handoff note.
 */
const RULES_G7 = [1, 10, 12, 16, 21, 22, 23, 29, 30, 31, 32, ...range(34, 50)];
const RULES_A01 = [3, 4, 6, 7, 8, 9, 11, 13, 14, 15, 17];
const RULES_RISK_JUSTIFIED = new Set(['isms', 'abms']); // BR-02 (digest 6.2: ISO27001, ISO37001)
const RULE_PARAMS = {
  // BR-03: justification phrases that are not meaningful, per language (digest 6.2, A-07).
  'BR-03': {
    phrases: {
      en: ['-', 'n/a', 'na', 'none', 'not applicable', 'not relevant', 'tbd'],
      id: ['-', 't/a', 'tidak ada', 'tidak berlaku', 'tidak relevan', 'belum ditentukan'],
    },
  },
};

/** Risk profiles (A-33 is open: labels, scale bounds and impact dimensions only). */
const RISK_PROFILES = {
  information_security: {
    label_en: 'Information security risk', label_id: 'Risiko keamanan informasi',
    likelihood_scale: { min: 1, max: 5 }, consequence_scale: { min: 1, max: 5 },
    impact_dimensions: ['confidentiality', 'integrity', 'availability'],
  },
  quality: {
    label_en: 'Risk or opportunity', label_id: 'Risiko atau peluang',
    likelihood_scale: { min: 1, max: 5 }, consequence_scale: { min: 1, max: 5 },
    impact_dimensions: [], allows_opportunity: true,
  },
  disruption: {
    label_en: 'Disruption risk', label_id: 'Risiko gangguan',
    likelihood_scale: { min: 1, max: 5 }, consequence_scale: { min: 1, max: 5 },
    impact_dimensions: [],
  },
  bribery: {
    label_en: 'Bribery risk', label_id: 'Risiko penyuapan',
    likelihood_scale: { min: 1, max: 5 }, consequence_scale: { min: 1, max: 5 },
    impact_dimensions: [], level_lookup_domain: 'bribery_risk_level',
    assessed_by: ['position', 'transaction', 'associate', 'region'],
  },
};

/** ISO 27001 audit activity templates, short titles written for this build (G.7). */
const ISO27001_AUDIT_ACTIVITIES = [
  {
    code: 'AA-S1-01', event_type: 'stage1', clause_ref: '4.3', title: 'Review ISMS scope and context',
    auditee_role: 'ISMS Manager',
    key_questions: 'Are the scope, boundaries and interfaces documented and consistent with the context and interested parties?',
    evidence_to_request: 'Scope statement; register of context issues and interested parties',
  },
  {
    code: 'AA-S1-02', event_type: 'stage1', clause_ref: '6.1', title: 'Review risk method and Statement of Applicability',
    auditee_role: 'ISMS Manager',
    key_questions: 'Is the risk method repeatable, and does every control decision trace to a risk or a stated reason?',
    evidence_to_request: 'Risk assessment method; risk register; Statement of Applicability',
  },
  {
    code: 'AA-S1-03', event_type: 'stage1', clause_ref: '9.2', title: 'Confirm audit programme and management review plan',
    auditee_role: 'ISMS Manager',
    key_questions: 'Are an internal audit and a management review planned or held before Stage 2?',
    evidence_to_request: 'Internal audit programme; management review plan or minutes',
  },
  {
    code: 'AA-S2-01', event_type: 'stage2', clause_ref: '5.1', title: 'Interview top management on leadership',
    auditee_role: 'Top Management',
    key_questions: 'How does top management set the policy and objectives, provide resources and review results?',
    evidence_to_request: 'Approved policy; objectives; management review decisions',
  },
  {
    code: 'AA-S2-02', event_type: 'stage2', clause_ref: '8.1', title: 'Sample controls in operation',
    auditee_role: 'Domain Owner',
    key_questions: 'Does evidence from the current cycle show each sampled control operating as the Statement of Applicability says?',
    evidence_to_request: 'Operating records of the sampled controls; linked procedures',
  },
  {
    code: 'AA-S2-03', event_type: 'stage2', clause_ref: '10.2', title: 'Follow up nonconformities and corrective actions',
    auditee_role: 'ISMS Manager',
    key_questions: 'Were causes analysed and were corrective actions verified as effective before closure?',
    evidence_to_request: 'Nonconformity register; root cause analyses; effectiveness checks',
  },
];

/** ISO 27001 finding conditions, short titles written for this build (G.7). */
const ISO27001_FINDING_CONDITIONS = [
  { code: 'FC-01', classification: 'major', requirement_code: '8.2', text: 'No information security risk assessment performed for the scope' },
  { code: 'FC-02', classification: 'major', requirement_code: '9.2', text: 'Internal audit programme not carried out within the cycle' },
  { code: 'FC-03', classification: 'minor', requirement_code: '6.1', text: 'Control decision in the Statement of Applicability without a risk-based justification' },
  { code: 'FC-04', classification: 'minor', requirement_code: '7.5', text: 'Controlled document used after its review date' },
  { code: 'FC-05', classification: 'minor', requirement_code: '10.2', text: 'Corrective action closed without an effectiveness check' },
  { code: 'FC-06', classification: 'ofi', requirement_code: '9.1', text: 'Performance metrics without target values' },
];

/** Systems whose packs carry the generic audit activities and finding conditions. */
const AUDIT_CONTENT_SYSTEMS = new Set(['isms']);

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function fail(message) {
  throw new Error(message);
}

function ruleId(n) {
  return 'BR-' + String(n).padStart(2, '0');
}

/** Days between two ISO dates (b minus a), computed in UTC so no time zone shifts the result. */
function daysBetween(a, b) {
  const ms = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86400000);
}

function lookupCode(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function pair(value, what) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== 'string')) {
    fail(`${what} is not an [en, id] pair`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------
// Dataset builders
// ---------------------------------------------------------------------------------------

function buildPack(S, def) {
  const ms = S.MS.find((m) => m.id === def.ms) ?? fail(`sample MS "${def.ms}" not found`);
  checkPackAgainstSample(S, def, ms);

  const files = new Map();
  const requirements = requirementRows(S, ms);
  const catalogue = ms.unit === 'ctrl' ? catalogueRows(S, ms) : [];
  const chain = chainRows(S, ms);
  const lookups = lookupRows(S, ms);

  files.set('manifest.json', toJson(manifest(def, ms)));
  files.set('requirements.csv', toCsv(CSV_HEADERS['requirements.csv'], requirements));
  files.set('catalogue.csv', toCsv(CSV_HEADERS['catalogue.csv'], catalogue));
  files.set('chain.csv', toCsv(CSV_HEADERS['chain.csv'], chain));
  files.set('activities.csv', toCsv(CSV_HEADERS['activities.csv'], activityRows(S, ms)));
  files.set('frequencies.csv', toCsv(CSV_HEADERS['frequencies.csv'], frequencyRows(S)));
  const labels = labelSets(ms);
  files.set('labels.en.json', toJson(labels.en));
  files.set('labels.id.json', toJson(labels.id));
  files.set('cycle_requirements.csv', toCsv(CSV_HEADERS['cycle_requirements.csv'], cycleRows(S, ms)));
  files.set('drift_rules.json', toJson(driftRules(S, ms)));
  files.set('prep_tasks.csv', toCsv(CSV_HEADERS['prep_tasks.csv'], prepRows(S, ms)));
  files.set('review_inputs.csv', toCsv(CSV_HEADERS['review_inputs.csv'], []));
  const auditContent = AUDIT_CONTENT_SYSTEMS.has(ms.id);
  files.set('finding_conditions.csv', toCsv(CSV_HEADERS['finding_conditions.csv'], auditContent ? ISO27001_FINDING_CONDITIONS : []));
  files.set('document_templates.csv', toCsv(CSV_HEADERS['document_templates.csv'], []));
  files.set('audit_activities.csv', toCsv(CSV_HEADERS['audit_activities.csv'],
    auditContent ? ISO27001_AUDIT_ACTIVITIES.map((a, i) => ({ ...a, sort_order: i + 1 })) : []));
  files.set('lookups.csv', toCsv(CSV_HEADERS['lookups.csv'], lookups));
  files.set('rules.json', toJson(rules(ms)));
  files.set('risk_profiles.json', toJson(riskProfiles(chain)));

  if (auditContent) {
    const codes = new Set(requirements.map((r) => r.requirement_code));
    for (const c of ISO27001_FINDING_CONDITIONS) {
      if (!codes.has(c.requirement_code)) fail(`finding condition ${c.code} names requirement ${c.requirement_code}, which ${def.packId} does not hold`);
    }
  }
  return files;
}

/** Stops when the hard-coded pack set no longer matches the sample's pack cards. */
function checkPackAgainstSample(S, def, ms) {
  const card = S.PACKS[ms.id] ?? fail(`sample PACKS has no entry for ${ms.id}`);
  const eds = Array.isArray(card.eds) ? card.eds[0] : card.eds;
  if (def.status === 'withdrawn') {
    if (!eds.includes(`${def.edition} withdrawn`)) fail(`${def.packId}: sample PACKS.${ms.id}.eds does not list edition ${def.edition} as withdrawn`);
  } else {
    if (!card.v.split(', ').some((v) => v.startsWith(def.version))) fail(`${def.packId}: version ${def.version} is not in sample PACKS.${ms.id}.v "${card.v}"`);
    if (!ms.ed.includes(def.edition)) fail(`${def.packId}: edition ${def.edition} is not in sample MS ${ms.id} ed "${ms.ed}"`);
  }
  if (def.preRelease !== card.v.includes('(beta)')) fail(`${def.packId}: pre_release does not match sample PACKS.${ms.id}.v "${card.v}"`);
  if (def.supersedes && !eds.includes(`${def.supersedes.edition} in transition`)) {
    fail(`${def.packId}: sample PACKS.${ms.id}.eds does not list edition ${def.supersedes.edition} in transition`);
  }
}

function manifest(def, ms) {
  const m = {
    pack_id: def.packId,
    pack_version: def.version,
    framework_code: def.frameworkCode,
    framework_name: ms.code,
    edition: def.edition,
    status: def.status,
    pre_release: def.preRelease,
  };
  if (def.supersedes) m.supersedes = { edition: def.supersedes.edition, transition_ends: def.supersedes.transition_ends };
  m.engine_min_version = ENGINE_MIN_VERSION;
  // Framework workbenches are deferred (Appendix 1), so no pack enables a module yet.
  m.modules = [];
  m.applicability_target = ms.unit === 'ctrl' ? 'catalogue_item' : 'requirement';
  m.catalogue = ms.unit === 'ctrl';
  return m;
}

/** Harmonized Structure entries of the sample QMS list: every clause except 8. */
function hsEntries(S) {
  const qms = S.MS.find((m) => m.id === 'qms') ?? fail('sample MS "qms" not found');
  return S.buildReqs(qms).filter((r) => r.key.split('.')[0] !== '8').map((r) => ({ key: r.key, title: r.title }));
}

function requirementRows(S, ms) {
  const hs = hsEntries(S);
  const hsCodes = new Set(hs.map((r) => r.key));
  let list;
  if (ms.unit === 'ctrl') {
    // ISO 27001: the Harmonized Structure list plus its own clause 8 entries.
    list = [...hs, ...ISO27001_CLAUSE_8.map(([key, title]) => ({ key, title }))].map((r) => ({ ...r, freq: null }));
  } else {
    list = S.buildReqs(ms).map((r) => ({ key: r.key, title: r.title, freq: r.freq }));
  }
  const seen = new Set();
  for (const r of list) {
    if (seen.has(r.key)) fail(`${ms.id}: requirement ${r.key} appears twice`);
    seen.add(r.key);
    if (r.freq && !S.FREQ[r.freq]) fail(`${ms.id}: requirement ${r.key} has unknown frequency ${r.freq}`);
  }
  const documented = new Set([...DOCUMENTED_INFO_HS, ...(DOCUMENTED_INFO_EXTRA[ms.id] ?? [])]);
  return [...list].sort((a, b) => compareCodes(a.key, b.key)).map((r, i) => {
    const group = r.key.split('.')[0];
    return {
      requirement_code: r.key,
      parent_code: null,
      title_short: r.title,
      clause_group: group,
      is_hs_common: hsCodes.has(r.key) || (r.key === HS_CLAUSE_8[0] && r.title === HS_CLAUSE_8[1]),
      documented_info_mandatory: documented.has(r.key),
      applicability_assessable: group === '8' && CLAUSE_8_ASSESSABLE.has(ms.id),
      default_frequency_code: r.freq,
      // Evidence examples belong to the catalogue (G.7); requirement keys repeat Annex A keys.
      evidence_example: null,
      sort_order: i + 1,
    };
  });
}

function catalogueRows(S, ms) {
  const items = S.buildReqs(ms);
  const keys = new Set(items.map((c) => c.key));
  for (const key of Object.keys(S.EXAMPLES)) {
    if (!keys.has(key)) fail(`sample EXAMPLES key ${key} is not a ${ms.id} catalogue item`);
  }
  return items.map((c, i) => {
    const [themeCode, ...rest] = c.theme.split(' ');
    const themeNo = themeCode.replace(/^A\./, '');
    if (rest.join(' ') !== ms.theme[themeNo]) fail(`${ms.id}: catalogue item ${c.id} theme "${c.theme}" does not match MS.theme`);
    if (!S.FREQ[c.freq]) fail(`${ms.id}: catalogue item ${c.id} has unknown frequency ${c.freq}`);
    return {
      item_code: c.id,
      theme_code: themeCode,
      title_short: c.title,
      requirement_code: null,
      default_frequency_code: c.freq,
      evidence_example: S.EXAMPLES[c.key] ?? null,
      sort_order: i + 1,
    };
  });
}

function chainRows(S, ms) {
  const stages = S.STAGES[ms.id] ?? fail(`sample STAGES has no entry for ${ms.id}`);
  return stages.map((st, i) => {
    const label = pair(st.l, `STAGES.${ms.id}.${st.id}.l`);
    let source;
    let entityType = null;
    let riskProfile = null;
    if (st.src) {
      source = STAGE_SOURCE[st.src] ?? fail(`${ms.id}: stage ${st.id} has unknown src ${st.src}`);
      // Explicit records of the justification stage live in chain_record (G.7, C.10).
      if (source === 'justification') entityType = 'chain_record';
    } else {
      const ent = STAGE_ENTITY[st.id] ?? fail(`${ms.id}: no record table for stage ${st.id}`);
      source = 'entity';
      entityType = ent.entityType;
      if (ent.riskProfile) riskProfile = ent.riskProfile[ms.id] ?? fail(`${ms.id}: no risk profile for stage ${st.id}`);
    }
    const q = st.q ?? '';
    const qId = q === '' ? '' : QUESTION_ID[q] ?? fail(`${ms.id}: no Indonesian text for stage question "${q}"`);
    const gate = GATE_TYPE_LABEL[st.id] ?? null;
    return {
      stage_key: st.id,
      position: i + 1,
      label_en: label[0],
      label_id: label[1],
      question_en: q,
      question_id: qId,
      source,
      entity_type: entityType,
      risk_profile_code: riskProfile,
      is_mandatory: true,
      clause_at_risk: S.CLAUSE_AT_RISK[st.id] ?? null,
      overview_clause: OVERVIEW_CLAUSE[st.id] ?? 8,
      gate_type_label_en: gate ? gate[0] : null,
      gate_type_label_id: gate ? gate[1] : null,
    };
  });
}

/** The sample's output rule: the first OUTPUT_MAP keyword contained in the title (case-insensitive). */
function outputDocument(S, title) {
  const hit = S.OUTPUT_MAP.find(([k]) => title.toLowerCase().includes(k.toLowerCase()));
  return hit ? hit[1] : null;
}

function activityRows(S, ms) {
  const phases = S.PHASES[ms.id] ?? fail(`sample PHASES has no entry for ${ms.id}`);
  const rows = [];
  phases.forEach((p, pi) => {
    const nameId = PHASE_NAME_ID[p.n] ?? fail(`${ms.id}: no Indonesian name for phase "${p.n}"`);
    p.acts.forEach((title, ai) => {
      rows.push({
        phase_no: pi + 1,
        phase_name_en: p.n,
        phase_name_id: nameId,
        is_gate_phase: !!p.gate,
        activity_no: ai + 1,
        title,
        clause_ref: null,
        output_document_code: outputDocument(S, title),
        expected_outcome: title + EXPECTED_OUTCOME_SUFFIX,
      });
    });
  });
  return rows;
}

function frequencyRows(S) {
  const order = S.FREQ_ORDER;
  if (order.length !== Object.keys(S.FREQ).length || order.some((c) => !S.FREQ[c])) fail('sample FREQ_ORDER and FREQ differ');
  return order.map((code, i) => {
    const [en, id, days] = S.FREQ[code];
    return { code, label_en: en, label_id: id, period_days: days, sort_order: i + 1 };
  });
}

function labelSets(ms) {
  const l = LABELS[ms.id] ?? fail(`no labels for ${ms.id}`);
  const longName = pair(ms.name, `MS.${ms.id}.name`);
  const en = {
    'ms.name': ms.short,
    'ms.long_name': longName[0],
    'ms.manager_role': ms.mgrRole,
    'gate.name': l.gate[0],
    'applicability.artefact_name': l.artefact[0],
    'risk.object_name': l.riskObject[0],
  };
  const id = {
    'ms.name': ms.short,
    'ms.long_name': longName[1],
    'ms.manager_role': l.managerRoleId,
    'gate.name': l.gate[1],
    'applicability.artefact_name': l.artefact[1],
    'risk.object_name': l.riskObject[1],
  };
  if (ms.theme) {
    for (const [no, name] of Object.entries(ms.theme)) {
      en[`catalogue.theme.${no}`] = name;
      id[`catalogue.theme.${no}`] = THEME_ID[name] ?? fail(`no Indonesian name for theme "${name}"`);
    }
  }
  return { en, id };
}

function cycleRows(S, ms) {
  const items = S.CYCLE_ITEMS[ms.id] ?? fail(`sample CYCLE_ITEMS has no entry for ${ms.id}`);
  const codes = CYCLE_CODES[ms.id] ?? {};
  return items.map(([clause, title], i) => ({
    code: codes[clause] ?? fail(`${ms.id}: no cycle requirement code for clause ${clause} ("${title}")`),
    requirement_code: clause === '-' ? null : clause,
    title,
    // No derivation: cycle.derive keeps the seeded statuses (G.7).
    derivation: null,
    sort_order: i + 1,
  }));
}

function driftRules(S, ms) {
  const defs = S.DRIFT[ms.id] ?? fail(`sample DRIFT has no entry for ${ms.id}`);
  return defs.map((r, i) => {
    const d = DRIFT_RULES[r.id] ?? fail(`${ms.id}: no drift rule kind for sample rule ${r.id}`);
    if (r.src && r.src !== d.sourceKind) fail(`${ms.id}: drift rule ${r.id} has src ${r.src}, expected ${d.sourceKind}`);
    if (!r.src && !Array.isArray(r.rows)) fail(`${ms.id}: drift rule ${r.id} has neither src nor rows`);
    const label = pair(r.l, `DRIFT.${ms.id}.${r.id}.l`);
    return {
      code: r.id,
      label_en: label[0],
      label_id: label[1],
      severity: d.severity,
      source_stage: d.sourceStage,
      source_kind: d.sourceKind,
      predicate: d.predicate,
      message: d.message,
      sort_order: i + 1,
    };
  });
}

function prepRows(S, ms) {
  const tasks = S.PREP[ms.id] ?? fail(`sample PREP has no entry for ${ms.id}`);
  if (!tasks.length) return [];
  const eventDate = ms.audit?.date ?? fail(`${ms.id}: PREP tasks without a next audit event`);
  return tasks.map(([title, , due], i) => {
    const days = daysBetween(due, eventDate);
    if (days <= 0) fail(`${ms.id}: prep task "${title}" is not due before the audit`);
    return {
      code: 'PREP-' + String(i + 1).padStart(2, '0'),
      title,
      days_before_audit: days,
      // BR-44: finding-closure tasks are skipped on a system's first audit.
      skip_on_first_audit: /\b(NC|OFI)-\d{4}-\d+\b/.test(title),
      sort_order: i + 1,
    };
  });
}

function lookupRows(S, ms) {
  const used = new Set([...Object.values(S.DOCS).flat(), ...S.SHARED].map((d) => d[2]));
  for (const tier of used) {
    if (!DOC_TYPES.some(([en]) => en === tier)) fail(`sample document tier "${tier}" is not in DOC_TYPES`);
  }
  const domains = {
    doc_type: DOC_TYPES.map(([en, id]) => [lookupCode(en), en, id]),
    ...LOOKUPS_COMMON,
    ...(LOOKUPS_BY_SYSTEM[ms.id] ?? {}),
  };
  const rows = [];
  for (const [domain, values] of Object.entries(domains)) {
    values.forEach(([code, en, id], i) => rows.push({ domain, code, label_en: en, label_id: id, sort_order: i + 1 }));
  }
  return rows;
}

function rules(ms) {
  const ids = [...RULES_G7, ...RULES_A01];
  if (RULES_RISK_JUSTIFIED.has(ms.id)) ids.push(2);
  return [...new Set(ids)].sort((a, b) => a - b).map((n) => {
    const id = ruleId(n);
    return { rule_id: id, active: true, params: RULE_PARAMS[id] ?? {} };
  });
}

function riskProfiles(chain) {
  const codes = [...new Set(chain.map((s) => s.risk_profile_code).filter(Boolean))];
  return codes.map((code) => ({ code, definition: RISK_PROFILES[code] ?? fail(`no definition for risk profile ${code}`) }));
}

// ---------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------

/** Every generated file as a map from a path relative to packs/sources to its content. */
async function generate() {
  const S = await import(pathToFileURL(SAMPLE_FILE).href);
  const out = new Map();
  for (const def of PACK_DEFS) {
    for (const [file, content] of buildPack(S, def)) out.set(`${def.packId}/${file}`, content);
  }
  return out;
}

/** Files under a folder as paths relative to it, with forward slashes, sorted. */
function listFiles(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function check(generated) {
  const problems = [];
  for (const [rel, content] of generated) {
    const file = path.join(SOURCES_DIR, rel);
    if (!existsSync(file)) problems.push(`missing: packs/sources/${rel}`);
    else if (readFileSync(file, 'utf8') !== content) problems.push(`differs: packs/sources/${rel}`);
  }
  for (const rel of listFiles(SOURCES_DIR)) {
    if (!generated.has(rel)) problems.push(`not generated: packs/sources/${rel}`);
  }
  if (problems.length) {
    console.error(`packs/sources is out of date with the sample (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) console.error('  ' + p);
    console.error('Run: node packs/scripts/extract-from-sample.mjs');
    return 1;
  }
  console.log(`packs/sources matches the sample: ${generated.size} files in ${PACK_DEFS.length} packs`);
  return 0;
}

function write(generated) {
  let written = 0;
  for (const [rel, content] of generated) {
    const file = path.join(SOURCES_DIR, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
    writeFileSync(file, content);
    written += 1;
  }
  // The folder belongs to this script: remove what it no longer produces.
  const removed = [];
  for (const rel of listFiles(SOURCES_DIR)) {
    if (!generated.has(rel)) {
      rmSync(path.join(SOURCES_DIR, rel));
      removed.push(rel);
    }
  }
  removeEmptyDirs(SOURCES_DIR);
  for (const rel of removed) console.log(`removed packs/sources/${rel}`);
  console.log(`packs/sources: ${generated.size} files in ${PACK_DEFS.length} packs (${written} written, ${generated.size - written} unchanged, ${removed.length} removed)`);
  return 0;
}

function removeEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      removeEmptyDirs(full);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    }
  }
}

async function main(argv) {
  let checkMode = false;
  for (const arg of argv) {
    if (arg === '--check') checkMode = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`Unknown option: ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  const generated = await generate();
  return checkMode ? check(generated) : write(generated);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`extract-from-sample: ${err.message}`);
  process.exitCode = 1;
}
