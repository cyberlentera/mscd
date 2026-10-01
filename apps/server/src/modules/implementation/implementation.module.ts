import { Module } from '@nestjs/common';
import { ReadModelModule } from '../read-model/read-model.module';
import { ActivityService } from './activity.service';
import { ApplicabilityService } from './applicability.service';
import { ImplementationController } from './implementation.controller';
import { IMPLEMENTATION_RULES } from './rules';

/**
 * Applicability, activity and phase commands (A.4, C.13, D.3, WP-20) and the rules they trigger (BR-01, BR-02, BR-03,
 * BR-12, BR-39, BR-40, BR-46, BR-47, VERIFY-SELF), registered with `@BusinessRule` for the global `RuleEngine`.
 * `ActivityService.gateConsistencyIn` gives the BR-46 flag to the implementation summary (WP-32).
 */
@Module({
  imports: [ReadModelModule],
  controllers: [ImplementationController],
  providers: [ApplicabilityService, ActivityService, ...IMPLEMENTATION_RULES],
  exports: [ApplicabilityService, ActivityService],
})
export class ImplementationModule {}
