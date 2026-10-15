// Records of the UI snapshot (UI 4.2 interfaces, G.5 field rules) in their wire form: the shapes `GET /ui/org` and
// `GET /ui/ms/{ms}` return. Fields the controller renders through li() accept a `Text` (a string or a pair), as the
// sample does. Fields that the external auditor projection removes (G.5 `EaProjection`) are optional.
import { z } from 'zod';
import {
  ActStatus, AlertTone, ChainItemKind, DeployLabel, DocStatus, FreshnessStatus, IntegId, ItemStatus, MsAlertKind, ReqStatus,
  StageSrc,
} from '../enums.js';
import {
  Color, FreqId, IsoDate, IsoDateOrEmpty, MsId, OrgSlug, Pair, PersonId, RecordKey, RepositorySlug, StageKey, Text, named,
} from '../api/common.js';
import {
  EXAMPLE_ACTIVITY, EXAMPLE_CHAIN_ITEM, EXAMPLE_DOCUMENT, EXAMPLE_EVIDENCE, EXAMPLE_GATE_ITEM, EXAMPLE_MS, EXAMPLE_ORGANISATION,
  EXAMPLE_PHASE, EXAMPLE_REQUIREMENT, EXAMPLE_STAGE, EXAMPLE_X_RECORD,
} from '../examples.js';

// ---------------------------------------------------------------------------------------------------------------
// Organisation and management system (UI 1.1, 1.2)
// ---------------------------------------------------------------------------------------------------------------

export const Organisation = named(
  'Organisation',
  z.object({ id: OrgSlug, name: z.string(), ms: z.array(MsId), deploy: DeployLabel, sites: z.int().min(0) }),
  'Organisation the user belongs to (UI 1.1): id is the slug, ms the systems where the user holds a role',
  {
    valid: [EXAMPLE_ORGANISATION, { id: 'rmn', name: 'RS Medika Nusantara', ms: ['isms'], deploy: 'onprem', sites: 1 }],
    invalid: [{ ...EXAMPLE_ORGANISATION, deploy: 'cloud' }, { ...EXAMPLE_ORGANISATION, sites: -1 }, { id: 'ndt', name: 'x' }],
  },
);
export type Organisation = z.infer<typeof Organisation>;

export const MS_UNITS = ['ctrl', 'req'] as const;
export const MsUnit = z.enum(MS_UNITS).meta({ id: 'MsUnit', description: 'ctrl when the applicability target is catalogue_item, else req (G.5)' });
export type MsUnit = z.infer<typeof MsUnit>;

export const MsAudit = named(
  'MsAudit',
  z.object({ name: Pair, date: IsoDate, days: z.int().min(0).nullable(), prepWindowDays: z.int().min(0).max(365) }),
  'Next audit event of a system (TS 9.4, G.5 MS.audit)',
  {
    valid: [EXAMPLE_MS.audit, { name: ['Stage 1', 'Stage 1'], date: '2027-02-10', days: null, prepWindowDays: 60 }],
    invalid: [{ name: ['Stage 1', 'Stage 1'], date: '2027-02-10', days: 1 }, { ...EXAMPLE_MS.audit, date: '10 Feb 2027' }],
  },
);
export type MsAudit = z.infer<typeof MsAudit>;

export const MsBanner = named(
  'MsBanner',
  z.object({ tone: AlertTone, text: Pair, kind: MsAlertKind.optional() }),
  'Newest open ms_alert of a system (G.5 MS.banner)',
  {
    valid: [{ tone: 'bad', text: ['Google Shared Drive token expired', 'Token Google Shared Drive kedaluwarsa'], kind: 'connector' }, { tone: 'info', text: ['a', 'b'] }],
    invalid: [{ tone: 'error', text: ['a', 'b'] }, { tone: 'warn', text: 'a' }],
  },
);
export type MsBanner = z.infer<typeof MsBanner>;

