// `UserView` rows (D.2, `GET /admin/users`): members of the organisation with their account and membership fields,
// role grants in the organisation's systems, whether a second factor is enrolled and whether the user holds an
// active membership elsewhere (then the global fields are read-only for the Tenant Admin, F.6).
import type { ApprovalStatus, BusinessRole, OrgRole, UserView } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../../common/tokens';

interface MemberRow {
  id: string;
  handle: string;
  email: string;
  display_name: string;
  job_title: string | null;
  kind: 'person' | 'system' | 'guest';
  account_status: 'active' | 'invited' | 'disabled';
  membership_status: 'active' | 'invited' | 'disabled';
  admin_roles: OrgRole[];
  last_login_at: Date | null;
  mfa_enrolled: boolean;
}

interface GrantRow {
  id: string;
  user_id: string;
  slug: string;
  role: BusinessRole;
  is_primary: boolean;
  approval_status: ApprovalStatus;
  valid_until: Date | null;
}

/** `%` and `_` in a search text match themselves (LIKE escaping). */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Members of the organisation. Until the user accepts an invited membership the row shows only what the inviting
 * organisation supplied or may know (F.6: `POST /admin/users` never reveals another tenant's account): the account
 * status `invited`, the email as display name, no job title, no last sign-in and no second factor. A new email and an
 * account of another organisation therefore look the same in the list, in search and in the order.
 */
function membersQuery(orgId: string, filter: (cols: { handle: RawBuilder<string>; email: RawBuilder<string>; displayName: RawBuilder<string> }) => RawBuilder<unknown>): RawBuilder<MemberRow> {
  const invited = sql`m.status = 'invited'`;
  const displayName = sql<string>`(case when ${invited} then u.email else u.display_name end)`;
  return sql<MemberRow>`
    select u.id, u.handle, u.email, ${displayName} as display_name,
           case when ${invited} then null else u.job_title end as job_title,
           u.kind,
           case when ${invited} then 'invited' else u.status end as account_status,
           case when ${invited} then null else u.last_login_at end as last_login_at,
           m.status as membership_status, m.admin_roles,
           (not ${invited}) and exists (select 1 from platform.mfa_factor f
                   where f.user_id = u.id and f.confirmed_at is not null and f.deleted_at is null) as mfa_enrolled
    from platform.org_membership m
    join platform.app_user u on u.id = m.user_id
    where m.organization_id = ${orgId} and m.deleted_at is null and u.deleted_at is null and u.kind <> 'system'
      and ${filter({ handle: sql<string>`u.handle`, email: sql<string>`u.email`, displayName })}`;
}

/** One page of members, ordered by name, with the total. */
export async function memberPage(
  trx: Trx,
  orgId: string,
  query: { q?: string; page: number; pageSize: number },
): Promise<{ rows: MemberRow[]; total: number }> {
  const q = query.q?.trim();
  const members = membersQuery(orgId, (c) =>
    q ? sql`(${c.handle} ilike ${likePattern(q)} or ${c.email} ilike ${likePattern(q)} or ${c.displayName} ilike ${likePattern(q)})` : sql`true`,
  );
  const total = await sql<{ n: string }>`select count(*) as n from (${members}) x`.execute(trx);
  const { rows } = await sql<MemberRow>`
    select * from (${members}) x order by lower(x.display_name), x.handle
    limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`.execute(trx);
  return { rows, total: Number(total.rows[0]?.n ?? 0) };
}

/** One member (any membership status, invited ones projected as in the list), or undefined when the user is not a member of the organisation. */
export async function memberRow(trx: Trx, orgId: string, userId: string): Promise<MemberRow | undefined> {
  const { rows } = await membersQuery(orgId, () => sql`u.id = ${userId}`).execute(trx);
  return rows[0];
}

/** Role grants (not deleted) of the users in the organisation's systems. */
async function grantsOf(trx: Trx, userIds: readonly string[]): Promise<Map<string, GrantRow[]>> {
  const byUser = new Map<string, GrantRow[]>();
  if (userIds.length === 0) return byUser;
  const rows = await trx
    .selectFrom('user_ms_role as r')
    .innerJoin('management_system as ms', 'ms.id', 'r.management_system_id')
    .select(['r.id', 'r.user_id', 'ms.slug', 'r.role', 'r.is_primary', 'r.approval_status', 'r.valid_until'])
    .where('r.user_id', 'in', [...userIds])
    .where('r.deleted_at', 'is', null)
    .where('ms.deleted_at', 'is', null)
    .orderBy('ms.position')
    .orderBy('r.role')
    .execute();
  for (const row of rows as GrantRow[]) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  return byUser;
}

/** `UserView` of each member row, in the order given. */
export async function toUserViews(trx: Trx, rows: readonly MemberRow[], otherMemberships: ReadonlySet<string>): Promise<UserView[]> {
  const grants = await grantsOf(
    trx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    email: row.email,
    displayName: row.display_name,
    jobTitle: row.job_title,
    kind: row.kind,
    accountStatus: row.account_status,
    membershipStatus: row.membership_status,
    adminRoles: [...row.admin_roles],
    roles: (grants.get(row.id) ?? []).map((g) => ({
      grantId: g.id,
      ms: g.slug,
      role: g.role,
      isPrimary: g.is_primary,
      approvalStatus: g.approval_status,
      validUntil: g.valid_until ? g.valid_until.toISOString() : null,
    })),
    mfaEnrolled: row.mfa_enrolled,
    otherMemberships: row.membership_status !== 'invited' && otherMemberships.has(row.id),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
  }));
}

export type { MemberRow };
