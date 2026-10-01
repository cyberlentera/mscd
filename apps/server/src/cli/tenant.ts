import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** `tenant create` and `tenant verify-domain` (D-01, C.8). WP-06 implements them. */
export function register(program: Command): void {
  const tenant = program.command('tenant').description('Organisation (tenant) administration');
  tenant
    .command('create')
    .description('Create an organisation with its schema, data key and Managed Vault repository')
    .requiredOption('--slug <slug>', 'organisation slug (schema org_<slug>)')
    .requiredOption('--name <name>', 'display name')
    .option('--id <uuid>', 'fixed organisation id')
    .action(notImplemented('tenant create', 'WP-06'));
  tenant
    .command('verify-domain')
    .description('Record an email domain as verified for an organisation (needed for JIT provisioning, D-25)')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--domain <domain>', 'email domain')
    .requiredOption('--by <name>', 'who verified it')
    .action(notImplemented('tenant verify-domain', 'WP-06'));
}
