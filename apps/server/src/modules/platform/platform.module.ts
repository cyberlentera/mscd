import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ProblemFilter } from '../../common/problem-filter';
import { MscdConfig, type RunMode } from '../../config/mscd-config';
import { HealthController } from './health.controller';
import { loggerParams } from './logging';
import { MetricsServer, MetricsService } from './metrics';
import { RateLimitService } from './rate-limit';
import { ReadinessService } from './readiness.service';
import { SystemProfileController } from './system-profile.controller';

/**
 * Platform services shared by every run mode: pino logging (F.12), readiness, the metrics registry and its
 * listener, `GET /healthz` and `GET /readyz`. In run mode `api` also the problem details filter (D.1), the rate
 * limit service (F.3) and `GET /api/v1/system/profile`. Global, so any module can inject `ReadinessService` and
 * `MetricsService`.
 */
@Module({})
export class PlatformModule {
  static forRunMode(runMode: RunMode): DynamicModule {
    const api = runMode === 'api';
    const apiProviders: Provider[] = api ? [{ provide: APP_FILTER, useClass: ProblemFilter }, RateLimitService] : [];
    return {
      module: PlatformModule,
      global: true,
      imports: [LoggerModule.forRootAsync({ inject: [MscdConfig], useFactory: (config: MscdConfig) => loggerParams(config) })],
      controllers: api ? [HealthController, SystemProfileController] : [HealthController],
      providers: [ReadinessService, MetricsService, MetricsServer, ...apiProviders],
      exports: [ReadinessService, MetricsService, ...(api ? [RateLimitService] : [])],
    };
  }
}
