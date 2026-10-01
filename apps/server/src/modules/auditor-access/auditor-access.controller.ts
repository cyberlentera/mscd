// Routes of D.3 "Evidence packs, auditor access" owned by WP-26 for guest auditor grants (F.14). The guard has
// checked `auditor_access.grant` in the system of the path; the service checks the licence feature.
import { Controller } from '@nestjs/common';
import {
  auditorAccessGrantRoute,
  auditorAccessListRoute,
  auditorAccessRevokeRoute,
  type AuditorAccessGrantView,
  type AuditorAccessRequest,
  type AuditorAccessResult,
  type CommandResult,
  type MsParams,
  type MsRecordParams,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { AuditorAccessService } from './auditor-access.service';

@Controller()
export class AuditorAccessController {
  constructor(private readonly grants: AuditorAccessService) {}

  @ApiRoute(auditorAccessGrantRoute)
  grant(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: AuditorAccessRequest,
  ): Promise<AuditorAccessResult> {
    return this.grants.grant(principal, params.ms, body);
  }

  @ApiRoute(auditorAccessListRoute)
  list(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsParams): Promise<AuditorAccessGrantView[]> {
    return this.grants.list(principal, params.ms);
  }

  @ApiRoute(auditorAccessRevokeRoute)
  revoke(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<CommandResult> {
    return this.grants.revoke(principal, params.ms, params.id);
  }
}
