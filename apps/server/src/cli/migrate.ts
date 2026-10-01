import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { sql, type Kysely } from 'kysely';
import type { MscdConfig } from '../config/mscd-config';
import { ConfigError } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { migrateFolder, migrationsDir, MIGRATIONS_ROOT, openDedicatedDatabase, type MigrationFolder } from '../db/migrator';
import { SqlFileMigrationProvider } from '../db/sql-migration-provider';
import type { DB } from '../db/types';

// Run mode `migrate` (build plan C.3). This file implements steps 1 (platform), 2 (ref) and 4 (every tenant
// schema); WP-22 adds step 3 (pg-boss schema) and WP-12 step 5 (packs) at the marked places. Every step runs as
// mscd_migrator on a dedicated connection of its own (never a pool shared with other work) with
// `app.platform_scope = 'on'` for that session, and the connection is closed when the step is done.

/** Registers `mscd-server migrate [--dry-run]`. */
export function register(program: Command): void {
  program
    .command('migrate')
    .description('Apply platform, ref and tenant migrations, create the pg-boss schema and install new packs, then exit')
    .option('--dry-run', 'print the SQL a run would apply without changing anything')
    .action(runMigrateCommand);
}

export interface TenantMigrationResult {
  organizationId: string;
  slug: string;
  schema: string;
  applied: string[];
  /** Set when this schema failed; the other schemas are still migrated and the command exits 1. */
  error?: string;
}

export interface MigrateReport {
  platform: string[];
  ref: string[];
  tenants: TenantMigrationResult[];
}

export interface MigrateOptions {
  /** URL of role mscd_migrator. */
  connectionString: string;
  /** Folder holding platform/, ref/ and tenant/ (default `apps/server/migrations`). */
  migrationsRoot?: string;
  /** Progress lines (default: none). */
  log?: (line: string) => void;
}

/**
 * C.3 steps 1, 2 and 4. Platform or ref failures stop the run (tenant migrations may depend on them). A failing
 * tenant schema is reported and the remaining schemas are still migrated; the caller treats any tenant error as
 * a failed run.
 */
export async function migrateAll(options: MigrateOptions): Promise<MigrateReport> {
  const log = options.log ?? (() => undefined);
  const root = options.migrationsRoot ?? MIGRATIONS_ROOT;
  const report: MigrateReport = { platform: [], ref: [], tenants: [] };

  // Steps 1 and 2: installation-wide schemas.
  for (const folder of ['platform', 'ref'] as const) {
    report[folder] = await withDedicated(options.connectionString, {}, (migrator) =>
      migrateFolder(migrator, folder, { migrationTableSchema: folder, root }),
    );
    log(appliedLine(folder, report[folder]));
  }

  // Step 3 (WP-22): pg-boss schema creation and its grants to mscd_app, when jobs.driver is pgboss.

  // Step 4: every organisation schema, each on its own dedicated connection.
  const organizations = await listOrganizations(options.connectionString);
  for (const org of organizations) {
    const result: TenantMigrationResult = { organizationId: org.id, slug: org.slug, schema: org.schema_name, applied: [] };
    try {
      if (!org.schema_exists) throw new Error(`schema ${org.schema_name} does not exist`);
      result.applied = await withDedicated(options.connectionString, { searchPath: [org.schema_name, 'ext'] }, (migrator) =>
        migrateFolder(migrator, 'tenant', { migrationTableSchema: org.schema_name, root }),
      );
      log(appliedLine(`tenant ${org.schema_name}`, result.applied));
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      log(`tenant ${org.schema_name}: FAILED: ${result.error}`);
    }
    report.tenants.push(result);
  }

  // Step 5 (WP-12): install the packs of packs.dir that are not installed yet, as mscd_pack_installer.

  return report;
}

export interface PendingMigration {
  /** `platform`, `ref` or the tenant schema name. */
  target: string;
  folder: MigrationFolder;
  name: string;
}

/** What a run would apply, read without changing anything (`--dry-run`). */
export async function pendingMigrations(options: Omit<MigrateOptions, 'log'>): Promise<PendingMigration[]> {
  const root = options.migrationsRoot ?? MIGRATIONS_ROOT;
  const pending: PendingMigration[] = [];
  const names = async (folder: MigrationFolder) =>
    Object.keys(await new SqlFileMigrationProvider(migrationsDir(folder, root)).getMigrations()).sort();
  await withDedicated(options.connectionString, {}, async (migrator) => {
    for (const folder of ['platform', 'ref'] as const) {
      const applied = await appliedMigrations(migrator, folder);
      for (const name of await names(folder)) if (!applied.has(name)) pending.push({ target: folder, folder, name });
    }
  });
  const tenantFiles = await names('tenant');
  for (const org of await listOrganizations(options.connectionString)) {
    const applied = org.schema_exists
      ? await withDedicated(options.connectionString, {}, (migrator) => appliedMigrations(migrator, org.schema_name))
      : new Set<string>();
    for (const name of tenantFiles) if (!applied.has(name)) pending.push({ target: org.schema_name, folder: 'tenant', name });
  }
  return pending;
}

