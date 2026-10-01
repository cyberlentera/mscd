// The sample snapshot the demo seed reads (build plan G.2): `demo/sample-snapshot.json`, written by
// `apps/web/scripts/export-sample-snapshot.mjs` from the web sample data. The types below describe the parts the seed
// uses; the file holds the full UI 4.2 snapshots of the three sample organisations.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** A text in both interface languages, or one text for both. */
export type SampleText = string | [string, string];
export type Pair = [string, string];

export interface SampleOrg {
  id: string;
  name: string;
  ms: string[];
  deploy: 'saas' | 'onprem';
  sites: number;
}

export interface SampleMs {
  id: string;
  code: string;
  ed: string;
  short: string;
  name: Pair;
  mgr: string;
  mgrRole: string;
  color: string;
  scope: string;
  certifier: string;
  lead: SampleText;
  cert: Pair;
  stage: Pair;
  audit: { name: Pair; date: string; days: number; prepWindowDays?: number } | null;
  clauses: number[];
  findings: { open: number; major: number };
  loc: string;
  locMode: string;
  pack: string;
  phase: Pair;
  unit: 'ctrl' | 'req';
  theme?: Record<string, string>;
  banner?: { tone: 'info' | 'warn' | 'bad'; text: Pair; kind: 'transition' | 'connector' | 'beta' };
  gateName?: Pair;
  gtSuggestions?: string[];
  approver?: string;
}

export interface SampleReq {
  id: string;
  key: string;
  title: string;
  theme: string;
  st: 'ns' | 'planned' | 'partial' | 'complete' | 'implemented' | 'na' | 'blocked';
  owner: string;
  doc: string;
  freq: string;
  note: string;
  gate: boolean;
  just: string;
  risks: string[];
  prod?: string;
  integ: string;
  loc: string;
  due?: string;
  by?: string;
}

export interface SampleDoc {
  id: string;
  title: string;
  tier: string;
  ver: string;
  st: 'approved' | 'review' | 'draft' | 'expired';
  appr: string;
  rev: string;
  owner: string;
  shared: boolean;
  ms: string;
  approver?: string;
}

export interface SampleEvidence {
  code: string;
  ctrl: string;
  ctrlKey: string;
  title: string;
  freq: string;
  p: number;
  prod: string;
  next: string | null;
  fresh: string;
  integ: string;
  loc: string;
  owner: string;
  ver: string;
  hashAlg: string;
  path: string;
}

export interface SampleChainItem {
  key: string;
  stage: string;
  kind: 'req' | 'soa' | 'doc' | 'ev' | 'x';
  id: string;
  title: Pair;
  act: Pair;
  h: string;
  due: string | null;
  st: 'pending' | 'overdue' | 'missing';
  gate: boolean;
  up: string[];
  down: string[];
  ref?: string;
}

export interface SampleActivity {
  key: string;
  no: string;
  title: string;
  st: 'verified' | 'complete' | 'progress' | 'blocked' | 'ns' | 'locked';
  blocker: string | null;
  owner: string;
  out: string | null;
  doc: string | null;
  date: string | null;
  pno: number;
}

export interface SamplePhase {
  no: number;
  n: string;
  gate: boolean;
  acts: SampleActivity[];
  total: number;
}

export interface SampleBundle {
  reqs: SampleReq[];
  docs: SampleDoc[];
  evs: SampleEvidence[];
  chain: { items: SampleChainItem[]; recs: Record<string, number> };
  gates: unknown[];
  phases: SamplePhase[];
}

export interface SampleStage {
  id: string;
  l: Pair;
  q: string;
  src?: 'req' | 'soa' | 'doc' | 'ev';
  rec?: number;
}

export interface SampleXRecord {
  id: string;
  t: string;
  act: string;
  h: string;
  due: string | null;
  gate?: boolean;
  up?: string[];
  down?: string[];
}

export interface SampleEvent {
  t: Pair;
  short?: Pair;
  d: string;
  days: number;
  result?: Pair;
  next?: boolean;
}

export interface SampleDriftRule {
  id: string;
  l: Pair;
  rows?: [string, string, string, string][];
  src?: string;
}

export interface SampleRepo {
  id: string;
  adapter: string;
  ownershipType: 'organizational' | 'personal';
  actions: string[];
  name: string;
  type: string;
  modes: SampleText;
  status: 'ok' | 'warn' | 'bad';
  msg?: Pair;
  tenant: SampleText;
  ms: string[];
  last: string;
}

export interface SamplePackCard {
  v: string;
  installed: string;
  eds: SampleText;
  update: SampleText | null;
  status: 'current' | 'transition' | 'beta';
}

