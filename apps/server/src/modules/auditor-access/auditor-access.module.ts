import { Module, type OnModuleInit } from '@nestjs/common';
import { GuestModule } from '../identity/guest/guest.module';
import { JobsModule } from '../jobs/jobs.module';
import { TenantCleanupRegistry } from '../jobs/tenant-cleanup';
import { AuditorAccessController } from './auditor-access.controller';
import { AuditorAccessService } from './auditor-access.service';

/** Name of the `cleanup.expired` tenant step that closes expired grants (its count in the job's result). */
export const AUDITOR_GRANTS_EXPIRED_STEP = 'auditorGrantsExpired';

/**
 * External auditor grants and their time-boxed access (F.14, D-27, D-34; WP-26): grant, list and revoke routes of
 * a system. Imports `GuestModule` (identity/guest), which serves the guest sign-in routes and creates the guest
 * account of each grant. Registers the closing of expired grants (F.14 step 5) as a tenant step of the hourly
 * `cleanup.expired` job, so an expired grant revokes its guest sessions and disables the membership on time.
 */
@Module({
  imports: [GuestModule, JobsModule],
  controllers: [AuditorAccessController],
  providers: [AuditorAccessService],
  exports: [AuditorAccessService],
})
export class AuditorAccessModule implements OnModuleInit {
  constructor(
    private readonly cleanup: TenantCleanupRegistry,
    private readonly grants: AuditorAccessService,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({ name: AUDITOR_GRANTS_EXPIRED_STEP, run: (trx, orgId, now) => this.grants.closeExpired(trx, orgId, now) });
  }
}
