// `POST /test/reset` and `POST /test/session` (build plan D.3 "Test support", WP-27). Test-only routes: the
// authorisation guard answers 404 unless the profile enables them, logs every call at warn, and checks the Origin of
// these public POST routes (F.2).
import { Controller, Req, Res } from '@nestjs/common';
import { testResetRoute, testSessionRoute, type Me, type TestResetResponse, type TestSessionRequest } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, RouteInputParam } from '../../common/api-route';
import { TestSupportService } from './test-support.service';

@Controller()
export class TestSupportController {
  constructor(private readonly testSupport: TestSupportService) {}

  @ApiRoute(testResetRoute)
  reset(): Promise<TestResetResponse> {
    return this.testSupport.reset();
  }

  @ApiRoute(testSessionRoute)
  session(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('body') body: TestSessionRequest,
  ): Promise<Me> {
    return this.testSupport.session(request, reply, body);
  }
}
