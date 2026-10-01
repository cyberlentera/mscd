import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** `seed demo` (D-01, G.1). Development flavour and demo mode only. WP-14 implements it. */
export function register(program: Command): void {
  const seed = program.command('seed').description('Demo data (development builds with demo.enabled only)');
  seed
    .command('demo')
    .description('Load the demo organisations, users, licences, packs and sample records')
    .option('--reset', 'drop the demo organisations first')
    .action(notImplemented('seed demo', 'WP-14'));
}
