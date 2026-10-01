import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Command } from 'commander';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from '../app/worker.module';
import { ConfigError } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { BUILD_FLAVOR, VERSION } from '../generated/build-info';
import { jobDriverOf } from '../modules/jobs/job-queue-factory';
import { parseQueues, WorkerRuntime } from '../worker/worker-runtime';

/** Run mode `worker` (D.4, E.1): job handlers, cron schedules and the outbox relay; health and metrics on the metrics port. */
export function register(program: Command): void {
  program
    .command('worker')
    .description('Run the job worker: handlers, schedules and the outbox relay (health and metrics on the metrics port)')
    .option('--queues <names>', 'comma-separated queue names this process works on (default: all)')
    .action(runWorker);
}

export async function runWorker(options: { queues?: string }): Promise<void> {
  const config = loadConfigOrExit('worker');
  let queues: string[] | undefined;
  try {
    queues = parseQueues(options.queues);
  } catch (error) {
    exitOnConfigError(new ConfigError((error as Error).message));
  }
  if (jobDriverOf(config) === 'memory') {
    exitOnConfigError(new ConfigError('The worker needs a job queue shared with the api: use a profile other than the test profile, or set MSCD_TEST_JOBS_DRIVER=profile'));
  }
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false, abortOnError: false }).catch(exitOnConfigError);
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
  const started = await app.get(WorkerRuntime).start({ queues });
  new NestLogger('worker').log(
    `MSCD worker ${VERSION} (${BUILD_FLAVOR} build) with profile ${config.profileFile}: driver ${jobDriverOf(config)}, ` +
      `${started.queues.length} queue(s), ${started.schedules.length} cron schedule(s)`,
  );
}
