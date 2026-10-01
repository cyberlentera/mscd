// Loaders of the read model (build plan WP-17, D-05): the rows of one or every system of the transaction's
// organisation in a fixed number of queries, one per table group, never one per record (no N+1). Everything runs in
// the caller's tenant transaction (D-03); person columns come back as handles.
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../../../common/tokens';
import type { AuditEventRow, CycleItemRow, FindingRow, PrepTaskRow } from '../derive/audit';
import type { DriftResultRow, DriftRuleDefRow } from '../derive/drift';
import type { ThresholdRow } from '../derive/freshness';
import type { ActivityRow, ChainRecordRow, DocumentRow, EntryRow, EvidenceRow, FrequencyDef, StageDef, StorageObjectRow } from '../derive/inputs';
import type { AlertRow, PackLabels, VersionInfo } from '../derive/ms-fields';
import type { CatalogEntry } from '../derive/org-formats';

/** The core of one system: everything `GET /ui/org` needs (G.5 `MS[]`, `STAGES`, `CHAINS`, `TITLES`, ...). */
export interface SystemCore {
  id: string;
  slug: string;
  code: string;
  name: string;
  scope: string;
  certificationBody: string | null;
  color: string;
  status: string;
  display: Record<string, unknown>;
  position: number;
  defaultRepository: { id: string; slug: string; name: string; adapter: 'managed_vault' | 'm365' | 'google_drive' | 'smb' | 's3' | 'webdav' };
  active: VersionInfo;
  target: VersionInfo | null;
  labels: PackLabels;
  stages: StageDef[];
  frequencies: FrequencyDef[];
  docTypes: Record<string, string>;
  driftDefs: DriftRuleDefRow[];
  primaryManager: string | null;
  alerts: AlertRow[];
  readiness: Map<number, number>;
  findings: FindingRow[];
  events: AuditEventRow[];
  defaultRoute: { mode: 'stored' | 'pass_through' | 'link' | 'zero_transit'; note: string | null; repositoryName: string } | null;
  /** Every chain record of the system's entity and justification stages (open and ready), by table and position. */
  records: LoadedChainRecord[];
  entryCount: number;
  chains: { id: string; nodes: [string, string | null][] }[];
  /** Approver of the system's own documents (the first by position that names one). */
  approver: string | null;
  /** Evidence examples of the active version by requirement key (`EXAMPLES`). */
  examples: Record<string, string>;
}

/** The bundle rows of one system (`GET /ui/ms/{ms}`). */
export interface SystemBundleRows {
  entries: EntryRow[];
  documents: DocumentRow[];
  evidence: EvidenceRow[];
  activities: ActivityRow[];
  prepTasks: PrepTaskRow[];
  cycleItems: CycleItemRow[];
  latestCycleId: string | null;
  driftResults: DriftResultRow[];
  /** Ids of rows that the snapshot refs need (`<kind>:<business id>` to row), filled by the builders. */
  thresholds: ThresholdRow[];
}

export interface SystemData extends SystemCore {
  bundle: SystemBundleRows | null;
}

export interface OrgData {
  systems: SystemData[];
  /** Every installed version of the frameworks the systems use (pack cards list the installed editions). */
  frameworkVersions: VersionInfo[];
  catalog: CatalogEntry[];
}

