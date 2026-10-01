// Routes of the risk-side registers and workflows (D.3 "Registers and workflows: risk side", WP-36) and the operating
// criteria route of the implementation area (`PUT /ms/{ms}/applicability/{id}/operating-criteria`).
import { Controller } from '@nestjs/common';
import {
  applicabilityOperatingCriteriaRoute,
  entityLinksCreateRoute,
  entityLinksMakePrimaryRoute,
  entityLinksRemoveRoute,
  evidenceCreateRoute,
  evidenceTargetsCreateRoute,
  evidenceTargetsRemoveRoute,
  evidenceUpdateRoute,
  metricValuesCreateRoute,
  registersCreateRoute,
  registersListRoute,
  registersUpdateRoute,
  residualAcceptanceRoute,
  treatmentsCreateRoute,
  treatmentsTransitionRoute,
  treatmentsUpdateRoute,
  type CommandResult,
  type EntityLinkRequest,
  type EvidenceCreate,
  type EvidencePatch,
  type EvidenceTargetParams,
  type EvidenceTargetRemoveRequest,
  type EvidenceTargetRequest,
  type MetricValueRequest,
  type MsParams,
  type MsRecordParams,
  type OperatingCriteriaRequest,
  type Page,
  type ReasonBody,
  type RegisterCreate,
  type RegisterItem,
  type RegisterItemParams,
  type RegisterListQuery,
  type RegisterParams,
  type RegisterPatch,
  type ResidualAcceptanceRequest,
  type TreatmentCreate,
  type TreatmentPatch,
  type TreatmentTransition,
} from '@mscd/shared';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import type { AuthzState, Principal } from '../../common/tokens';
import { EntityLinksService } from './entity-links.service';
import { EvidenceService } from './evidence.service';
import { OperatingCriteriaService } from './operating-criteria.service';
import { RegistersService } from './registers.service';
import { TreatmentsService } from './treatments.service';

@Controller()
export class RiskRegistersController {
  constructor(
    private readonly registers: RegistersService,
    private readonly treatments: TreatmentsService,
    private readonly evidence: EvidenceService,
    private readonly links: EntityLinksService,
    private readonly criteria: OperatingCriteriaService,
  ) {}

  // Registers -----------------------------------------------------------------------------------------------------

  @ApiRoute(registersListRoute)
  list(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: RegisterParams,
    @RouteInputParam('query') query: RegisterListQuery,
  ): Promise<Page<RegisterItem>> {
    return this.registers.list(principal, authz, params.ms, params.register, query);
  }

  @ApiRoute(registersCreateRoute)
  create(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: RegisterParams,
    @RouteInputParam('body') body: RegisterCreate,
  ): Promise<CommandResult> {
    return this.registers.create(principal, authz, params.ms, params.register, body);
  }

  @ApiRoute(registersUpdateRoute)
  update(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: RegisterItemParams,
    @RouteInputParam('body') body: RegisterPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.registers.update(principal, authz, params.ms, params.register, params.id, body, ifMatch);
  }

  @ApiRoute(metricValuesCreateRoute)
  recordMetricValue(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: MetricValueRequest,
  ): Promise<CommandResult> {
    return this.registers.recordMetricValue(principal, authz, params.ms, params.id, body);
  }

  // Treatments and residual acceptance ----------------------------------------------------------------------------

  @ApiRoute(treatmentsCreateRoute)
  createTreatment(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: TreatmentCreate,
  ): Promise<CommandResult> {
    return this.treatments.create(principal, params.ms, params.id, body);
  }

  @ApiRoute(treatmentsUpdateRoute)
  updateTreatment(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: TreatmentPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.treatments.update(principal, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(treatmentsTransitionRoute)
  transitionTreatment(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: TreatmentTransition,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.treatments.transition(principal, authz, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(residualAcceptanceRoute)
  acceptResidual(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: ResidualAcceptanceRequest,
  ): Promise<CommandResult> {
    return this.treatments.acceptResidual(principal, params.ms, params.id, body);
  }

  // Evidence ------------------------------------------------------------------------------------------------------

  @ApiRoute(evidenceCreateRoute)
  createEvidence(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: EvidenceCreate,
  ): Promise<CommandResult> {
    return this.evidence.create(principal, authz, params.ms, body);
  }

  @ApiRoute(evidenceUpdateRoute)
  updateEvidence(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: EvidencePatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.evidence.update(principal, authz, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(evidenceTargetsCreateRoute)
  addEvidenceTarget(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: EvidenceTargetRequest,
  ): Promise<CommandResult> {
    return this.evidence.addTarget(principal, authz, params.ms, params.id, body);
  }

  @ApiRoute(evidenceTargetsRemoveRoute)
  removeEvidenceTarget(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: EvidenceTargetParams,
    @RouteInputParam('body') body: EvidenceTargetRemoveRequest,
  ): Promise<CommandResult> {
    return this.evidence.removeTarget(principal, authz, params.ms, params.id, params.targetId, body);
  }

  // Entity links --------------------------------------------------------------------------------------------------

  @ApiRoute(entityLinksCreateRoute)
  createLink(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: EntityLinkRequest,
  ): Promise<CommandResult> {
    return this.links.create(principal, params.ms, body);
  }

  @ApiRoute(entityLinksMakePrimaryRoute)
  makePrimary(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: ReasonBody,
  ): Promise<CommandResult> {
    return this.links.makePrimary(principal, params.ms, params.id, body ?? {});
  }

  @ApiRoute(entityLinksRemoveRoute)
  removeLink(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: ReasonBody,
  ): Promise<CommandResult> {
    return this.links.remove(principal, params.ms, params.id, body ?? {});
  }

  // Operating criteria --------------------------------------------------------------------------------------------

  @ApiRoute(applicabilityOperatingCriteriaRoute)
  setOperatingCriteria(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: OperatingCriteriaRequest,
  ): Promise<CommandResult> {
    return this.criteria.set(principal, params.ms, params.id, body);
  }
}
