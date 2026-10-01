import { Module } from '@nestjs/common';
import { ReadModelApiController } from './read-model-api.controller';
import { ScreenReadService } from './screen-read.service';

/**
 * Per-screen read endpoints of TS 9.2 (build plan D.3 "Read model per screen", D-05, WP-32): projections of the
 * WP-17 derivation output, every result through `ScopePolicy`. `ScreenReadService` uses the read model's exported
 * loader and builders; `ScopePolicyService`, `TenantScope` and `Clock` come from global modules.
 */
@Module({
  controllers: [ReadModelApiController],
  providers: [ScreenReadService],
  exports: [ScreenReadService],
})
export class ReadModelApiModule {}
