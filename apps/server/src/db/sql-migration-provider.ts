import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql, type Kysely, type Migration, type MigrationProvider } from 'kysely';

/** Migration file names: four digits, an underscore and a lower-case name (C.3), for example 0001_foundation.sql. */
export const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * One Kysely migration per `NNNN_name.sql` file of a folder, sorted by name (C.3). `up` runs the whole file
 * with `sql.raw(text).execute(db)`, which uses the simple query protocol, so a file may hold several
 * statements. Forward only: there is no `down`. The migration name is the file name without `.sql`.
 * A missing folder has no migrations; a `.sql` file with another name, or two files with the same number,
 * is an error rather than being skipped.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const files = entries.filter((name) => name.endsWith('.sql')).sort();
    const numbers = new Map<string, string>();
    const migrations: Record<string, Migration> = {};
    for (const name of files) {
      const match = MIGRATION_FILE.exec(name);
      if (!match) {
        throw new Error(`Migration file ${path.join(this.dir, name)} does not match NNNN_name.sql`);
      }
      const clash = numbers.get(match[1]!);
      if (clash) throw new Error(`Migrations ${clash} and ${name} in ${this.dir} share the number ${match[1]}`);
      numbers.set(match[1]!, name);
      const text = await readFile(path.join(this.dir, name), 'utf8');
      migrations[name.slice(0, -'.sql'.length)] = {
        up: async (db: Kysely<unknown>) => {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}
