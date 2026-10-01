import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ReadinessService, type ReadinessReport } from './readiness.service';

/** Liveness and readiness on the service port, outside `/api` (D.3 "Health and metrics"). */
@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** The process is alive. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** 200 when every registered readiness check passes, else 503 with the failing checks. */
  @Get('readyz')
  async readyz(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.readiness.evaluate();
    reply.status(report.status === 'ready' ? 200 : 503);
    return report;
  }
}
