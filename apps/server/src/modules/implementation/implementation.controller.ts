// Routes of the implementation commands (D.3 "Commands from the UI", WP-20). The operating criteria route belongs
// to WP-36.
import { Controller } from '@nestjs/common';
import {
  activityTransitionRoute,
  applicabilityCreateRoute,
  applicabilityTransitionRoute,
  applicabilityUpdateRoute,
  phaseVerifyRoute,
  type ActivityTransitionRequest,
  type ApplicabilityCreateRequest,
  type ApplicabilityPatch,
  type ApplicabilityTransitionRequest,
  type CommandResult,
} from '@mscd/shared';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import type { AuthzState, Principal } from '../../common/tokens';
import { ActivityService } from './activity.service';
import { ApplicabilityService } from './applicability.service';

@Controller()
export class ImplementationController {
  constructor(
    private readonly applicability: ApplicabilityService,
    private readonly activities: ActivityService,
  ) {}

  @ApiRoute(applicabilityTransitionRoute)
  transitionEntry(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: { ms: string; id: string },
    @RouteInputParam('body') body: ApplicabilityTransitionRequest,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.applicability.transition(principal, authz, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(applicabilityUpdateRoute)
  updateEntry(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string; id: string },
    @RouteInputParam('body') body: ApplicabilityPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.applicability.update(principal, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(applicabilityCreateRoute)
  createEntry(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: ApplicabilityCreateRequest,
  ): Promise<CommandResult> {
    return this.applicability.create(principal, params.ms, body);
  }

  @ApiRoute(activityTransitionRoute)
  transitionActivity(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: { ms: string; id: string },
    @RouteInputParam('body') body: ActivityTransitionRequest,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.activities.transition(principal, authz, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(phaseVerifyRoute)
  verifyPhase(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string; n: number }): Promise<CommandResult> {
    return this.activities.verifyPhase(principal, params.ms, params.n);
  }
}
