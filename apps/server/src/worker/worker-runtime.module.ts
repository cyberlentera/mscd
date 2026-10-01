import { Module } from '@nestjs/common';
import { WorkerRuntime } from './worker-runtime';

/**
 * Worker bootstrap and schedules (E.1, E.2): job handler discovery, the cron schedules and the run wrapper of every
 * handler (`WorkerRuntime`). Imported by `WorkerModule`; `mscd-server worker` calls `WorkerRuntime.start`. The
 * outbox relay of the BullMQ driver lives in `JobsModule`.
 */
@Module({
  providers: [WorkerRuntime],
  exports: [WorkerRuntime],
})
export class WorkerRuntimeModule {}