export const ManagementSystem = named(
  'ManagementSystem',
  z.object({
    id: MsId,
    code: z.string(),
    ed: z.string(),
    short: z.string(),
    name: Pair,
    mgr: PersonId,
    mgrRole: z.string(),
    color: Color,
    scope: z.string(),
    certifier: z.string(),
    lead: Text,
    cert: Text,
    stage: Pair,
    audit: MsAudit.nullable(),
    clauses: z.array(z.int().min(0).max(100)).length(7),
    findings: z.object({ open: z.int().min(0), major: z.int().min(0) }),
    banner: MsBanner.optional(),
    loc: RepositorySlug,
    locMode: z.string(),
    pack: z.string(),
    phase: Pair,
    unit: MsUnit,
    theme: z.record(z.string().regex(/^\d+$/), z.string()).optional(),
    gateName: Text.optional(),
    gtSuggestions: z.array(z.string()).optional(),
    approver: PersonId.optional(),
  }),
  'Management system card and header fields (UI 1.2, G.5 MS[])',
  {
    valid: [
      EXAMPLE_MS,
      {
        ...EXAMPLE_MS, id: 'abms', code: 'ISO 37001', ed: '2025', short: 'ABMS', audit: null, lead: '-', unit: 'req', theme: undefined,
        banner: { tone: 'warn', text: ['Beta pack', 'Pack beta'], kind: 'beta' },
      },
    ],
    invalid: [
      { ...EXAMPLE_MS, clauses: [100, 100] },
      { ...EXAMPLE_MS, unit: 'control' },
      { ...EXAMPLE_MS, color: 'orange' },
      { ...EXAMPLE_MS, audit: { name: ['a', 'b'], date: '2026-11-12', days: 2 } },
    ],
  },
);
export type ManagementSystem = z.infer<typeof ManagementSystem>;

// ---------------------------------------------------------------------------------------------------------------
// Bundle records (UI 1.5 to 1.9, 2.3, 2.4, 2.7)
// ---------------------------------------------------------------------------------------------------------------

export const Requirement = named(
  'Requirement',
  z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    theme: z.string(),
    st: ReqStatus,
    owner: PersonId.optional(),
    doc: z.string(),
    freq: FreqId,
    note: z.string().optional(),
    gate: z.boolean(),
    just: z.string(),
    risks: z.array(z.string()),
    by: PersonId.nullable().optional(),
    due: IsoDate.nullable().optional(),
  }),
  'Requirement or control of a system (UI 1.5, G.5 bundle.reqs); owner, by and note are absent in the external auditor projection',
  {
    valid: [EXAMPLE_REQUIREMENT, { ...EXAMPLE_REQUIREMENT, st: 'complete', by: 'bagus' }, { ...EXAMPLE_REQUIREMENT, owner: undefined, note: undefined, by: undefined }],
    invalid: [{ ...EXAMPLE_REQUIREMENT, st: 'partially_implemented' }, { ...EXAMPLE_REQUIREMENT, risks: 'R-014' }, { ...EXAMPLE_REQUIREMENT, gate: 'no' }],
  },
);
export type Requirement = z.infer<typeof Requirement>;

export const Document = named(
  'Document',
  z.object({
    id: z.string(),
    title: z.string(),
    tier: z.string(),
    ver: z.string(),
    st: DocStatus,
    appr: IsoDateOrEmpty,
    rev: IsoDateOrEmpty,
    owner: PersonId.optional(),
    shared: z.boolean(),
    ms: MsId,
    approver: PersonId.optional(),
    path: z.string().optional(),
    hashAlg: z.string().optional(),
    usedBy: z.array(z.string()).optional(),
  }),
  'Controlled document linked to a system (UI 1.6, G.5 bundle.docs); owner, approver and path are absent in the external auditor projection',
  {
    valid: [EXAMPLE_DOCUMENT, { ...EXAMPLE_DOCUMENT, id: 'IMS-01', st: 'approved', shared: true, usedBy: ['QMS', 'BCMS'] }, { ...EXAMPLE_DOCUMENT, ver: '-', appr: '', st: 'draft' }],
    invalid: [{ ...EXAMPLE_DOCUMENT, st: 'in_review' }, { ...EXAMPLE_DOCUMENT, appr: '24 Sep 2025' }, { ...EXAMPLE_DOCUMENT, shared: undefined }],
  },
);
export type Document = z.infer<typeof Document>;

