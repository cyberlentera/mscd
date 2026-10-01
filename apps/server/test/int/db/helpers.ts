// Shared helpers of the schema tests (WP-06): transactions with tenant settings as withTenant sets them (F.10),
// fixture rows, PostgreSQL error assertions and the SQL of the C.3 readiness and F.11 chain checks.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import pg from 'pg';
import { expect, inject } from 'vitest';
import { runBootstrap } from '../../../src/db/bootstrap';
import { createKysely } from '../../../src/db/kysely';
import type { DB } from '../../../src/db/types';
import { serverUrl, TEST_ROLE_PASSWORDS, type TestDbServer } from '../../setup/test-db-server';

export const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';

/** Columns that name a person and are checked by the `assert_member` trigger (C.4 `secure_tenant_schema`). */
export const PERSON_COLUMNS = [
  'user_id', 'owner_user_id', 'holder_user_id', 'pending_holder_user_id', 'approver_user_id',
  'justification_holder_user_id', 'relationship_owner_user_id', 'recipient_user_id', 'accepted_by_user_id',
  'auditee_user_id', 'implemented_by_user_id', 'verified_by_user_id', 'completed_by_user_id',
] as const;

export interface ScopeSettings {
  /** `app.org_id` (transaction local). */
  orgId?: string;
  /** Tenant schema put first on the transaction's search_path, followed by ext (D-03). */
  schema?: string;
  userId?: string;
  /** `app.platform_scope = 'on'` (F.10). */
  platformScope?: boolean;
}

/** Runs `fn` in a transaction with transaction-local settings, like `withTenant` and `withPlatform` (F.10). */
export async function inScope<T>(database: Kysely<DB>, scope: ScopeSettings, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return database.transaction().execute(async (trx) => {
    await applyScope(trx, scope);
    return fn(trx);
  });
}

export async function applyScope(trx: Kysely<DB>, scope: ScopeSettings): Promise<void> {
  await sql`select set_config('search_path', ${scope.schema ? `"${scope.schema}", ext` : ''}, true),
                   set_config('app.org_id', ${scope.orgId ?? ''}, true),
                   set_config('app.user_id', ${scope.userId ?? ''}, true),
                   set_config('app.platform_scope', ${scope.platformScope ? 'on' : ''}, true)`.execute(trx);
}

/** Expects a PostgreSQL error with the SQLSTATE `code` (and a message matching `message`). */
export async function expectPgError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SQLSTATE ${code}${message ? ` matching ${message}` : ''}`).toBeDefined();
  const failure = caught as { code?: string; message?: string };
  expect({ code: failure.code, message: failure.message }).toEqual({ code, message: message ? expect.stringMatching(message) : expect.anything() });
}

/** Runs `fn` in a transaction that is always rolled back (for statements that are expected to change nothing). */
export async function rolledBack<T>(database: Kysely<DB>, scope: ScopeSettings, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  const marker = new Error('rollback');
  let result: T | undefined;
  try {
    await database.transaction().execute(async (trx) => {
      await applyScope(trx, scope);
      result = await fn(trx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
  return result as T;
}

/** A user with active memberships in the given organisations (written as the migrator with platform scope). */
export async function addUser(migrator: Kysely<DB>, handle: string, orgIds: readonly string[]): Promise<string> {
  return inScope(migrator, { platformScope: true }, async (trx) => {
    const user = await trx
      .insertInto('platform.app_user')
      .values({ handle, email: `${handle}@test.invalid`, display_name: handle })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const orgId of orgIds) {
      await trx.insertInto('platform.org_membership').values({ organization_id: orgId, user_id: user.id }).execute();
    }
    return user.id;
  });
}

export interface FrameworkFixture {
  frameworkId: string;
  versionId: string;
  requirementId: string;
  catalogueItemId: string;
  reviewInputDefId: string;
  driftRuleDefId: string;
}

/** One framework edition with a requirement, a catalogue item and the definitions tenant rows refer to. */
export async function addFramework(migrator: Kysely<DB>, code = 'TEST'): Promise<FrameworkFixture> {
  return inScope(migrator, { platformScope: true }, async (trx) => {
    const framework = await trx.insertInto('ref.framework').values({ code, name: `${code} standard` }).returning('id').executeTakeFirstOrThrow();
    const version = await trx
      .insertInto('ref.framework_version')
      .values({
        framework_id: framework.id,
        edition: '2024',
        pack_id: `${code}-2024`,
        pack_version: '1.0.0',
        status: 'current',
        applicability_target: 'catalogue_item',
        pack_checksum: '0'.repeat(64),
        manifest: JSON.stringify({ packId: `${code}-2024` }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const requirement = await trx
      .insertInto('ref.requirement')
      .values({ framework_version_id: version.id, requirement_code: '6.1', title_short: 'Risk actions', clause_group: '6', sort_order: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const item = await trx
      .insertInto('ref.catalogue_item')
      .values({ framework_version_id: version.id, item_code: 'A.5.1', theme_code: '5', title_short: 'Policies', requirement_id: requirement.id, sort_order: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const input = await trx
      .insertInto('ref.review_input_def')
      .values({ framework_version_id: version.id, code: 'MR-IN-1', title: 'Status of actions' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const drift = await trx
      .insertInto('ref.drift_rule_def')
      .values({ framework_version_id: version.id, code: 'DR-1', label_en: 'Drift', label_id: 'Drift', severity: 'warn', source_kind: 'manual', message: 'Drift' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      frameworkId: framework.id,
      versionId: version.id,
      requirementId: requirement.id,
      catalogueItemId: item.id,
      reviewInputDefId: input.id,
      driftRuleDefId: drift.id,
    };
  });
}

export interface TenantRef {
  id: string;
  schemaName: string;
  vaultRepositoryId: string;
}

/** A management system of a tenant on the given framework edition, using the tenant's Managed Vault by default. */
export async function addManagementSystem(
  migrator: Kysely<DB>,
  tenant: TenantRef,
  versionId: string,
  slug = 'isms',
): Promise<string> {
  return inScope(migrator, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
    const ms = await trx
      .insertInto('management_system')
      .values({
        slug,
        code: slug.toUpperCase(),
        name: `${slug} system`,
        framework_version_id: versionId,
        scope_statement: 'Whole organisation',
        status: 'implementing',
        default_storage_repository_id: tenant.vaultRepositoryId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return ms.id;
  });
}

/** Tables of a schema that the migrations created (Kysely's own bookkeeping tables excluded). */
export async function schemaTables(database: Kysely<DB>, schema: string): Promise<string[]> {
  const { rows } = await sql<{ relname: string }>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind in ('r', 'p') and c.relname not like 'kysely\\_%'
    order by c.relname`.execute(database);
  return rows.map((r) => r.relname);
}

