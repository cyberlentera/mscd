import { Module } from '@nestjs/common';
import { GuestModule } from '../identity/guest/guest.module';
import { AuditorAccessController } from './auditor-access.controller';
import { AuditorAccessService } from './auditor-access.service';

/**
 * External auditor grants and their time-boxed access (F.14, D-27, D-34; WP-26): grant, list and revoke routes of
 * a system. Imports `GuestModule` (identity/guest), which serves the guest sign-in routes and creates the guest
 * account of each grant.
 */
@Module({
  imports: [GuestModule],
  controllers: [AuditorAccessController],
  providers: [AuditorAccessService],
  exports: [AuditorAccessService],
})
export class AuditorAccessModule {}
