import { Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MscdConfig } from '../config/mscd-config';
import { Clock } from './clock';
import { FileResponder } from './file-response';
import { InMemoryJobQueue } from './jobs/in-memory-job-queue';
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
    if (this.queue instanceof InMemoryJobQueue && this.config.profile.test === undefined) {
      this.logger.warn(
        `jobs.driver ${this.config.profile.jobs.driver} is not available in this build yet (WP-22); jobs are kept in memory in this process`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.stop();
  }
}

/**
 * Services every api and worker module may inject (B.4 `src/common`): the clock, file responses, the job queue
 * (in-memory driver until WP-22 adds pg-boss and BullMQ), job handler discovery and the notification writer.
 * Global; imported once by `TenancyModule`, which every api and worker application loads.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    Clock,
    FileResponder,
    JobHandlerRegistry,
    { provide: JOB_QUEUE, useFactory: () => new InMemoryJobQueue() },
    JobQueueLifecycle,
    { provide: NOTIFICATION_WRITER, useClass: TenantNotificationWriter },
  ],
  exports: [Clock, FileResponder, JobHandlerRegistry, JOB_QUEUE, NOTIFICATION_WRITER],
})
export class CommonModule {}
