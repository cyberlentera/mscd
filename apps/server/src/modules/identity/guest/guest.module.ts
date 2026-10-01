import { Module, type OnModuleInit } from '@nestjs/common';
import { GuestOtpResolverRegistry } from '../guest-otp';
import { GuestAccessService } from './guest-access.service';
import { GuestAccountService } from './guest-accounts.service';
import { GuestController } from './guest.controller';

/**
 * Guest auditor sign-in (F.14, D-27, WP-26): the access link, the emailed one-time code and its binding cookie,
 * guest sessions pinned to the grant, and the guest accounts of grants (`GuestAccountService`, used by the auditor
 * access module). Builds on the identity module's exported services; registers the resolver of the guest binding
 * cookie with `GuestOtpResolverRegistry` at start. Loaded by `AuditorAccessModule`.
 */
@Module({
  controllers: [GuestController],
  providers: [GuestAccessService, GuestAccountService],
  exports: [GuestAccountService],
})
export class GuestModule implements OnModuleInit {
  constructor(
    private readonly registry: GuestOtpResolverRegistry,
    private readonly guests: GuestAccessService,
  ) {}

  onModuleInit(): void {
    this.registry.register({ resolve: (request) => this.guests.resolve(request) });
  }
}