export interface LoadOptions {
  /** Load only these systems (slugs); default every system of the organisation. */
  slugs?: readonly string[];
  /** Also load the bundle rows (requirements, documents, evidence, phases, cycle). */
  bundle: boolean;
  /** The request's clock (role grants past `valid_until` do not count); default the database time. */
  now?: Date;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** `(select handle ...)` of a person column, so rows carry handles. */
function handleOf(column: string): RawBuilder<string | null> {
  return sql<string | null>`(select u.handle from platform.app_user u where u.id = ${sql.ref(column)})`;
}

function uuids(ids: readonly string[]): RawBuilder<string[]> {
  return sql<string[]>`${[...ids]}::uuid[]`;
}

function group<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------

interface SystemRow {
  id: string;
  slug: string;
  code: string;
  name: string;
  scope_statement: string;
  certification_body: string | null;
  color: string;
  status: string;
  display: Record<string, unknown> | null;
  position: number;
  framework_version_id: string;
  transition_target_version_id: string | null;
  repo_id: string;
  repo_slug: string;
  repo_name: string;
  repo_adapter: SystemCore['defaultRepository']['adapter'];
}

interface VersionRow {
  id: string;
  framework_id: string;
  framework_code: string;
  framework_name: string;
  edition: string;
  pack_id: string;
  pack_version: string;
  status: VersionInfo['status'];
  pre_release: boolean;
  applicability_target: VersionInfo['applicabilityTarget'];
  installed_at: Date;
}

function versionInfo(r: VersionRow): VersionInfo {
  return {
    id: r.id,
    frameworkCode: r.framework_code,
    frameworkName: r.framework_name,
    edition: r.edition,
    packId: r.pack_id,
    packVersion: r.pack_version,
    status: r.status,
    preRelease: r.pre_release,
    applicabilityTarget: r.applicability_target,
    installedAt: r.installed_at,
  };
}

/** Loads the organisation's systems (or the requested ones) with their reference content and stored rows. */
export async function loadOrgData(trx: Trx, options: LoadOptions): Promise<OrgData> {
  const slugFilter = options.slugs ? sql`and ms.slug = any(${[...options.slugs]}::text[])` : sql``;
  const systemRows = (
    await sql<SystemRow>`
      select ms.id, ms.slug, ms.code, ms.name, ms.scope_statement, ms.certification_body, ms.color, ms.status, ms.display,
             ms.position, ms.framework_version_id, ms.transition_target_version_id,
             r.id as repo_id, r.slug as repo_slug, r.name as repo_name, r.adapter as repo_adapter
      from management_system ms
      join storage_repository r on r.id = ms.default_storage_repository_id
      where ms.deleted_at is null ${slugFilter}
      order by ms.position, ms.slug`.execute(trx)
  ).rows;
  if (systemRows.length === 0) {
    const catalog = await loadCatalog(trx);
    return { systems: [], frameworkVersions: [], catalog };
  }
  const msIds = systemRows.map((s) => s.id);
  const activeIds = [...new Set(systemRows.map((s) => s.framework_version_id))];

  // Reference content of the active versions, and every installed version of the same frameworks.
  const versions = (
    await sql<VersionRow>`
      select fv.id, fv.framework_id, f.code as framework_code, f.name as framework_name, fv.edition, fv.pack_id, fv.pack_version,
             fv.status, fv.pre_release, fv.applicability_target, fv.installed_at
      from ref.framework_version fv join ref.framework f on f.id = fv.framework_id
      where fv.framework_id in (select framework_id from ref.framework_version where id = any(${uuids(activeIds)}))
      order by f.code, fv.edition`.execute(trx)
  ).rows.map((r) => ({ row: r, info: versionInfo(r) }));
  const versionById = new Map(versions.map((v) => [v.row.id, v.info]));

  const labelRows = (
    await sql<{ framework_version_id: string; key: string; lang: 'en' | 'id'; value: string }>`
      select framework_version_id, key, lang, value from ref.label where framework_version_id = any(${uuids(activeIds)})`.execute(trx)
  ).rows;
  const stageRows = (
    await sql<{
      framework_version_id: string; stage_key: string; position: number; label_en: string; label_id: string; auditor_question_en: string;
      source: StageDef['source']; entity_type: string | null; risk_profile_code: string | null; clause_at_risk: string | null;
      overview_clause: number; gate_type_label_en: string | null; gate_type_label_id: string | null;
    }>`
      select framework_version_id, stage_key, position, label_en, label_id, auditor_question_en, source, entity_type, risk_profile_code,
             clause_at_risk, overview_clause, gate_type_label_en, gate_type_label_id
      from ref.traceability_chain_def where framework_version_id = any(${uuids(activeIds)}) order by position`.execute(trx)
  ).rows;
  const frequencyRows = (
    await sql<{ framework_version_id: string; code: string; label_en: string; label_id: string; period_days: number; sort_order: number }>`
      select framework_version_id, code, label_en, label_id, period_days, sort_order
      from ref.evidence_frequency_rule where framework_version_id = any(${uuids(activeIds)}) order by sort_order, code`.execute(trx)
  ).rows;
  const docTypeRows = (
    await sql<{ framework_version_id: string; code: string; label_en: string }>`
      select framework_version_id, code, label_en from ref.lookup_value
      where framework_version_id = any(${uuids(activeIds)}) and domain = 'doc_type' order by sort_order`.execute(trx)
  ).rows;
  const driftRows = (
    await sql<{
      framework_version_id: string; code: string; label_en: string; label_id: string; source_kind: DriftRuleDefRow['sourceKind'];
      source_stage: string | null; predicate: Record<string, unknown> | null; sort_order: number;
    }>`
      select framework_version_id, code, label_en, label_id, source_kind, source_stage, predicate, sort_order
      from ref.drift_rule_def where framework_version_id = any(${uuids(activeIds)}) order by sort_order, code`.execute(trx)
  ).rows;
  const exampleRows = (
    await sql<{ framework_version_id: string; key: string; example: string }>`
      select framework_version_id, regexp_replace(item_code, '^A\\.', '') as key, evidence_example as example
      from ref.catalogue_item where framework_version_id = any(${uuids(activeIds)}) and coalesce(evidence_example, '') <> ''
      union all
      select framework_version_id, requirement_code as key, evidence_example as example
      from ref.requirement where framework_version_id = any(${uuids(activeIds)}) and coalesce(evidence_example, '') <> ''`.execute(trx)
  ).rows;

  // Stored rows of the systems.
  const managers = (
    await sql<{ management_system_id: string; handle: string | null }>`
      select r.management_system_id, ${handleOf('r.user_id')} as handle
      from user_ms_role r
      where r.management_system_id = any(${uuids(msIds)}) and r.role = 'ms_manager' and r.is_primary
        and r.deleted_at is null and r.approval_status = 'active'
        and (r.valid_until is null or r.valid_until > ${options.now ?? sql`now()`})`.execute(trx)
  ).rows;
  const alertRows = (
    await sql<{ management_system_id: string; kind: AlertRow['kind']; tone: AlertRow['tone']; text_en: string; text_id: string; raised_at: Date }>`
      select management_system_id, kind, tone, text_en, text_id, raised_at from ms_alert
      where management_system_id = any(${uuids(msIds)}) and resolved_at is null and deleted_at is null`.execute(trx)
  ).rows;
  const readinessRows = (
    await sql<{ management_system_id: string; clause_group: number; readiness_pct: number }>`
      select management_system_id, clause_group, readiness_pct from clause_readiness
      where management_system_id = any(${uuids(msIds)}) and deleted_at is null`.execute(trx)
  ).rows;
  const findingRows = (
    await sql<{
      id: string; management_system_id: string; code: string; title: string; classification: FindingRow['classification'];
      clause_ref: string | null; source: FindingRow['source']; status: FindingRow['status']; status_note: string | null; position: number;
    }>`
      select id, management_system_id, code, title, classification, clause_ref, source, status, status_note, position from finding
      where management_system_id = any(${uuids(msIds)}) and deleted_at is null order by position, code`.execute(trx)
  ).rows;
  const eventRows = (
    await sql<{
      id: string; management_system_id: string; updated_at: Date; scheduled_at: string; audit_days: number | null; short_label: string;
      name_en: string; name_id: string; lead_auditor_name: string | null; expected_focus: string | null; prep_window_days: number;
      outcome_summary: string | null;
    }>`
      select id, management_system_id, updated_at, scheduled_at, audit_days, short_label, name_en, name_id, lead_auditor_name,
             expected_focus, prep_window_days, outcome_summary
      from audit_event where management_system_id = any(${uuids(msIds)}) and deleted_at is null order by scheduled_at, id`.execute(trx)
  ).rows;
  const routeRows = (
    await sql<{ management_system_id: string; mode: NonNullable<SystemCore['defaultRoute']>['mode']; note: string | null; repository_name: string }>`
      select rr.management_system_id, rr.mode, rr.note, r.name as repository_name
      from storage_routing_rule rr join storage_repository r on r.id = rr.storage_repository_id
      where rr.management_system_id = any(${uuids(msIds)}) and rr.classification is null and rr.object_kind is null
        and rr.approval_status = 'active' and rr.deleted_at is null
      order by rr.priority, rr.created_at`.execute(trx)
  ).rows;
  const records = await loadChainRecords(trx, msIds);
  const entryCounts = (
    await sql<{ management_system_id: string; n: number }>`
      select management_system_id, count(*)::int as n from applicability_entry
      where management_system_id = any(${uuids(msIds)}) and deleted_at is null group by management_system_id`.execute(trx)
  ).rows;
  const chainRows = (
    await sql<{ management_system_id: string; anchor_code: string; instance_position: number; node_position: number | null; stage_key: string | null; record_code: string | null }>`
      select i.management_system_id, i.anchor_code, i.position as instance_position, n.position as node_position, n.stage_key, n.record_code
      from trace_chain_instance i
      left join trace_chain_node n on n.trace_chain_instance_id = i.id and n.deleted_at is null
      where i.management_system_id = any(${uuids(msIds)}) and i.deleted_at is null
      order by i.position, i.anchor_code, n.position`.execute(trx)
  ).rows;
  const approverRows = (
    await sql<{ management_system_id: string; handle: string | null }>`
      select distinct on (l.management_system_id) l.management_system_id, ${handleOf('d.approver_user_id')} as handle
      from entity_ms_link l join document d on d.id = l.entity_id and d.deleted_at is null
      where l.entity_type = 'document' and l.is_primary and l.deleted_at is null and l.management_system_id = any(${uuids(msIds)})
        and not d.is_org_wide and d.approver_user_id is not null
      order by l.management_system_id, d.position, d.doc_code`.execute(trx)
  ).rows;
  const catalog = await loadCatalog(trx);

  const labelsByVersion = group(labelRows, (r) => r.framework_version_id);
  const stagesByVersion = group(stageRows, (r) => r.framework_version_id);
  const frequenciesByVersion = group(frequencyRows, (r) => r.framework_version_id);
  const docTypesByVersion = group(docTypeRows, (r) => r.framework_version_id);
  const driftByVersion = group(driftRows, (r) => r.framework_version_id);
  const examplesByVersion = group(exampleRows, (r) => r.framework_version_id);
  const managersByMs = new Map(managers.map((m) => [m.management_system_id, m.handle]));
  const alertsByMs = group(alertRows, (r) => r.management_system_id);
  const readinessByMs = group(readinessRows, (r) => r.management_system_id);
  const findingsByMs = group(findingRows, (r) => r.management_system_id);
  const eventsByMs = group(eventRows, (r) => r.management_system_id);
  const routesByMs = group(routeRows, (r) => r.management_system_id);
  const recordsByMs = group(records, (r) => r.msId);
  const entryCountByMs = new Map(entryCounts.map((r) => [r.management_system_id, num(r.n)]));
  const chainsByMs = group(chainRows, (r) => r.management_system_id);
  const approverByMs = new Map(approverRows.map((r) => [r.management_system_id, r.handle]));

  const bundles = options.bundle ? await loadBundles(trx, systemRows) : new Map<string, SystemBundleRows>();

  const systems: SystemData[] = systemRows.map((s) => {
    const active = versionById.get(s.framework_version_id);
    if (!active) throw new Error(`Management system ${s.slug}: framework version ${s.framework_version_id} is not installed`);
    const labels: Record<string, [string, string]> = {};
    for (const l of labelsByVersion.get(s.framework_version_id) ?? []) {
      const current = labels[l.key] ?? [l.value, l.value];
      if (l.lang === 'en') {
        const hadId = l.key in labels && current[1] !== current[0];
        labels[l.key] = [l.value, hadId ? current[1] : l.value];
      } else {
        labels[l.key] = [current[0], l.value];
      }
    }
    const route = routesByMs.get(s.id)?.[0];
    const chains = new Map<string, { id: string; nodes: [string, string | null][] }>();
    for (const row of chainsByMs.get(s.id) ?? []) {
      const chain = chains.get(row.anchor_code) ?? { id: row.anchor_code, nodes: [] };
      if (row.stage_key) chain.nodes.push([row.stage_key, row.record_code]);
      chains.set(row.anchor_code, chain);
    }
    return {
      id: s.id,
      slug: s.slug,
      code: s.code,
      name: s.name,
      scope: s.scope_statement,
      certificationBody: s.certification_body,
      color: s.color,
      status: s.status,
      display: s.display ?? {},
      position: s.position,
      defaultRepository: { id: s.repo_id, slug: s.repo_slug, name: s.repo_name, adapter: s.repo_adapter },
      active,
      target: s.transition_target_version_id ? (versionById.get(s.transition_target_version_id) ?? null) : null,
      labels,
      stages: (stagesByVersion.get(s.framework_version_id) ?? []).map((d) => ({
        key: d.stage_key,
        position: d.position,
        labelEn: d.label_en,
        labelId: d.label_id,
        questionEn: d.auditor_question_en,
        source: d.source,
        entityType: d.entity_type,
        riskProfileCode: d.risk_profile_code,
        clauseAtRisk: d.clause_at_risk || null,
        overviewClause: d.overview_clause,
        gateTypeLabel: d.gate_type_label_en ? [d.gate_type_label_en, d.gate_type_label_id ?? d.gate_type_label_en] : null,
      })),
      frequencies: (frequenciesByVersion.get(s.framework_version_id) ?? []).map((f) => ({
        code: f.code,
        labelEn: f.label_en,
        labelId: f.label_id,
        periodDays: f.period_days,
        sortOrder: f.sort_order,
      })),
      docTypes: Object.fromEntries((docTypesByVersion.get(s.framework_version_id) ?? []).map((d) => [d.code, d.label_en])),
      driftDefs: (driftByVersion.get(s.framework_version_id) ?? []).map((d) => ({
        code: d.code,
        labelEn: d.label_en,
        labelId: d.label_id,
        sourceKind: d.source_kind,
        sourceStage: d.source_stage,
        predicate: d.predicate ?? {},
        sortOrder: d.sort_order,
      })),
      primaryManager: managersByMs.get(s.id) ?? null,
      alerts: (alertsByMs.get(s.id) ?? []).map((a) => ({ kind: a.kind, tone: a.tone, textEn: a.text_en, textId: a.text_id, raisedAt: a.raised_at })),
      readiness: new Map((readinessByMs.get(s.id) ?? []).map((r) => [num(r.clause_group), num(r.readiness_pct)])),
      findings: (findingsByMs.get(s.id) ?? []).map((f) => ({
        id: f.id,
        code: f.code,
        title: f.title,
        classification: f.classification,
        clauseRef: f.clause_ref,
        source: f.source,
        status: f.status,
        statusNote: f.status_note,
        position: f.position,
      })),
      events: (eventsByMs.get(s.id) ?? []).map((e) => ({
        id: e.id,
        updatedAt: e.updated_at,
        scheduledAt: e.scheduled_at,
        auditDays: e.audit_days,
        shortLabel: e.short_label,
        nameEn: e.name_en,
        nameId: e.name_id,
        leadAuditorName: e.lead_auditor_name,
        expectedFocus: e.expected_focus,
        prepWindowDays: e.prep_window_days,
        outcomeSummary: e.outcome_summary,
      })),
      defaultRoute: route ? { mode: route.mode, note: route.note, repositoryName: route.repository_name } : null,
      records: recordsByMs.get(s.id) ?? [],
      entryCount: entryCountByMs.get(s.id) ?? 0,
      chains: [...chains.values()],
      approver: approverByMs.get(s.id) ?? null,
      examples: Object.fromEntries((examplesByVersion.get(s.framework_version_id) ?? []).map((e) => [e.key, e.example])),
      bundle: bundles.get(s.id) ?? null,
    };
  });
  return { systems, frameworkVersions: versions.map((v) => v.info), catalog };
}

async function loadCatalog(trx: Trx): Promise<CatalogEntry[]> {
  const rows = (
    await sql<{ pack_id: string; pack_version: string; note_en: string; note_id: string }>`
      select pack_id, pack_version, note_en, note_id from platform.pack_catalog order by pack_id, pack_version`.execute(trx)
  ).rows;
  return rows.map((r) => ({ packId: r.pack_id, packVersion: r.pack_version, noteEn: r.note_en, noteId: r.note_id }));
}

/** Chain record tables (C.10) and how a record reaches its system: its own column or `entity_ms_link`. */
const LINKED_TABLES = ['context_issue', 'risk', 'metric'] as const;
const OWNED_TABLES = ['risk_treatment', 'quality_objective', 'prioritized_activity', 'business_impact_analysis', 'exercise', 'business_associate'] as const;

interface RawRecord {
  tbl: string;
  id: string;
  ms_id: string;
  updated_at: Date;
  code: string;
  title: string;
  holder: string | null;
  pending_action: string | null;
  action_due_at: string | null;
  is_gate_item: boolean;
  position: number;
  stage_key: string | null;
  risk_profile_code: string | null;
}

/** Records of the systems' chain tables with their stage key (`chain_record`) or risk profile, plus up and down codes. */
export interface LoadedChainRecord extends Omit<ChainRecordRow, 'stage'> {
  msId: string;
  stageKey: string | null;
  riskProfileCode: string | null;
}

async function loadChainRecords(trx: Trx, msIds: readonly string[]): Promise<LoadedChainRecord[]> {
  const common = (alias: string) =>
    sql`${sql.ref(`${alias}.id`)} as id, ${sql.ref(`${alias}.updated_at`)} as updated_at, ${sql.ref(`${alias}.code`)} as code,
        ${sql.ref(`${alias}.title`)} as title, ${handleOf(`${alias}.owner_user_id`)} as holder, ${sql.ref(`${alias}.pending_action`)} as pending_action,
        ${sql.ref(`${alias}.action_due_at`)} as action_due_at, ${sql.ref(`${alias}.is_gate_item`)} as is_gate_item, ${sql.ref(`${alias}.position`)} as position`;
  const parts: RawBuilder<unknown>[] = [];
  for (const table of LINKED_TABLES) {
    parts.push(sql`
      select ${sql.lit(table)} as tbl, l.management_system_id as ms_id, ${common('r')}, null::text as stage_key,
             ${table === 'risk' ? sql`r.risk_profile_code` : sql`null::text`} as risk_profile_code
      from ${sql.table(table)} r
      join entity_ms_link l on l.entity_type = ${sql.lit(table)} and l.entity_id = r.id and l.deleted_at is null
      where r.deleted_at is null and l.management_system_id = any(${uuids(msIds)})`);
  }
  for (const table of OWNED_TABLES) {
    parts.push(sql`
      select ${sql.lit(table)} as tbl, r.management_system_id as ms_id, ${common('r')}, null::text as stage_key, null::text as risk_profile_code
      from ${sql.table(table)} r where r.deleted_at is null and r.management_system_id = any(${uuids(msIds)})`);
  }
  parts.push(sql`
    select 'chain_record' as tbl, r.management_system_id as ms_id, ${common('r')}, r.stage_key, null::text as risk_profile_code
    from chain_record r where r.deleted_at is null and r.management_system_id = any(${uuids(msIds)})`);
  const rows = (await sql<RawRecord>`${sql.join(parts, sql` union all `)} order by position, code`.execute(trx)).rows;
  const ids = [...new Set(rows.map((r) => r.id))];
  const refs = ids.length
    ? (
        await sql<{ entity_id: string; direction: 'up' | 'down'; target_code: string }>`
          select entity_id, direction, target_code from record_reference
          where deleted_at is null and entity_id = any(${uuids(ids)}) order by entity_id, direction, position`.execute(trx)
      ).rows
    : [];
  const refsById = group(refs, (r) => r.entity_id);
  return rows.map((r) => {
    const own = refsById.get(r.id) ?? [];
    return {
      id: r.id,
      msId: r.ms_id,
      updatedAt: r.updated_at,
      table: r.tbl,
      code: r.code,
      title: r.title,
      holder: r.holder,
      pendingAction: r.pending_action,
      actionDueAt: r.action_due_at,
      gate: r.is_gate_item,
      position: num(r.position),
      stageKey: r.stage_key,
      riskProfileCode: r.risk_profile_code,
      up: own.filter((x) => x.direction === 'up').map((x) => x.target_code),
      down: own.filter((x) => x.direction === 'down').map((x) => x.target_code),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Bundle rows
// ---------------------------------------------------------------------------------------------------------------

interface ObjectColumns {
  so_id: string | null;
  so_repo_slug: string | null;
  so_version_label: string | null;
  so_folder_path: string | null;
  so_hash_algorithm: StorageObjectRow['hashAlgorithm'] | null;
  so_hash_value: string | null;
  so_hash_source: StorageObjectRow['hashSource'] | null;
  so_link_status: StorageObjectRow['linkStatus'] | null;
  so_link_status_since: Date | null;
  so_link_status_reason: StorageObjectRow['linkStatusReason'];
  so_last_verified_at: Date | null;
  so_last_good_check_at: Date | null;
}

const OBJECT_COLUMNS = sql`so.id as so_id, sr.slug as so_repo_slug, so.version_label as so_version_label, so.folder_path as so_folder_path,
  so.hash_algorithm as so_hash_algorithm, so.hash_value as so_hash_value, so.hash_source as so_hash_source, so.link_status as so_link_status,
  so.link_status_since as so_link_status_since, so.link_status_reason as so_link_status_reason, so.last_verified_at as so_last_verified_at,
  so.last_good_check_at as so_last_good_check_at`;

function objectOf(r: ObjectColumns): StorageObjectRow | null {
  if (!r.so_id || !r.so_link_status || !r.so_hash_algorithm || !r.so_hash_source || !r.so_link_status_since) return null;
  return {
    id: r.so_id,
    repositorySlug: r.so_repo_slug ?? '',
    versionLabel: r.so_version_label,
    folderPath: r.so_folder_path,
    hashAlgorithm: r.so_hash_algorithm,
    hashValue: r.so_hash_value,
    hashSource: r.so_hash_source,
    linkStatus: r.so_link_status,
    linkStatusSince: r.so_link_status_since,
    linkStatusReason: r.so_link_status_reason,
    lastVerifiedAt: r.so_last_verified_at,
    lastGoodCheckAt: r.so_last_good_check_at,
  };
}

async function loadBundles(trx: Trx, systems: readonly SystemRow[]): Promise<Map<string, SystemBundleRows>> {
  const msIds = systems.map((s) => s.id);
  const entryRows = (
    await sql<{
      id: string; management_system_id: string; updated_at: Date; target_type: EntryRow['targetType']; code: string; title: string;
      theme_code: string | null; clause_group: string | null; implementation_status: EntryRow['status']; holds_gate: boolean;
      gate_reason: string | null; is_applicable: boolean | null; inclusion_justification: string | null; exclusion_justification: string | null;
      owner: string | null; status_note: string | null; frequency: string | null; completed_by: string | null; action_due_at: string | null;
      justification_holder: string | null; justification_due_at: string | null; position: number; document_codes: string[] | null;
      risk_codes: string[] | null;
    }>`
      select e.id, e.management_system_id, e.updated_at, e.target_type,
             coalesce(ci.item_code, rq.requirement_code) as code, coalesce(ci.title_short, rq.title_short) as title,
             ci.theme_code, rq.clause_group, e.implementation_status, e.holds_gate, e.gate_reason, e.is_applicable,
             e.inclusion_justification, e.exclusion_justification, ${handleOf('e.owner_user_id')} as owner, e.status_note,
             coalesce(oc.frequency_code, ci.default_frequency_code, rq.default_frequency_code) as frequency,
             ${handleOf('e.completed_by_user_id')} as completed_by, e.action_due_at,
             ${handleOf('e.justification_holder_user_id')} as justification_holder, e.justification_due_at, e.position,
             (select array_agg(d.doc_code order by ed.position, d.doc_code) from applicability_entry_document ed
                join document d on d.id = ed.document_id and d.deleted_at is null
              where ed.applicability_entry_id = e.id and ed.deleted_at is null) as document_codes,
             (select array_agg(rk.code order by er.position, rk.code) from applicability_entry_risk er
                join risk rk on rk.id = er.risk_id and rk.deleted_at is null
              where er.applicability_entry_id = e.id and er.deleted_at is null) as risk_codes
      from applicability_entry e
      left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
      left join ref.requirement rq on rq.id = e.requirement_id
      left join operating_criteria oc on oc.applicability_entry_id = e.id and oc.deleted_at is null
      where e.management_system_id = any(${uuids(msIds)}) and e.deleted_at is null
      order by e.position, code`.execute(trx)
  ).rows;

  const documentRows = (
    await sql<ObjectColumns & {
      id: string; ms_id: string; updated_at: Date; doc_code: string; title: string; doc_type: string; status: DocumentRow['status'];
      classification: DocumentRow['classification']; owner: string | null; approver: string | null; approved_at: string | null;
      next_review_at: string | null; is_org_wide: boolean; linked_ms_ids: string[] | null; version_label: string | null;
      pending_holder: string | null; pending_due_at: string | null; position: number;
    }>`
      select s.ms_id, d.id, d.updated_at, d.doc_code, d.title, d.doc_type, d.status, d.classification,
             ${handleOf('d.owner_user_id')} as owner, ${handleOf('d.approver_user_id')} as approver, d.approved_at, d.next_review_at,
             d.is_org_wide, d.position, ${handleOf('d.pending_holder_user_id')} as pending_holder, d.pending_due_at,
             (select array_agg(l.management_system_id order by m.position, m.slug) from entity_ms_link l
                join management_system m on m.id = l.management_system_id and m.deleted_at is null
              where l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null) as linked_ms_ids,
             v.version_label, ${OBJECT_COLUMNS}
      from (
        select l.management_system_id as ms_id, l.entity_id as document_id from entity_ms_link l
        where l.entity_type = 'document' and l.deleted_at is null and l.management_system_id = any(${uuids(msIds)})
        union
        select m.id as ms_id, d.id as document_id from document d cross join management_system m
        where d.is_org_wide and d.deleted_at is null and m.id = any(${uuids(msIds)})
      ) s
      join document d on d.id = s.document_id and d.deleted_at is null
      left join document_version v on v.id = d.current_version_id and v.deleted_at is null
      left join storage_object so on so.id = v.storage_object_id
      left join storage_repository sr on sr.id = so.storage_repository_id
      order by d.is_org_wide, d.position, d.doc_code`.execute(trx)
  ).rows;

  const evidenceRows = (
    await sql<ObjectColumns & {
      id: string; ms_id: string; entry_id: string; updated_at: Date; evidence_code: string; title: string; owner: string | null;
      produced_at: string | null; frequency_code: string; next_due_override: string | null; classification: EvidenceRow['classification'];
      position: number;
    }>`
      select distinct on (t.management_system_id, e.id) t.management_system_id as ms_id, t.applicability_entry_id as entry_id,
             e.id, e.updated_at, e.evidence_code, e.title, ${handleOf('e.owner_user_id')} as owner, e.produced_at, e.frequency_code,
             e.next_due_override, e.classification, e.position, ${OBJECT_COLUMNS}
      from evidence_target t
      join evidence e on e.id = t.evidence_id and e.deleted_at is null
      left join storage_object so on so.id = e.storage_object_id
      left join storage_repository sr on sr.id = so.storage_repository_id
      where t.deleted_at is null and t.management_system_id = any(${uuids(msIds)})
      order by t.management_system_id, e.id, t.position, t.created_at`.execute(trx)
  ).rows;

  const activityRows = (
    await sql<{
      id: string; management_system_id: string; updated_at: Date; phase_no: number; activity_no: number; phase_name: string | null;
      is_gate_phase: boolean; title: string; status: ActivityRow['status']; owner: string | null; output_document_code: string | null;
      linked_document_code: string | null; blocker_gate_item_ref: string | null; due_at: string | null; verified_at: string | null;
      completed_by: string | null;
    }>`
      select a.id, a.management_system_id, a.updated_at, a.phase_no, a.activity_no, t.phase_name_en as phase_name, a.is_gate_phase,
             a.title, a.status, ${handleOf('a.owner_user_id')} as owner, a.output_document_code,
             (select d.doc_code from document d where d.id = a.output_document_id and d.deleted_at is null) as linked_document_code,
             a.blocker_gate_item_ref, a.due_at, a.verified_at, ${handleOf('a.completed_by_user_id')} as completed_by
      from implementation_activity_progress a
      left join ref.activity_template t on t.id = a.activity_template_id
      where a.management_system_id = any(${uuids(msIds)}) and a.deleted_at is null
      order by a.phase_no, a.activity_no`.execute(trx)
  ).rows;

  const prepRows = (
    await sql<{ id: string; management_system_id: string; updated_at: Date; audit_event_id: string; title: string; owner: string | null; due_at: string; status: PrepTaskRow['status']; position: number }>`
      select p.id, p.management_system_id, p.updated_at, p.audit_event_id, p.title, ${handleOf('p.owner_user_id')} as owner, p.due_at, p.status, p.position
      from audit_prep_task p where p.management_system_id = any(${uuids(msIds)}) and p.deleted_at is null order by p.position, p.due_at`.execute(trx)
  ).rows;
  const cycleRows = (
    await sql<{ id: string; management_system_id: string; updated_at: Date; certification_cycle_id: string; requirement_code: string; title: string; owner: string | null; due_at: string; status: CycleItemRow['status']; condition_note: string | null; position: number }>`
      select c.id, c.management_system_id, c.updated_at, c.certification_cycle_id, c.requirement_code, c.title,
             ${handleOf('c.owner_user_id')} as owner, c.due_at, c.status, c.condition_note, c.position
      from cycle_requirement_status c where c.management_system_id = any(${uuids(msIds)}) and c.deleted_at is null order by c.position`.execute(trx)
  ).rows;
  const latestCycles = (
    await sql<{ management_system_id: string; id: string }>`
      select distinct on (management_system_id) management_system_id, id from certification_cycle
      where management_system_id = any(${uuids(msIds)}) and deleted_at is null
      order by management_system_id, cycle_start desc, created_at desc`.execute(trx)
  ).rows;
  const driftResultRows = (
    await sql<{ id: string; management_system_id: string; updated_at: Date; rule_code: string; entity_code: string; title: string; holder: string | null; due_at: string | null; detected_on: string; position: number }>`
      select r.id, r.management_system_id, r.updated_at, r.rule_code, r.entity_code, r.title, ${handleOf('r.holder_user_id')} as holder,
             r.due_at, (r.detected_at at time zone 'UTC')::date::text as detected_on, r.position
      from drift_result r where r.management_system_id = any(${uuids(msIds)}) and r.resolved_at is null and r.deleted_at is null
      order by r.rule_code, r.position`.execute(trx)
  ).rows;
  const thresholdRows = (
    await sql<{ management_system_id: string | null; frequency_code: string; fresh_grace_days: string; aging_factor: string; expired_factor: string }>`
      select management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor from freshness_threshold
      where deleted_at is null and (management_system_id is null or management_system_id = any(${uuids(msIds)}))`.execute(trx)
  ).rows;
  const thresholds: ThresholdRow[] = thresholdRows.map((t) => ({
    managementSystemId: t.management_system_id,
    frequencyCode: t.frequency_code,
    freshGraceDays: Number(t.fresh_grace_days),
    agingFactor: Number(t.aging_factor),
    expiredFactor: Number(t.expired_factor),
  }));

  const entriesByMs = group(entryRows, (r) => r.management_system_id);
  const docsByMs = group(documentRows, (r) => r.ms_id);
  const evsByMs = group(evidenceRows, (r) => r.ms_id);
  const actsByMs = group(activityRows, (r) => r.management_system_id);
  const prepByMs = group(prepRows, (r) => r.management_system_id);
  const cycleByMs = group(cycleRows, (r) => r.management_system_id);
  const latestByMs = new Map(latestCycles.map((c) => [c.management_system_id, c.id]));
  const driftByMs = group(driftResultRows, (r) => r.management_system_id);

  const out = new Map<string, SystemBundleRows>();
  for (const s of systems) {
    out.set(s.id, {
      entries: (entriesByMs.get(s.id) ?? []).map((e) => ({
        id: e.id,
        updatedAt: e.updated_at,
        targetType: e.target_type,
        code: e.code,
        title: e.title,
        themeCode: e.theme_code,
        clauseGroup: e.clause_group,
        status: e.implementation_status,
        holdsGate: e.holds_gate,
        gateReason: e.gate_reason,
        isApplicable: e.is_applicable,
        inclusionJustification: e.inclusion_justification,
        exclusionJustification: e.exclusion_justification,
        owner: e.owner,
        statusNote: e.status_note,
        frequency: e.frequency ?? 'annual',
        documentCodes: e.document_codes ?? [],
        riskCodes: e.risk_codes ?? [],
        completedBy: e.completed_by,
        actionDueAt: e.action_due_at,
        justificationHolder: e.justification_holder,
        justificationDueAt: e.justification_due_at,
        position: num(e.position),
      })),
      documents: (docsByMs.get(s.id) ?? []).map((d) => ({
        id: d.id,
        updatedAt: d.updated_at,
        code: d.doc_code,
        title: d.title,
        docType: d.doc_type,
        status: d.status,
        classification: d.classification,
        owner: d.owner,
        approver: d.approver,
        approvedAt: d.approved_at,
        nextReviewAt: d.next_review_at,
        orgWide: d.is_org_wide,
        linkedMsIds: d.linked_ms_ids ?? [],
        versionLabel: d.version_label,
        object: objectOf(d),
        pendingHolder: d.pending_holder,
        pendingDueAt: d.pending_due_at,
        position: num(d.position),
      })),
      evidence: (evsByMs.get(s.id) ?? [])
        .map((e) => ({
          id: e.id,
          updatedAt: e.updated_at,
          code: e.evidence_code,
          title: e.title,
          owner: e.owner,
          producedAt: e.produced_at,
          frequency: e.frequency_code,
          nextDueOverride: e.next_due_override,
          classification: e.classification,
          entryId: e.entry_id,
          object: objectOf(e),
          position: num(e.position),
        }))
        .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code)),
      activities: (actsByMs.get(s.id) ?? []).map((a) => ({
        id: a.id,
        updatedAt: a.updated_at,
        phaseNo: num(a.phase_no),
        activityNo: num(a.activity_no),
        phaseName: a.phase_name ?? `Phase ${a.phase_no}`,
        isGatePhase: a.is_gate_phase,
        title: a.title,
        status: a.status,
        owner: a.owner,
        outputDocumentCode: a.output_document_code,
        linkedDocumentCode: a.linked_document_code,
        blockerGateItemRef: a.blocker_gate_item_ref,
        dueAt: a.due_at,
        verifiedAt: a.verified_at,
        completedBy: a.completed_by,
      })),
      prepTasks: (prepByMs.get(s.id) ?? []).map((p) => ({
        id: p.id,
        updatedAt: p.updated_at,
        auditEventId: p.audit_event_id,
        title: p.title,
        owner: p.owner,
        dueAt: p.due_at,
        status: p.status,
        position: num(p.position),
      })),
      cycleItems: (cycleByMs.get(s.id) ?? []).map((c) => ({
        id: c.id,
        updatedAt: c.updated_at,
        cycleId: c.certification_cycle_id,
        requirementCode: c.requirement_code,
        title: c.title,
        owner: c.owner,
        dueAt: c.due_at,
        status: c.status,
        conditionNote: c.condition_note,
        position: num(c.position),
      })),
      latestCycleId: latestByMs.get(s.id) ?? null,
      driftResults: (driftByMs.get(s.id) ?? []).map((r) => ({
        id: r.id,
        updatedAt: r.updated_at,
        ruleCode: r.rule_code,
        entityCode: r.entity_code,
        title: r.title,
        holder: r.holder,
        dueAt: r.due_at,
        detectedOn: r.detected_on,
        position: num(r.position),
      })),
      thresholds,
    });
  }
  return out;
}

/** Open stored tasks of a person in the given systems (D-29). */
export async function loadOpenTasks(trx: Trx, userId: string, msIds: readonly string[]): Promise<{
  id: string; msId: string; entityType: string; entityId: string; entityCode: string | null; titleEn: string; titleId: string; dueAt: string | null;
}[]> {
  if (msIds.length === 0) return [];
  const rows = (
    await sql<{ id: string; management_system_id: string; entity_type: string; entity_id: string; entity_code: string | null; title_en: string; title_id: string; due_at: string | null }>`
      select id, management_system_id, entity_type, entity_id, entity_code, title_en, title_id, due_at from task
      where owner_user_id = ${userId}::uuid and status = 'open' and deleted_at is null and management_system_id = any(${uuids(msIds)})
      order by due_at nulls last, created_at`.execute(trx)
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    msId: r.management_system_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityCode: r.entity_code,
    titleEn: r.title_en,
    titleId: r.title_id,
    dueAt: r.due_at,
  }));
}