export const Evidence = named(
  'Evidence',
  z.object({
    code: z.string(),
    ctrl: z.string(),
    ctrlKey: z.string(),
    title: z.string(),
    freq: FreqId,
    p: z.int().min(0),
    prod: IsoDateOrEmpty,
    next: IsoDate.nullable(),
    fresh: FreshnessStatus,
    integ: IntegId,
    loc: z.string(),
    owner: PersonId.optional(),
    ver: z.string(),
    hashAlg: z.string(),
    path: z.string().optional(),
    hash: z.string().optional(),
    lastCheck: z.string().optional(),
    lastGoodCheck: z.string().optional(),
  }),
  'Evidence record of a system (UI 1.7, G.5 bundle.evs); owner, path and hash are absent in the external auditor projection',
  {
    valid: [EXAMPLE_EVIDENCE, { ...EXAMPLE_EVIDENCE, integ: 'ok', fresh: 'fresh', lastGoodCheck: '29 Sep 2026 06:00' }, { ...EXAMPLE_EVIDENCE, p: 0, freq: 'event', next: null }],
    invalid: [{ ...EXAMPLE_EVIDENCE, integ: 'intact' }, { ...EXAMPLE_EVIDENCE, fresh: 'stale' }, { ...EXAMPLE_EVIDENCE, p: -1 }],
  },
);
export type Evidence = z.infer<typeof Evidence>;

export const ChainItem = named(
  'ChainItem',
  z.object({
    key: RecordKey,
    stage: StageKey,
    kind: ChainItemKind,
    id: z.string(),
    title: Pair,
    act: Pair,
    h: PersonId,
    due: IsoDate.nullable(),
    st: ItemStatus,
    after: z.boolean(),
    gate: z.boolean(),
    up: z.array(z.string()),
    down: z.array(z.string()),
    q: z.string(),
    refKey: RecordKey.optional(),
  }),
  'Open chain item (UI 2.3) in wire form: refKey names the requirement, document or evidence of the same bundle (D.2)',
  {
    valid: [EXAMPLE_CHAIN_ITEM, { ...EXAMPLE_CHAIN_ITEM, key: 'isms:doc:PRC-07', kind: 'doc', id: 'PRC-07', refKey: 'isms:doc:PRC-07', due: '2026-09-24', st: 'overdue', gate: false }],
    invalid: [{ ...EXAMPLE_CHAIN_ITEM, kind: 'act' }, { ...EXAMPLE_CHAIN_ITEM, st: 'ready' }, { ...EXAMPLE_CHAIN_ITEM, act: 'Select a treatment' }],
  },
);
export type ChainItem = z.infer<typeof ChainItem>;

export const GateItem = named(
  'GateItem',
  z.object({ id: z.string(), type: Pair, why: Pair, h: PersonId, due: IsoDate.nullable(), key: z.string() }),
  'Gate item holding the critical gate (UI 2.4, A-27); type is a pair and the controller applies li() (G.5)',
  {
    valid: [EXAMPLE_GATE_ITEM, { id: 'R-031', type: ['Risk', 'Risiko'], why: ['Select a treatment', 'Select a treatment'], h: 'rina', due: '2026-10-20', key: 'x:R-031' }],
    invalid: [{ ...EXAMPLE_GATE_ITEM, type: 'Control' }, { ...EXAMPLE_GATE_ITEM, due: 'soon' }],
  },
);
export type GateItem = z.infer<typeof GateItem>;

