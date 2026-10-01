import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import type { MscdConfig } from '../config/mscd-config';
import { GatewayServerModule } from '../gateway/gateway-server.module';
import { ObservabilityModule } from '../modules/observability/observability.module';
import { PlatformModule } from '../modules/platform/platform.module';

/**
 * Root module of run mode `storage-gateway` (D.4): the D.5 server, health and metrics. No database module and no
 * `/api/v1` routes; the gateway holds `storage.key` and never `platform.key`.
 */
@Module({})
export class GatewayModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: GatewayModule,
      imports: [ConfigModule.forRoot(config), PlatformModule.forRunMode('storage-gateway'), ObservabilityModule, GatewayServerModule],
    };
  }
}
