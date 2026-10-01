import { Module } from '@nestjs/common';
import { OidcModule } from '../identity/oidc/oidc.module';
import { AdminIdpController } from './admin-idp.controller';
import { IdentityProvidersService } from './identity-providers.service';

/**
 * Administration of OIDC and SAML identity providers (D.3, F.8, F.9, WP-16): the organisation's providers, their
 * discovery test, sealed client secrets, JIT only with verified domains, and session revocation when a provider is
 * disabled. Imports `OidcModule`, which serves the OIDC sign-in routes in the same application (the identity module
 * of WP-11 does not list its subfolders).
 */
@Module({
  imports: [OidcModule],
  controllers: [AdminIdpController],
  providers: [IdentityProvidersService],
})
export class AdminIdpModule {}
