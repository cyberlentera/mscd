import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** Run mode `migrate` (C.3). WP-06 implements steps 1, 2 and 4, WP-22 the pg-boss step, WP-12 the pack step. */
export function register(program: Command): void {
  program
    .command('migrate')
    .description('Apply platform, ref and tenant migrations, create the pg-boss schema and install new packs, then exit')
    .option('--dry-run', 'print the SQL a run would apply without changing anything')
    .action(notImplemented('migrate', 'WP-06'));
}
