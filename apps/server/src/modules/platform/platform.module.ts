import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { MscdConfig, type RunMode } from '../../config/mscd-config';
import { HealthController } from './health.controller';
import { loggerParams } from './logging';
import { MetricsServer, MetricsService } from './metrics';
import { ReadinessService } from './readiness.service';
import { SystemProfileController } from './system-profile.controller';

/**
 * Platform services shared by every run mode: pino logging (F.12), readiness, the metrics registry and its
 * listener, `GET /healthz` and `GET /readyz`; in run mode `api` also `GET /api/v1/system/profile`.
 * Global, so any module can inject `ReadinessService` and `MetricsService`.
 */
@Module({})
export class PlatformModule {
  static forRunMode(runMode: RunMode): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      imports: [LoggerModule.forRootAsync({ inject: [MscdConfig], useFactory: (config: MscdConfig) => loggerParams(config) })],
      controllers: runMode === 'api' ? [HealthController, SystemProfileController] : [HealthController],
      providers: [ReadinessService, MetricsService, MetricsServer],
      exports: [ReadinessService, MetricsService],
    };
  }
}
