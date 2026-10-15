// Snapshots of the parity endpoints (D.2 `UiOrgSnapshot`, `UiMsSnapshot`; G.5 rules). The web API source merges them
// into the UI 4.2 `Snapshot` (H.4).
import { z } from 'zod';
import {
  AuditEventType, AuditOutcome, FindingClassLabel, LocKind, OpenClosed, OwnershipType, RepoStatus, StorageAdapter, TupleStatus, UiRole, DriftSrc,
} from '../enums.js';
import {
  FreqId, Instant, IsoDate, MsId, Pair, PermissionSet, PersonId, RecordKey, RecordRef, RepositorySlug, StageKey, Text, Uuid, named,
} from '../api/common.js';
import { ManagementSystem, MsBundle, Organisation, Stage, XRecord } from './records.js';
import {
  EXAMPLE_LICENCE_CARD, EXAMPLE_MS_SNAPSHOT, EXAMPLE_ORG_SNAPSHOT, EXAMPLE_PACK_CARD, EXAMPLE_REPO,
} from '../examples.js';

// ---------------------------------------------------------------------------------------------------------------
// Organisation snapshot parts
// ---------------------------------------------------------------------------------------------------------------

export const PeopleMap = named(
  'PeopleMap',
  z.record(PersonId, z.tuple([z.string(), z.string()])),
  'People by handle: [display name, job title or -], plus none: [Unassigned, -] (G.5 PEOPLE)',
  {
    valid: [EXAMPLE_ORG_SNAPSHOT.PEOPLE, {}],
    invalid: [{ rina: 'Rina Kusuma' }, { Rina: ['Rina Kusuma', 'ISMS Manager'] }],
  },
);
export type PeopleMap = z.infer<typeof PeopleMap>;

export const RolesMap = named(
  'RolesMap',
  z.partialRecord(UiRole, z.object({ who: PersonId, label: Pair })),
  'Personas by UI role: the four demo personas, or one entry per UI role of the session user (G.5 ROLES)',
  {
    valid: [EXAMPLE_ORG_SNAPSHOT.ROLES, { owner: { who: 'bagus', label: ['Domain Owner', 'Pemilik Domain'] }, top: { who: 'hendra', label: ['Top Management', 'Manajemen Puncak'] } }],
    invalid: [{ admin: { who: 'rina', label: ['a', 'b'] } }, { manager: { who: 'rina' } }],
  },
);
export type RolesMap = z.infer<typeof RolesMap>;

export const LocEntry = named(
  'LocEntry',
  z.tuple([z.string(), LocKind, z.string()]),
  'Repository location [name, kind, short label]; the web adds colour and icon by kind (G.5 LOC)',
  { valid: [['SharePoint Online', 'sp', 'SharePoint'], ['Managed Vault', 'vault', 'Vault']], invalid: [['SharePoint Online', 'm365', 'SharePoint'], ['x', 'sp']] },
);
export type LocEntry = z.infer<typeof LocEntry>;

export const REPO_ACTIONS = ['test', 'reauthorise', 'moveToLibrary'] as const;
export const RepoAction = z.enum(REPO_ACTIONS).meta({ id: 'RepoAction', description: 'Action offered on a repository card (G.5 REPOS.actions)' });
export type RepoAction = z.infer<typeof RepoAction>;

export const RepoRow = named(
  'RepoRow',
  z.object({
    id: RepositorySlug,
    ref: Uuid,
    adapter: StorageAdapter,
    ownershipType: OwnershipType,
    actions: z.array(RepoAction),
    name: z.string(),
    type: z.string(),
    modes: Text,
    status: RepoStatus,
    msg: Text.optional(),
    tenant: Text,
    ms: z.array(z.string()),
    last: z.string(),
  }),
  'Repository card (UI 1.14, G.5 REPOS): ref is the uuid the admin repository routes take',
  {
    valid: [EXAMPLE_REPO, { ...EXAMPLE_REPO, id: 'vault', adapter: 'managed_vault', actions: ['test'], type: '', modes: ['Upload, versioned, SHA-256', 'Upload, berversi, SHA-256'], status: 'ok', msg: undefined }],
    invalid: [{ ...EXAMPLE_REPO, status: 'degraded' }, { ...EXAMPLE_REPO, actions: ['delete'] }, { ...EXAMPLE_REPO, ref: 'gd' }],
  },
);
export type RepoRow = z.infer<typeof RepoRow>;

export const RoutingRow = named(
  'RoutingRow',
  z.tuple([z.string(), z.string(), z.string(), Text]),
  'Default routing rule per system [system short code, repository name, mode label, note or -] (G.5 ROUTING)',
  { valid: [['QMS', 'Managed Vault', 'Upload', '-'], ['BCMS', 'Google Shared Drive', 'Zero-transit', ['Internal to Link', 'Internal ke Link']]], invalid: [['QMS', 'Managed Vault', 'Upload'], ['QMS', 'Managed Vault', 'Upload', null]] },
);
export type RoutingRow = z.infer<typeof RoutingRow>;