/** The `--dry-run` listing: the pending migrations per target, then the SQL of each pending file once. */
export async function renderDryRun(pending: readonly PendingMigration[], migrationsRoot = MIGRATIONS_ROOT): Promise<string> {
  const lines = ['-- mscd-server migrate --dry-run: nothing was changed.'];
  if (pending.length === 0) {
    lines.push('-- Every migration is applied.');
    return `${lines.join('\n')}\n`;
  }
  const byTarget = new Map<string, PendingMigration[]>();
  for (const p of pending) byTarget.set(p.target, [...(byTarget.get(p.target) ?? []), p]);
  for (const [target, items] of byTarget) {
    const where = items[0]!.folder === 'tenant' ? `tenant schema ${target} (search_path "${target}", ext)` : `schema ${target}`;
    lines.push(`-- ${where}: ${items.map((i) => i.name).join(', ')}`);
  }
  const files = [...new Map(pending.map((p) => [`${p.folder}/${p.name}`, p])).values()];
  for (const file of files) {
    const text = await readFile(path.join(migrationsDir(file.folder, migrationsRoot), `${file.name}.sql`), 'utf8');
    lines.push('', `-- >>> ${file.folder}/${file.name}.sql`, text.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

async function runMigrateCommand(options: { dryRun?: boolean }): Promise<void> {
  const config = loadConfigOrExit('migrate');
  try {
    const exitCode = await runMigrate(config, { dryRun: options.dryRun === true, out: (text) => process.stdout.write(text) });
    if (exitCode !== 0) process.exit(exitCode);
  } catch (error) {
    if (error instanceof ConfigError) exitOnConfigError(error);
    process.stderr.write(`migrate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * The `migrate` run mode with a loaded configuration: applies (or with `dryRun` lists) the migrations and
 * returns the process exit code (1 when a tenant schema failed). Platform and ref errors are thrown.
 */
export async function runMigrate(
  config: MscdConfig,
  options: { dryRun?: boolean; out: (text: string) => void; migrationsRoot?: string },
): Promise<number> {
  const connectionString = config.databaseUrl('migrator');
  if (options.dryRun) {
    const pending = await pendingMigrations({ connectionString, migrationsRoot: options.migrationsRoot });
    options.out(await renderDryRun(pending, options.migrationsRoot));
    return 0;
  }
  const report = await migrateAll({
    connectionString,
    migrationsRoot: options.migrationsRoot,
    log: (line) => options.out(`migrate: ${line}\n`),
  });
  const failed = report.tenants.filter((t) => t.error !== undefined);
  const migrated = report.tenants.length - failed.length;
  options.out(
    `migrate: done (platform ${report.platform.length} applied, ref ${report.ref.length} applied, ` +
      `${migrated} of ${report.tenants.length} tenant schemas up to date)\n`,
  );
  if (failed.length > 0) {
    options.out(`migrate: ${failed.length} tenant schema(s) failed: ${failed.map((t) => t.schema).join(', ')}\n`);
    return 1;
  }
  return 0;
}

interface OrganizationRow {
  id: string;
  slug: string;
  schema_name: string;
  schema_exists: boolean;
}

async function listOrganizations(connectionString: string): Promise<OrganizationRow[]> {
  return withDedicated(connectionString, {}, async (migrator) => {
    const table = await sql<{ found: boolean }>`select to_regclass('platform.organization') is not null as found`.execute(migrator);
    if (!table.rows[0]?.found) return [];
    const { rows } = await sql<OrganizationRow>`
      select o.id, o.slug, o.schema_name, to_regnamespace(o.schema_name) is not null as schema_exists
      from platform.organization o
      where o.deleted_at is null
      order by o.position, o.slug`.execute(migrator);
    return rows;
  });
}

async function appliedMigrations(migrator: Kysely<DB>, schema: string): Promise<Set<string>> {
  const table = await sql<{ found: boolean }>`select to_regclass(${`"${schema}".kysely_migration`}) is not null as found`.execute(migrator);
  if (!table.rows[0]?.found) return new Set();
  const { rows } = await sql<{ name: string }>`select name from ${sql.id(schema, 'kysely_migration')}`.execute(migrator);
  return new Set(rows.map((r) => r.name));
}

/** Opens a dedicated mscd_migrator connection with platform scope for one step and always closes it. */
async function withDedicated<T>(
  connectionString: string,
  options: { searchPath?: string[] },
  fn: (migrator: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const migrator = openDedicatedDatabase<DB>(connectionString, { ...options, platformScope: true, applicationName: 'mscd-migrate' });
  try {
    return await fn(migrator);
  } finally {
    await migrator.destroy();
  }
}

function appliedLine(target: string, applied: readonly string[]): string {
  return applied.length === 0 ? `${target} up to date` : `${target} applied ${applied.length}: ${applied.join(', ')}`;
}
