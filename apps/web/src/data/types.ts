// Types of the web data layer: the UI 4.2 interfaces of docs/platform/ui-contract.md with the additions of
// BUILD-PLAN H.2 (UiRole, Permission, the session methods of DataSource, `me` and `permissions` on the snapshot).
// Types only: the sample source (SampleDataSource.js) and the API source (api/ApiDataSource.ts, WP-25) both
// produce these shapes, and the TypeScript files of WP-25 and WP-38 import them.
//
// Language: fields typed `Pair` are [English, Indonesian]; fields typed `Text` are a Pair or one string, and the
// controller shows them with li(), which returns a string unchanged. The sample source returns pairs for the
// derived texts that depend on the language (ChainItem.title and act, GateItem.type and why), as the API does
// (BUILD-PLAN D.1 "Language").

export type Pair = [en: string, id: string];
export type Text = string | Pair;
export type IsoDate = string;                       // local date YYYY-MM-DD
export type PersonId = string;                      // key of PEOPLE; 'none' = unassigned (BR-45)
export type MsId = string;                          // management system slug: 'isms', 'qms', ...
/** `${MsId}:${RecordKind}:${business id}`, for example 'isms:req:A.5.23' (UI section 0). */
export type RecordKey = string;
export type RecordKind = 'req' | 'soa' | 'doc' | 'ev' | 'act' | 'x' | 'prep' | 'cycle' | 'drift';

export type ReqStatus = 'implemented' | 'partial' | 'planned' | 'ns' | 'blocked' | 'na' | 'complete';
export type DocStatus = 'approved' | 'expired' | 'review' | 'draft';
export type Fresh = 'fresh' | 'aging' | 'expired' | 'critical';
export type IntegId = 'ok' | 'nohash' | 'pending' | 'changed' | 'moved' | 'missing' | 'revoked';
export type ItemStatus = 'pending' | 'overdue' | 'missing';
export type ActStatus = 'verified' | 'complete' | 'progress' | 'blocked' | 'ns' | 'locked';
export type FreqId = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'semi' | 'annual' | 'event';
export type Tone = 'ok' | 'warn' | 'bad';
/** Repository kind, LOC entry [1]: SharePoint, OneDrive, Google Drive, Managed Vault, file share. */
export type LocKind = 'sp' | 'od' | 'gd' | 'vault' | 'smb';

/** UI role of the session user in a system (F.7 "UI role per system"); also the demo personas. */
export type UiRole = 'manager' | 'owner' | 'auditor' | 'top';

/** Permission codes of the F.6 matrix. */
export type Permission =
  | 'ms.read' | 'applicability.complete' | 'applicability.verify' | 'applicability.manage'
  | 'activity.transition' | 'activity.verify' | 'phase.verify'
  | 'record.assign' | 'record.complete_action' | 'record.delete'
  | 'document.review' | 'document.approve' | 'document.manage' | 'document.version.create'
  | 'evidence.file.submit' | 'evidence.manage' | 'register.manage' | 'metric.record'
  | 'risk.manage' | 'risk.treatment.update' | 'risk.residual.accept' | 'entity_link.manage' | 'ms.transition'
  | 'reminder.send' | 'audit.pending.all' | 'audit.pending.aggregate' | 'audit_event.manage'
  | 'prep_task.update' | 'cycle_item.update' | 'finding.raise' | 'finding.manage'
  | 'corrective_action.manage' | 'corrective_action.update' | 'corrective_action.verify'
  | 'self_assessment.manage' | 'management_review.manage' | 'evidence_pack.build' | 'auditor_access.grant'
  | 'export.run' | 'link_health.run' | 'storage.move.request' | 'storage.object.read' | 'audit_trail.read'
  | 'storage.repository.read' | 'storage.repository.manage' | 'storage.repository.test' | 'storage.routing.manage'
  | 'storage.object.metadata.read' | 'pack.read' | 'pack.activate' | 'pack.install' | 'license.read' | 'license.manage'
  | 'user.manage' | 'idp.manage' | 'org.settings.manage' | 'ms.admin' | 'audit_trail.metadata.read'
  | 'ops.read' | 'ops.jobs.run' | 'ops.users.manage';

