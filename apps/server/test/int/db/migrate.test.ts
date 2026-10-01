// Migrations on the PostgreSQL version of this run (C.1: 16 reference, 15 and 17 through MSCD_TEST_PG_IMAGE, or the
// external server of MSCD_TEST_DATABASE_URL): the `migrate` command from a bootstrapped database (C.3 steps 1, 2
// and 4), tenant schemas created by the provisioner, a new tenant migration reaching every schema, --dry-run, and
// the checks the DDL of C.2 to C.6 promises (C.12).
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateAll, pendingMigrations, renderDryRun, runMigrate } from '../../../src/cli/migrate';
import { MIGRATIONS_ROOT } from '../../../src/db/migrator';
import { buildProgram } from '../../../src/program';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { MIGRATIONS_BY_FOLDER, MIGRATIONS_EXPECTED } from '../../../src/generated/build-info';
import { createTenant } from '../../setup/global-db';
import { TEST_PROFILE_FILE } from '../../setup/test-db';
import { MscdConfig } from '../../../src/config/mscd-config';
import {
  addUser,
  chainVerificationQuery,
  connect,
  createBareDatabase,
  expectPgError,
  inScope,
  rolledBack,
  schemaTables,
  type BareDatabase,
} from './helpers';

const PLATFORM = ['0001_foundation', '0002_identity', '0003_licensing_packs_keys', '0004_operations'];
const REF = ['0001_framework_content'];
const TENANT = [
  '0001_core',
  '0002_storage',
  '0003_registers',
  '0004_documents_applicability_evidence',
  '0005_audit_cycle_phases',
  '0006_workflow',
  '0007_registers_workflow',
];

/** A packs.dir that does not exist: C.3 step 5 (WP-12) installs nothing, whether packs/dist was built or not. */
const NO_PACKS_DIR = path.join(MIGRATIONS_ROOT, 'no-packs');

/** An external server (MSCD_TEST_DATABASE_URL, J.2) ignores MSCD_TEST_PG_IMAGE. */
const EXTERNAL_SERVER = Boolean(process.env.MSCD_TEST_DATABASE_URL);
const IMAGE = process.env.MSCD_TEST_PG_IMAGE || 'postgres:16.15-alpine';

/**
 * The PostgreSQL major version this run must use: MSCD_TEST_PG_MAJOR when set, otherwise the image's; none for an
 * external server without MSCD_TEST_PG_MAJOR (only "15 or later" is checked then).
 */
function expectedMajor(): number | undefined {
  const explicit = process.env.MSCD_TEST_PG_MAJOR;
  if (explicit) return Number(explicit);
  if (EXTERNAL_SERVER) return undefined;
  return Number(/postgres:(\d+)/.exec(IMAGE)?.[1]);
}

