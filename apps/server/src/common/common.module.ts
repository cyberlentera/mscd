import { Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MscdConfig } from '../config/mscd-config';
import { Clock } from './clock';
import { FileResponder } from './file-response';
import { createJobQueue, jobDriverOf } from '../modules/jobs/job-queue-factory';
import { JobHandlerRegistry } from './jobs/job-handler';
import { JOB_QUEUE, type JobQueue } from './jobs/job-queue';
import { TenantNotificationWriter } from './notifications/notification-writer';
import { NOTIFICATION_WRITER } from './tokens';

/** Stops the job queue when the application shuts down and says which driver is in use. */
@Injectable()
class JobQueueLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('JobQueue');

  constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly config: MscdConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (jobDriverOf(this.config) === 'memory' && this.config.runMode !== 'cli') {
      this.logger.debug('Jobs are kept in memory in this process (test profile)');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.stop();
  }
}

/**
 * Services every api and worker module may inject (B.4 `src/common`): the clock, file responses, the job queue
 * (the pg-boss or BullMQ driver of `src/modules/jobs`, in memory with the test profile), job handler discovery and
 * the notification writer.
 * Global; imported once by `TenancyModule`, which every api and worker application loads.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    Clock,
    FileResponder,
    JobHandlerRegistry,
    // The driver of `jobs.driver` (WP-22, `src/modules/jobs`); in memory with the test profile.
    { provide: JOB_QUEUE, inject: [MscdConfig], useFactory: (config: MscdConfig) => createJobQueue(config) },
    JobQueueLifecycle,
    { provide: NOTIFICATION_WRITER, useClass: TenantNotificationWriter },
  ],
  exports: [Clock, FileResponder, JobHandlerRegistry, JOB_QUEUE, NOTIFICATION_WRITER],
})
export class CommonModule {}
