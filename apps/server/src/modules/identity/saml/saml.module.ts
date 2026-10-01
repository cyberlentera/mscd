import { Module } from '@nestjs/common';
import { OidcModule } from '../oidc/oidc.module';
import { SamlController } from './saml.controller';
import { SamlSignInService } from './saml-sign-in.service';

/**
 * SAML 2.0 sign-in, invitation redemption and identity linking (F.9, D.3, WP-19). Builds on the identity module's
 * exported services (sessions, MFA, local sign-in helpers, mail) and imports `OidcModule` for `IdentityLinkRegistry`,
 * where `SamlSignInService` registers the starter of SAML links (`POST /me/identities/{slug}/link` is served by the
 * OIDC controller). The application loads it next to `OidcModule` (see README).
 */
@Module({
  imports: [OidcModule],
  controllers: [SamlController],
  providers: [SamlSignInService],
  exports: [SamlSignInService],
})
export class SamlModule {}
