import type { Command } from 'commander';
import { ConfigError } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { chooseKeyService, type KeyServiceMode } from '../seed/key-service';
import { seedDemo } from '../seed/seed-demo';

/** `seed demo [--reset] [--keys auto|gateway|local]` (D-01, G.1). Development flavour and demo mode only. */
export function register(program: Command): void {
  const seed = program.command('seed').description('Demo data (development builds with demo.enabled only)');
  seed
    .command('demo')
    .description(
      'Load the demo organisations, users, licences, packs and sample records (G.1); a second run reports "already seeded"',
    )
    .option('--reset', 'remove the demo organisations and users first, then seed again')
    .option(
      '--keys <mode>',
      'where data keys and sealed credentials come from: gateway (storage.gateway of the profile), local (the gateway key ' +
        'file gateway.kms.file, in this process) or auto (the gateway when it answers, else local)',
      'auto',
    )
    .action(async (options: { reset?: boolean; keys: string }) => {
      const config = loadConfigOrExit('cli');
      if (!['auto', 'gateway', 'local'].includes(options.keys)) {
        process.stderr.write(`seed demo: --keys must be auto, gateway or local, not ${options.keys}\n`);
        process.exit(2);
      }
      const log = (line: string) => process.stdout.write(`${line}\n`);
      try {
        const keys = await chooseKeyService(config, options.keys as KeyServiceMode, log);
        try {
          await seedDemo(config, { reset: options.reset === true, keys, log });
        } finally {
          await keys.close();
        }
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`seed demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
