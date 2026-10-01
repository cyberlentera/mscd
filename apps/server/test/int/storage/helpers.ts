// Fixtures of the storage administration tests (WP-13): organisations with systems, Tenant and Storage Admins and
// MS Managers, and the fake identities of `withFakeAuth` (J.2).
import type { BusinessRole, OrgRole, StorageAdapter } from '@mscd/shared';
import type { LicenceGate, TenantInfo } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { FakeIdentity } from '../../setup/auth-fakes';
import type { TestDatabase } from '../../setup/test-db';
import { addUser, inScope } from '../db/helpers';
import { infoOf } from '../platform/helpers';

export interface UserFixture {
  handle: string;
  orgRoles?: OrgRole[];
  rolesByMs?: Record<string, BusinessRole[]>;
}

/** Creates the users of one organisation, with admin roles and system roles, and returns their fake identities. */
export async function addStorageUsers(
  db: TestDatabase,
  tenant: CreatedTenant,
  systems: Record<string, string>,
  users: Record<string, UserFixture>,
  info: TenantInfo = infoOf(tenant),
): Promise<{ ids: Record<string, string>; identities: Record<string, FakeIdentity> }> {
  const ids: Record<string, string> = {};
  const identities: Record<string, FakeIdentity> = {};
  for (const [name, user] of Object.entries(users)) {
    const id = await addUser(db.migrator, user.handle, [tenant.id]);
    ids[name] = id;
    if (user.orgRoles?.length) {
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx
          .updateTable('platform.org_membership')
          .set({ admin_roles: [...user.orgRoles!] })
          .where('organization_id', '=', tenant.id)
          .where('user_id', '=', id)
          .execute(),
      );
    }
    for (const [slug, roles] of Object.entries(user.rolesByMs ?? {})) {
      await inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
        for (const role of roles) {
          await trx.insertInto('user_ms_role').values({ user_id: id, management_system_id: systems[slug]!, role }).execute();
        }
      });
    }
    identities[name] = {
      user: { id, handle: user.handle, displayName: user.handle },
      org: info,
      orgRoles: user.orgRoles ?? [],
      rolesByMs: user.rolesByMs ?? {},
      knownMs: Object.keys(systems),
    };
  }
  return { ids, identities };
}

/**
 * A licence gate for the storage tests: everything writable and allowed, except the adapters in `unlicensed` (a set
 * the tests may change). The real gate (WP-12) needs an installed licence, which these tests do not depend on.
 */
export function storageLicenceGate(): LicenceGate & { unlicensed: Set<StorageAdapter> } {
  const unlicensed = new Set<StorageAdapter>();
  return {
    unlicensed,
    assertWritable: async () => undefined,
    assertCanAddUser: async () => undefined,
    assertCanAddMs: async () => undefined,
    assertFeature: async () => undefined,
    isAdapterLicensed: async (_orgId, adapter) => !unlicensed.has(adapter),
  };
}
