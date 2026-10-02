// What other modules use from the audit-side registers (B.4).
export { AuditRegistersModule } from './audit-registers.module';
export { FindingsService } from './findings.service';
export { CorrectiveActionsService } from './corrective-actions.service';
export { SelfAssessmentsService } from './self-assessments.service';
export { AuditActivitiesService } from './audit-activities.service';
export { ManagementReviewsService } from './management-reviews.service';
export { CycleDeriveService, DERIVATION_KINDS, cycleDeriveKey, type CycleDeriveResult, type DerivationKind } from './cycle-derive.service';
export { CycleDeriveJob } from './cycle-derive.job';
export { hasEffectiveCorrectiveAction, missingReviewInputs } from './rules';
