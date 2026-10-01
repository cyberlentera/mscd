import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import type { MscdConfig } from '../config/mscd-config';
import { DatabaseModule } from '../db/database.module';
import { PlatformModule } from '../modules/platform/platform.module';
import { WorkerRuntimeModule } from '../worker/worker-runtime.module';
import { WORKER_FEATURE_MODULES } from './feature-modules';

/**
 * Root module of run mode `worker` (D.4): job handlers, schedules and the outbox relay; health and metrics on
 * the metrics port only. Started as a Nest application context (no HTTP routes).
 */
@Module({})
export class WorkerModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot(config),
        PlatformModule.forRunMode('worker'),
        DatabaseModule,
        WorkerRuntimeModule,
        ...WORKER_FEATURE_MODULES,
      ],
    };
  }
}