/** One organisation's snapshot (UI 4.2 `Snapshot`) as the sample source returns it. */
export interface SampleOrgSnapshot {
  today: string;
  orgs: SampleOrg[];
  MS: SampleMs[];
  PEOPLE: Record<string, [string, string]>;
  ROLES: Record<string, { who: string; label: Pair }>;
  LOC: Record<string, [string, string, string, ...unknown[]]>;
  TITLES: Record<string, string>;
  CLAUSE_AT_RISK: Record<string, string>;
  LICENCE: Record<string, unknown>;
  REPOS: SampleRepo[];
  ROUTING: [string, string, string, SampleText][];
  PICKER_FILES: Record<string, { path: string; files: string[][] }>;
  bundles: Record<string, SampleBundle>;
  STAGES: Record<string, SampleStage[]>;
  X: Record<string, Record<string, SampleXRecord[]>>;
  CHAINS: Record<string, { id: string; nodes: [string, string][] }[]>;
  EVENTS: Record<string, SampleEvent[]>;
  FOCUS: Record<string, string>;
  PREP: Record<string, [string, string, string, 'done' | 'progress' | 'open'][]>;
  PAST: Record<string, [string, string, string, string, 'open' | 'closed', string][]>;
  CYCLE_ITEMS: Record<string, [string, string, string, string, 'done' | 'progress' | 'open', string][]>;
  DRIFT: Record<string, SampleDriftRule[]>;
  PACKS: Record<string, SamplePackCard>;
}

/** Storage object of an evidence record (`ev:<code>`) or document version (`doc:<code>`), computed by the export. */
export interface SampleStorageObject {
  code: string;
  system: string;
  repo: string;
  /** Null for Managed Vault objects: the seed names them `<vault prefix>demo-vault-<code>` per organisation. */
  externalItemId: string | null;
  externalVersionId: string | null;
  versionLabel: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number | null;
  hashAlgorithm: 'sha256' | 'quickxor' | 'none';
  hashSource: 'computed' | 'provider' | 'none';
  hashValue: string | null;
  folderPath: string;
  providerCreatedAt: string;
  providerModifiedAt: string;
  providerModifiedBy: string;
  createdBy: string;
  linkStatus: 'intact' | 'moved' | 'version_changed' | 'verification_pending' | 'hash_mismatch' | 'pinned_version_lost' | 'missing' | 'access_denied';
  linkStatusReason: 'unreachable' | 'credential_invalid' | null;
  linkStatusSince: string;
  lastVerifiedAt: string;
  lastGoodCheckAt: string | null;
}

export interface SampleDrive {
  adapter: 'm365' | 'google_drive';
  driveId: string;
  siteId?: string;
  rootFolderId: string;
  roots: Record<string, { folderId: string; path: string }>;
}

export interface SampleSnapshotFile {
  today: string;
  orgs: SampleOrg[];
  snapshots: Record<string, SampleOrgSnapshot>;
  raw: {
    PHASES: Record<string, { n: string; gate?: boolean; acts: string[] }[]>;
    PHASE_STATE: Record<string, unknown>;
    OUTPUT_MAP: [string, string][];
    PICKER_FILES: Record<string, { path: string; files: string[][] }>;
    FREQ: Record<string, [string, string, number]>;
    TERA_KEYS: string[];
  };
  literals: {
    gateName: Record<string, Pair>;
    gtSuggestions: Record<string, string[]>;
    docApprover: Record<string, string>;
  };
  storage: {
    m365: { tenantId: string; clientId: string; keyLabel: string; certificatePem: string; thumbprintSha256: string; notAfter: string };
    google: { clientId: string; clientSecret: string; refreshToken: string; account: { displayName: string; email: string } };
    drives: Record<string, SampleDrive>;
    objects: Record<string, SampleStorageObject>;
  };
}

/** Name of the snapshot file inside the `demo` folder. */
export const SNAPSHOT_FILE_NAME = 'sample-snapshot.json';

/**
 * Where the snapshot file is: next to the compiled module (an image that copies it there), else in the source tree
 * (`apps/server/src/seed/demo`), which `tsc` does not copy to `dist`.
 */
export function snapshotFileCandidates(moduleDir = __dirname): string[] {
  const candidates = [path.join(moduleDir, 'demo', SNAPSHOT_FILE_NAME)];
  const serverDir = path.resolve(moduleDir, '..', '..');
  candidates.push(path.join(serverDir, 'src', 'seed', 'demo', SNAPSHOT_FILE_NAME));
  return [...new Set(candidates)];
}

/** Reads and checks the sample snapshot (`file`, or the first candidate that exists). */
export function loadSampleSnapshot(file?: string): SampleSnapshotFile {
  const chosen = file ?? snapshotFileCandidates().find((candidate) => existsSync(candidate));
  if (!chosen) {
    throw new Error(
      `The demo snapshot ${SNAPSHOT_FILE_NAME} was not found (looked in ${snapshotFileCandidates().join(', ')}); ` +
        'run node apps/web/scripts/export-sample-snapshot.mjs',
    );
  }
  const parsed = JSON.parse(readFileSync(chosen, 'utf8')) as Partial<SampleSnapshotFile>;
  for (const key of ['today', 'orgs', 'snapshots', 'raw', 'literals', 'storage'] as const) {
    if (parsed[key] === undefined) throw new Error(`The demo snapshot ${chosen} has no "${key}"; run node apps/web/scripts/export-sample-snapshot.mjs`);
  }
  return parsed as SampleSnapshotFile;
}

/** English and Indonesian parts of a sample text. */
export function textPair(text: SampleText): Pair {
  return typeof text === 'string' ? [text, text] : text;
}

/** The English part of a sample text. */
export function textEn(text: SampleText): string {
  return typeof text === 'string' ? text : text[0];
}
