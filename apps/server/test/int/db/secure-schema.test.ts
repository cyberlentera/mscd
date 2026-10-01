// platform.secure_tenant_schema and platform.secure_platform_schema (C.4): idempotent, and refusing what they
// cannot secure.
import { sql, type Kysely } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { expectPgError, rolledBack } from './helpers';

/** Policies, triggers, RLS flags and grants of a schema: what the secure functions write. */
async function securitySnapshot(database: Kysely<DB>, schema: string): Promise<unknown> {
  const { rows } = await sql<{ relname: string; rls: boolean; forced: boolean; acl: string | null; policies: string[]; triggers: string[] }>`
    select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relacl::text as acl,
           array(select p.polname || ':' || pg_get_expr(p.polqual, p.polrelid) || ':' || pg_get_expr(p.polwithcheck, p.polrelid)
                 from pg_policy p where p.polrelid = c.oid order by 1) as policies,
           array(select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal order by 1) as triggers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind in ('r', 'p')
    order by c.relname`.execute(database);
  const namespace = await sql<{ acl: string | null }>`select nspacl::text as acl from pg_namespace where nspname = ${schema}`.execute(database);
  return { tables: rows, schemaAcl: namespace.rows[0]?.acl };
}

describe('secure functions (C.4)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;

  beforeAll(async () => {
    tenant = await createTenant(db, 'secure');
  });

  it('secure_tenant_schema is idempotent: a second and third call change nothing', async () => {
    const before = await securitySnapshot(db.migrator, tenant.schemaName);
    for (let i = 0; i < 2; i += 1) {
      await sql`select platform.secure_tenant_schema(${tenant.schemaName})`.execute(db.migrator);
    }
    expect(await securitySnapshot(db.migrator, tenant.schemaName)).toEqual(before);
    const triggers = await sql<{ n: string }>`
      select count(*) as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${tenant.schemaName} and t.tgname in ('set_updated_at', 'assert_member')
      group by c.relname, t.tgname having count(*) > 1`.execute(db.migrator);
    expect(triggers.rows).toEqual([]);
  });

  it('secure_tenant_schema secures a table added later and raises for a table without organization_id', async () => {
    await rolledBack(db.migrator, { schema: tenant.schemaName }, async (trx) => {
      await sql`create table later_register (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null default nullif(current_setting('app.org_id', true), '')::uuid,
        updated_at timestamptz not null default now(),
        owner_user_id uuid)`.execute(trx);
      await sql`select platform.secure_tenant_schema(current_schema())`.execute(trx);
      const { rows } = await sql<{ rls: boolean; forced: boolean; triggers: string[]; app: boolean }>`
        select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
               array(select t.tgname::text from pg_trigger t where t.tgrelid = c.oid order by 1) as triggers,
               has_table_privilege('mscd_app', c.oid, 'INSERT') as app
        from pg_class c where c.oid = 'later_register'::regclass`.execute(trx);
      expect(rows[0]).toEqual({ rls: true, forced: true, triggers: ['assert_member', 'set_updated_at'], app: true });
    });
    await expectPgError(
      rolledBack(db.migrator, { schema: tenant.schemaName }, async (trx) => {
        await sql`create table no_org (id int primary key)`.execute(trx);
        await sql`select platform.secure_tenant_schema(current_schema())`.execute(trx);
      }),
      'P0001',
      new RegExp(`Tenant table ${tenant.schemaName}\\.no_org has no organization_id column`),
    );
  });

  it('secure_tenant_schema refuses a schema without an organisation row', async () => {
    await expectPgError(
      rolledBack(db.migrator, {}, async (trx) => {
        await sql`create schema org_orphan`.execute(trx);
        await sql`select platform.secure_tenant_schema('org_orphan')`.execute(trx);
      }),
      'P0001',
      /Schema org_orphan has no row in platform.organization/,
    );
  });

  it('secure_platform_schema is idempotent', async () => {
    const before = await securitySnapshot(db.migrator, 'platform');
    await sql`select platform.secure_platform_schema()`.execute(db.migrator);
    await sql`select platform.secure_platform_schema()`.execute(db.migrator);
    expect(await securitySnapshot(db.migrator, 'platform')).toEqual(before);
  });

  it('runs every platform function with a fixed search_path (D-03)', async () => {
    const { rows } = await sql<{ proname: string; config: string[] | null }>`
      select p.proname, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform' order by p.proname`.execute(db.migrator);
    expect(rows.map((r) => r.proname)).toEqual([
      'assert_member',
      'audit_canonical_text',
      'chain_hash',
      'entity_link_has_primary',
      'forbid_change',
      'prep_task_before_audit',
      'secure_platform_schema',
      'secure_tenant_schema',
      'set_updated_at',
    ]);
    for (const row of rows) expect([row.proname, row.config]).toEqual([row.proname, ['search_path=pg_catalog, platform']]);
  });
});
