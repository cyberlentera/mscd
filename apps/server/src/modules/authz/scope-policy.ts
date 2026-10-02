// SCOPE_POLICY (build plan D-04, D-34, F.7, G.5): what a caller may read of one system, applied by every read path
// (`/ui/*`, the TS 9.2 endpoints, register lists, files, evidence packs, chains, exports, notifications, the audit
// trail). Counts and derived values are computed by the readers on the full data first; this policy then removes
// what the caller may not see.
//
// - Read scope per system, from the caller's roles there (first match wins, `readScopeKind`): `full` (MS Manager,
//   Programme Owner, Internal Auditor), `top_management` (no storage object access, pending data as aggregates
//   only), `own` (Domain Owner, Risk Owner, Compliance Investigator: only records whose owner or holder is the
//   user), `external_auditor` (the G.5 `EaProjection`).
// - Classification: documents and evidence classified `restricted` are visible only to their owner and to MS
//   Managers and Programme Owners of a linked system; `confidential` ones are hidden from external auditors unless
//   the item is in one of their evidence packs.
// - External auditors see evidence only through `ready` evidence packs of the audited system and open only the pack
//   copies (`evidence_pack_item.copy_storage_object_id`); `web_url`, holder names and pending data are never sent.
//
// Readers use `scopeContext` once per request and then `filterRecords`, `projectSnapshot` (`GET /ui/ms/{ms}`),
// `filterOrgSnapshot` (`GET /ui/org`) and `canReadObject` (file routes).
import { Injectable } from '@nestjs/common';
import {
  readScopeKind,
  type BusinessRole,
  type Document,
  type Evidence,
  type ReadScopeKind,
  type UiMsSnapshot,
  type UiOrgSnapshot,
} from '@mscd/shared';
import { sql } from 'kysely';
import { ForbiddenError, NotFoundError } from '../../common/problems';
import type { AuthzState, MsRef, Principal, ReadScope, ScopePolicy, ScopedRecord, Trx } from '../../common/tokens';
import { AuthzInfra } from './authz-infra';
import { RoleResolver, type PrincipalRoles } from './role-resolver';

export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';

/** A document or evidence record classified `confidential` or `restricted`. */
export interface ClassifiedRecord {
  id: string;
  code: string;
  ownerUserId: string | null;
  classification: Classification;
  /** Systems the record is linked to (`entity_ms_link`, and evidence targets for evidence). */
  msIds: readonly string[];
  /** Organisation-wide documents count as linked to every system. */
  orgWide: boolean;
}

/** What the read paths of one request need to scope the data of one system (built once per request). */
export interface ScopeContext {
  userId: string;
  handle: string;
  ms: MsRef;
  kind: ReadScopeKind;
  /** The caller's business roles in the system. */
  roles: readonly BusinessRole[];
  /** Systems (ids) where the caller is MS Manager or Programme Owner (restricted classification). */
  managerOf: ReadonlySet<string>;
  /** Documents classified confidential or restricted, by `doc_code`. */
  classifiedDocuments: ReadonlyMap<string, ClassifiedRecord>;
  /** Evidence classified confidential or restricted, by `evidence_code`. */
  classifiedEvidence: ReadonlyMap<string, ClassifiedRecord>;
  /** External auditors: the evidence of `ready` packs of the system and the pack copies they may open. */
  auditorPack: { evidenceIds: ReadonlySet<string>; evidenceCodes: ReadonlySet<string>; copyObjectIds: ReadonlySet<string> };
}

/** A record as `filterRecords` needs it. */
export interface ScopableRecord extends ScopedRecord {
  /** Documents and evidence: their classification. */
  classification?: Classification | null;
  /** Systems (ids) the record is linked to, for the restricted rule; default the context system. */
  linkedMsIds?: readonly string[];
  /** Evidence: its id (external auditors see evidence only through their packs). */
  evidenceId?: string | null;
}

