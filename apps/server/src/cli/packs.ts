import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** `packs install` (D-01, E.8). WP-12 implements it. */
export function register(program: Command): void {
  const packs = program.command('packs').description('Framework pack administration');
  packs
    .command('install')
    .description('Verify and install a signed framework pack file (role mscd_pack_installer)')
    .argument('<file>', 'pack file (<pack_id>-<version>.pack)')
    .action(notImplemented('packs install', 'WP-12'));
}
