// Schema drift test (C.7): the TABLE_COLUMNS lists of src/db/types/*.ts must name exactly the tables and columns
// of a freshly migrated database (platform, ref and one tenant schema). The compiler already ties each list to its
// row interfaces (tableColumns<T>()), so together the Kysely types and the migrations cannot drift apart.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { tableColumns } from '../../../src/db/types';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';

const TYPES_DIR = path.resolve(__dirname, '../../../src/db/types');

/** Every group file's TABLE_COLUMNS, merged; a table listed by two files is an error. */
async function loadTableColumns(): Promise<Map<string, readonly string[]>> {
  const merged = new Map<string, readonly string[]>();
  const files = (await readdir(TYPES_DIR)).filter((f) => f.endsWith('.ts') && f !== 'index.ts').sort();
  expect(files.length).toBeGreaterThanOrEqual(9);
  for (const file of files) {
    const mod = (await import(path.join(TYPES_DIR, file))) as { TABLE_COLUMNS?: Record<string, readonly string[]> };
    expect(mod.TABLE_COLUMNS, `${file} exports TABLE_COLUMNS`).toBeDefined();
    for (const [table, columns] of Object.entries(mod.TABLE_COLUMNS!)) {
      expect(merged.has(table), `${table} is listed by two type files`).toBe(false);
      expect(new Set(columns).size, `${table} lists a column twice`).toBe(columns.length);
      merged.set(table, columns);
    }
  }
  return merged;
}

describe('Kysely types and the migrated schema (C.7)', () => {
  const db = useTestDatabase('empty');
  let schemaName: string;

  beforeAll(async () => {
    ({ schemaName } = await createTenant(db, 'drift'));
  });

  it('lists exactly the tables and columns of platform, ref and a tenant schema', async () => {
    const { rows } = await sql<{ table_schema: string; table_name: string; column_name: string }>`
      select c.table_schema, c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema in ('platform', 'ref', ${schemaName})
        and t.table_type = 'BASE TABLE'
        and c.table_name not in ('kysely_migration', 'kysely_migration_lock')
      order by c.table_schema, c.table_name, c.ordinal_position`.execute(db.migrator);
    const actual = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.table_schema === schemaName ? row.table_name : `${row.table_schema}.${row.table_name}`;
      actual.set(key, [...(actual.get(key) ?? []), row.column_name]);
    }
    const declared = await loadTableColumns();

    const missingTypes = [...actual.keys()].filter((t) => !declared.has(t)).sort();
    const missingTables = [...declared.keys()].filter((t) => !actual.has(t)).sort();
    expect({ tablesWithoutTypes: missingTypes, typesWithoutTables: missingTables }).toEqual({ tablesWithoutTypes: [], typesWithoutTables: [] });

    const columnDiffs: string[] = [];
    for (const [table, columns] of actual) {
      const listed = new Set(declared.get(table));
      for (const c of columns) if (!listed.has(c)) columnDiffs.push(`${table}.${c} is not in TABLE_COLUMNS`);
      for (const c of listed) if (!columns.includes(c)) columnDiffs.push(`${table}.${c} is not in the database`);
    }
    expect(columnDiffs).toEqual([]);
    expect(declared.size).toBe(112);
  });

  it('keeps the kysely_migration type of the platform schema in line with the Kysely Migrator', async () => {
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'platform' and table_name = 'kysely_migration' order by ordinal_position`.execute(db.migrator);
    expect(rows.map((r) => r.column_name)).toEqual(['name', 'timestamp']);
  });
});

// Compile-time checks of tableColumns(): `npm run typecheck` fails when one of these stops being an error.
interface SampleGroup {
  'platform.sample': { id: string; name: string };
}
export const COMPLETE = tableColumns<SampleGroup>()({ 'platform.sample': ['id', 'name'] });
// @ts-expect-error a column of the interface is missing from the list
export const MISSING_COLUMN = tableColumns<SampleGroup>()({ 'platform.sample': ['id'] });
// @ts-expect-error a listed column is not in the interface
export const UNKNOWN_COLUMN = tableColumns<SampleGroup>()({ 'platform.sample': ['id', 'name', 'other'] });
// @ts-expect-error a table of the group is not listed
export const MISSING_TABLE = tableColumns<SampleGroup>()({});
// @ts-expect-error a listed table has no interface in the group
export const EXTRA_TABLE = tableColumns<SampleGroup>()({ 'platform.sample': ['id', 'name'], 'platform.other': ['id'] });
