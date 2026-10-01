import { Global, Module, type DynamicModule } from '@nestjs/common';
import { MscdConfig } from './mscd-config';

/** Makes the validated configuration of this process injectable everywhere (`MscdConfig`). */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: MscdConfig, useValue: config }],
      exports: [MscdConfig],
    };
  }
}
