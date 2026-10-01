// The read model of the UI parity reads (build plan D-05, G.5, D-04, D-29): loads the organisation's rows in a
// tenant transaction, derives the snapshots on the full data, then applies `ScopePolicy` (F.7). Used by the `ui`
// module (`GET /ui/org`, `GET /ui/ms/{ms}`, `GET /tasks`) and, for the per-screen endpoints, by WP-32.
import { Inject, Injectable } from '@nestjs/common';
import {
  UI_ROLE_LABELS, type LicenceCard, type Permission, type RolesMap, type TaskList, type UiMsSnapshot, type UiOrgSnapshot, type UiRole,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError } from '../../common/problems';
import {
  ME_ASSEMBLER, PERMISSION_EVALUATOR, type MeAssembler, type PermissionEvaluator, type Principal, type TenantInfo, type Trx,
} from '../../common/tokens';
import { ScopePolicyService, type OrgScopeContext } from '../authz/scope-policy';
import { LicenceService } from '../license/licence.service';
import { listRepositoryViews, repositoryConfigSha256 } from '../storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { buildOrgSnapshot, exampleKeysByMs, heldRecordCodes, type LocRepository } from './build/organisation';
import { buildSystemSnapshot, type BuildContext } from './build/system';
import { licenceCard, repoRow } from './derive/org-formats';
import { deriveTaskList, type StoredTask } from './derive/tasks';
import { loadOpenTasks, loadOrgData, type OrgData, type SystemData } from './load/loader';

interface Member {
  handle: string;
  displayName: string;
  jobTitle: string | null;
  hasRole: boolean;
}

