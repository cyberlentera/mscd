import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { FreshnessRecomputeJob, FreshnessSweepJob } from './freshness.jobs';
import { FreshnessService } from './freshness.service';

/**
 * `freshness.recompute` and `freshness.sweep` (E.3) with `FreshnessService`, which stores the derived freshness and
 * integrity of evidence and applicability entries, downgrades entries (TS 6.1) and opens and closes BR-11 and BR-31
 * tasks. Producers queue the recompute with `freshnessRecomputeKey` and `FRESHNESS_RECOMPUTE_DELAY_SECONDS`.
 */
@Module({
  imports: [JobsModule],
  providers: [FreshnessService, FreshnessRecomputeJob, FreshnessSweepJob],
  exports: [FreshnessService],
})
export class FreshnessModule {}
