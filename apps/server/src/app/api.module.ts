import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import type { MscdConfig } from '../config/mscd-config';
import { DatabaseModule } from '../db/database.module';
import { PlatformModule } from '../modules/platform/platform.module';
import { API_FEATURE_MODULES } from './feature-modules';

/** Root module of run mode `api` (D.4): PostgreSQL as `mscd_app`, every `/api/v1` route, health and metrics. */
@Module({})
export class ApiModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [ConfigModule.forRoot(config), PlatformModule.forRunMode('api'), DatabaseModule, ...API_FEATURE_MODULES],
    };
  }
}
