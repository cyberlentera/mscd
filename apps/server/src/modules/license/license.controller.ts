// `GET /license` and `PUT /admin/license` (build plan D.3, D-15, D-32).
import { Controller } from '@nestjs/common';
import { licenseGetRoute, licensePutRoute, type LicenceInstallRequest, type LicenceView } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { LicenceService } from './licence.service';

@Controller()
export class LicenseController {
  constructor(private readonly licences: LicenceService) {}

  /** The licence of the caller's organisation with its derived state and usage (404 when none is installed). */
  @ApiRoute(licenseGetRoute)
  get(@CurrentPrincipal() principal: Principal): Promise<LicenceView> {
    return this.licences.viewForPrincipal(principal);
  }

  /** Verifies and installs a signed licence; allowed in read-only mode (D.1). */
  @ApiRoute(licensePutRoute)
  put(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: LicenceInstallRequest): Promise<LicenceView> {
    return this.licences.install(principal, body);
  }
}
