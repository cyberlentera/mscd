// Operations routes of the platform operator (D.3 "Operations", WP-34). Every route needs a platform permission
// (`ops.read` or `ops.jobs.run`), which only the `platform_operator` role grants (F.6).
import { Controller, Inject, Res } from '@nestjs/common';
import {
  opsDiagnosticsRoute,
  opsHealthRoute,
  opsJobRunRoute,
  opsQueuesRoute,
  type JobRunParams,
  type JobRunRequest,
  type JobRunResponse,
  type OpsHealth,
  type QueueStats,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { FILE_CONTENT_SECURITY_POLICY, contentDisposition } from '../../common/file-response';
import { UnauthenticatedError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { DiagnosticsService } from './diagnostics.service';
import { OpsService } from './ops.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly diagnostics: DiagnosticsService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  @ApiRoute(opsHealthRoute)
  health(): Promise<OpsHealth> {
    return this.ops.health();
  }

  @ApiRoute(opsQueuesRoute)
  queues(): Promise<QueueStats[]> {
    return this.ops.queues();
  }

  @ApiRoute(opsJobRunRoute)
  run(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: JobRunParams,
    @RouteInputParam('body') body: JobRunRequest,
  ): Promise<JobRunResponse> {
    return this.ops.runJob(required(principal), params.name, body);
  }

  /**
   * The archive is audited (`ops.diagnostics_exported`, platform chain) before the bytes are sent, and sent as an
   * attachment with the sandbox policy of file responses (F.13).
   */
  @ApiRoute(opsDiagnosticsRoute)
  async export(@CurrentPrincipal() principal: Principal | null, @Res() reply: FastifyReply): Promise<void> {
    const operator = required(principal);
    const archive = await this.diagnostics.build();
    await this.audit.recordDetached({
      action: 'ops.diagnostics_exported',
      actor: { userId: operator.user.id, kind: 'operator' },
      organizationId: null,
      entityType: 'diagnostics',
      entityCode: archive.fileName.slice(0, 80),
      after: { fileName: archive.fileName, sha256: archive.sha256, bytes: archive.data.length, files: archive.files.length, logLines: archive.logLines },
    });
    reply.headers({
      'content-type': 'application/gzip',
      'content-disposition': contentDisposition(archive.fileName),
      'content-length': String(archive.data.length),
      'content-security-policy': FILE_CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    await reply.status(200).send(archive.data);
  }
}
