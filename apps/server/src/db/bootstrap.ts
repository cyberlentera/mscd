import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { migrationsDir } from './migrator';

/** The login roles of C.2 and the user name each role URL must carry. */
export const BOOTSTRAP_ROLES = {
  migrator: 'mscd_migrator',
  app: 'mscd_app',
  packInstaller: 'mscd_pack_installer',
} as const;

export interface BootstrapPasswords {
  migrator: string;
  app: string;
  packInstaller: string;
}

export interface BootstrapOptions {
  /** Administrator URL of the target database (superuser or a role allowed to create roles and extensions). */
  adminUrl: string;
  passwords: BootstrapPasswords;
  /** Also run `report-role.sql` (refused by the CLI when `tenancy.mode` is `multi`, C.2). */
  withReportRole?: boolean;
  /** Folder holding roles.sql and report-role.sql (default `apps/server/migrations/bootstrap`). */
  dir?: string;
}

export interface BootstrapResult {
  database: string;
  reportRole: boolean;
}

/**
 * Fills the `{{name}}` placeholders of a bootstrap template with escaped literals: a placeholder inside single
 * quotes becomes a string literal (quotes doubled), one inside double quotes a quoted identifier. Any other
 * placeholder, an unknown name or a NUL character is an error.
 */
export function renderBootstrapSql(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/(['"]?)\{\{([a-z_]+)\}\}(['"]?)/g, (whole, open: string, name: string, close: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Bootstrap template uses an unknown placeholder {{${name}}}`);
    if (value.includes('\0')) throw new Error(`Bootstrap value ${name} contains a NUL character`);
    if (open === "'" && close === "'") return `'${value.replace(/'/g, "''")}'`;
    if (open === '"' && close === '"') return `"${value.replace(/"/g, '""')}"`;
    throw new Error(`Bootstrap placeholder {{${name}}} must be wrapped in single or double quotes: ${whole}`);
  });
}

/** Database name of a PostgreSQL URL (its path), required for the bootstrap grants. */
export function databaseNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The administrator database URL is not a valid URL');
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!name) throw new Error('The administrator database URL must name the target database, for example .../mscd');
  return name;
}

/**
 * Password of a role URL, checking that the URL names the expected role (C.2 role names are fixed).
 * `what` names the setting in error messages.
 */
export function passwordFromRoleUrl(url: string, expectedUser: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  const user = decodeURIComponent(parsed.username);
  if (user !== expectedUser) throw new Error(`${what} must sign in as ${expectedUser}, not ${user || 'no user'}`);
  const password = decodeURIComponent(parsed.password);
  if (!password) throw new Error(`${what} has no password`);
  return password;
}

/**
 * Runs the C.2 bootstrap (`roles.sql`, and `report-role.sql` when asked) on the administrator connection of the
 * target database. Idempotent: existing roles keep their passwords, grants and the extension are re-applied.
 */
export async function runBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const database = databaseNameOf(options.adminUrl);
  const dir = options.dir ?? migrationsDir('bootstrap');
  const values = {
    database,
    migrator_password: options.passwords.migrator,
    app_password: options.passwords.app,
    pack_installer_password: options.passwords.packInstaller,
  };
  const scripts = [renderBootstrapSql(await readFile(path.join(dir, 'roles.sql'), 'utf8'), values)];
  if (options.withReportRole) scripts.push(renderBootstrapSql(await readFile(path.join(dir, 'report-role.sql'), 'utf8'), values));

  const client = new pg.Client({ connectionString: options.adminUrl, application_name: 'mscd-bootstrap' });
  client.on('notice', () => undefined);
  await client.connect();
  try {
    for (const script of scripts) await client.query(script);
  } finally {
    await client.end();
  }
  return { database, reportRole: options.withReportRole === true };
}