@Injectable()
export class ReadModelService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly scopePolicy: ScopePolicyService,
    private readonly licences: LicenceService,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(ME_ASSEMBLER) private readonly me: MeAssembler,
  ) {}

  private orgOf(principal: Principal): TenantInfo {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return principal.org;
  }

  /** `today` of the organisation (D-07: `demo.fixed_today` in demo and test installs). */
  today(org: Pick<TenantInfo, 'timeZone'>): string {
    return this.clock.todayIn(org.timeZone);
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /ui/ms/{ms}
  // -------------------------------------------------------------------------------------------------------------

  /** The full (unscoped) snapshot of one system, derived in the caller's transaction. */
  async systemSnapshotIn(trx: Trx, org: TenantInfo, ms: string): Promise<UiMsSnapshot> {
    const data = await loadOrgData(trx, { slugs: [ms], bundle: true, now: this.clock.now() });
    const system = data.systems[0];
    if (!system) throw new NotFoundError('Unknown management system');
    const ctx = await this.buildContext(trx, org, data);
    return buildSystemSnapshot(system, ctx);
  }

  /** `GET /ui/ms/{ms}` (G.5): derived on the full data, then `ScopePolicy.projectSnapshot` (owner scope, classification, D-34). */
  async msSnapshot(principal: Principal, ms: string): Promise<UiMsSnapshot> {
    const org = this.orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const scope = await this.scopePolicy.scopeContext(trx, principal, ms);
      const snapshot = await this.systemSnapshotIn(trx, org, ms);
      return this.scopePolicy.projectSnapshot(scope, snapshot);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /ui/org
  // -------------------------------------------------------------------------------------------------------------

  /** `GET /ui/org` (G.5, D.3): the organisation snapshot, then `ScopePolicy.filterOrgSnapshot`. */
  async orgSnapshot(principal: Principal): Promise<UiOrgSnapshot> {
    const org = this.orgOf(principal);
    const me = await this.me.assemble(principal, { csrfToken: '' });
    const permissions = me.permissions;
    const can = async (permission: Permission) => (await this.evaluator.evaluate(principal, permission, { scope: 'org' })) !== null;
    const [repoRead, packRead, licenceRead] = [await can('storage.repository.read'), await can('pack.read'), await can('license.read')];
    const roles = this.rolesMap(principal, me.personas, me.uiRoleByMs);
    const orgs = me.orgs;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.today(org);
      const scope = await this.scopePolicy.orgScopeContext(trx, principal);
      const data = await loadOrgData(trx, { bundle: false, now: this.clock.now() });
      const members = await this.members(trx, org.id);
      const repositories = await this.repositories(trx);
      const repos = repoRead
        ? (await listRepositoryViews(trx, { timeZone: org.timeZone, configSha256: repositoryConfigSha256 })).map(repoRow)
        : [];
      const licence = licenceRead ? await this.licenceCard(trx, org, data) : null;
      const snapshot = buildOrgSnapshot(data, {
        today,
        generatedAt: this.clock.now().toISOString(),
        timeZone: org.timeZone,
        orgs,
        roles,
        permissions,
        people: members.filter((m) => m.hasRole),
        repositories,
        repos,
        routing: repoRead,
        packs: packRead,
        licence,
      });
      const visibleCodesByMs = await this.ownVisibleCodes(trx, org, principal.user.handle, scope);
      return this.scopePolicy.filterOrgSnapshot(scope, snapshot, { visibleCodesByMs, exampleKeysByMs: exampleKeysByMs(data.systems) });
    });
  }

  /** G.5 `ROLES`: the demo personas, else one entry per UI role the session user holds, all naming the user. */
  private rolesMap(principal: Principal, personas: RolesMap | undefined, uiRoleByMs: Record<string, UiRole>): RolesMap {
    if (personas && Object.keys(personas).length > 0) return personas;
    const roles: RolesMap = {};
    for (const role of new Set(Object.values(uiRoleByMs))) {
      roles[role] = { who: principal.user.handle, label: [...UI_ROLE_LABELS[role]] as [string, string] };
    }
    return roles;
  }

  /** Members of the organisation with display names, job titles and whether they hold an active business role. */
  private async members(trx: Trx, orgId: string): Promise<Member[]> {
    const rows = (
      await sql<{ handle: string; display_name: string; job_title: string | null; has_role: boolean }>`
        select u.handle, u.display_name, u.job_title,
               exists (select 1 from user_ms_role r join management_system ms on ms.id = r.management_system_id and ms.deleted_at is null
                       where r.user_id = u.id and r.deleted_at is null and r.approval_status = 'active'
                         and (r.valid_until is null or r.valid_until > ${this.clock.now()})) as has_role
        from platform.org_membership m
        join platform.app_user u on u.id = m.user_id and u.deleted_at is null
        where m.organization_id = ${orgId}::uuid and m.deleted_at is null and m.status = 'active' and u.status = 'active'
        order by u.handle`.execute(trx)
    ).rows;
    return rows.map((r) => ({ handle: r.handle, displayName: r.display_name, jobTitle: r.job_title, hasRole: r.has_role }));
  }

  /** Every repository of the organisation (G.5 `LOC`), in card order. */
  private async repositories(trx: Trx): Promise<LocRepository[]> {
    const rows = await trx
      .selectFrom('storage_repository')
      .select(['slug', 'name', 'adapter', 'ownership_type', 'display'])
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .orderBy('slug')
      .execute();
    return rows.map((r) => ({ slug: r.slug, name: r.name, adapter: r.adapter, ownershipType: r.ownership_type, display: (r.display ?? {}) as Record<string, unknown> }));
  }

  /** G.5 `LICENCE` from the evaluated licence (D-15); null when none is installed. */
  private async licenceCard(trx: Trx, org: TenantInfo, data: OrgData): Promise<LicenceCard | null> {
    const evaluated = await this.licences.evaluate(trx, org.id);
    const doc = evaluated?.document;
    if (!evaluated || !doc) return null;
    const live = data.systems.filter((s) => s.status !== 'archived');
    return licenceCard({
      organization: doc.organization,
      validUntil: doc.valid_until,
      frameworks: doc.frameworks,
      storageAdapters: doc.storage_adapters,
      features: doc.features,
      maxManagementSystems: doc.max_management_systems,
      maxUsers: doc.max_users,
      frameworksUsed: new Set(live.map((s) => s.active.frameworkCode)).size,
      managementSystems: await this.licences.countManagementSystems(trx),
      activeUsers: await this.licences.countActiveUsers(trx, org.id),
      verified: evaluated.verified,
    });
  }

  /**
   * F.7 sources of `filterOrgSnapshot` for systems where the caller's roles are only own-scoped: the codes of the
   * records the caller owns or holds there, with the codes those records reference.
   */
  private async ownVisibleCodes(trx: Trx, org: TenantInfo, handle: string, scope: OrgScopeContext): Promise<Record<string, Set<string>>> {
    const own = [...scope.kindByMs].filter(([, kind]) => kind === 'own').map(([ms]) => ms);
    if (own.length === 0) return {};
    const data = await loadOrgData(trx, { slugs: own, bundle: true, now: this.clock.now() });
    const ctx = await this.buildContext(trx, org, data);
    const out: Record<string, Set<string>> = {};
    for (const system of data.systems) {
      const snapshot = buildSystemSnapshot(system, ctx);
      const codes = heldRecordCodes(system, handle);
      const addAll = (list: readonly string[] | undefined) => list?.forEach((c) => c && codes.add(c));
      for (const r of snapshot.bundle.reqs) if (r.owner === handle) addAll([r.id, r.doc, ...r.risks]);
      for (const d of snapshot.bundle.docs) if (d.owner === handle) codes.add(d.id);
      for (const e of snapshot.bundle.evs) if (e.owner === handle) addAll([e.code, e.ctrl, `ev:${e.ctrl}`]);
      for (const i of snapshot.bundle.chain.items) if (i.h === handle) addAll([i.id, ...i.up, ...i.down]);
      for (const records of Object.values(snapshot.X)) for (const x of records) if (x.h === handle) addAll([x.id, ...(x.up ?? []), ...(x.down ?? [])]);
      out[system.slug] = codes;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /tasks
  // -------------------------------------------------------------------------------------------------------------

  /** `GET /tasks` (D-29): chain items the caller holds in every system where they hold a role, plus stored tasks. */
  async tasks(principal: Principal): Promise<TaskList> {
    const org = this.orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.today(org);
      const scope = await this.scopePolicy.orgScopeContext(trx, principal);
      const slugs = [...scope.kindByMs.keys()];
      if (slugs.length === 0) return { items: [], counts: { total: 0, overdue: 0, week: 0, later: 0 } };
      const data = await loadOrgData(trx, { slugs, bundle: true, now: this.clock.now() });
      const ctx = await this.buildContext(trx, org, data);
      const sources = data.systems.map((system) => {
        const snapshot = buildSystemSnapshot(system, ctx);
        const next = system.events.filter((e) => e.scheduledAt >= today).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
        return { ms: system.slug, auditDate: next?.scheduledAt ?? null, items: snapshot.bundle.chain.items, reqs: snapshot.bundle.reqs, refs: snapshot.refs };
      });
      const slugById = new Map(data.systems.map((s) => [s.id, s.slug]));
      const stored: StoredTask[] = (await loadOpenTasks(trx, principal.user.id, data.systems.map((s) => s.id))).map((t) => ({
        id: t.id,
        ms: slugById.get(t.msId)!,
        entityType: t.entityType,
        entityId: t.entityId,
        entityCode: t.entityCode,
        title: [t.titleEn, t.titleId],
        dueAt: t.dueAt,
      }));
      return deriveTaskList(principal.user.handle, today, sources, stored);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------------------------------------------

  private async buildContext(trx: Trx, org: TenantInfo, data: OrgData): Promise<BuildContext> {
    const members = await this.members(trx, org.id);
    const codes = await trx.selectFrom('management_system').select(['id', 'code']).where('deleted_at', 'is', null).execute();
    return {
      today: this.today(org),
      now: this.clock.now(),
      timeZone: org.timeZone,
      people: new Map(members.map((m) => [m.handle, m.displayName])),
      systemCodes: new Map([...codes.map((c) => [c.id, c.code] as const), ...data.systems.map((s) => [s.id, s.code] as const)]),
    };
  }

  /** Loads and builds every system snapshot of the organisation (unscoped), for readers that need all of them. */
  async allSystemSnapshotsIn(trx: Trx, org: TenantInfo): Promise<{ system: SystemData; snapshot: UiMsSnapshot }[]> {
    const data = await loadOrgData(trx, { bundle: true, now: this.clock.now() });
    const ctx = await this.buildContext(trx, org, data);
    return data.systems.map((system) => ({ system, snapshot: buildSystemSnapshot(system, ctx) }));
  }
}
