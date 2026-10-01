// Text formats of the organisation snapshot (build plan G.5 `LOC`, `REPOS`, `ROUTING`, `PACKS`, `LICENCE`,
// `STAGES`, `FREQ`, D-18). Display strings that combine data are composed here in English and Indonesian.
import type {
  FreqEntry, LicenceCard, LocEntry, LocKind, OwnershipType, PackCard, Pair, RepoRow, RepositoryView, RoutingRow, Stage,
  StorageAdapter, StorageMode, Text,
} from '@mscd/shared';
import { fmtDay, localDate } from '../../../common/dates';
import { repositoryModesText, routingModeLabel } from '../../storage';
import type { FrequencyDef, StageDef } from './inputs';
import type { VersionInfo } from './ms-fields';
import { EDITION_STATUS_WORDS, SIGNATURE_TEXT } from './text';

// ---------------------------------------------------------------------------------------------------------------
// Storage (G.5 LOC, REPOS, ROUTING)
// ---------------------------------------------------------------------------------------------------------------

/** G.5 `LOC` kind of a repository: `sp` (Microsoft 365 organisational), `od` (personal), `gd`, `vault`, `smb`. */
export function locKind(adapter: StorageAdapter, ownership: OwnershipType): LocKind {
  switch (adapter) {
    case 'm365':
      return ownership === 'personal' ? 'od' : 'sp';
    case 'google_drive':
      return 'gd';
    case 'managed_vault':
      return 'vault';
    default:
      return 'smb';
  }
}

const LOC_SHORT: Readonly<Record<LocKind, string>> = { sp: 'SharePoint', od: 'OneDrive', gd: 'Google Drive', vault: 'Vault', smb: 'File share' };

/** G.5 `LOC[slug]`: `[display.locName or name, kind, short]`. */
export function locEntry(repo: { name: string; adapter: StorageAdapter; ownershipType: OwnershipType; display: Readonly<Record<string, unknown>> }): LocEntry {
  const kind = locKind(repo.adapter, repo.ownershipType);
  const name = typeof repo.display.locName === 'string' ? repo.display.locName : repo.name;
  return [name, kind, LOC_SHORT[kind]];
}

/** G.5 `REPOS[]` row of a repository view (`modes` as the joined labels). */
export function repoRow(view: RepositoryView): RepoRow {
  const row: RepoRow = {
    id: view.id,
    ref: view.ref,
    adapter: view.adapter,
    ownershipType: view.ownershipType,
    actions: [...view.actions],
    name: view.name,
    type: view.type,
    modes: repositoryModesText(view.modes),
    status: view.status,
    tenant: view.tenant,
    ms: [...view.ms],
    last: view.last,
  };
  if (view.msg) row.msg = view.msg;
  return row;
}

/**
 * G.5 `ROUTING[]` row of a system's active default rule: `[ms.code, repository name, mode label, note or -]`. The
 * note is the bilingual one kept on the system (`display.routingNote`) while its English text is the rule's note.
 */
export function routingRow(input: { msCode: string; repositoryName: string; mode: StorageMode; note: string | null; displayNote?: unknown }): RoutingRow {
  const pair = input.displayNote;
  let note: Text = input.note ?? '-';
  if (input.note && Array.isArray(pair) && pair.length === 2 && pair[0] === input.note && typeof pair[1] === 'string') note = [pair[0], pair[1]];
  return [input.msCode, input.repositoryName, routingModeLabel(input.mode), note];
}

// ---------------------------------------------------------------------------------------------------------------
// Framework packs (G.5 PACKS)
// ---------------------------------------------------------------------------------------------------------------

/** A newer pack version of an edition in `platform.pack_catalog`. */
export interface CatalogEntry {
  packId: string;
  packVersion: string;
  noteEn: string;
  noteId: string;
}

/** Semantic version order (pre-release tags lower than the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre);
}

/** Editions by year, newest first (`2026` before `2015`). */
function newestFirst<T extends Pick<VersionInfo, 'edition'>>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => b.edition.localeCompare(a.edition, undefined, { numeric: true }));
}

/**
 * G.5 `PACKS[ms]`. `used`: the active version and the transition target; `installed`: every installed edition of the
 * framework; `catalog`: newer versions offered.
 */
