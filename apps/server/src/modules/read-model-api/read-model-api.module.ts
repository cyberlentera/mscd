import { Module } from '@nestjs/common';
import { ImplementationModule } from '../implementation/implementation.module';
import { RulesModule } from '../rules/rules.module';
import { ReadModelApiController } from './read-model-api.controller';
import { ScreenReadService } from './screen-read.service';

/**
 * Per-screen read endpoints of TS 9.2 (build plan D.3 "Read model per screen", D-05, WP-32): projections of the
 * WP-17 derivation output, every result through `ScopePolicy`. `ScreenReadService` uses the read model's exported
 * loader and builders; `ScopePolicyService`, `TenantScope` and `Clock` come from global modules.
 */
@Module({
  // ImplementationModule gives the BR-46 gate consistency of the summary (WP-20); RulesModule is global in the
  // application and imported here so the module also works in test modules that do not list it.
  imports: [RulesModule, ImplementationModule],
  controllers: [ReadModelApiController],
  providers: [ScreenReadService],
  exports: [ScreenReadService],
})
export class ReadModelApiModule {}
