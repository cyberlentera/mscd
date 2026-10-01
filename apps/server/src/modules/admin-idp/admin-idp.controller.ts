// Identity provider administration routes (D.3 "Administration", WP-16). The guard has checked `idp.manage` in the
// session's organisation and validated the request; the service works in that organisation only.
import { Controller } from '@nestjs/common';
import {
  adminIdpCreateRoute,
  adminIdpListRoute,
  adminIdpTestRoute,
  adminIdpUpdateRoute,
  type IdParams,
  type IdentityProviderPatch,
  type IdentityProviderRequest,
  type IdentityProviderTestResult,
  type IdentityProviderView,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { IdentityProvidersService } from './identity-providers.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class AdminIdpController {
  constructor(private readonly providers: IdentityProvidersService) {}

  @ApiRoute(adminIdpListRoute)
  list(@CurrentPrincipal() principal: Principal | null): Promise<IdentityProviderView[]> {
    return this.providers.list(required(principal));
  }

  @ApiRoute(adminIdpCreateRoute)
  create(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: IdentityProviderRequest): Promise<IdentityProviderView> {
    return this.providers.create(required(principal), body);
  }

  @ApiRoute(adminIdpUpdateRoute)
  update(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: IdentityProviderPatch,
  ): Promise<IdentityProviderView> {
    return this.providers.update(required(principal), params.id, body);
  }

  @ApiRoute(adminIdpTestRoute)
  test(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: IdParams): Promise<IdentityProviderTestResult> {
    return this.providers.test(required(principal), params.id);
  }
}
