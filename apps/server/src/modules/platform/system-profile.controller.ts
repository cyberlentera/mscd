import { Controller, Get } from '@nestjs/common';
import { MscdConfig } from '../../config/mscd-config';
import { buildSystemProfile, type SystemProfile } from './system-profile';

/** `GET /api/v1/system/profile` (public). Mounted only in run mode `api` (D.1: `/api/v1` is served by api only). */
@Controller('api/v1/system')
export class SystemProfileController {
  constructor(private readonly config: MscdConfig) {}

  @Get('profile')
  profile(): SystemProfile {
    return buildSystemProfile(this.config);
  }
}