export const PACK_CARD_STATUSES = ['current', 'transition', 'beta'] as const;
export const PackCardStatus = z.enum(PACK_CARD_STATUSES).meta({ id: 'PackCardStatus', description: 'Framework pack card status (G.5 PACKS.status)' });
export type PackCardStatus = z.infer<typeof PackCardStatus>;

export const PackCard = named(
  'PackCard',
  z.object({ v: z.string(), installed: z.string(), eds: Text, update: Text.nullable(), status: PackCardStatus }),
  'Framework pack card of a system (UI 1.13, G.5 PACKS)',
  {
    valid: [EXAMPLE_PACK_CARD, { v: '1.2.0', installed: '02 Feb 2026', eds: '2022', update: null, status: 'current' }],
    invalid: [{ ...EXAMPLE_PACK_CARD, status: 'withdrawn' }, { v: '1.2.0', installed: '02 Feb 2026', eds: '2022', status: 'current' }],
  },
);
export type PackCard = z.infer<typeof PackCard>;

export const LicenceCard = named(
  'LicenceCard',
  z.object({
    org: z.string(), to: z.string(), fw: z.string(), ms: z.string(), users: z.string(), adapters: z.string(), features: z.array(Text), sig: Text,
  }),
  'Licence card texts (UI 1.13, G.5 LICENCE)',
  { valid: [EXAMPLE_LICENCE_CARD], invalid: [{ ...EXAMPLE_LICENCE_CARD, features: 'Integrated Management System' }, { org: 'x' }] },
);
export type LicenceCard = z.infer<typeof LicenceCard>;

export const ChainInstance = named(
  'ChainInstance',
  z.object({ id: z.string(), nodes: z.array(z.tuple([StageKey, z.string().nullable()])) }),
  'Traceability chain instance: anchor code and [stage, record code] nodes; ev:<control> means the latest evidence of that control (UI 1.8 CHAINS)',
  {
    valid: [EXAMPLE_ORG_SNAPSHOT.CHAINS.isms[0], { id: 'PA-05', nodes: [] }],
    invalid: [{ id: 'R-014', nodes: [['context']] }, { nodes: [] }],
  },
);
export type ChainInstance = z.infer<typeof ChainInstance>;

export const FreqEntry = named(
  'FreqEntry',
  z.tuple([z.string(), z.string(), z.int().min(0)]),
  'Frequency [English label, Indonesian label, period in days] (UI 1.16 FREQ)',
  { valid: [['Monthly', 'Bulanan', 30], ['Per event', 'Per kejadian', 0]], invalid: [['Monthly', 'Bulanan'], ['Monthly', 'Bulanan', -1]] },
);
export type FreqEntry = z.infer<typeof FreqEntry>;

export const UiOrgSnapshot = named(
  'UiOrgSnapshot',
  z.object({
    today: IsoDate,
    generatedAt: Instant,
    orgs: z.array(Organisation),
    MS: z.array(ManagementSystem),
    PEOPLE: PeopleMap,
    ROLES: RolesMap,
    LOC: z.record(RepositorySlug, LocEntry),
    REPOS: z.array(RepoRow),
    ROUTING: z.array(RoutingRow),
    PACKS: z.record(MsId, PackCard),
    LICENCE: LicenceCard.nullable(),
    STAGES: z.record(MsId, z.array(Stage)),
    CHAINS: z.record(MsId, z.array(ChainInstance)),
    TITLES: z.record(z.string(), z.string()),
    CLAUSE_AT_RISK: z.record(StageKey, z.string()),
    EXAMPLES: z.record(z.string(), z.string()),
    FREQ: z.record(FreqId, FreqEntry),
    FREQ_ORDER: z.array(FreqId),
    permissions: PermissionSet,
  }),
  'GET /ui/org: organisation-wide snapshot keys (D.2, G.5). LICENCE is null without license.read; PACKS omits systems without pack.read (A.4)',
  {
    valid: [EXAMPLE_ORG_SNAPSHOT, { ...EXAMPLE_ORG_SNAPSHOT, LICENCE: null, PACKS: {}, REPOS: [], ROUTING: [] }],
    invalid: [{ ...EXAMPLE_ORG_SNAPSHOT, LICENCE: undefined }, { ...EXAMPLE_ORG_SNAPSHOT, today: '29 Sep 2026' }, { ...EXAMPLE_ORG_SNAPSHOT, LOC: { sp: ['SharePoint Online', 'sharepoint', 'SharePoint'] } }],
  },
);
export type UiOrgSnapshot = z.infer<typeof UiOrgSnapshot>;

// ---------------------------------------------------------------------------------------------------------------
// System snapshot parts
// ---------------------------------------------------------------------------------------------------------------