export const Activity = named(
  'Activity',
  z.object({
    key: RecordKey,
    no: z.string().regex(/^\d+\.\d+$/),
    title: z.string(),
    st: ActStatus,
    blocker: z.string().nullable(),
    owner: PersonId,
    out: z.string().nullable(),
    docId: z.string().nullable(),
    date: IsoDate.nullable(),
    pno: z.int().min(1),
    by: PersonId.nullable().optional(),
  }),
  'Implementation activity (UI 1.9) in wire form: docId names the output document of the same bundle (D.2)',
  {
    valid: [EXAMPLE_ACTIVITY, { ...EXAMPLE_ACTIVITY, st: 'locked', blocker: null, out: null, docId: null, date: null }],
    invalid: [{ ...EXAMPLE_ACTIVITY, st: 'in_progress' }, { ...EXAMPLE_ACTIVITY, no: '4' }, { ...EXAMPLE_ACTIVITY, pno: 0 }],
  },
);
export type Activity = z.infer<typeof Activity>;

export const Phase = named(
  'Phase',
  z.object({
    no: z.int().min(1),
    n: z.string(),
    gate: z.boolean(),
    acts: z.array(Activity),
    total: z.int().min(0),
    c: z.object({
      verified: z.int().min(0), complete: z.int().min(0), progress: z.int().min(0),
      blocked: z.int().min(0), ns: z.int().min(0), locked: z.int().min(0),
    }),
  }),
  'Implementation phase with its activities and counts per status (UI 2.7)',
  {
    valid: [EXAMPLE_PHASE],
    invalid: [{ ...EXAMPLE_PHASE, c: { verified: 0 } }, { ...EXAMPLE_PHASE, no: 0 }],
  },
);
export type Phase = z.infer<typeof Phase>;

export const Stage = named(
  'Stage',
  z.object({ id: StageKey, l: Pair, q: z.string(), rec: z.int().min(0).optional(), src: StageSrc.optional() }),
  'Chain stage definition (UI 1.8 STAGES, G.5); src is absent for entity stages',
  {
    valid: [EXAMPLE_STAGE, { id: 'control', l: ['Control', 'Kontrol'], q: 'Which Annex A control implements the treatment?', src: 'req' }],
    invalid: [{ ...EXAMPLE_STAGE, src: 'entity' }, { ...EXAMPLE_STAGE, l: 'Risk' }],
  },
);
export type Stage = z.infer<typeof Stage>;

export const XRecord = named(
  'XRecord',
  z.object({
    id: z.string(),
    t: z.string(),
    act: z.string(),
    h: PersonId,
    due: IsoDate.nullable(),
    gate: z.boolean().optional(),
    up: z.array(z.string()).optional(),
    down: z.array(z.string()).optional(),
  }),
  'Open record of an entity stage (UI 1.8 X, G.5)',
  {
    valid: [EXAMPLE_X_RECORD, { id: 'CI-09', t: 'Regulatory change', act: 'Review relevance', h: 'lina', due: '2026-10-20' }],
    invalid: [{ ...EXAMPLE_X_RECORD, h: 'Rina' }, { ...EXAMPLE_X_RECORD, due: undefined }],
  },
);
export type XRecord = z.infer<typeof XRecord>;

export const MsBundle = named(
  'MsBundle',
  z.object({
    reqs: z.array(Requirement),
    docs: z.array(Document),
    evs: z.array(Evidence),
    chain: z.object({ items: z.array(ChainItem), recs: z.record(StageKey, z.int().min(0)) }),
    gates: z.array(GateItem),
    phases: z.array(Phase),
  }),
  'Derived records of one system (UI 4.2 MsBundle) in wire form',
  {
    valid: [
      {
        reqs: [EXAMPLE_REQUIREMENT], docs: [EXAMPLE_DOCUMENT], evs: [EXAMPLE_EVIDENCE],
        chain: { items: [EXAMPLE_CHAIN_ITEM], recs: { risk: 38, control: 93 } }, gates: [EXAMPLE_GATE_ITEM], phases: [EXAMPLE_PHASE],
      },
      { reqs: [], docs: [], evs: [], chain: { items: [], recs: {} }, gates: [], phases: [] },
    ],
    invalid: [{ reqs: [], docs: [], evs: [], chain: { items: [] }, gates: [], phases: [] }, { reqs: [] }],
  },
);
export type MsBundle = z.infer<typeof MsBundle>;