/**
 * C.3 readiness check (b): roles other than mscd_migrator, superusers, predefined pg_* roles and the database
 * owner that may create objects in public, ext, platform, ref or a tenant schema, and every schema where PUBLIC
 * holds CREATE. The readiness check of WP-08 reports not ready while this returns a row.
 */
export const SCHEMA_CREATE_PRIVILEGE_QUERY = sql<{ schema_name: string; role_name: string }>`
  select n.nspname::text as schema_name, r.rolname::text as role_name
  from pg_namespace n
  cross join pg_roles r
  where (n.nspname in ('public', 'ext', 'platform', 'ref') or n.nspname ~ '^org_[a-z0-9_]{1,59}$')
    and r.rolname <> 'mscd_migrator'
    and not r.rolsuper
    and r.rolname !~ '^pg_'
    and r.oid <> (select d.datdba from pg_database d where d.datname = current_database())
    and has_schema_privilege(r.oid, n.oid, 'CREATE')
  union all
  select n.nspname::text, 'PUBLIC'
  from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
  where a.grantee = 0 and a.privilege_type = 'CREATE'
  order by 1, 2`;

/** The F.11 chain verification query for `audit_trail` (search_path on a tenant schema) or `platform.audit_log`. */
export function chainVerificationQuery(table: 'audit_trail' | 'platform.audit_log') {
  const from = table === 'audit_trail' ? sql`audit_trail` : sql`platform.audit_log`;
  return sql<{ checked: string; first_broken_seq: string | null }>`
    WITH c AS (
      SELECT seq, prev_hash, row_hash,
             lag(row_hash) OVER (ORDER BY seq) AS expected_prev,
             lag(seq) OVER (ORDER BY seq) AS prev_seq,
             sha256(prev_hash || convert_to(platform.audit_canonical_text(seq, id, occurred_at, organization_id,
               management_system_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code,
               before_data, after_data, edition, request_id, source_ip, user_agent), 'UTF8')) AS expected_hash
      FROM ${from})
    SELECT count(*) AS checked,
           min(seq) FILTER (WHERE row_hash <> expected_hash
                               OR prev_hash <> coalesce(expected_prev, '\\x'::bytea)
                               OR seq <> coalesce(prev_seq, 0) + 1) AS first_broken_seq
    FROM c`;
}

export interface BareDatabase {
  name: string;
  urls: { admin: string; migrator: string; app: string; packInstaller: string };
  drop(): Promise<void>;
}

/**
 * A new database with the C.2 bootstrap only (no migrations), for tests of the `migrate` command itself. The
 * caller drops it.
 */
export async function createBareDatabase(): Promise<BareDatabase> {
  const server = inject('mscdTestDb');
  const name = `t_bare_${randomBytes(6).toString('hex')}`;
  await withAdmin(server, (admin) => admin.query(`CREATE DATABASE ${name}`));
  const urls = {
    admin: serverUrl(server, name),
    migrator: serverUrl(server, name, 'mscd_migrator', TEST_ROLE_PASSWORDS.migrator),
    app: serverUrl(server, name, 'mscd_app', TEST_ROLE_PASSWORDS.app),
    packInstaller: serverUrl(server, name, 'mscd_pack_installer', TEST_ROLE_PASSWORDS.packInstaller),
  };
  await runBootstrap({ adminUrl: urls.admin, passwords: { ...TEST_ROLE_PASSWORDS } });
  return {
    name,
    urls,
    drop: () => withAdmin(server, (admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => undefined),
  };
}

/** A Kysely instance for an arbitrary role URL (closed by the caller). */
export function connect(url: string, applicationName = 'mscd-test'): Kysely<DB> {
  return createKysely<DB>({ connectionString: url, max: 2, applicationName });
}

export async function withAdmin<T>(server: TestDbServer, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl(server, server.adminDatabase) });
  client.on('notice', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const uuid = (): string => randomUUID();
