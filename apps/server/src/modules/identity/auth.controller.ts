// Routes of D.3 "System, session and identity" implemented by the identity module (WP-11): local sign-in, second
// factor, enrolment, logout, password reset and change, invitation acceptance and the user's preferences. The
// guard has already checked the session state of each route, the CSRF token or the Origin (F.2), the rate limits
// (F.3) and the request schema; handlers read the validated input.
import { Controller, Req, Res } from '@nestjs/common';
import {
  authInvitationAcceptRoute,
  authLoginRoute,
  authLogoutRoute,
  authMfaEnrolConfirmRoute,
  authMfaEnrolStartRoute,
  authMfaVerifyRoute,
  authPasswordChangeRoute,
  authPasswordResetRequestRoute,
  authPasswordResetRoute,
  mePreferencesRoute,
  type InvitationAcceptRequest,
  type LoginRequest,
  type LoginResponse,
  type MfaEnrolConfirmRequest,
  type MfaEnrolConfirmResponse,
  type MfaEnrolStartRequest,
  type MfaEnrolStartResponse,
  type MfaVerifyRequest,
  type PasswordChangeRequest,
  type PasswordResetConfirm,
  type PasswordResetRequest,
  type PreferencesBody,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import { AuthService } from './auth.service';
import { InvitationService } from './invitation.service';
import { MfaService } from './mfa.service';
import { PreferencesService } from './preferences.service';
import { SessionService, type CurrentSession } from './session.service';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly invitations: InvitationService,
    private readonly preferences: PreferencesService,
    private readonly sessions: SessionService,
  ) {}

  @ApiRoute(authLoginRoute)
  async login(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @RouteInputParam('body') body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(request, reply, body);
  }

  @ApiRoute(authMfaVerifyRoute)
  async verifyMfa(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @RouteInputParam('body') body: MfaVerifyRequest): Promise<LoginResponse> {
    return this.mfa.verify(this.current(request), reply, body);
  }

  @ApiRoute(authMfaEnrolStartRoute)
  async startEnrolment(@Req() request: FastifyRequest, @RouteInputParam('body') body: MfaEnrolStartRequest): Promise<MfaEnrolStartResponse> {
    return this.mfa.startEnrolment(this.current(request), body);
  }

  @ApiRoute(authMfaEnrolConfirmRoute)
  async confirmEnrolment(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('body') body: MfaEnrolConfirmRequest,
  ): Promise<MfaEnrolConfirmResponse> {
    return this.mfa.confirmEnrolment(this.current(request), reply, body.code);
  }

  @ApiRoute(authLogoutRoute)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(this.current(request), reply);
  }

  @ApiRoute(authPasswordResetRequestRoute)
  async requestPasswordReset(@RouteInputParam('body') body: PasswordResetRequest): Promise<void> {
    await this.auth.requestPasswordReset(body);
  }

  @ApiRoute(authPasswordResetRoute)
  async resetPassword(@RouteInputParam('body') body: PasswordResetConfirm): Promise<void> {
    await this.auth.resetPassword(body);
  }

  @ApiRoute(authPasswordChangeRoute)
  async changePassword(@Req() request: FastifyRequest, @RouteInputParam('body') body: PasswordChangeRequest): Promise<void> {
    await this.auth.changePassword(this.current(request), body);
  }

  @ApiRoute(authInvitationAcceptRoute)
  async acceptInvitation(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('body') body: InvitationAcceptRequest,
  ): Promise<LoginResponse> {
    return this.invitations.accept(request, reply, body);
  }

  @ApiRoute(mePreferencesRoute)
  async putPreferences(@Req() request: FastifyRequest, @RouteInputParam('body') body: PreferencesBody): Promise<void> {
    await this.preferences.put(this.current(request).row.user_id, body);
  }

  /** The session the resolver found; routes with a session auth level always have one. */
  private current(request: FastifyRequest): CurrentSession {
    const current = this.sessions.currentOf(request);
    if (!current) throw new UnauthenticatedError();
    return current;
  }
}
