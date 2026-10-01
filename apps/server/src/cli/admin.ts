import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** `admin create-user` (D-01). WP-11 implements it. */
export function register(program: Command): void {
  const admin = program.command('admin').description('User administration from the command line');
  admin
    .command('create-user')
    .description('Create a user and membership and print a one-time invitation link')
    .requiredOption('--email <email>', 'email address')
    .option('--name <name>', 'display name')
    .option('--tenant-admin', 'grant the tenant_admin role')
    .option('--org <slug>', 'organisation slug (default: the only organisation)')
    .action(notImplemented('admin create-user', 'WP-11'));
}
