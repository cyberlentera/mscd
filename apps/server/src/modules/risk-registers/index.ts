// What other modules use from the risk-side registers (B.4).
export { RiskRegistersModule } from './risk-registers.module';
export { RegistersService, RISK_ASSESSMENT_KEYS, RISK_NEEDS_TREATMENT, METRIC_NEEDS_VALUE } from './registers.service';
export { TreatmentsService, TREATMENT_ACTIONS, RISK_NEEDS_ACCEPTANCE } from './treatments.service';
export { EvidenceService } from './evidence.service';
export { EntityLinksService } from './entity-links.service';
export { OperatingCriteriaService } from './operating-criteria.service';
export { confirmShared, crossSystemNonReusable } from './rules';
