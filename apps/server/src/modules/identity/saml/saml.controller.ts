// Routes of D.3 "System, session and identity" owned by WP-19: SAML start (HTTP-Redirect binding), the assertion
// consumer service (HTTP-POST binding) and the SP metadata (F.9). The guard has checked the auth level and the request
// schemas; the ACS is exempt from the CSRF header (`csrfExempt`) and protected by the binding cookie, InResponseTo,
// the assertion id cache and the signature.
import { Controller, Req, Res } from '@nestjs/common';
import { authSamlAcsRoute, authSamlMetadataRoute, authSamlStartRoute, type ProviderParams, type SamlAcsBody, type SsoStartQuery } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, RouteInputParam } from '../../../common/api-route';
import { SessionService } from '../session.service';
import { SamlSignInService, type SamlRedirect } from './saml-sign-in.service';

@Controller()
export class SamlController {
  constructor(
    private readonly signIn: SamlSignInService,
    private readonly sessions: SessionService,
  ) {}

  @ApiRoute(authSamlStartRoute)
  async start(
    @Res() reply: FastifyReply,
    @RouteInputParam('params') params: ProviderParams,
    @RouteInputParam('query') query: SsoStartQuery,
  ): Promise<void> {
    await this.redirect(reply, await this.signIn.start(reply, params.slug, query));
  }

  @ApiRoute(authSamlAcsRoute)
  async acs(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @RouteInputParam('params') params: ProviderParams,
    @RouteInputParam('body') body: SamlAcsBody,
  ): Promise<void> {
    const outcome = await this.signIn.acs(request, params.slug, body);
    this.signIn.clearBindingCookie(reply);
    if (outcome.session) this.sessions.setCookie(reply, outcome.session);
    await this.redirect(reply, outcome);
  }

  @ApiRoute(authSamlMetadataRoute)
  async metadata(@Res() reply: FastifyReply, @RouteInputParam('params') params: ProviderParams): Promise<void> {
    const xml = await this.signIn.metadata(params.slug);
    await reply.code(200).type('application/samlmetadata+xml; charset=utf-8').send(xml);
  }

  private async redirect(reply: FastifyReply, outcome: SamlRedirect): Promise<void> {
    await reply.code(302).header('location', outcome.location).send();
  }
}