describe(`migrations on ${EXTERNAL_SERVER ? 'the server of MSCD_TEST_DATABASE_URL' : IMAGE}`, () => {
  let bare: BareDatabase;
  let migrator: Kysely<DB>;
  let app: Kysely<DB>;
  let admin: Kysely<DB>;
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let tmp: string | undefined;

  beforeAll(async () => {
    bare = await createBareDatabase();
    migrator = connect(bare.urls.migrator, 'mscd-test-migrator');
    app = connect(bare.urls.app, 'mscd-test-app');
    admin = connect(bare.urls.admin, 'mscd-test-admin');
  });

  afterAll(async () => {
    await Promise.all([migrator?.destroy(), app?.destroy(), admin?.destroy()]);
    await bare?.drop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('runs on the PostgreSQL major version of the image (or of MSCD_TEST_PG_MAJOR), 15 or later', async () => {
    const { rows } = await sql<{ v: number }>`select current_setting('server_version_num')::int as v`.execute(admin);
    const actual = Math.floor(rows[0]!.v / 10000);
    expect(actual).toBeGreaterThanOrEqual(15);
    const major = expectedMajor();
    if (major !== undefined) {
      expect(Number.isInteger(major), 'MSCD_TEST_PG_MAJOR or the image tag gives a whole major version').toBe(true);
      expect(actual).toBe(major);
    }
  });

  it('lists every platform, ref and tenant file as pending in a dry run and changes nothing', async () => {
    const pending = await pendingMigrations({ connectionString: bare.urls.migrator });
    expect(pending.map((p) => `${p.target}/${p.name}`)).toEqual([...PLATFORM.map((n) => `platform/${n}`), ...REF.map((n) => `ref/${n}`)]);
    const text = await renderDryRun(pending);
    expect(text).toContain('-- >>> platform/0001_foundation.sql');
    expect(text).toContain('CREATE FUNCTION platform.secure_tenant_schema(target_schema text)');
    const { rows } = await sql<{ n: string }>`select count(*) as n from pg_namespace where nspname in ('platform', 'ref')`.execute(admin);
    expect(rows[0]!.n).toBe('0');
  });

  it('applies the platform and ref migrations (C.3 steps 1 and 2) and is idempotent', async () => {
    const lines: string[] = [];
    const first = await migrateAll({ connectionString: bare.urls.migrator, log: (l) => lines.push(l) });
    expect(first).toEqual({ platform: PLATFORM, ref: REF, tenants: [] });
    expect(lines).toEqual([`platform applied 4: ${PLATFORM.join(', ')}`, `ref applied 1: ${REF[0]}`]);
    // The readiness check of WP-08 compares platform.kysely_migration with the list compiled into the build.
    expect(MIGRATIONS_EXPECTED).toEqual(PLATFORM);
    expect(MIGRATIONS_BY_FOLDER).toEqual({ platform: PLATFORM, ref: REF, tenant: TENANT });

    const second = await migrateAll({ connectionString: bare.urls.migrator });
    expect(second).toEqual({ platform: [], ref: [], tenants: [] });

    const owners = await sql<{ nspname: string; owner: string }>`
      select nspname, nspowner::regrole::text as owner from pg_namespace
      where nspname in ('platform', 'ref', 'ext') order by nspname`.execute(admin);
    expect(owners.rows).toEqual([
      { nspname: 'ext', owner: 'mscd_migrator' },
      { nspname: 'platform', owner: 'mscd_migrator' },
      { nspname: 'ref', owner: 'mscd_migrator' },
    ]);
    const system = await sql<{ handle: string; kind: string }>`select handle, kind from platform.app_user`.execute(migrator);
    expect(system.rows).toEqual([{ handle: 'system', kind: 'system' }]);
    const singletons = await sql<{ installations: string; marks: string }>`
      select (select count(*) from platform.installation) as installations,
             (select count(*) from platform.clock_mark) as marks`.execute(migrator);
    expect(singletons.rows[0]).toEqual({ installations: '1', marks: '1' });
  });

  it('creates two tenant schemas with all seven tenant migrations', async () => {
    alpha = await createTenant({ urls: bare.urls }, 'alpha');
    beta = await createTenant({ urls: bare.urls }, 'beta');
    for (const tenant of [alpha, beta]) {
      expect(tenant.migrations).toEqual(TENANT);
      const applied = await sql<{ name: string }>`select name from ${sql.id(tenant.schemaName, 'kysely_migration')} order by name`.execute(migrator);
      expect(applied.rows.map((r) => r.name)).toEqual(TENANT);
      expect(await schemaTables(migrator, tenant.schemaName)).toHaveLength(66);
    }
  });

  it('runs as the `migrate` command line (run mode migrate) with and without --dry-run', async () => {
    vi.stubEnv('MSCD_PROFILE_FILE', TEST_PROFILE_FILE);
    vi.stubEnv('MSCD_DATABASE_MIGRATOR_URL', bare.urls.migrator);
    vi.stubEnv('MSCD_DATABASE_MIGRATOR_URL_FILE', '');
    vi.stubEnv('MSCD__PACKS__DIR', NO_PACKS_DIR);
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    });
    try {
      await buildProgram().parseAsync(['node', 'mscd-server', 'migrate', '--dry-run']);
      expect(out).toBe('-- mscd-server migrate --dry-run: nothing was changed.\n-- Every migration is applied.\n');
      out = '';
      await buildProgram().parseAsync(['node', 'mscd-server', 'migrate']);
      expect(out.split('\n')).toEqual([
        'migrate: platform up to date',
        'migrate: ref up to date',
        'migrate: tenant org_alpha up to date',
        'migrate: tenant org_beta up to date',
        'migrate: done (platform 0 applied, ref 0 applied, 2 of 2 tenant schemas up to date)',
        '',
      ]);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('migrates every tenant schema through `migrate` (C.3 step 4), also a migration added later', async () => {
    const config = MscdConfig.load({
      runMode: 'migrate',
      env: { ...process.env, MSCD_PROFILE_FILE: TEST_PROFILE_FILE, MSCD_DATABASE_MIGRATOR_URL: bare.urls.migrator, MSCD_DATABASE_MIGRATOR_URL_FILE: '', MSCD__PACKS__DIR: NO_PACKS_DIR },
    });
    const out: string[] = [];
    expect(await runMigrate(config, { out: (t) => out.push(t) })).toBe(0);
    expect(out.join('')).toContain('tenant org_alpha up to date');
    expect(out.join('')).toContain('2 of 2 tenant schemas up to date');

    // A later work package adds a tenant migration (C.3 numbering); one run applies it to every schema.
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mscd-migrations-'));
    await cp(MIGRATIONS_ROOT, tmp, { recursive: true });
    await writeFile(
      path.join(tmp, 'tenant', '0601_test_added.sql'),
      `CREATE TABLE test_added (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  note text
);
SELECT platform.secure_tenant_schema(current_schema());
`,
    );
    const dry = await pendingMigrations({ connectionString: bare.urls.migrator, migrationsRoot: tmp });
    expect(dry.map((p) => `${p.target}/${p.name}`)).toEqual(['org_alpha/0601_test_added', 'org_beta/0601_test_added']);
    const dryText = await renderDryRun(dry, tmp);
    expect(dryText).toContain('-- tenant schema org_alpha (search_path "org_alpha", ext): 0601_test_added');
    expect(dryText.match(/-- >>> tenant\/0601_test_added\.sql/g)).toHaveLength(1);

    const report = await migrateAll({ connectionString: bare.urls.migrator, migrationsRoot: tmp });
    expect(report.tenants.map((t) => [t.schema, t.applied, t.error])).toEqual([
      ['org_alpha', ['0601_test_added'], undefined],
      ['org_beta', ['0601_test_added'], undefined],
    ]);
    const secured = await sql<{ relname: string; rls: boolean; forced: boolean }>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relname = 'test_added' order by n.nspname`.execute(admin);
    expect(secured.rows).toEqual([
      { relname: 'test_added', rls: true, forced: true },
      { relname: 'test_added', rls: true, forced: true },
    ]);
  });

  it('reports a failing tenant schema, still migrates the others and exits 1', async () => {
    // A third organisation, migrated after org_beta (organisations run in position and slug order).
    const gamma = await createTenant({ urls: bare.urls }, 'gamma');
    expect(gamma.migrations).toEqual(TENANT);
    const broken = path.join(tmp!, 'tenant', '0602_test_broken.sql');
    // Fails only in org_beta: the table exists there already.
    await sql`create table org_beta.test_clash (organization_id uuid)`.execute(admin);
    await writeFile(broken, 'CREATE TABLE test_clash (organization_id uuid);\n');
    const config = MscdConfig.load({
      runMode: 'migrate',
      env: { ...process.env, MSCD_PROFILE_FILE: TEST_PROFILE_FILE, MSCD_DATABASE_MIGRATOR_URL: bare.urls.migrator, MSCD_DATABASE_MIGRATOR_URL_FILE: '', MSCD__PACKS__DIR: NO_PACKS_DIR },
    });
    const out: string[] = [];
    expect(await runMigrate(config, { out: (t) => out.push(t), migrationsRoot: tmp })).toBe(1);
    const text = out.join('');
    expect(text).toMatch(/tenant org_beta: FAILED: Migration of tenant into schema org_beta failed at 0602_test_broken: relation "test_clash" already exists/);
    expect(text).toContain('migrate: 1 tenant schema(s) failed: org_beta');
    const applied = await sql<{ schema: string }>`
      select 'org_alpha' as schema from org_alpha.kysely_migration where name = '0602_test_broken'
      union all select 'org_gamma' from org_gamma.kysely_migration where name = '0602_test_broken'
      union all select 'org_beta' from org_beta.kysely_migration where name = '0602_test_broken'`.execute(admin);
    expect(applied.rows.map((r) => r.schema)).toEqual(['org_alpha', 'org_gamma']);
    await sql`drop table org_alpha.test_clash, org_gamma.test_clash, org_beta.test_clash`.execute(admin);
    await rm(broken);
  });

  describe('promises of the DDL (C.12)', () => {
    let member: string;
    let outsider: string;

    beforeAll(async () => {
      member = await addUser(migrator, 'member.one', [alpha.id]);
      outsider = await addUser(migrator, 'outsider.one', [beta.id]);
    });

    it('chains audit_trail inserts and the F.11 verification query finds no broken row', async () => {
      await inScope(app, { orgId: alpha.id, schema: alpha.schemaName, userId: member }, async (trx) => {
        for (const action of ['risk.created', 'risk.updated', 'risk.updated']) {
          await trx.insertInto('audit_trail').values({ actor_kind: 'user', actor_user_id: member, action, after_data: JSON.stringify({ a: 1 }) }).execute();
        }
        const rows = await trx.selectFrom('audit_trail').select(['seq', 'prev_hash', 'row_hash']).orderBy('seq').execute();
        expect(rows.map((r) => r.seq)).toEqual(['1', '2', '3']);
        expect(rows[0]!.prev_hash.length).toBe(0);
        expect(rows[1]!.prev_hash.equals(rows[0]!.row_hash)).toBe(true);
        const check = await chainVerificationQuery('audit_trail').execute(trx);
        expect(check.rows[0]).toEqual({ checked: '3', first_broken_seq: null });
      });
    });

    it('denies UPDATE on audit_trail and DELETE on reminder to mscd_app', async () => {
      await expectPgError(
        rolledBack(app, { orgId: alpha.id, schema: alpha.schemaName }, (trx) => sql`update audit_trail set action = 'x'`.execute(trx)),
        '42501',
        /permission denied for table audit_trail/,
      );
      await expectPgError(
        rolledBack(app, { orgId: alpha.id, schema: alpha.schemaName }, (trx) => sql`delete from reminder`.execute(trx)),
        '42501',
        /permission denied for table reminder/,
      );
    });

    it('shows a second app.org_id zero rows and rejects an insert without app.org_id', async () => {
      const own = await inScope(app, { orgId: alpha.id, schema: alpha.schemaName }, (trx) =>
        sql<{ n: string }>`select count(*) as n from audit_trail`.execute(trx),
      );
      expect(own.rows[0]!.n).toBe('3');
      const other = await inScope(app, { orgId: beta.id, schema: alpha.schemaName }, (trx) =>
        sql<{ n: string }>`select count(*) as n from org_alpha.audit_trail`.execute(trx),
      );
      expect(other.rows[0]!.n).toBe('0');
      await expectPgError(
        rolledBack(app, { schema: alpha.schemaName }, (trx) =>
          trx.insertInto('context_issue').values({ organization_id: alpha.id, code: 'CI-1', title: 'No organisation set' }).execute(),
        ),
        '42501',
        /new row violates row-level security policy/,
      );
    });

    it('rejects a person column naming a non-member (assert_member)', async () => {
      await expectPgError(
        rolledBack(app, { orgId: alpha.id, schema: alpha.schemaName }, (trx) =>
          trx.insertInto('context_issue').values({ code: 'CI-2', title: 'Owned by an outsider', owner_user_id: outsider }).execute(),
        ),
        '23503',
        /is not a member of organisation/,
      );
      await rolledBack(app, { orgId: alpha.id, schema: alpha.schemaName }, (trx) =>
        trx.insertInto('context_issue').values({ code: 'CI-3', title: 'Owned by a member', owner_user_id: member }).execute(),
      );
    });

    it('denies mscd_app writes to platform.platform_role, platform.licence (except superseded_at), platform.pack_install and ref', async () => {
      const scope = { orgId: alpha.id, platformScope: true };
      await expectPgError(
        rolledBack(app, scope, (trx) => trx.insertInto('platform.platform_role').values({ user_id: member, role: 'platform_operator' }).execute()),
        '42501',
        /permission denied for table platform_role/,
      );
      await expectPgError(
        rolledBack(app, scope, (trx) => sql`update platform.licence set document = '{}'::jsonb`.execute(trx)),
        '42501',
        /permission denied for table licence/,
      );
      await rolledBack(app, scope, (trx) => sql`update platform.licence set superseded_at = now()`.execute(trx));
      await expectPgError(
        rolledBack(app, scope, (trx) =>
          trx
            .insertInto('platform.pack_install')
            .values({
              pack_id: 'X',
              pack_version: '1.0.0',
              framework_code: 'X',
              edition: '1',
              status: 'installed',
              manifest: '{}',
              archive_sha256: '0'.repeat(64),
              signature_key_id: 'k',
            })
            .execute(),
        ),
        '42501',
        /permission denied for table pack_install/,
      );
      await expectPgError(
        rolledBack(app, scope, (trx) => trx.insertInto('ref.framework').values({ code: 'X', name: 'X' }).execute()),
        '42501',
        /permission denied for table framework/,
      );
    });
  });
});
