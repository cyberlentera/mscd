// Facts the storage administration rules need about the organisation and the actor (build plan BR-38, A-50,
// spec 7.5 four-eyes on routing): the active Tenant Admins, the actor's organisation roles and the systems where
// the actor is MS Manager. Read inside the request's tenant transaction (RLS limits them to the organisation).
import { sql } from 'kysely';
import type { MscdConfig } from '../../config/mscd-config';
import type { Principal, Trx } from '../../common/tokens';

/** Active, non-deleted members of the organisation holding `tenant_admin`, whose account is active. */
export async function activeTenantAdmins(trx: Trx, orgId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('platform.org_membership as m')
    .innerJoin('platform.app_user as u', 'u.id', 'm.user_id')
    .select('m.user_id')
    .where('m.organization_id', '=', orgId)
    .where('m.status', '=', 'active')
    .where('m.deleted_at', 'is', null)
    .where('u.status', '=', 'active')
    .where('u.deleted_at', 'is', null)
    .where(sql<boolean>`'tenant_admin' = any(m.admin_roles)`)
    .execute();
  return rows.map((row) => row.user_id);
}

/** The organisation roles of a user in the organisation (active membership only). */
export async function adminRolesOf(trx: Trx, orgId: string, userId: string): Promise<('tenant_admin' | 'storage_admin')[]> {
  const row = await trx
    .selectFrom('platform.org_membership')
    .select('admin_roles')
    .where('organization_id', '=', orgId)
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? [...row.admin_roles] : [];
}

/** Ids of the systems where the user holds an active MS Manager role. */
export async function managedSystemIds(trx: Trx, userId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('user_ms_role')
    .select('management_system_id')
    .where('user_id', '=', userId)
    .where('role', '=', 'ms_manager')
    .where('approval_status', '=', 'active')
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', sql<Date>`now()`)]))
    .execute();
  return rows.map((row) => row.management_system_id);
}

/**
 * Whether the organisation's Managed Vault is the provider's cloud (BR-38): a SaaS installation, or in demo mode an
 * organisation labelled SaaS (D-20). On-premise, the vault is the customer's own object store.
 */
export function vaultIsProviderCloud(config: MscdConfig, principal: Principal): boolean {
  if (config.demoEnabled && principal.org?.demoDeployLabel) return principal.org.demoDeployLabel === 'saas';
  return config.deploy === 'saas';
}
