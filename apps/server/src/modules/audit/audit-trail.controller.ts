// The four `/admin/audit-trail` routes (build plan D.3, F.11, F.15).
import { Controller, Res } from '@nestjs/common';
import {
  auditTrailAnchorsRoute,
  auditTrailExportRoute,
  auditTrailListRoute,
  auditTrailVerifyRoute,
  type AuditAnchorsQuery,
  type AuditChainVerifyResult,
  type AuditTrailExportQuery,
  type AuditTrailQuery,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { FileResponder } from '../../common/file-response';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/problems';
import { Clock } from '../../common/clock';
import type { AuthzState, Principal } from '../../common/tokens';
import { AuditTrailService, type Page } from './audit-trail.service';
import { AuditChainVerifier } from './chain-verifier';

function orgOf(principal: Principal | null): NonNullable<Principal['org']> {
  if (!principal?.org) throw new NotFoundError('No current organisation');
  return principal.org;
}

@Controller()
export class AuditTrailController {
  constructor(
    private readonly trail: AuditTrailService,
    private readonly verifier: AuditChainVerifier,
    private readonly files: FileResponder,
    private readonly clock: Clock,
  ) {}

  /** Full entries of a system with `audit_trail.read` there; metadata with `audit_trail.metadata.read`. */
  @ApiRoute(auditTrailListRoute)
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState,
    @RouteInputParam('query') query: AuditTrailQuery,
  ): Promise<Page<unknown>> {
    const full = query.ms !== undefined && authz.ms === query.ms && authz.granted.has('audit_trail.read');
    if (!full && !authz.granted.has('audit_trail.metadata.read')) {
      if (query.ms === undefined) throw new ValidationError([{ path: 'query.ms', message: 'Name the management system whose audit trail to read' }]);
      throw new ForbiddenError();
    }
    return this.trail.list(principal, query, full);
  }

  /** Every entry of a system as formula-safe CSV, through the file responder (F.13, F.15). */
  @ApiRoute(auditTrailExportRoute)
  async export(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('query') query: AuditTrailExportQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const org = orgOf(principal);
    const today = this.clock.todayIn(org.timeZone);
    const fileName = `audit-trail-${org.slug}-${query.ms}-${today}.csv`;
    await this.files.send(reply, {
      body: this.trail.exportCsv(principal, query.ms),
      storedType: 'text/csv',
      fileName,
      audit: {
        action: 'file.downloaded',
        msSlug: query.ms,
        entityType: 'audit_trail',
        entityCode: fileName.slice(0, 80),
        after: { ms: query.ms, format: 'csv' },
      },
    });
  }

  /** Verification of the organisation's chain and of the platform chain, with their newest anchors (F.11). */
  @ApiRoute(auditTrailVerifyRoute)
  async verify(@CurrentPrincipal() principal: Principal): Promise<AuditChainVerifyResult[]> {
    const org = orgOf(principal);
    return this.verifier.verifyForOrganisation({ orgId: org.id, schema: org.schema });
  }

  /** Signed anchors as NDJSON, verifiable offline with `audit-anchor.pub` (D-33). */
  @ApiRoute(auditTrailAnchorsRoute)
  async anchors(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('query') query: AuditAnchorsQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const anchors = await this.trail.anchors(principal, query.from, query.to);
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    return anchors.map((anchor) => JSON.stringify(anchor)).join('\n') + (anchors.length > 0 ? '\n' : '');
  }
}
