import { Controller } from '@nestjs/common';
import { systemProfileRoute, type SystemProfile } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { MscdConfig } from '../../config/mscd-config';
import { buildSystemProfile } from './system-profile';

/** `GET /api/v1/system/profile` (public), mounted from the shared route definition in run mode `api` only (D.1). */
@Controller()
export class SystemProfileController {
  constructor(private readonly config: MscdConfig) {}

  @ApiRoute(systemProfileRoute)
  profile(): SystemProfile {
    return buildSystemProfile(this.config);
  }
}
