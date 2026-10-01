import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { DriftEvaluateJob } from './drift.job';
import { DriftService } from './drift.service';

/** Drift rule evaluation (`drift.evaluate`, TS 9.6, BR-48, BR-49) with the read model's drift predicates. */
@Module({
  imports: [JobsModule],
  providers: [DriftService, DriftEvaluateJob],
  exports: [DriftService],
})
export class DriftModule {}
