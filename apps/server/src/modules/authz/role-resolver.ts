// Role resolution (build plan F.7). The roles of a principal are read once per request (cached on the principal
// object, which the session resolver creates for each request):
// - business roles per system: `user_ms_role` rows of (user, system) that are not deleted, `approval_status =
//   'active'` and not past `valid_until` (so pending grants and expired external auditor grants never count);
// - organisation roles: `org_membership.admin_roles` of the current organisation, only while the membership is
//   active (a disabled or invited membership grants nothing);
// - platform roles: `platform_role` rows that are not revoked.
// Guest accounts (D-27) hold only the external auditor role of their grant: any other role is ignored.
import { Injectable } from '@nestjs/common';
import { BUSINESS_ROLES, type BusinessRole, type OrgRole, type PlatformRole } from '@mscd/shared';
import { sql } from 'kysely';
import type { Principal, TenantInfo, Trx } from '../../common/tokens';
import { tenantContextOf } from '../tenancy/tenant-scope';
import { AuthzInfra } from './authz-infra';

/** One management system of the organisation with the user's active business roles there (possibly none). */
export interface SystemRoles {
  id: string;
  slug: string;
  position: number;
  roles: BusinessRole[];
}

/** Everything the authorisation decisions of one request need about the principal (F.7 role resolution). */
export interface PrincipalRoles {
  /** Current organisation, or null for a principal without one (a platform operator). */
  orgId: string | null;
  /** Every system of the organisation that is not deleted, by slug, in position order. */
  systems: ReadonlyMap<string, SystemRoles>;
  /** Organisation roles of an active membership. */
  orgRoles: OrgRole[];
  platformRoles: PlatformRole[];
  /** True when the membership of the current organisation is active. */
  membershipActive: boolean;
}

const ROLE_ORDER = new Map<string, number>(BUSINESS_ROLES.map((r, i) => [r, i]));

/** Business roles in the order of `BUSINESS_ROLES` (stable output for `Me` and the snapshots). */
export function sortRoles(roles: readonly BusinessRole[]): BusinessRole[] {
  return [...new Set(roles)].sort((a, b) => (ROLE_ORDER.get(a) ?? 99) - (ROLE_ORDER.get(b) ?? 99));
}

interface SystemRow {
  id: string;
  slug: string;
  position: number;
  roles: BusinessRole[] | null;
}

@Injectable()
export class RoleResolver {
  private readonly cache = new WeakMap<Principal, Promise<PrincipalRoles>>();

  constructor(private readonly infra: AuthzInfra) {}

  /** True when roles can be read (the database services are present). */
  get available(): boolean {
    return this.infra.available;
  }

  /** The roles of a principal, read once per principal object (that is, once per request). */
  rolesOf(principal: Principal): Promise<PrincipalRoles> {
    let pending = this.cache.get(principal);
    if (!pending) {
      pending = this.load(principal);
      this.cache.set(principal, pending);
      pending.catch(() => this.cache.delete(principal));
    }
    return pending;
  }

  /**
   * The roles of a principal read in the caller's transaction of the principal's organisation when they are not
   * cached yet, so a read path never needs a second pool connection while its transaction is open.
   */
  rolesOfIn(trx: Trx, principal: Principal): Promise<PrincipalRoles> {
    const cached = this.cache.get(principal);
    if (cached) return cached;
    if (!principal.org) return this.rolesOf(principal);
    const pending = this.loadIn(trx, principal.org, principal.user.id, principal.user.kind, this.infra.now());
    this.cache.set(principal, pending);
    pending.catch(() => this.cache.delete(principal));
    return pending;
  }

  /** Forgets the cached roles of a principal (after a change of its own roles within the request). */
  forget(principal: Principal): void {
    this.cache.delete(principal);
  }

  private async load(principal: Principal): Promise<PrincipalRoles> {
    const now = this.infra.now();
    const userId = principal.user.id;
    if (!principal.org) {
      const platformRoles = await this.infra.withUserOnly(userId, (trx) => this.platformRoles(trx, userId));
      return { orgId: null, systems: new Map(), orgRoles: [], platformRoles: principal.user.kind === 'guest' ? [] : platformRoles, membershipActive: false };
    }
    const org = principal.org;
    return this.infra.scope.withTenant(tenantContextOf(principal), (trx) => this.loadIn(trx, org, userId, principal.user.kind, now));
  }

  /**
   * The roles of a user in an organisation, read in `trx` (a transaction of that organisation, F.10). Used for the
   * request principal and for the `Me.orgs` systems of the user's other organisations.
   */
  async loadIn(trx: Trx, org: Pick<TenantInfo, 'id'>, userId: string, kind: Principal['user']['kind'], now: Date): Promise<PrincipalRoles> {
    const membership = await trx
      .selectFrom('platform.org_membership')
      .select(['admin_roles', 'status', 'deleted_at'])
      .where('organization_id', '=', org.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const membershipActive = membership !== undefined && membership.status === 'active' && membership.deleted_at === null;
    const { rows } = await sql<SystemRow>`
      select ms.id, ms.slug, ms.position,
             array_agg(r.role order by r.role) filter (where r.role is not null) as roles
      from management_system ms
      left join user_ms_role r
        on r.management_system_id = ms.id and r.user_id = ${userId} and r.deleted_at is null
       and r.approval_status = 'active' and (r.valid_until is null or r.valid_until > ${now})
      where ms.deleted_at is null
      group by ms.id, ms.slug, ms.position
      order by ms.position, ms.slug`.execute(trx);
    const guest = kind === 'guest';
    const systems = new Map<string, SystemRoles>();
    for (const row of rows) {
      let roles = membershipActive ? (row.roles ?? []) : [];
      if (guest) roles = roles.filter((r) => r === 'external_auditor');
      systems.set(row.slug, { id: row.id, slug: row.slug, position: row.position, roles: sortRoles(roles) });
    }
    const orgRoles = membershipActive && !guest ? [...new Set(membership!.admin_roles)] : [];
    const platformRoles = guest ? [] : await this.platformRoles(trx, userId);
    return { orgId: org.id, systems, orgRoles, platformRoles, membershipActive };
  }

  private async platformRoles(trx: Trx, userId: string): Promise<PlatformRole[]> {
    const rows = await trx.selectFrom('platform.platform_role').select('role').where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
    return [...new Set(rows.map((r) => r.role))];
  }
}

/** Business roles the user holds in at least one system, for "MM of any system" rows (F.7). */
export function rolesInAnySystem(roles: PrincipalRoles): BusinessRole[] {
  return sortRoles([...roles.systems.values()].flatMap((s) => s.roles));
}