// ---------- entities (UI section 1) ----------

export interface Organisation { id: string; name: string; ms: MsId[]; deploy: 'saas' | 'onprem'; sites: number }

export interface AuditRef { name: Pair; date: IsoDate; days: number; prepWindowDays?: number }

/** UI 1.2. The optional fields replace hard-coded switches of the controller (UI 2.14, H.5 step 11). */
export interface ManagementSystem {
  id: MsId; code: string; ed: string; short: string; name: Pair; mgr: PersonId; mgrRole: string; color: string;
  scope: string; certifier: string; lead: Text; cert: Text; stage: Pair;
  audit: AuditRef | null;
  clauses: number[]; findings: { open: number; major: number };
  banner?: { tone: 'info' | 'warn' | 'bad'; text: Pair; kind?: 'connector' | 'transition' | 'beta' };
  loc: string; locMode: string; pack: string; phase: Pair; unit: 'ctrl' | 'req'; theme?: Record<number, string>;
  gateName?: Text; gtSuggestions?: string[];
  /** Document approver of the system (sample only; the API sends `Document.approver`). */
  approver?: PersonId;
}

export interface Requirement {
  id: string; key: string; title: string; theme: string; st: ReqStatus; owner: PersonId;
  doc: string; freq: FreqId; note: string; gate: boolean; just: string; risks: string[];
  by?: PersonId | null; due?: IsoDate | null;
  /** Sample-only inputs of the evidence generator (UI 2.15). */
  prod?: IsoDate; integ?: IntegId; loc?: string;
}

export interface Document {
  id: string; title: string; tier: string; ver: string; st: DocStatus; appr: IsoDate | ''; rev: IsoDate;
  owner: PersonId; shared: boolean; ms: MsId;
  approver?: PersonId; path?: string; hashAlg?: string; usedBy?: string[];
  /** Sample overrides of a reassignment (UI 1.6); not read by the register. */
  h?: PersonId; due?: IsoDate | null;
}

export interface Evidence {
  code: string; ctrl: string; ctrlKey: string; title: string; freq: FreqId; p: number; prod: IsoDate;
  next: IsoDate | null; fresh: Fresh; integ: IntegId; loc: string; owner: PersonId; ver: string; hashAlg: string; path: string;
  hash?: string; lastCheck?: string; lastGoodCheck?: string;
  h?: PersonId; due?: IsoDate | null;
}

export interface ChainItem {
  key: RecordKey; stage: string; kind: 'req' | 'soa' | 'doc' | 'ev' | 'x'; id: string; title: Text; act: Text;
  h: PersonId; due: IsoDate | null; st: ItemStatus; after: boolean; gate: boolean; up: string[]; down: string[]; q: string;
  /** The requirement, document or evidence of the same bundle (sample objects; the API source rehydrates refKey). */
  ref?: Requirement | Document | Evidence;
  refKey?: RecordKey;
}

/** UI 2.4. `type` is a Pair since WP-07 (G.5); the controller applies li() when it builds the gate rows. */
export interface GateItem { id: string; type: Pair; why: Text; h: PersonId; due: IsoDate | null; key: string }

export interface Activity {
  key: RecordKey; no: string; title: string; st: ActStatus; blocker: string | null; owner: PersonId;
  out: string | null; doc: Document | null; date: IsoDate | null; pno: number; by?: PersonId | null;
  /** Wire form of `doc` (API). */
  docId?: string | null;
}

export interface Phase {
  no: number; n: string; gate: boolean; acts: Activity[]; total: number;
  c: Record<'verified' | 'complete' | 'progress' | 'blocked' | 'ns' | 'locked', number>;
}

export interface Stage { id: string; l: Pair; q: string; rec?: number; src?: 'req' | 'soa' | 'doc' | 'ev' }
export interface XRecord { id: string; t: string; act: string; h: PersonId; due: IsoDate | null; gate?: boolean; up?: string[]; down?: string[] }

/** Everything the controller reads for one system; S values of UI section 2. */
export interface MsBundle {
  reqs: Requirement[]; docs: Document[]; evs: Evidence[];
  chain: { items: ChainItem[]; recs: Record<string, number> };
  gates: GateItem[];
  phases: Phase[];
}

