// Routes of the audit-side registers and workflows (D.3 "Registers and workflows: audit side", WP-37): findings,
// corrective actions, self-assessment, the audit activity planner and management reviews.
import { Controller } from '@nestjs/common';
import {
  auditActivitiesGenerateRoute,
  auditActivitiesListRoute,
  auditActivitiesUpdateRoute,
  correctiveActionsCreateRoute,
  correctiveActionsListRoute,
  correctiveActionsTransitionRoute,
  correctiveActionsUpdateRoute,
  findingsCreateRoute,
  findingsListRoute,
  findingsTransitionRoute,
  findingsUpdateRoute,
  managementReviewsCreateRoute,
  managementReviewsInputRoute,
  managementReviewsListRoute,
  managementReviewsTransitionRoute,
  selfAssessmentsListRoute,
  selfAssessmentsRaiseFindingRoute,
  selfAssessmentsUpdateRoute,
  type AuditActivityItem,
  type AuditActivityPatch,
  type CommandResult,
  type CorrectiveActionCreate,
  type CorrectiveActionItem,
  type CorrectiveActionListQuery,
  type CorrectiveActionPatch,
  type CorrectiveActionTransition,
  type FindingCreate,
  type FindingItem,
  type FindingListQuery,
  type FindingPatch,
  type FindingTransition,
  type ManagementReviewCreate,
  type ManagementReviewInputParams,
  type ManagementReviewInputRequest,
  type ManagementReviewItem,
  type ManagementReviewTransition,
  type MsParams,
  type MsRecordParams,
  type Page,
  type RaiseFindingRequest,
  type SelfAssessmentItem,
  type SelfAssessmentListQuery,
  type SelfAssessmentParams,
  type SelfAssessmentUpdate,
} from '@mscd/shared';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import type { AuthzState, Principal } from '../../common/tokens';
import { AuditActivitiesService } from './audit-activities.service';
import { CorrectiveActionsService } from './corrective-actions.service';
import { FindingsService } from './findings.service';
import { ManagementReviewsService } from './management-reviews.service';
import { SelfAssessmentsService } from './self-assessments.service';

@Controller()
export class AuditRegistersController {
  constructor(
    private readonly findings: FindingsService,
    private readonly actions: CorrectiveActionsService,
    private readonly assessments: SelfAssessmentsService,
    private readonly activities: AuditActivitiesService,
    private readonly reviews: ManagementReviewsService,
  ) {}

  // Findings ------------------------------------------------------------------------------------------------------

  @ApiRoute(findingsListRoute)
  listFindings(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: FindingListQuery,
  ): Promise<Page<FindingItem>> {
    return this.findings.list(principal, authz, params.ms, query);
  }

  @ApiRoute(findingsCreateRoute)
  createFinding(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsParams, @RouteInputParam('body') body: FindingCreate): Promise<CommandResult> {
    return this.findings.create(principal, params.ms, body);
  }

  @ApiRoute(findingsUpdateRoute)
  updateFinding(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: FindingPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.findings.update(principal, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(findingsTransitionRoute)
  transitionFinding(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: FindingTransition,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.findings.transition(principal, authz, params.ms, params.id, body, ifMatch);
  }

  // Corrective actions --------------------------------------------------------------------------------------------

  @ApiRoute(correctiveActionsListRoute)
  listCorrectiveActions(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: CorrectiveActionListQuery,
  ): Promise<Page<CorrectiveActionItem>> {
    return this.actions.list(principal, authz, params.ms, query);
  }

  @ApiRoute(correctiveActionsCreateRoute)
  createCorrectiveAction(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: CorrectiveActionCreate,
  ): Promise<CommandResult> {
    return this.actions.create(principal, params.ms, body);
  }

  @ApiRoute(correctiveActionsUpdateRoute)
  updateCorrectiveAction(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: CorrectiveActionPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.actions.update(principal, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(correctiveActionsTransitionRoute)
  transitionCorrectiveAction(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: CorrectiveActionTransition,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.actions.transition(principal, authz, params.ms, params.id, body, ifMatch);
  }

  // Self-assessment -----------------------------------------------------------------------------------------------

  @ApiRoute(selfAssessmentsListRoute)
  listSelfAssessments(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: SelfAssessmentListQuery,
  ): Promise<Page<SelfAssessmentItem>> {
    return this.assessments.list(principal, authz, params.ms, query);
  }

  @ApiRoute(selfAssessmentsUpdateRoute)
  updateSelfAssessment(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: SelfAssessmentParams,
    @RouteInputParam('body') body: SelfAssessmentUpdate,
  ): Promise<CommandResult> {
    return this.assessments.update(principal, authz, params.ms, params.conditionCode, body);
  }

  @ApiRoute(selfAssessmentsRaiseFindingRoute)
  raiseFinding(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: RaiseFindingRequest,
  ): Promise<CommandResult> {
    return this.assessments.raiseFinding(principal, params.ms, params.id, body);
  }

  // Audit activity planner ----------------------------------------------------------------------------------------

  @ApiRoute(auditActivitiesListRoute)
  listAuditActivities(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
  ): Promise<AuditActivityItem[]> {
    return this.activities.list(principal, authz, params.ms, params.id);
  }

  @ApiRoute(auditActivitiesGenerateRoute)
  generateAuditActivities(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<CommandResult> {
    return this.activities.generate(principal, params.ms, params.id);
  }

  @ApiRoute(auditActivitiesUpdateRoute)
  updateAuditActivity(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: AuditActivityPatch,
  ): Promise<CommandResult> {
    return this.activities.update(principal, params.ms, params.id, body);
  }

  // Management reviews --------------------------------------------------------------------------------------------

  @ApiRoute(managementReviewsListRoute)
  listManagementReviews(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsParams,
  ): Promise<ManagementReviewItem[]> {
    return this.reviews.list(principal, authz, params.ms);
  }

  @ApiRoute(managementReviewsCreateRoute)
  createManagementReview(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: ManagementReviewCreate,
  ): Promise<CommandResult> {
    return this.reviews.create(principal, params.ms, body);
  }

  @ApiRoute(managementReviewsInputRoute)
  putManagementReviewInput(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: ManagementReviewInputParams,
    @RouteInputParam('body') body: ManagementReviewInputRequest,
  ): Promise<CommandResult> {
    return this.reviews.putInput(principal, params.ms, params.id, params.defCode, body);
  }

  @ApiRoute(managementReviewsTransitionRoute)
  transitionManagementReview(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: ManagementReviewTransition,
  ): Promise<CommandResult> {
    return this.reviews.transition(principal, authz, params.ms, params.id, body);
  }
}
