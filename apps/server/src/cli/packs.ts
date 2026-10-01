import type { Command } from 'commander';
import type { Kysely } from 'kysely';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import type { DB } from '../db/types';
import { ChainedAuditWriter } from '../modules/audit/audit-writer';
import { installPackFile, type PackFileResult } from '../modules/packs/install-from-dir';
import { TenantScope } from '../modules/tenancy/tenant-scope';

/** `packs install <file>` (D-01, E.8): verifies and installs one signed pack file as mscd_pack_installer (D-17). */
export function register(program: Command): void {
  const packs = program.command('packs').description('Framework pack administration');
  packs
    .command('install')
    .description('Verify and install a signed framework pack file (role mscd_pack_installer)')
    .argument('<file>', 'pack file (<pack_id>-<version>.pack)')
    .action(async (file: string) => {
      const config = loadConfigOrExit('cli');
      let result: PackFileResult;
      try {
        result = await packsInstall(config, file, (text) => process.stdout.write(text));
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`packs install failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
      if (result.status === 'rejected' || result.status === 'failed') process.exit(1);
    });
}

/** The platform audit writer on an installer connection (the `pack.*` entries of F.11). */
export function installerAuditWriter(installerDb: Kysely<DB>): ChainedAuditWriter {
  return new ChainedAuditWriter(new TenantScope(installerDb));
}

/** `packs install <file>` with a loaded configuration; prints one line and returns the result. */
export async function packsInstall(config: MscdConfig, file: string, out: (text: string) => void): Promise<PackFileResult> {
  return installPackFile(file, {
    installerUrl: config.databaseUrl('pack_installer'),
    audit: installerAuditWriter,
    actor: { userId: null, kind: 'operator' },
    log: (line) => out(`packs install: ${line}\n`),
  });
}
