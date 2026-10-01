import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { runBootstrap } from '../../../src/db/bootstrap';
import { migrateFolder, openDedicatedDatabase } from '../../../src/db/migrator';
import { ReadinessService } from '../../../src/modules/platform/readiness.service';
import { TEST_ROLE_PASSWORDS } from '../../setup/test-db-server';
import { useTestDatabase } from '../../setup/test-db';

// Smoke test of the integration test setup (J.2) and of the bootstrap (C.2): a copy of the empty template holds
// the roles, the ext schema with pg_trgm and the privileges the later migrations rely on.
describe('test database and bootstrap', () => {
  const db = useTestDatabase('empty');

  it('connects as the application role and returns dates as YYYY-MM-DD strings', async () => {
    const { rows } = await sql<{ who: string; d: unknown; n: unknown }>`
      select current_user as who, date '2026-09-29' as d, current_setting('search_path') as n`.execute(db.app);
    expect(rows[0]).toEqual({ who: 'mscd_app', d: '2026-09-29', n: '""' });
  });

  it('has the three login roles of C.2 with their settings', async () => {
    const { rows } = await sql<{ rolname: string; rolcanlogin: boolean; rolconfig: string[] | null }>`
      select rolname, rolcanlogin, rolconfig from pg_roles
      where rolname in ('mscd_migrator', 'mscd_app', 'mscd_pack_installer') order by rolname`.execute(db.migrator);
    expect(rows.map((r) => [r.rolname, r.rolcanlogin])).toEqual([
      ['mscd_app', true],
      ['mscd_migrator', true],
      ['mscd_pack_installer', true],
    ]);
    const app = rows.find((r) => r.rolname === 'mscd_app')!;
    expect(app.rolconfig).toEqual(
      expect.arrayContaining(['statement_timeout=30s', 'idle_in_transaction_session_timeout=60s', 'search_path=""']),
    );
    expect(rows.find((r) => r.rolname === 'mscd_pack_installer')!.rolconfig).toEqual(['search_path=""']);
  });

  it('keeps public closed and gives the migrator the ext schema with pg_trgm', async () => {
    const { rows } = await sql<{ app_public: boolean; public_public: boolean; ext_owner: string; trgm_schema: string; migrator_db: boolean; app_ext: boolean }>`
      select has_schema_privilege('mscd_app', 'public', 'CREATE') as app_public,
             exists (select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                     where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'CREATE') as public_public,
             (select nspowner::regrole::text from pg_namespace where nspname = 'ext') as ext_owner,
             (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
              where e.extname = 'pg_trgm') as trgm_schema,
             has_database_privilege('mscd_migrator', current_database(), 'CREATE') as migrator_db,
             has_schema_privilege('mscd_app', 'ext', 'USAGE') as app_ext`.execute(db.migrator);
    expect(rows[0]).toEqual({
      app_public: false,
      public_public: false,
      ext_owner: 'mscd_migrator',
      trgm_schema: 'ext',
      migrator_db: true,
      app_ext: true,
    });
  });

  it('runs the bootstrap again without error (idempotent), also with the report role', async () => {
    const result = await runBootstrap({ adminUrl: db.urls.admin, passwords: { ...TEST_ROLE_PASSWORDS }, withReportRole: true });
    expect(result).toEqual({ database: db.name, reportRole: true });
    const { rows } = await sql<{ rolcanlogin: boolean }>`select rolcanlogin from pg_roles where rolname = 'mscd_report'`.execute(db.migrator);
    expect(rows).toEqual([{ rolcanlogin: false }]);
  });

  describe('SQL file migrations', () => {
    let dir: string | undefined;
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('applies NNNN_name.sql files in order, several statements per file, once', async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-migrations-'));
      const folder = path.join(dir, 'platform');
      await mkdir(folder);
      await writeFile(path.join(folder, '0002_second.sql'), 'INSERT INTO smoke.step VALUES (2); INSERT INTO smoke.step VALUES (3);');
      await writeFile(path.join(folder, '0001_first.sql'), 'CREATE TABLE smoke.step (n int PRIMARY KEY);\nINSERT INTO smoke.step VALUES (1);');

      const first = await migrateFolder(db.migrator, 'platform', { migrationTableSchema: 'smoke', root: dir });
      expect(first).toEqual(['0001_first', '0002_second']);
      const second = await migrateFolder(db.migrator, 'platform', { migrationTableSchema: 'smoke', root: dir });
      expect(second).toEqual([]);

      const steps = await sql<{ n: number }>`select n from smoke.step order by n`.execute(db.migrator);
      expect(steps.rows.map((r) => r.n)).toEqual([1, 2, 3]);
      const recorded = await sql<{ name: string }>`select name from smoke.kysely_migration order by name`.execute(db.migrator);
      expect(recorded.rows.map((r) => r.name)).toEqual(['0001_first', '0002_second']);
    });
  });

  it('opens a dedicated connection with a session search_path and platform scope', async () => {
    const dedicated = openDedicatedDatabase(db.urls.migrator, { searchPath: ['smoke', 'ext'], platformScope: true });
    try {
      const { rows } = await sql<{ path: string; scope: string }>`
        select current_setting('search_path') as path, current_setting('app.platform_scope', true) as scope`.execute(dedicated);
      expect(rows[0]).toEqual({ path: 'smoke,ext', scope: 'on' });
    } finally {
      await dedicated.destroy();
    }
  });

  it('reports the database in readiness through the Nest modules', async () => {
    const moduleRef = await db.createTestingModule().compile();
    await moduleRef.init();
    try {
      const report = await moduleRef.get(ReadinessService).evaluate();
      expect(report.status).toBe('ready');
      expect(report.checks.map((c) => [c.name, c.status])).toEqual([['database', 'ok']]);
    } finally {
      await moduleRef.close();
    }
  });
});
