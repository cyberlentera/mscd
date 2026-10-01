import { Module } from '@nestjs/common';
import { EntityLinksService } from './entity-links.service';
import { EvidenceService } from './evidence.service';
import { OperatingCriteriaService } from './operating-criteria.service';
import { RegistersService } from './registers.service';
import { RiskRegistersController } from './risk-registers.controller';
import { RISK_REGISTER_RULES } from './rules';
import { TreatmentsService } from './treatments.service';

/**
 * Context issues, interested parties, assets, risks and metrics (with their system links), metric values, risk
 * treatments (C.13), residual acceptance (BR-04), evidence records and targets (BR-23), entity links (A-29) and the
 * operating criteria of applicability entries (D.3 "Registers and workflows: risk side", WP-36). The rules BR-04,
 * BR-17 and BR-23 are registered here with `@BusinessRule` for the global `RuleEngine`.
 */
@Module({
  controllers: [RiskRegistersController],
  providers: [RegistersService, TreatmentsService, EvidenceService, EntityLinksService, OperatingCriteriaService, ...RISK_REGISTER_RULES],
  exports: [RegistersService, TreatmentsService, EvidenceService, EntityLinksService, OperatingCriteriaService],
})
export class RiskRegistersModule {}
