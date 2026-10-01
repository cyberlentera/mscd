// The management system administration routes of D.3 and `POST /ms/{ms}/transitions` (WP-12).
import { Controller } from '@nestjs/common';
import {
  adminMsCreateRoute,
  adminMsListRoute,
  adminMsUpdateRoute,
  msTransitionRoute,
  type CommandResult,
  type ManagementSystemCreate,
  type ManagementSystemPatch,
  type ManagementSystemView,
  type MsTransitionRequest,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { ManagementSystemsService } from './management-systems.service';

@Controller()
export class ManagementSystemsController {
  constructor(private readonly systems: ManagementSystemsService) {}

  @ApiRoute(adminMsListRoute)
  list(@CurrentPrincipal() principal: Principal): Promise<ManagementSystemView[]> {
    return this.systems.list(principal);
  }

  @ApiRoute(adminMsCreateRoute)
  create(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: ManagementSystemCreate): Promise<ManagementSystemView> {
    return this.systems.create(principal, body);
  }

  @ApiRoute(adminMsUpdateRoute)
  update(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string },
    @RouteInputParam('body') body: ManagementSystemPatch,
  ): Promise<ManagementSystemView> {
    return this.systems.update(principal, params.id, body);
  }

  @ApiRoute(msTransitionRoute)
  transition(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: MsTransitionRequest,
  ): Promise<CommandResult> {
    return this.systems.transition(principal, params.ms, body);
  }
}