/** What the read paths of `GET /ui/org` need: the caller's scope in every system of the organisation. */
export interface OrgScopeContext {
  userId: string;
  handle: string;
  /** Read scope per system slug where the caller holds a business role. */
  kindByMs: ReadonlyMap<string, ReadScopeKind>;
  /** True when the caller holds an organisation role (Tenant or Storage Admin). */
  orgAdmin: boolean;
  /** True when the caller's only business role, in every system, is external auditor (G.5 `EaProjection`). */
  externalAuditorOnly: boolean;
  /** Handles of active members holding an active business role, with the slugs of those systems. */
  peopleSystems: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Inputs the reader of `GET /ui/org` knows and this policy cannot derive from the snapshot alone. */
export interface OrgSnapshotSources {
  /**
   * For systems where the caller's roles are only own-scoped: the codes of the records the caller owns or holds,
   * plus the codes those records reference (up and down). Chains of such a system keep only these codes (other
   * nodes become null) and `TITLES` only their titles. Without it, such systems contribute no chains or titles.
   */
  visibleCodesByMs?: Readonly<Record<string, ReadonlySet<string>>>;
  /** Requirement keys of `EXAMPLES` per system; without it `EXAMPLES` is kept whole when the caller holds a role. */
  exampleKeysByMs?: Readonly<Record<string, readonly string[]>>;
}

/** The handle of an unassigned holder (UI 1.3 `PEOPLE.none`). */
const NONE_HANDLE = 'none';

const MANAGER_ROLES: ReadonlySet<BusinessRole> = new Set(['ms_manager', 'programme_owner']);

interface ClassifiedRow {
  id: string;
  code: string;
  owner_user_id: string | null;
  classification: Classification;
  ms_ids: string[] | null;
  org_wide: boolean;
}

interface ObjectReference {
  owner_user_id: string | null;
  classification: Classification;
  code: string;
  kind: 'evidence' | 'document';
}

@Injectable()
export class ScopePolicyService implements ScopePolicy {
  constructor(
    private readonly roles: RoleResolver,
    private readonly infra: AuthzInfra,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // ScopePolicy token (WP-08 interface)
  // ---------------------------------------------------------------------------------------------------------------

  async readScope(trx: Trx, principal: Principal, ms: string, _authz?: AuthzState | null): Promise<ReadScope> {
    const held = await this.rolesOf(trx, principal);
    const system = held.systems.get(ms);
    if (!system) throw new NotFoundError('Unknown management system');
    const kind = readScopeKind(system.roles);
    switch (kind) {
      case 'full':
        return { kind: 'full' };
      case 'top_management':
        return { kind: 'top_management' };
      case 'own':
        return { kind: 'own', userId: principal.user.id };
      case 'external_auditor':
        return { kind: 'external_auditor', userId: principal.user.id };
      default:
        throw new ForbiddenError('No role in this management system');
    }
  }

  filter<T extends ScopedRecord>(scope: ReadScope, records: readonly T[]): T[] {
    switch (scope.kind) {
      case 'full':
      case 'top_management':
        return [...records];
      case 'own':
        return records.filter((r) => isOwnedBy(r, scope.userId));
      default:
        // External auditors see records only through the projection, which needs the pack context.
        return [];
    }
  }

  async canReadObject(trx: Trx, principal: Principal, ms: string, storageObjectId: string, _authz?: AuthzState | null): Promise<boolean> {
    const ctx = await this.scopeContext(trx, principal, ms);
    return this.canReadObjectIn(trx, ctx, storageObjectId);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------------------------------------------

  /** The scope of `ms` for the caller, read in the request's tenant transaction. 404 unknown system, 403 no role. */
  async scopeContext(trx: Trx, principal: Principal, ms: string): Promise<ScopeContext> {
    const held = await this.rolesOf(trx, principal);
    const system = held.systems.get(ms);
    if (!system) throw new NotFoundError('Unknown management system');
    const kind = readScopeKind(system.roles);
    if (!kind) throw new ForbiddenError('No role in this management system');
    const managerOf = new Set([...held.systems.values()].filter((s) => s.roles.some((r) => MANAGER_ROLES.has(r))).map((s) => s.id));
    // One transaction runs one statement at a time: read in sequence.
    const documents = await this.classifiedDocuments(trx);
    const evidence = await this.classifiedEvidence(trx);
    const auditorPack = kind === 'external_auditor' ? await this.auditorPack(trx, system.id) : EMPTY_PACK;
    return {
      userId: principal.user.id,
      handle: principal.user.handle,
      ms: { id: system.id, slug: system.slug },
      kind,
      roles: system.roles,
      managerOf,
      classifiedDocuments: documents,
      classifiedEvidence: evidence,
      auditorPack,
    };
  }

  /** The caller's scope in every system of the organisation, for `GET /ui/org`. */
  async orgScopeContext(trx: Trx, principal: Principal): Promise<OrgScopeContext> {
    const held = await this.rolesOf(trx, principal);
    const kindByMs = new Map<string, ReadScopeKind>();
    const all: BusinessRole[] = [];
    for (const system of held.systems.values()) {
      const kind = readScopeKind(system.roles);
      if (kind) kindByMs.set(system.slug, kind);
      all.push(...system.roles);
    }
    const externalAuditorOnly = all.length > 0 && all.every((r) => r === 'external_auditor');
    const { rows } = await sql<{ handle: string; systems: string[] }>`
      select u.handle, array_agg(distinct ms.slug) as systems
      from user_ms_role r
      join management_system ms on ms.id = r.management_system_id and ms.deleted_at is null
      join platform.app_user u on u.id = r.user_id and u.status = 'active' and u.deleted_at is null
      join platform.org_membership m on m.user_id = r.user_id and m.status = 'active' and m.deleted_at is null
        and m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
      where r.deleted_at is null and r.approval_status = 'active' and (r.valid_until is null or r.valid_until > ${this.infra.now()})
      group by u.handle`.execute(trx);
    const peopleSystems = new Map<string, ReadonlySet<string>>(rows.map((r) => [r.handle, new Set(r.systems)]));
    return {
      userId: principal.user.id,
      handle: principal.user.handle,
      kindByMs,
      orgAdmin: held.orgRoles.length > 0,
      externalAuditorOnly,
      peopleSystems,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------------------------------------------

  /** Keeps the records the caller may see in the context system (owner scope, classification, auditor packs). */
  filterRecords<T extends ScopableRecord>(ctx: ScopeContext, records: readonly T[]): T[] {
    return records.filter((r) => this.recordVisible(ctx, r));
  }

  /** One record of `filterRecords`. */
  recordVisible(ctx: ScopeContext, record: ScopableRecord): boolean {
    if (ctx.kind === 'own' && !isOwnedBy(record, ctx.userId)) return false;
    if (ctx.kind === 'external_auditor') {
      if (record.evidenceId !== undefined && (!record.evidenceId || !ctx.auditorPack.evidenceIds.has(record.evidenceId))) return false;
      if (record.classification === 'confidential' && !(record.evidenceId && ctx.auditorPack.evidenceIds.has(record.evidenceId))) return false;
    }
    if (record.classification === 'restricted') {
      const linked = record.linkedMsIds && record.linkedMsIds.length > 0 ? record.linkedMsIds : [ctx.ms.id];
      return record.ownerUserId === ctx.userId || linked.some((id) => ctx.managerOf.has(id));
    }
    return true;
  }

  /** True when a document code of the system's snapshot may be shown to the caller (classification). */
  documentVisible(ctx: ScopeContext, code: string): boolean {
    const c = ctx.classifiedDocuments.get(code);
    if (!c) return true;
    if (c.classification === 'confidential') return ctx.kind !== 'external_auditor';
    return this.restrictedVisible(ctx, c);
  }

  /** True when an evidence code of the system's snapshot may be shown to the caller (classification, packs). */
  evidenceVisible(ctx: ScopeContext, code: string): boolean {
    if (ctx.kind === 'external_auditor' && !ctx.auditorPack.evidenceCodes.has(code)) return false;
    const c = ctx.classifiedEvidence.get(code);
    if (!c || c.classification === 'confidential') return true;
    return this.restrictedVisible(ctx, c);
  }

  private restrictedVisible(ctx: ScopeContext, c: ClassifiedRecord): boolean {
    if (c.ownerUserId === ctx.userId) return true;
    if (c.orgWide && ctx.managerOf.size > 0) return true;
    const linked = c.msIds.length > 0 ? c.msIds : [ctx.ms.id];
    return linked.some((id) => ctx.managerOf.has(id));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * `GET /ui/ms/{ms}` for the caller (G.5): classification for everyone, owner scoping for own-scoped roles (lists
   * keep the records whose owner or holder is the caller; counts such as `chain.recs` and phase counts stay as
   * computed on the full data, D-04), the `EaProjection` for external auditors. Returns a new snapshot.
   */
  projectSnapshot(ctx: ScopeContext, snapshot: UiMsSnapshot): UiMsSnapshot {
    if (ctx.kind === 'external_auditor') return this.auditorProjection(ctx, snapshot);
    const ms = snapshot.ms;
    const own = ctx.kind === 'own';
    const mine = (holder: string | null | undefined) => !own || holder === ctx.handle;
    const bundle = snapshot.bundle;

    const reqs = bundle.reqs.filter((r) => mine(r.owner));
    const docs = bundle.docs.filter((d) => mine(d.owner) && this.documentVisible(ctx, d.id));
    const evs = bundle.evs.filter((e) => mine(e.owner) && this.evidenceVisible(ctx, e.code));
    const hiddenDocs = new Set(bundle.docs.filter((d) => !this.documentVisible(ctx, d.id)).map((d) => d.id));
    const hiddenEvs = new Set(bundle.evs.filter((e) => !this.evidenceVisible(ctx, e.code)).map((e) => e.code));
    const itemHidden = (kind: string, id: string) => (kind === 'doc' && hiddenDocs.has(id)) || (kind === 'ev' && hiddenEvs.has(id));
    const items = bundle.chain.items.filter((i) => mine(i.h) && !itemHidden(i.kind, i.id));
    const gates = bundle.gates.filter((g) => mine(g.h));
    const phases = bundle.phases.map((p) => ({ ...p, acts: p.acts.filter((a) => mine(a.owner)) }));
    const X: UiMsSnapshot['X'] = {};
    for (const [stage, records] of Object.entries(snapshot.X)) X[stage] = records.filter((x) => mine(x.h));
    const PREP = snapshot.PREP.filter((row) => mine(row[1]));
    const CYCLE_ITEMS = snapshot.CYCLE_ITEMS.filter((row) => mine(row[2]));
    const DRIFT = snapshot.DRIFT.map((pattern) => (pattern.rows ? { ...pattern, rows: pattern.rows.filter((row) => mine(row[2])) } : { ...pattern }));

    if (ctx.kind === 'top_management') {
      // F.7, Q-8: Top Management gets pending data as aggregates only. Holders and due dates of pending work are kept
      // only for records the caller holds; counts stay as computed on the full data (the rule of the TS 9.2
      // endpoints, `holderShown` in read-model-api/screens.ts).
      const shown = (holder: string | null | undefined) => !!holder && holder === ctx.handle;
      const hide = <T extends { h: string; due: string | null }>(x: T): T => (shown(x.h) ? x : { ...x, h: NONE_HANDLE, due: null });
      for (let i = 0; i < items.length; i += 1) items[i] = hide(items[i]!);
      for (let i = 0; i < gates.length; i += 1) gates[i] = hide(gates[i]!);
      for (const stage of Object.keys(X)) X[stage] = X[stage]!.map(hide);
      for (let i = 0; i < PREP.length; i += 1) {
        const row = PREP[i]!;
        if (!shown(row[1])) PREP[i] = [row[0], NONE_HANDLE, row[2], row[3]];
      }
      for (let i = 0; i < CYCLE_ITEMS.length; i += 1) {
        const row = CYCLE_ITEMS[i]!;
        if (!shown(row[2])) CYCLE_ITEMS[i] = [row[0], row[1], NONE_HANDLE, row[3], row[4], row[5]];
      }
      for (let i = 0; i < DRIFT.length; i += 1) {
        const pattern = DRIFT[i]!;
        if (pattern.rows) DRIFT[i] = { ...pattern, rows: pattern.rows.map((row) => (shown(row[2]) ? row : [row[0], row[1], NONE_HANDLE, row[3]])) };
      }
    }

    const keep = new KeptKeys(ms);
    keep.reqs(reqs, true);
    keep.docs(docs);
    keep.evs(evs);
    keep.items(items);
    for (const phase of phases) keep.acts(phase.acts);
    for (const records of Object.values(X)) keep.xs(records);
    keep.rows('prep', PREP.map((row) => row[0]));
    keep.rows('cycle', CYCLE_ITEMS.map((row) => row[0]));
    keep.rows('drift', DRIFT.flatMap((pattern) => (pattern.rows ?? []).map((row) => row[0])));
    // Everything a full reader sees keeps its ref, minus hidden documents and evidence.
    const refs = own ? keep.filter(snapshot.refs) : filterRefs(snapshot.refs, ms, hiddenDocs, hiddenEvs);

    return {
      ...snapshot,
      bundle: { ...bundle, reqs, docs, evs, chain: { items, recs: { ...bundle.chain.recs } }, gates, phases },
      X,
      PREP,
      CYCLE_ITEMS,
      DRIFT,
      refs,
    };
  }

  /** The G.5 `EaProjection` of `GET /ui/ms/{ms}` for an external auditor. */
  private auditorProjection(ctx: ScopeContext, snapshot: UiMsSnapshot): UiMsSnapshot {
    const reqs = snapshot.bundle.reqs.map(({ owner: _owner, by: _by, note: _note, ...rest }) => rest);
    const docs = snapshot.bundle.docs
      .filter((d) => this.documentVisible(ctx, d.id))
      .map(({ owner: _owner, approver: _approver, path: _path, ...rest }): Document => rest);
    const evs = snapshot.bundle.evs
      .filter((e) => this.evidenceVisible(ctx, e.code))
      .map(({ owner: _owner, path: _path, hash: _hash, ...rest }): Evidence => rest);
    const keep = new KeptKeys(snapshot.ms);
    keep.reqs(reqs, false);
    keep.docs(docs);
    keep.evs(evs);
    return {
      ms: snapshot.ms,
      bundle: { reqs, docs, evs, chain: { items: [], recs: { ...snapshot.bundle.chain.recs } }, gates: [], phases: [] },
      X: {},
      EVENTS: snapshot.EVENTS,
      FOCUS: snapshot.FOCUS,
      PREP: [],
      PAST: snapshot.PAST,
      CYCLE_ITEMS: [],
      DRIFT: [],
      refs: keep.filter(snapshot.refs),
    };
  }

  /**
   * `GET /ui/org` for the caller (F.7, G.5): `CHAINS`, `TITLES`, `CLAUSE_AT_RISK` and `EXAMPLES` only for systems
   * where the caller holds a role (with only own-scoped roles there, only visible records), `PEOPLE` only members
   * holding a role in one of those systems; for external auditors only the audited systems, `PEOPLE` without job
   * titles and `REPOS`, `ROUTING`, `PACKS` and `LICENCE` empty. Returns a new snapshot.
   */
  filterOrgSnapshot(ctx: OrgScopeContext, snapshot: UiOrgSnapshot, sources: OrgSnapshotSources = {}): UiOrgSnapshot {
    const roleSystems = new Set(ctx.kindByMs.keys());
    const CHAINS: UiOrgSnapshot['CHAINS'] = {};
    const titled = new Set<string>();
    for (const [ms, chains] of Object.entries(snapshot.CHAINS)) {
      const kind = ctx.kindByMs.get(ms);
      if (!kind) continue;
      if (kind !== 'own') {
        CHAINS[ms] = chains.map((c) => ({ id: c.id, nodes: c.nodes.map(([stage, code]) => [stage, code] as [string, string | null]) }));
        for (const c of chains) {
          titled.add(c.id);
          for (const [, code] of c.nodes) if (code) titled.add(code);
        }
        continue;
      }
      const visible = sources.visibleCodesByMs?.[ms];
      if (!visible) continue;
      const kept = [];
      for (const c of chains) {
        if (!visible.has(c.id) && !c.nodes.some(([, code]) => code !== null && visible.has(code))) continue;
        const nodes = c.nodes.map(([stage, code]) => [stage, code !== null && visible.has(code) ? code : null] as [string, string | null]);
        kept.push({ id: c.id, nodes });
        if (visible.has(c.id)) titled.add(c.id);
        for (const [, code] of nodes) if (code) titled.add(code);
      }
      CHAINS[ms] = kept;
    }
    const TITLES: Record<string, string> = {};
    for (const [code, title] of Object.entries(snapshot.TITLES)) if (titled.has(code)) TITLES[code] = title;

    const stageKeys = new Set<string>();
    for (const ms of roleSystems) for (const stage of snapshot.STAGES[ms] ?? []) stageKeys.add(stage.id);
    const CLAUSE_AT_RISK: Record<string, string> = {};
    for (const [stage, clause] of Object.entries(snapshot.CLAUSE_AT_RISK)) if (stageKeys.has(stage)) CLAUSE_AT_RISK[stage] = clause;

    let EXAMPLES: Record<string, string> = {};
    if (sources.exampleKeysByMs) {
      const keys = new Set([...roleSystems].flatMap((ms) => sources.exampleKeysByMs?.[ms] ?? []));
      for (const [key, example] of Object.entries(snapshot.EXAMPLES)) if (keys.has(key)) EXAMPLES[key] = example;
    } else if (roleSystems.size > 0) {
      EXAMPLES = { ...snapshot.EXAMPLES };
    }

    const PEOPLE: UiOrgSnapshot['PEOPLE'] = {};
    for (const [handle, person] of Object.entries(snapshot.PEOPLE)) {
      const systems = ctx.peopleSystems.get(handle);
      const shown = handle === 'none' || (systems !== undefined && [...systems].some((ms) => roleSystems.has(ms)));
      if (!shown) continue;
      PEOPLE[handle] = ctx.externalAuditorOnly && handle !== 'none' ? [person[0], '-'] : [person[0], person[1]];
    }

    // A system card of a system where the caller holds no role keeps its aggregates, but not the gate suggestions:
    // they are record codes of that system (J.5 "nothing of QMS", WP-30).
    const MS = snapshot.MS.map((m) => {
      if (roleSystems.has(m.id) || m.gtSuggestions === undefined) return m;
      const { gtSuggestions: _hidden, ...card } = m;
      return card;
    });
    const result: UiOrgSnapshot = { ...snapshot, MS, CHAINS, TITLES, CLAUSE_AT_RISK, EXAMPLES, PEOPLE };
    if (ctx.externalAuditorOnly) {
      const STAGES: UiOrgSnapshot['STAGES'] = {};
      for (const [ms, stages] of Object.entries(snapshot.STAGES)) if (roleSystems.has(ms)) STAGES[ms] = stages;
      return {
        ...result,
        MS: snapshot.MS.filter((m) => roleSystems.has(m.id)),
        STAGES,
        REPOS: [],
        ROUTING: [],
        PACKS: {},
        LICENCE: null,
      };
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * F.7 `canReadObject` with a context: Top Management never; external auditors only pack copies of `ready` packs of
   * the system; everyone else when the object is referenced by a record of the system they can see (evidence,
   * document version, a copy in an evidence pack, or a pack manifest or archive for full readers).
   */
  async canReadObjectIn(trx: Trx, ctx: ScopeContext, storageObjectId: string): Promise<boolean> {
    if (!UUID.test(storageObjectId)) return false;
    if (ctx.kind === 'top_management') return false;
    if (ctx.kind === 'external_auditor') return ctx.auditorPack.copyObjectIds.has(storageObjectId);
    const msId = ctx.ms.id;
    const { rows } = await sql<ObjectReference>`
      select e.owner_user_id, e.classification, e.evidence_code as code, 'evidence' as kind
      from evidence e
      where e.deleted_at is null
        and (e.storage_object_id = ${storageObjectId}
             or exists (select 1 from evidence_pack_item i join evidence_pack p on p.id = i.evidence_pack_id
                        where i.evidence_id = e.id and i.copy_storage_object_id = ${storageObjectId}
                          and p.management_system_id = ${msId} and p.deleted_at is null))
        and (exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = e.id
                       and l.management_system_id = ${msId} and l.deleted_at is null)
             or exists (select 1 from evidence_target t where t.evidence_id = e.id
                          and t.management_system_id = ${msId} and t.deleted_at is null))
      union all
      select d.owner_user_id, d.classification, d.doc_code as code, 'document' as kind
      from document_version v
      join document d on d.id = v.document_id and d.deleted_at is null
      where v.storage_object_id = ${storageObjectId} and v.deleted_at is null
        and (d.is_org_wide
             or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                          and l.management_system_id = ${msId} and l.deleted_at is null))`.execute(trx);
    for (const ref of rows) {
      const classified = ref.kind === 'evidence' ? ctx.classifiedEvidence.get(ref.code) : ctx.classifiedDocuments.get(ref.code);
      const visible = this.recordVisible(ctx, {
        ownerUserId: ref.owner_user_id,
        classification: ref.classification,
        linkedMsIds: classified?.msIds,
      });
      if (visible) return true;
    }
    if (ctx.kind !== 'full') return false;
    const pack = await trx
      .selectFrom('evidence_pack')
      .select('id')
      .where('management_system_id', '=', msId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('manifest_pdf_object_id', '=', storageObjectId),
          eb('manifest_csv_object_id', '=', storageObjectId),
          eb('archive_object_id', '=', storageObjectId),
        ]),
      )
      .executeTakeFirst();
    return pack !== undefined;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------------------------

  private rolesOf(trx: Trx, principal: Principal): Promise<PrincipalRoles> {
    return this.roles.rolesOfIn(trx, principal);
  }

  private async classifiedDocuments(trx: Trx): Promise<Map<string, ClassifiedRecord>> {
    const { rows } = await sql<ClassifiedRow>`
      select d.id, d.doc_code as code, d.owner_user_id, d.classification, d.is_org_wide as org_wide,
             array_agg(l.management_system_id) filter (where l.id is not null) as ms_ids
      from document d
      left join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null
      where d.deleted_at is null and d.classification in ('confidential', 'restricted')
      group by d.id`.execute(trx);
    return toClassified(rows);
  }

  private async classifiedEvidence(trx: Trx): Promise<Map<string, ClassifiedRecord>> {
    const { rows } = await sql<ClassifiedRow>`
      select e.id, e.evidence_code as code, e.owner_user_id, e.classification, false as org_wide,
             array_remove(array_cat(
               coalesce((select array_agg(l.management_system_id) from entity_ms_link l
                         where l.entity_type = 'evidence' and l.entity_id = e.id and l.deleted_at is null), '{}'),
               coalesce((select array_agg(t.management_system_id) from evidence_target t
                         where t.evidence_id = e.id and t.deleted_at is null), '{}')), null) as ms_ids
      from evidence e
      where e.deleted_at is null and e.classification in ('confidential', 'restricted')`.execute(trx);
    return toClassified(rows);
  }

  private async auditorPack(trx: Trx, msId: string): Promise<ScopeContext['auditorPack']> {
    const rows = await trx
      .selectFrom('evidence_pack_item as i')
      .innerJoin('evidence_pack as p', 'p.id', 'i.evidence_pack_id')
      .select(['i.evidence_id', 'i.evidence_code', 'i.copy_storage_object_id'])
      .where('p.management_system_id', '=', msId)
      .where('p.status', '=', 'ready')
      .where('p.deleted_at', 'is', null)
      .execute();
    return {
      evidenceIds: new Set(rows.map((r) => r.evidence_id)),
      evidenceCodes: new Set(rows.map((r) => r.evidence_code)),
      copyObjectIds: new Set(rows.flatMap((r) => (r.copy_storage_object_id ? [r.copy_storage_object_id] : []))),
    };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_PACK: ScopeContext['auditorPack'] = { evidenceIds: new Set(), evidenceCodes: new Set(), copyObjectIds: new Set() };

function isOwnedBy(record: ScopedRecord, userId: string): boolean {
  return record.ownerUserId === userId || record.holderUserId === userId;
}

function toClassified(rows: ClassifiedRow[]): Map<string, ClassifiedRecord> {
  return new Map(
    rows.map((r) => [
      r.code,
      { id: r.id, code: r.code, ownerUserId: r.owner_user_id, classification: r.classification, msIds: [...new Set(r.ms_ids ?? [])], orgWide: r.org_wide },
    ]),
  );
}

/** Record keys (`<ms>:<kind>:<business id>`, G.5) of the records a projection keeps. */
class KeptKeys {
  private readonly keys = new Set<string>();
  private readonly codes = new Map<string, Set<string>>();

  constructor(private readonly ms: string) {}

  reqs(reqs: readonly { id: string }[], withSoa: boolean): void {
    for (const r of reqs) {
      this.keys.add(`${this.ms}:req:${r.id}`);
      if (withSoa) this.keys.add(`${this.ms}:soa:${r.id}`);
    }
  }

  docs(docs: readonly { id: string }[]): void {
    for (const d of docs) this.keys.add(`${this.ms}:doc:${d.id}`);
  }

  evs(evs: readonly { code: string }[]): void {
    for (const e of evs) this.keys.add(`${this.ms}:ev:${e.code}`);
  }

  items(items: readonly { key: string; refKey?: string | undefined }[]): void {
    for (const i of items) {
      this.keys.add(i.key);
      if (i.refKey) this.keys.add(i.refKey);
    }
  }

  acts(acts: readonly { key: string }[]): void {
    for (const a of acts) this.keys.add(a.key);
  }

  xs(records: readonly { id: string }[]): void {
    for (const x of records) this.keys.add(`${this.ms}:x:${x.id}`);
  }

  /** Rows without a key of their own (`prep`, `cycle`, `drift`): matched by the business id or the ref code. */
  rows(kind: 'prep' | 'cycle' | 'drift', ids: readonly string[]): void {
    const set = this.codes.get(kind) ?? new Set<string>();
    for (const id of ids) set.add(id);
    this.codes.set(kind, set);
  }

  filter(refs: UiMsSnapshot['refs']): UiMsSnapshot['refs'] {
    const out: UiMsSnapshot['refs'] = {};
    for (const [key, ref] of Object.entries(refs)) {
      if (this.keys.has(key)) {
        out[key] = ref;
        continue;
      }
      const kind = key.split(':')[1] ?? '';
      const codes = this.codes.get(kind);
      const businessId = key.slice(key.indexOf(':', key.indexOf(':') + 1) + 1);
      if (codes && (codes.has(businessId) || codes.has(ref.code))) out[key] = ref;
    }
    return out;
  }
}

/** All refs except those of hidden documents and evidence. */
function filterRefs(refs: UiMsSnapshot['refs'], ms: string, hiddenDocs: ReadonlySet<string>, hiddenEvs: ReadonlySet<string>): UiMsSnapshot['refs'] {
  const out: UiMsSnapshot['refs'] = {};
  for (const [key, ref] of Object.entries(refs)) {
    if (key.startsWith(`${ms}:doc:`) && hiddenDocs.has(key.slice(ms.length + 5))) continue;
    if (key.startsWith(`${ms}:ev:`) && hiddenEvs.has(key.slice(ms.length + 4))) continue;
    out[key] = ref;
  }
  return out;
}
