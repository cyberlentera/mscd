import type { Command } from 'commander';
import { ConfigError } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { BOOTSTRAP_ROLES, passwordFromRoleUrl, runBootstrap } from '../db/bootstrap';

/** `db bootstrap [--with-report-role]` (C.2). */
export function register(program: Command): void {
  const db = program.command('db').description('Database administration');
  db.command('bootstrap')
    .description(
      'Create the database roles, schema ext and extension pg_trgm (C.2) with an administrator URL ' +
        '(MSCD_DATABASE_ADMIN_URL or database.admin_url_file); the role passwords come from the role URLs',
    )
    .option('--with-report-role', 'also create the NOLOGIN reporting role mscd_report (tenancy.mode single only)')
    .action(runDbBootstrap);
}

export async function runDbBootstrap(options: { withReportRole?: boolean }): Promise<void> {
  const config = loadConfigOrExit('cli');
  if (options.withReportRole && config.profile.tenancy.mode === 'multi') {
    process.stderr.write('db bootstrap: --with-report-role is refused with tenancy.mode multi (C.2, D-31)\n');
    process.exit(1);
  }
  try {
    const roleUrl = (role: 'migrator' | 'app' | 'pack_installer', user: string, setting: string) =>
      passwordFromRoleUrl(config.databaseUrl(role), user, `The ${role} URL (${setting})`);
    const passwords = {
      migrator: roleUrl('migrator', BOOTSTRAP_ROLES.migrator, 'MSCD_DATABASE_MIGRATOR_URL or database.migrator_url_file'),
      app: roleUrl('app', BOOTSTRAP_ROLES.app, 'MSCD_DATABASE_URL or database.url_file'),
      packInstaller: roleUrl('pack_installer', BOOTSTRAP_ROLES.packInstaller, 'MSCD_DATABASE_PACK_URL or database.pack_installer_url_file'),
    };
    const result = await runBootstrap({
      adminUrl: config.databaseUrl('admin'),
      passwords,
      withReportRole: options.withReportRole === true,
    });
    const roles: string[] = [...Object.values(BOOTSTRAP_ROLES), ...(result.reportRole ? ['mscd_report (NOLOGIN)'] : [])];
    process.stdout.write(`db bootstrap: database ${result.database} ready (roles ${roles.join(', ')}; schema ext with pg_trgm)\n`);
  } catch (error) {
    if (error instanceof ConfigError) exitOnConfigError(error);
    process.stderr.write(`db bootstrap failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
