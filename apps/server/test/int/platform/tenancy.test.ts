// F.10 tenant scoping, the pool checkout guard and the C.3 readiness checks against PostgreSQL.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../src/common/problems';
import { afterCommit } from '../../../src/common/transaction-hooks';
import { DATABASE, type AppDatabase } from '../../../src/db/database.module';
import { createGuardedKysely, createKysely } from '../../../src/db/kysely';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { ReadinessService } from '../../../src/modules/platform/readiness.service';
import { SchemaReadiness } from '../../../src/modules/tenancy/schema-readiness';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser, inScope } from '../db/helpers';
import { createIntApp, type IntApp } from './helpers';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';

describe('tenant scope, resolver and readiness (F.10, F.7, C.3)', () => {
  const db = useTestDatabase('empty');
  let ndt: CreatedTenant;
  let bsd: CreatedTenant;
  let rina: string;
  let ctx: IntApp;
  let scope: TenantScope;

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt');
    bsd = await createTenant(db, 'bsd');
    rina = await addUser(db.migrator, 'rina', [ndt.id]);
    await addUser(db.migrator, 'budi', [bsd.id]);
    ctx = await createIntApp(db);
    scope = ctx.moduleRef.get(TenantScope);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('sets search path, organisation, user and request id for one transaction only', async () => {
    const inside = await scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: rina, requestId: 'req-scope-0001' }, async (trx) => {
      const { rows } = await sql<{ sp: string; org: string; usr: string; req: string; tables: string }>`
        select current_setting('search_path') as sp, current_setting('app.org_id') as org, current_setting('app.user_id') as usr,
               current_setting('app.request_id') as req, (select count(*)::text from management_system) as tables`.execute(trx);
      return rows[0]!;
    });
    expect(inside).toEqual({ sp: `"${ndt.schemaName}", ext`, org: ndt.id, usr: rina, req: 'req-scope-0001', tables: '0' });
    const after = await sql<{ org: string; sp: string }>`select coalesce(current_setting('app.org_id', true), '') as org, current_setting('search_path') as sp`.execute(
      ctx.moduleRef.get<AppDatabase>(DATABASE),
    );
    expect(after.rows[0]).toEqual({ org: '', sp: '""' });
  });

  it('refuses a schema or ids that are not tenant values', async () => {
    await expect(scope.withTenant({ orgId: ndt.id, schema: 'public', userId: rina }, async () => 1)).rejects.toThrow('bad schema');
    await expect(scope.withTenant({ orgId: ndt.id, schema: 'org_ndt"; drop', userId: rina }, async () => 1)).rejects.toThrow('bad schema');
    await expect(scope.withTenant({ orgId: 'x', schema: ndt.schemaName, userId: rina }, async () => 1)).rejects.toThrow('bad tenant context');
  });

  it('keeps organisations apart: rows of another organisation are invisible inside withTenant', async () => {
    const theirs = await scope.withTenant({ orgId: bsd.id, schema: bsd.schemaName, userId: SYSTEM_USER }, (trx) =>
      sql<{ n: string }>`select count(*)::text as n from storage_repository`.execute(trx),
    );
    expect(theirs.rows[0]!.n).toBe('1');
    const own = await scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: rina }, (trx) =>
      sql<{ n: string }>`select count(*)::text as n from ${sql.table(`${bsd.schemaName}.storage_repository`)}`.execute(trx),
    );
    expect(own.rows[0]!.n).toBe('0');
    const members = await scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: rina }, (trx) =>
      trx.selectFrom('platform.org_membership').select('organization_id').execute(),
    );
    expect(new Set(members.map((m) => m.organization_id))).toEqual(new Set([ndt.id]));
    const all = await scope.withPlatform((trx) => trx.selectFrom('platform.org_membership').select('organization_id').execute(), { scope: 'operator' });
    expect(new Set(all.map((m) => m.organization_id))).toEqual(new Set([ndt.id, bsd.id]));
  });

  it('runs after-commit hooks only when the transaction commits', async () => {
    const ran: string[] = [];
    await scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: rina }, async (trx) => {
      afterCommit(trx, () => {
        ran.push('committed');
      });
    });
    await expect(
      scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: rina }, async (trx) => {
        afterCommit(trx, () => {
          ran.push('rolled back');
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(ran).toEqual(['committed']);
  });

  it('resolves organisations by slug and id, caches them and drops the cache on invalidate', async () => {
    const resolver = ctx.moduleRef.get(TenantResolver);
    const bySlug = await resolver.resolve('ndt');
    expect(bySlug).toMatchObject({ id: ndt.id, slug: 'ndt', schema: ndt.schemaName, status: 'active', timeZone: 'Asia/Jakarta' });
    expect(await resolver.resolve(ndt.id)).toEqual(bySlug);
    expect(await resolver.resolve('nope')).toBeNull();
    expect(await resolver.resolve('not a slug')).toBeNull();
    await expect(resolver.require('nope')).rejects.toBeInstanceOf(NotFoundError);
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.organization').set({ status: 'suspended', time_zone: 'Europe/Berlin' }).where('id', '=', ndt.id).execute(),
    );
    expect((await resolver.resolve('ndt'))?.status).toBe('active');
    resolver.invalidate(ndt.id);
    expect(await resolver.resolve('ndt')).toMatchObject({ status: 'suspended', timeZone: 'Europe/Berlin' });
    expect(await resolver.timeZoneOf(ndt.id)).toBe('Europe/Berlin');
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.organization').set({ status: 'active', time_zone: 'Asia/Jakarta' }).where('id', '=', ndt.id).execute(),
    );
    resolver.invalidateAll();
    expect((await resolver.resolve(ndt.id))?.status).toBe('active');
  });

  it('reports ready when the newest platform migration is applied and the schema privileges are safe', async () => {
    const report = await ctx.moduleRef.get(ReadinessService).evaluate();
    expect(report.status).toBe('ready');
    expect(report.checks.map((c) => [c.name, c.status])).toEqual([
      ['database', 'ok'],
      ['migrations', 'ok'],
      ['schema-privileges', 'ok'],
    ]);
    const readyz = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(200);
    await expect(ctx.moduleRef.get(SchemaReadiness).checkMigrations(['0001_foundation', '9999_not_shipped'])).rejects.toThrow(
      /9999_not_shipped is not applied/,
    );
  });

  it('is not ready once PUBLIC may create objects in public, and names the role and schema (C.3)', async () => {
    const superuser = createKysely<DB>({ connectionString: db.urls.admin, max: 1 });
    try {
      await sql`GRANT CREATE ON SCHEMA public TO PUBLIC`.execute(superuser);
      const report = await ctx.moduleRef.get(ReadinessService).evaluate();
      expect(report.status).toBe('not_ready');
      const check = report.checks.find((c) => c.name === 'schema-privileges');
      expect(check).toMatchObject({ status: 'fail', detail: expect.stringContaining('PUBLIC can create objects in public') });
      const readyz = await ctx.app.inject({ method: 'GET', url: '/readyz' });
      expect(readyz.statusCode).toBe(503);
      await sql`GRANT CREATE ON SCHEMA ${sql.id(ndt.schemaName)} TO mscd_app`.execute(superuser);
      await expect(ctx.moduleRef.get(SchemaReadiness).checkSchemaPrivileges()).rejects.toThrow(`mscd_app can create objects in ${ndt.schemaName}`);
    } finally {
      await sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`.execute(superuser);
      await sql`REVOKE CREATE ON SCHEMA ${sql.id(ndt.schemaName)} FROM mscd_app`.execute(superuser);
      await superuser.destroy();
    }
    expect((await ctx.moduleRef.get(ReadinessService).evaluate()).status).toBe('ready');
  });
});

describe('pool checkout guard (F.10, J.5)', () => {
  const db = useTestDatabase('empty');

  it('destroys a connection returned with session-level settings and logs it', async () => {
    const messages: string[] = [];
    const { db: guarded, guard } = createGuardedKysely<DB>({
      connectionString: db.urls.app,
      max: 1,
      guardMode: 'every',
      onDirtyConnection: (message) => messages.push(message),
    });
    try {
      const pid = async () => (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(guarded)).rows[0]!.pid;
      const first = await pid();
      expect(await pid()).toBe(first);
      await guarded.connection().execute(async (conn) => {
        await sql`select set_config('app.org_id', '00000000-0000-4000-8000-00000000a001', false)`.execute(conn);
      });
      const second = await pid();
      expect(second).not.toBe(first);
      expect(guard.destroyed).toBe(1);
      expect(messages).toEqual([expect.stringContaining('app.org_id is set')]);
      const clean = await sql<{ org: string }>`select coalesce(current_setting('app.org_id', true), '') as org`.execute(guarded);
      expect(clean.rows[0]!.org).toBe('');

      await guarded.connection().execute(async (conn) => {
        await sql`select set_config('search_path', 'org_x, ext', false)`.execute(conn);
      });
      await pid();
      expect(guard.destroyed).toBe(2);
      expect(messages[1]).toContain('search_path');
    } finally {
      await guarded.destroy();
    }
  });

  it('in sampled mode checks a connection after a query error on it', async () => {
    const messages: string[] = [];
    const { db: guarded, guard } = createGuardedKysely<DB>({
      connectionString: db.urls.app,
      max: 1,
      guardMode: 'sampled',
      sampleEvery: 1_000_000,
      onDirtyConnection: (message) => messages.push(message),
    });
    try {
      await guarded.connection().execute(async (conn) => {
        await sql`select set_config('app.user_id', 'leak', false)`.execute(conn);
        await expect(sql`select 1/0`.execute(conn)).rejects.toThrow();
      });
      await sql`select 1`.execute(guarded);
      expect(guard.destroyed).toBe(1);
      expect(messages[0]).toContain('app.user_id is set');
    } finally {
      await guarded.destroy();
    }
  });
});
