// Routes of D.3 "System, session and identity" owned by WP-16: the login page's providers, OIDC start and callback
// (F.8), and the start of identity linking. The guard has checked the auth level, CSRF (the link route is a POST
// with a session) and the request schemas; handlers read the validated input.
import { Controller, Req, Res } from '@nestjs/common';
import {
  authOidcCallbackRoute,
  authOidcStartRoute,
  authProvidersRoute,
  meIdentityLinkRoute,
  type AuthProviders,
  type AuthProvidersQuery,
  type IdentityLinkStart,
  type OidcCallbackQuery,
  type ProviderParams,
  type SsoStartQuery,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, RouteInputParam } from '../../../common/api-route';
import { UnauthenticatedError } from '../../../common/problems';
import { SessionService } from '../session.service';
import { AuthProvidersService } from './auth-providers.service';
import { OidcSignInService, type OidcRedirect } from './oidc-sign-in.service';

@Controller()
export class OidcController {
  constructor(
    private readonly providers: AuthProvidersService,
    private readonly signIn: OidcSignInService,
    private readonly sessions: SessionService,
  ) {}

  @ApiRoute(authProvidersRoute)
  async listProviders(@RouteInputParam('query') query: AuthProvidersQuery): Promise<AuthProviders> {
    return this.providers.list(query);
  }

  @ApiRoute(authOidcStartRoute)
  async start(
    @Res() reply: FastifyReply,
    @RouteInputParam('params') params: ProviderParams,
    @RouteInputParam('query') query: SsoStartQuery,
  ): Promise<void> {
    await this.redirect(reply, await this.signIn.start(reply, params.slug, query));
  }

  @ApiRoute(authOidcCallbackRoute)
  async callback(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @RouteInputParam('params') params: ProviderParams,
    @RouteInputParam('query') query: OidcCallbackQuery,
  ): Promise<void> {
    const outcome = await this.signIn.callback(request, params.slug, query);
    this.signIn.clearBindingCookie(reply);
    if (outcome.session) this.sessions.setCookie(reply, outcome.session);
    await this.redirect(reply, outcome);
  }

  @ApiRoute(meIdentityLinkRoute)
  async link(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('params') params: ProviderParams,
  ): Promise<IdentityLinkStart> {
    const current = this.sessions.currentOf(request);
    if (!current) throw new UnauthenticatedError();
    return this.signIn.startLink(current, params.slug, reply);
  }

  private async redirect(reply: FastifyReply, outcome: OidcRedirect): Promise<void> {
    await reply.code(302).header('location', outcome.location).send();
  }
}