export const EventRow = named(
  'EventRow',
  z.object({
    t: Text,
    short: Text.optional(),
    d: IsoDate,
    days: z.int().min(0).nullable(),
    result: Text.optional(),
    next: z.boolean().optional(),
    /** `audit_event.event_type`: the journey reads certification from it instead of the label. */
    type: AuditEventType.optional(),
    /** `audit_event.outcome` once recorded. */
    outcome: AuditOutcome.optional(),
  }),
  'Audit event of the certification cycle (UI 1.10 EVENTS, G.5)',
  {
    valid: [...EXAMPLE_MS_SNAPSHOT.EVENTS, { t: 'Stage 1', d: '2027-02-10', days: null }, { t: 'Stage 2', d: '2025-03-10', days: 3, type: 'stage2', outcome: 'not_recommended' }],
    invalid: [{ t: ['Stage 1', 'Stage 1'], d: '2027-02-10' }, { t: ['Stage 1', 'Stage 1'], d: 'Feb 2027', days: 1 }, { t: 'Stage 2', d: '2025-03-10', days: 3, outcome: 'passed' }],
  },
);
export type EventRow = z.infer<typeof EventRow>;

export const PrepRow = named(
  'PrepRow',
  z.tuple([z.string(), PersonId, IsoDate, TupleStatus]),
  'Preparation task of the next audit [title, owner, due date, done or progress or open] (UI 1.10 PREP)',
  { valid: [['Approve SoA v3.0', 'hendra', '2026-10-15', 'open']], invalid: [['Approve SoA v3.0', 'hendra', '2026-10-15', 'not_started'], ['Approve SoA v3.0', 'hendra']] },
);
export type PrepRow = z.infer<typeof PrepRow>;

export const PastRow = named(
  'PastRow',
  z.tuple([z.string(), FindingClassLabel, z.string(), z.string(), OpenClosed, z.string()]),
  'Certification audit finding [code, Major or Minor or OFI, clause, title, open or closed, note] (UI 1.10 PAST)',
  { valid: [EXAMPLE_MS_SNAPSHOT.PAST[0]], invalid: [['NC-2025-02', 'minor', '8.8', 't', 'open', ''], ['NC-2025-02', 'Minor', '8.8', 't', 'in_progress', '']] },
);
export type PastRow = z.infer<typeof PastRow>;

export const CycleRow = named(
  'CycleRow',
  z.tuple([z.string(), z.string(), PersonId, IsoDate, TupleStatus, z.string()]),
  'Cycle requirement [requirement code, title, owner, due date, status code, condition note] (UI 1.10 CYCLE_ITEMS)',
  { valid: [EXAMPLE_MS_SNAPSHOT.CYCLE_ITEMS[0], ['-', 'Edition transition tasks complete', 'sari', '2026-11-10', 'progress', '']], invalid: [['9.3', 't', 'hendra', '2026-10-28', 'open'], ['9.3', 't', 'hendra', '2026-10-28', 'done', null]] },
);
export type CycleRow = z.infer<typeof CycleRow>;

export const DriftRow = named(
  'DriftRow',
  z.tuple([z.string(), z.string(), PersonId, IsoDate]),
  'Open drift result [record code, title, holder, due date] (UI 1.10 DRIFT rows)',
  { valid: [['R-005', 'Data centre power failure', 'bagus', '2026-10-30']], invalid: [['R-005', 'Data centre power failure', 'bagus'], ['R-005', 't', 'bagus', 'soon']] },
);
export type DriftRow = z.infer<typeof DriftRow>;

export const UiDriftPattern = named(
  'UiDriftPattern',
  z.object({ id: z.string(), l: Pair, rows: z.array(DriftRow).optional(), src: DriftSrc.optional() }),
  'Regression detector rule with its stored rows or the live list it reads (UI 1.10 DRIFT, G.5)',
  {
    valid: [...EXAMPLE_MS_SNAPSHOT.DRIFT, { id: 'dd', l: ['Business associates without valid due diligence', 'Mitra tanpa due diligence berlaku'], rows: [] }],
    invalid: [{ id: 'unverif', l: 'Evidence', src: 'unverif' }, { id: 'x', l: ['a', 'b'], src: 'manual' }],
  },
);
export type UiDriftPattern = z.infer<typeof UiDriftPattern>;

export const UiMsSnapshot = named(
  'UiMsSnapshot',
  z.object({
    ms: MsId,
    bundle: MsBundle,
    X: z.record(StageKey, z.array(XRecord)),
    EVENTS: z.array(EventRow),
    FOCUS: z.string(),
    PREP: z.array(PrepRow),
    PAST: z.array(PastRow),
    CYCLE_ITEMS: z.array(CycleRow),
    DRIFT: z.array(UiDriftPattern),
    refs: z.record(RecordKey, RecordRef),
  }),
  'GET /ui/ms/{ms}: bundle and per-system keys of one system, with record refs for commands (D.2, G.5)',
  {
    valid: [EXAMPLE_MS_SNAPSHOT, { ...EXAMPLE_MS_SNAPSHOT, X: {}, EVENTS: [], PREP: [], PAST: [], CYCLE_ITEMS: [], DRIFT: [], refs: {} }],
    invalid: [{ ...EXAMPLE_MS_SNAPSHOT, refs: { 'R-031': EXAMPLE_MS_SNAPSHOT.refs['isms:x:R-031'] } }, { ...EXAMPLE_MS_SNAPSHOT, bundle: undefined }],
  },
);
export type UiMsSnapshot = z.infer<typeof UiMsSnapshot>;
