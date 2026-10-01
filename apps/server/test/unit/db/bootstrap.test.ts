import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseNameOf, passwordFromRoleUrl, renderBootstrapSql } from '../../../src/db/bootstrap';
import { migrationsDir } from '../../../src/db/migrator';
import { SqlFileMigrationProvider } from '../../../src/db/sql-migration-provider';

describe('bootstrap templates (C.2)', () => {
  const values = {
    database: 'mscd',
    migrator_password: "it's-a-secret",
    app_password: 'app-dev',
    pack_installer_password: 'pack-dev',
  };

  it('fill quoted placeholders with escaped literals and identifiers', () => {
    expect(renderBootstrapSql(`PASSWORD '{{app_password}}'`, { app_password: "a'b" })).toBe(`PASSWORD 'a''b'`);
    expect(renderBootstrapSql(`ON DATABASE "{{database}}"`, { database: 'we"ird' })).toBe(`ON DATABASE "we""ird"`);
  });

  it('refuse unquoted or unknown placeholders and NUL characters', () => {
    expect(() => renderBootstrapSql('ON DATABASE {{database}}', values)).toThrow(/must be wrapped/);
    expect(() => renderBootstrapSql("'{{nope}}'", values)).toThrow(/unknown placeholder/);
    expect(() => renderBootstrapSql("'{{app_password}}'", { app_password: 'a\0b' })).toThrow(/NUL/);
  });

  it('render roles.sql and report-role.sql completely', () => {
    for (const file of ['roles.sql', 'report-role.sql']) {
      const rendered = renderBootstrapSql(readFileSync(path.join(migrationsDir('bootstrap'), file), 'utf8'), values);
      expect(rendered).not.toMatch(/\{\{/);
      expect(rendered).toContain('ON DATABASE "mscd"');
    }
    const roles = renderBootstrapSql(readFileSync(path.join(migrationsDir('bootstrap'), 'roles.sql'), 'utf8'), values);
    expect(roles).toContain(`CREATE ROLE mscd_migrator LOGIN PASSWORD 'it''s-a-secret';`);
    expect(roles).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ext;');
  });

  it('take the database from the administrator URL and passwords from the role URLs', () => {
    expect(databaseNameOf('postgres://postgres:pw@localhost:55432/mscd')).toBe('mscd');
    expect(() => databaseNameOf('postgres://postgres:pw@localhost:55432')).toThrow(/must name the target database/);
    expect(passwordFromRoleUrl('postgres://mscd_app:p%40ss@db/mscd', 'mscd_app', 'app URL')).toBe('p@ss');
    expect(() => passwordFromRoleUrl('postgres://other:x@db/mscd', 'mscd_app', 'app URL')).toThrow(/must sign in as mscd_app/);
    expect(() => passwordFromRoleUrl('postgres://mscd_app@db/mscd', 'mscd_app', 'app URL')).toThrow(/no password/);
  });
});

describe('SqlFileMigrationProvider (C.3)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-provider-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function folder(name: string, files: Record<string, string>): Promise<string> {
    const target = path.join(dir, name);
    await mkdir(target);
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(target, file), text);
    return target;
  }

  it('returns one migration per file, sorted, named without .sql, ignoring other files', async () => {
    const target = await folder('ok', { '0002_b.sql': 'select 2', '0001_a.sql': 'select 1', 'README.md': '# notes', '.gitkeep': '' });
    const migrations = await new SqlFileMigrationProvider(target).getMigrations();
    expect(Object.keys(migrations)).toEqual(['0001_a', '0002_b']);
    expect(typeof migrations['0001_a']?.up).toBe('function');
    expect(migrations['0001_a']?.down).toBeUndefined();
  });

  it('has no migrations for a missing folder', async () => {
    expect(await new SqlFileMigrationProvider(path.join(dir, 'missing')).getMigrations()).toEqual({});
  });

  it('refuses badly named files and duplicate numbers', async () => {
    const badName = await folder('bad', { '1_short.sql': 'select 1' });
    await expect(new SqlFileMigrationProvider(badName).getMigrations()).rejects.toThrow(/does not match NNNN_name.sql/);
    const duplicate = await folder('dup', { '0001_a.sql': 'select 1', '0001_b.sql': 'select 2' });
    await expect(new SqlFileMigrationProvider(duplicate).getMigrations()).rejects.toThrow(/share the number 0001/);
  });
});
