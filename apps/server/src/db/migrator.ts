import path from 'node:path';
import { Migrator, type Kysely, type MigrationResult } from 'kysely';
import { createKysely } from './kysely';
import { SqlFileMigrationProvider } from './sql-migration-provider';

export type MigrationFolder = 'platform' | 'ref' | 'tenant';

/** `apps/server/migrations`, from `src/db` (tests) and `dist/db` (built) alike. */
export const MIGRATIONS_ROOT = path.resolve(__dirname, '../../migrations');

export function migrationsDir(folder: MigrationFolder | 'bootstrap', root = MIGRATIONS_ROOT): string {
  return path.join(root, folder);
}

export class MigrationFailedError extends Error {
  constructor(
    readonly folder: string,
    readonly schema: string,
    readonly results: readonly MigrationResult[],
    override readonly cause: unknown,
  ) {
    const failed = results.find((r) => r.status === 'Error')?.migrationName;
    super(
      `Migration of ${folder} into schema ${schema} failed${failed ? ` at ${failed}` : ''}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'MigrationFailedError';
  }
}

export interface MigrateOptions {
  /** Schema of the `kysely_migration` and `kysely_migration_lock` tables: `platform`, `ref` or the tenant schema. */
  migrationTableSchema: string;
  /** Root folder holding platform/, ref/ and tenant/ (default `apps/server/migrations`). */
  root?: string;
}

/**
 * Applies the pending migrations of one folder (C.3) with the Kysely `Migrator` and the SQL file provider:
 * forward only, `allowUnorderedMigrations: true`. Returns the applied migration names; throws
 * `MigrationFailedError` when one fails (Kysely runs a folder's pending migrations in one transaction).
 */
export async function migrateFolder<T>(db: Kysely<T>, folder: MigrationFolder, options: MigrateOptions): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(migrationsDir(folder, options.root)),
    migrationTableSchema: options.migrationTableSchema,
    allowUnorderedMigrations: true,
  });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error !== undefined) throw new MigrationFailedError(folder, options.migrationTableSchema, results, error);
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export interface DedicatedConnectionOptions {
  /** Session `search_path`, for example `['org_ndt', 'ext']` for tenant migrations (C.3 step 4). */
  searchPath?: string[];
  /** Sets `app.platform_scope = 'on'` for the session (C.3: every migrate step runs with platform scope). */
  platformScope?: boolean;
  applicationName?: string;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A Kysely instance on one dedicated connection (never the shared pool), with session settings passed as
 * libpq startup options. Used by `migrate`, `db bootstrap` style commands and tests; destroy it when done.
 */
export function openDedicatedDatabase<T = unknown>(connectionString: string, options: DedicatedConnectionOptions = {}): Kysely<T> {
  const settings: string[] = [];
  if (options.searchPath) {
    for (const schema of options.searchPath) {
      if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name in search_path: ${schema}`);
    }
    settings.push(`-c search_path=${options.searchPath.join(',')}`);
  }
  if (options.platformScope) settings.push('-c app.platform_scope=on');
  return createKysely<T>({
    connectionString,
    max: 1,
    applicationName: options.applicationName ?? 'mscd-migrate',
    options: settings.length > 0 ? settings.join(' ') : undefined,
  });
}
