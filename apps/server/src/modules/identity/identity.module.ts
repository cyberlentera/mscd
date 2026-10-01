import { Global, Module } from '@nestjs/common';
import { SESSION_RESOLVER } from '../../common/tokens';
import { NoSessionResolver } from './defaults';

/**
 * Local sign-in, sessions, CSRF, MFA, passwords, invitations and the demo persona; subfolders oidc/, saml/ and
 * guest/ (F.1 to F.5, F.8, F.9, F.14). Built by WP-11; until then `SESSION_RESOLVER` authenticates nobody (WP-08).
 */
@Global()
@Module({
  providers: [{ provide: SESSION_RESOLVER, useClass: NoSessionResolver }],
  exports: [SESSION_RESOLVER],
})
export class IdentityModule {}
