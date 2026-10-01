import { Module } from '@nestjs/common';
import { AuthProvidersService } from './auth-providers.service';
import { OidcDiscovery } from './discovery';
import { IdentityLinkRegistry } from './identity-link.registry';
import { OidcController } from './oidc.controller';
import { OidcSignInService } from './oidc-sign-in.service';

/**
 * OIDC sign-in, identity linking and the login page's provider list (F.8, D.3, WP-16). Builds on the identity
 * module's exported services (sessions, MFA, local sign-in helpers, mail). Loaded through `AdminIdpModule`, which
 * also uses `OidcDiscovery` for its discovery test. Exports `IdentityLinkRegistry`, where the SAML module (WP-19)
 * registers its link starter.
 */
@Module({
  controllers: [OidcController],
  providers: [OidcDiscovery, IdentityLinkRegistry, OidcSignInService, AuthProvidersService],
  exports: [OidcDiscovery, IdentityLinkRegistry],
})
export class OidcModule {}
