import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** `keys generate`, `keys rewrap` and `keys rotate-gateway-token` (D-01, F.11, D.5). WP-13 implements them. */
export function register(program: Command): void {
  const keys = program.command('keys').description('Key and token administration');
  keys
    .command('generate')
    .description('Write platform.key, storage.key, gateway.token, audit-anchor.key and audit-anchor.pub')
    .requiredOption('--out <dir>', 'output directory')
    .action(notImplemented('keys generate', 'WP-13'));
  keys
    .command('rewrap')
    .description('Re-wrap tenant data keys and re-seal secrets under the current key-encryption key')
    .action(notImplemented('keys rewrap', 'WP-13'));
  keys
    .command('rotate-gateway-token')
    .description('Write a new current gateway token and keep the old one as previous until the next rotation')
    .action(notImplemented('keys rotate-gateway-token', 'WP-13'));
}
