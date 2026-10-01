import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** Run mode `storage-gateway` (D.4, D.5). WP-13 implements it with `GatewayModule`. */
export function register(program: Command): void {
  program
    .command('storage-gateway')
    .description('Run the storage gateway (port gateway.port, mTLS) that holds storage.key and talks to the storage providers')
    .action(notImplemented('storage-gateway', 'WP-13'));
}
