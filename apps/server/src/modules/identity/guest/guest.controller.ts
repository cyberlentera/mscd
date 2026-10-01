// Routes of D.3 "System, session and identity" owned by WP-26: the guest auditor access link, the returning
// guest's code request and the one-time code check (F.14). The guard has checked the Origin of these public routes
// (F.2), the per-address rate limits (F.3) and the request schemas; `verify` needs the guest binding cookie
// (`auth: 'guest_otp'`).
import { Controller, Req, Res } from '@nestjs/common';
import {
  authGuestLoginRoute,
  authGuestStartRoute,
  authGuestVerifyRoute,
  type GuestLoginRequest,
  type GuestStartRequest,
  type GuestStartResponse,
  type GuestVerifyRequest,
  type LoginResponse,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../../common/api-route';
import type { Principal } from '../../../common/tokens';
import { GuestAccessService } from './guest-access.service';

@Controller()
export class GuestController {
  constructor(private readonly guests: GuestAccessService) {}

  @ApiRoute(authGuestStartRoute)
  start(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('body') body: GuestStartRequest,
  ): Promise<GuestStartResponse> {
    return this.guests.start(request, reply, body.token);
  }

  @ApiRoute(authGuestLoginRoute)
  login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('body') body: GuestLoginRequest,
  ): Promise<GuestStartResponse> {
    return this.guests.login(request, reply, body.email);
  }

  @ApiRoute(authGuestVerifyRoute)
  verify(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('body') body: GuestVerifyRequest,
  ): Promise<LoginResponse> {
    return this.guests.verify(request, reply, principal, body.code);
  }
}