/** UI 1.14 LOC entry: [name, kind, short, colour, icon]. The API sends the first three; the web adds the visuals. */
export type LocEntry = [name: string, kind: string, short: string, colour?: string, icon?: string];

export type RepositoryAction = 'test' | 'reauthorise' | 'moveToLibrary';

export interface Repository {
  id: string; name: string; type: string; modes: Text; status: Tone; msg?: Pair; tenant: Text; ms: string[]; last: string;
  ref?: string; adapter?: 'managed_vault' | 'm365' | 'google_drive' | 'smb' | 's3' | 'webdav';
  ownershipType?: 'organizational' | 'personal'; actions?: RepositoryAction[];
}

export interface PackCard { v: string; installed: string; eds: Text; update: Text | null; status?: 'current' | 'transition' | 'beta' }
export interface Licence { org: string; to: string; fw: string; ms: string; users: string; adapters: string; features: Text[]; sig: Text }

export interface AuditEvent { t: Text; short?: Text; d: IsoDate; days: number; result?: Text; next?: boolean }
export interface DriftRule { id: string; l: Pair; rows?: [string, string, PersonId, IsoDate][]; src?: 'unverif' | 'metric' | 'exercise' | 'nohash' }

/** Session user as returned by GET /me (D.2 `Me`); present in API mode. */
export interface MeView {
  user: { id: string; handle: PersonId; email: string; displayName: string; jobTitle: string | null };
  org: { id: string; slug: string; name: string };
  orgs: Organisation[];
  rolesByMs: Record<MsId, string[]>;
  uiRoleByMs: Record<MsId, UiRole>;
  adminRoles: ('tenant_admin' | 'storage_admin')[];
  platformRoles: string[];
  permissions: { org: Permission[]; ms: Record<MsId, Permission[]> };
  csrfToken: string;
  session: { authMethod: string; idleExpiresAt: string; absoluteExpiresAt: string };
  personas?: Record<UiRole, { who: PersonId; label: Pair }>;
  preferences: Record<string, unknown>;
}

/** What a source returns: the keys the controller reads as this.D (UI 4.2), without the static content. */
export interface Snapshot {
  today: IsoDate;                                   // organisation's local date; the date helpers are bound to it
  generatedAt: string;
  orgs: Organisation[];
  MS: ManagementSystem[];                           // the systems of the selected organisation
  PEOPLE: Record<PersonId, [name: string, jobTitle: string]>;
  ROLES: Record<string, { who: PersonId; label: Pair }>;
  LOC: Record<string, LocEntry>;
  FREQ: Record<FreqId, [en: string, id: string, days: number]>; FREQ_ORDER: FreqId[];
  STAGES: Record<MsId, Stage[]>; X: Record<MsId, Record<string, XRecord[]>>;
  CHAINS: Record<MsId, { id: string; nodes: [string, string | null][] }[]>;
  TITLES: Record<string, string>; CLAUSE_AT_RISK: Record<string, string>; EXAMPLES: Record<string, string>;
  EVENTS: Record<MsId, AuditEvent[]>;
  FOCUS: Record<MsId, string>;
  PREP: Record<MsId, [string, PersonId, IsoDate, 'done' | 'progress' | 'open'][]>;
  PAST: Record<MsId, [string, 'Minor' | 'Major' | 'OFI', string, string, 'open' | 'closed', string][]>;
  CYCLE_ITEMS: Record<MsId, [string, string, PersonId, IsoDate, 'done' | 'progress' | 'open', string][]>;
  DRIFT: Record<MsId, DriftRule[]>;
  PACKS: Record<MsId, PackCard>;                    // an entry is absent without pack.read (A.4)
  LICENCE: Licence | null;                          // null without license.read (A.4)
  REPOS: Repository[];
  ROUTING: [string, string, string, Text][];
  /** Sample mode only: the picker listings of UI 1.15. */
  PICKER_FILES?: Record<string, { path: string; files: [string, string, string, string, string][] }>;
  bundles: Record<MsId, MsBundle>;                  // every system of the selected organisation
  me?: MeView;
  permissions?: { org: Permission[]; ms: Record<MsId, Permission[]> };
}

