// Local sign-in policy (build plan F.4, D-26). Each organisation sets `local_login`: `allowed`, `admins_only` (only
// members holding a Tenant or Storage Admin role) or `disabled`. A local sign-in succeeds only when at least one
// active membership allows it; the session is pinned to the user's default organisation among those. Otherwise the
// sign-in is refused with `auth.sso_required` and the providers of the user's organisations. A platform operator
// without any membership signs in without an organisation.
import type { LocalLoginPolicy, ReauthMethods } from '@mscd/shared';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';

/** True when an organisation's policy lets a member with these admin roles sign in locally. */
export function localLoginAllowed(policy: LocalLoginPolicy, adminRoles: readonly string[]): boolean {
  if (policy === 'allowed') return true;
  if (policy === 'admins_only') return adminRoles.includes('tenant_admin') || adminRoles.includes('storage_admin');
  return false;
}

export interface LocalLoginDecision {
  /** The organisation the session is pinned to; null for an operator without memberships. */
  allowed: { orgId: string | null } | null;
  /** Organisations of the user's active memberships (for the sign-in methods of a refusal). */
  memberOrgIds: string[];
}

interface MembershipRow {
  organization_id: string;
  admin_roles: string[];
  is_default: boolean;
  local_login: LocalLoginPolicy;
  org_status: string;
  position: number;
  name: string;
}

/**
 * Decides where a local sign-in of `userId` lands (F.4, F.1 organisation pin). Runs with platform scope (the
 * caller's sign-in transaction). Active organisations come before suspended or offboarding ones, then the default
 * membership, then the organisation order.
 */
export async function decideLocalLogin(trx: Trx, userId: string): Promise<LocalLoginDecision> {
  const { rows } = await sql<MembershipRow>`
    select m.organization_id, m.admin_roles, m.is_default, o.local_login, o.status as org_status, o.position, o.name
    from platform.org_membership m
    join platform.organization o on o.id = m.organization_id
    where m.user_id = ${userId} and m.status = 'active' and m.deleted_at is null
      and o.deleted_at is null and o.status <> 'archived'
    order by (o.status = 'active') desc, m.is_default desc, o.position, o.name`.execute(trx);
  const memberOrgIds = rows.map((r) => r.organization_id);
  const first = rows.find((r) => localLoginAllowed(r.local_login, r.admin_roles));
  if (first) return { allowed: { orgId: first.organization_id }, memberOrgIds };
  if (rows.length === 0) {
    const operator = await trx
      .selectFrom('platform.platform_role')
      .select('role')
      .where('user_id', '=', userId)
      .where('role', '=', 'platform_operator')
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (operator) return { allowed: { orgId: null }, memberOrgIds };
  }
  return { allowed: null, memberOrgIds };
}

/** The sign-in methods organisations accept besides local sign-in: their enabled identity providers (D-26, F.4). */
export async function providerMethods(trx: Trx, orgIds: readonly string[], local = false): Promise<ReauthMethods> {
  if (orgIds.length === 0) return { local, providers: [] };
  const rows = await trx
    .selectFrom('platform.identity_provider')
    .select(['slug', 'kind', 'display_name', 'icon'])
    .where('organization_id', 'in', [...orgIds])
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .orderBy('display_name')
    .execute();
  return { local, providers: rows.map((r) => ({ slug: r.slug, kind: r.kind, label: r.display_name, icon: r.icon })) };
}