export function packCard(input: {
  active: VersionInfo;
  target: VersionInfo | null;
  installed: readonly VersionInfo[];
  catalog: readonly CatalogEntry[];
  timeZone: string;
}): PackCard {
  const used = newestFirst([input.active, ...(input.target ? [input.target] : [])]);
  const v = used.map((u) => `${u.packVersion}${used.length > 1 ? ` (${u.edition})` : ''}${u.preRelease ? ' (beta)' : ''}`).join(', ');
  const newestInstall = used.reduce((a, b) => (b.installedAt > a.installedAt ? b : a));
  const editions = newestFirst(input.installed.length > 0 ? input.installed : used);
  let eds: Text;
  if (editions.length <= 1) {
    eds = (editions[0] ?? input.active).edition;
  } else {
    const word = (status: VersionInfo['status'], lang: 0 | 1) => EDITION_STATUS_WORDS[status][lang];
    eds = [editions.map((e) => `${e.edition} ${word(e.status, 0)}`).join(', '), editions.map((e) => `${e.edition} ${word(e.status, 1)}`).join(', ')];
  }
  const newestEdition = editions[0] ?? input.active;
  const updates = input.catalog
    .filter((c) => c.packId === newestEdition.packId && compareVersions(c.packVersion, newestEdition.packVersion) > 0)
    .sort((a, b) => compareVersions(b.packVersion, a.packVersion));
  const update = updates[0];
  return {
    v,
    installed: fmtDay(localDate(newestInstall.installedAt, input.timeZone)),
    eds,
    update: update ? [`${update.packVersion}: ${update.noteEn}`, `${update.packVersion}: ${update.noteId}`] : null,
    status: input.target ? 'transition' : input.active.preRelease ? 'beta' : 'current',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Licence (G.5 LICENCE)
// ---------------------------------------------------------------------------------------------------------------

const ADAPTER_LABELS: Readonly<Record<string, string>> = {
  managed_vault: 'Managed Vault',
  m365: 'Microsoft 365',
  google_drive: 'Google Workspace',
  smb: 'SMB',
  s3: 'S3',
  webdav: 'WebDAV',
};

const FEATURE_TEXT: Readonly<Record<string, Pair>> = {
  integrated_mode: ['Integrated Management System', 'Sistem Manajemen Terintegrasi'],
  edition_transition: ['Edition Transition Assistant', 'Asisten Transisi Edisi'],
  link_health_monitor: ['Link Health Monitor', 'Pemantau Kesehatan Tautan'],
  auditor_guest_access: ['Auditor guest access', 'Akses tamu auditor'],
};

export interface LicenceCardInput {
  organization: string;
  validUntil: string;
  frameworks: readonly string[];
  storageAdapters: readonly string[];
  features: readonly string[];
  maxManagementSystems: number;
  maxUsers: number;
  /** Frameworks of the organisation's systems. */
  frameworksUsed: number;
  managementSystems: number;
  activeUsers: number;
  verified: boolean;
}

/** G.5 `LICENCE`. */
export function licenceCard(input: LicenceCardInput): LicenceCard {
  return {
    org: input.organization,
    to: fmtDay(input.validUntil),
    fw: `${input.frameworksUsed} of ${input.frameworks.length}`,
    ms: `${input.managementSystems} of ${input.maxManagementSystems}`,
    users: `${input.activeUsers} of ${input.maxUsers}`,
    adapters: input.storageAdapters.map((a) => ADAPTER_LABELS[a] ?? a).join(', '),
    features: input.features.map((f) => FEATURE_TEXT[f] ?? ([f, f] as Pair)),
    sig: [...SIGNATURE_TEXT[input.verified ? 'verified' : 'unverified']] as Pair,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stages and frequencies (G.5 STAGES, FREQ)
// ---------------------------------------------------------------------------------------------------------------

const STAGE_SRC: Readonly<Record<StageDef['source'], Stage['src'] | undefined>> = {
  entity: undefined,
  applicability: 'req',
  justification: 'soa',
  document: 'doc',
  evidence: 'ev',
};

/** G.5 `STAGES[ms]` entry: `rec` for entity and justification stages. */
export function stageEntry(def: StageDef, rec: number): Stage {
  const stage: Stage = { id: def.key, l: [def.labelEn, def.labelId], q: def.questionEn };
  const src = STAGE_SRC[def.source];
  if (src) stage.src = src;
  if (def.source === 'entity' || def.source === 'justification') stage.rec = rec;
  return stage;
}

/** G.5 `FREQ` and `FREQ_ORDER` of the frequencies of the organisation's systems (the first definition of a code wins). */
export function frequencyTable(defs: readonly FrequencyDef[]): { FREQ: Record<string, FreqEntry>; FREQ_ORDER: string[] } {
  const FREQ: Record<string, FreqEntry> = {};
  const order: FrequencyDef[] = [];
  for (const def of defs) {
    if (FREQ[def.code]) continue;
    FREQ[def.code] = [def.labelEn, def.labelId, def.periodDays];
    order.push(def);
  }
  return { FREQ, FREQ_ORDER: order.sort((a, b) => a.sortOrder - b.sortOrder || a.periodDays - b.periodDays).map((d) => d.code) };
}
