import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { SESSION_RESOLVER } from '../../common/tokens';
import { AccountMailer } from './account-mailer';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GuestOtpResolverRegistry } from './guest-otp';
import { IdentityInfra } from './identity-infra';
import { InvitationService } from './invitation.service';
import { MfaService } from './mfa.service';
import { commonPasswords } from './password-policy';
import { PreferencesService } from './preferences.service';
import { IdentitySessionResolver } from './session-resolver';
import { SessionService } from './session.service';
import { SignInResponder } from './sign-in-responder';

/**
 * Local sign-in, sessions, CSRF, MFA, passwords, invitations and preferences (F.1 to F.5, WP-11), and the
 * `SESSION_RESOLVER` of the authorisation guard (F.7). Subfolders oidc/ (WP-16), saml/ (WP-19) and guest/ (WP-26)
 * build on the exported services: `SessionService` (create, rotate and revoke sessions, the cookie, the CSRF token of
 * a request), `MfaService` (second-factor checks, factor reset), `SignInResponder` (the `LoginResponse` of a new
 * session), `AccountMailer` (account and security emails), `InvitationService` (users with invitations),
 * `PreferencesService` (`Me.preferences`) and `GuestOtpResolverRegistry` (the guest one-time code caller).
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    IdentityInfra,
    SessionService,
    GuestOtpResolverRegistry,
    IdentitySessionResolver,
    { provide: SESSION_RESOLVER, useExisting: IdentitySessionResolver },
    AccountMailer,
    SignInResponder,
    MfaService,
    AuthService,
    InvitationService,
    PreferencesService,
  ],
  exports: [
    SESSION_RESOLVER,
    SessionService,
    GuestOtpResolverRegistry,
    AccountMailer,
    SignInResponder,
    MfaService,
    AuthService,
    InvitationService,
    PreferencesService,
  ],
})
export class IdentityModule implements OnModuleInit {
  onModuleInit(): void {
    // Fail at start, not at the first password change, when the image lacks the common password list (F.4).
    commonPasswords();
  }
}
