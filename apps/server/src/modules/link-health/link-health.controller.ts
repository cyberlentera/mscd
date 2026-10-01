// `POST /ms/{ms}/link-health/run` (D.3 page actions, E.4): checks every file reference of a system now, as one
// `link_health_run` background task (feature `link_health_monitor`).
import { Controller } from '@nestjs/common';
import { linkHealthRunRoute, type CommandResult, type MsParams } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { currentRequestId } from '../../common/request-context';
import type { Principal } from '../../common/tokens';
import { LinkHealthService } from './link-health.service';

@Controller()
export class LinkHealthController {
  constructor(private readonly linkHealth: LinkHealthService) {}

  @ApiRoute(linkHealthRunRoute)
  run(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsParams): Promise<CommandResult> {
    return this.linkHealth.run(principal, params.ms, currentRequestId());
  }
}
