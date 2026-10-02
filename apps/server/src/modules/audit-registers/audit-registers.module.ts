import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { AuditActivitiesService } from './audit-activities.service';
import { AuditRegistersController } from './audit-registers.controller';
import { CorrectiveActionsService } from './corrective-actions.service';
import { CycleDeriveJob } from './cycle-derive.job';
import { CycleDeriveService } from './cycle-derive.service';
import { FindingsService } from './findings.service';
import { ManagementReviewsService } from './management-reviews.service';
import { AUDIT_REGISTER_RULES } from './rules';
import { SelfAssessmentsService } from './self-assessments.service';

/**
 * Findings, corrective actions, self-assessment, the audit activity planner, management reviews (D.3 "Registers and
 * workflows: audit side", C.13) and the `cycle.derive` job (E.2), WP-37. The rules BR-06, BR-07, BR-08, BR-09,
 * BR-13 and BR-14 are registered here with `@BusinessRule` for the global `RuleEngine`.
 */
@Module({
  imports: [JobsModule],
  controllers: [AuditRegistersController],
  providers: [
    FindingsService,
    CorrectiveActionsService,
    SelfAssessmentsService,
    AuditActivitiesService,
    ManagementReviewsService,
    CycleDeriveService,
    CycleDeriveJob,
    ...AUDIT_REGISTER_RULES,
  ],
  exports: [FindingsService, CorrectiveActionsService, SelfAssessmentsService, AuditActivitiesService, ManagementReviewsService, CycleDeriveService],
})
export class AuditRegistersModule {}
