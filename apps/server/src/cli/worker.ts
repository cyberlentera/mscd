import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/** Run mode `worker` (D.4, E.1). WP-22 implements it with `WorkerModule`. */
export function register(program: Command): void {
  program
    .command('worker')
    .description('Run the job worker: handlers, schedules and the outbox relay (health and metrics on the metrics port)')
    .option('--queues <names>', 'comma-separated queue names this process works on (default: all)')
    .action(notImplemented('worker', 'WP-22'));
}