/** Date helpers of dates.js, bound to Snapshot.today (UI 1.19). */
export interface DateHelpers {
  TODAY_S: IsoDate;
  P(s: IsoDate): Date;
  iso(d: Date): IsoDate;
  dd(s: IsoDate): number;
  addD(s: IsoDate, n: number): IsoDate;
  fmt(s: IsoDate | null | undefined, l?: 'en' | 'id'): string;
}

/** The controller's `this.D`: the snapshot merged with the static content, the LOC visuals and the date helpers (H.5 step 1). */
export type ControllerData = Snapshot & DateHelpers & {
  T: Record<string, Pair>;
  TERA: Record<string, { what: Pair; how: Pair[] }>;
  INTEG: Record<IntegId, [en: string, id: string, tone: Tone]>;
  LOC: Record<string, [name: string, kind: string, short: string, colour: string, icon: string]>;
};

export interface PickerListing {                    // same shape as PICKER_FILES[src], plus refs
  path: string;
  files: [name: string, dateLabel: string, version: string, hashAlg: string, modifiedBy: string][];
  refs: { repositoryId: string; externalItemId: string; externalVersionId?: string }[];
}

export interface CommandResult {
  ok: boolean;
  changed: MsId[];                                  // bundles to reload; empty when nothing changed
  count?: number;                                   // reminders sent, references checked
  message?: Pair;                                   // server text when the UI cannot compose it
  warnings?: { rule: string; message: Pair }[];     // BR-23, BR-30, BR-36, BR-41
  error?: { status: number; rule?: string; message: Pair; methods?: unknown };
  redirectUrl?: string;                             // re-authorise consent
  downloadUrl?: string;                             // exports and evidence packs
}

export type PageAction =
  | 'exportBoard' | 'exportReadiness' | 'exportSoa' | 'exportDocs' | 'evidencePack' | 'auditorAccess'
  | 'runCheck' | 'calendarFeed' | 'checkUpdates' | 'importBundle' | 'verifyPhase';

export interface PickerFileChoice { src: string; index: number; ref?: PickerListing['refs'][number] }

/** UI 4.2 with the additions of BUILD-PLAN H.2. */
export interface DataSource {
  readonly kind: 'sample' | 'api';
  load(orgId?: string): Promise<Snapshot>;
  reload(snapshot: Snapshot, msIds: MsId[]): Promise<Snapshot>;
  listPickerFiles(key: RecordKey, src: string): Promise<PickerListing>;

  markComplete(key: RecordKey): Promise<CommandResult>;                           // req, act
  verify(key: RecordKey, to: 'implemented' | 'verified'): Promise<CommandResult>;  // req, act
  assign(key: RecordKey, h: PersonId, due: IsoDate | null): Promise<CommandResult>;
  remind(key: RecordKey, recipient: PersonId): Promise<CommandResult>;
  remindAll(msId: MsId): Promise<CommandResult>;
  completeRecordAction(key: RecordKey): Promise<CommandResult>;                   // My Tasks: x (API: task too)
  startReview(key: RecordKey): Promise<CommandResult>;                            // doc
  recordBlocker(key: RecordKey, gateRef: string, reason: string): Promise<CommandResult>;
  linkFile(key: RecordKey, file: PickerFileChoice): Promise<CommandResult>;
  uploadFile(key: RecordKey, file: File | null): Promise<CommandResult>;          // null in sample mode
  repositoryAction(repoId: string, action: RepositoryAction): Promise<CommandResult>;
  pageAction(msId: MsId, action: PageAction, arg?: unknown): Promise<CommandResult>;

  switchPersona(role: UiRole): Promise<Snapshot>;   // sample: local; api: POST /auth/demo/persona then load
  switchOrg(orgId: string): Promise<Snapshot>;      // api: PUT /me/org then load; 409 reauth-required goes to login
  logout(): Promise<void>;                          // sample: no-op
  onUnauthenticated(listener: () => void): () => void;   // api: any 401; returns the unsubscribe function
}
