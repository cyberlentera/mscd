// `GET /me`, `PUT /me/org`, `POST /me/memberships/{org}/accept` and `POST /auth/demo/persona` (build plan D.3, WP-39).
import { Controller, Req, Res } from '@nestjs/common';
import {
  authDemoPersonaRoute,
  meAcceptMembershipRoute,
  meGetRoute,
  meSwitchOrgRoute,
  type DemoPersonaRequest,
  type Me,
  type SwitchOrgRequest,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { MeService } from './me.service';

@Controller()
export class MeController {
  constructor(private readonly me: MeService) {}

  @ApiRoute(meGetRoute)
  get(@Req() request: FastifyRequest, @CurrentPrincipal() principal: Principal): Promise<Me> {
    return this.me.get(request, principal);
  }

  @ApiRoute(meSwitchOrgRoute)
  switchOrganisation(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('body') body: SwitchOrgRequest,
  ): Promise<Me> {
    return this.me.switchOrganisation(request, reply, principal, body.org);
  }

  @ApiRoute(meAcceptMembershipRoute)
  acceptMembership(
    @Req() request: FastifyRequest,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { org: string },
  ): Promise<Me> {
    return this.me.acceptMembership(request, principal, params.org);
  }

  @ApiRoute(authDemoPersonaRoute)
  switchPersona(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('body') body: DemoPersonaRequest,
  ): Promise<Me> {
    return this.me.switchPersona(request, reply, principal, body.role);
  }
}
