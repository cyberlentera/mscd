// Routes of the per-screen read endpoints (build plan D.3 "Read model per screen", TS 9.2). All `GET`, permission
// `ms.read` (checked by the guard from the route definitions in `packages/shared/src/api/readmodel.ts`), texts in
// the language of `Accept-Language` (D.1).
import { Controller, Res } from '@nestjs/common';
import {
  readApplicabilityRoute, readAuditStagesRoute, readChainRoute, readCycleRoute, readDocumentsRoute, readDriftRoute, readEvidenceRoute,
  readGatesRoute, readImplementationSummaryRoute, readNextAuditEventRoute, readPendingRoute, readPhaseActivitiesRoute, readStageRecordsRoute,
  readSurveillanceEventRoute,
  type ActivityItem, type ApplicabilityItem, type ApplicabilityQuery, type ChainQuery, type ChainResponse, type CycleItem, type CycleQuery,
  type DocumentItem, type DocumentsQuery, type DriftPattern, type DriftQuery, type EvidenceItem, type EvidenceQuery, type GateItemView,
  type ImplementationSummary, type MsRecordParams, type NextAuditEvent, type Page, type PendingAggregate, type PendingPerson, type PendingQuery,
  type PendingRecord, type PhaseParams, type StageParams, type StageReadiness, type StageRecordsQuery, type SurveillanceEvent,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { ScreenReadService } from './screen-read.service';
import { languageOf, type Lang } from './texts';

type Headers = Record<string, string | string[] | undefined>;

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

function lang(headers: Headers | undefined): Lang {
  return languageOf(headers?.['accept-language']);
}

@Controller()
export class ReadModelApiController {
  constructor(private readonly screens: ScreenReadService) {}

  @ApiRoute(readImplementationSummaryRoute)
  summary(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('headers') headers: Headers,
  ): Promise<ImplementationSummary> {
    return this.screens.summary(required(principal), params.ms, lang(headers));
  }

  @ApiRoute(readApplicabilityRoute)
  applicability(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: ApplicabilityQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<Page<ApplicabilityItem>> {
    return this.screens.applicability(required(principal), params.ms, lang(headers), query);
  }

  @ApiRoute(readDocumentsRoute)
  documents(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: DocumentsQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<Page<DocumentItem>> {
    return this.screens.documents(required(principal), params.ms, lang(headers), query);
  }

  @ApiRoute(readGatesRoute)
  gates(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('headers') headers: Headers,
  ): Promise<GateItemView[]> {
    return this.screens.gates(required(principal), params.ms, lang(headers));
  }

  @ApiRoute(readPhaseActivitiesRoute)
  activities(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: PhaseParams,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<ActivityItem[]> {
    return this.screens.activities(required(principal), params.ms, lang(headers), params.n);
  }

  /** 204 without a body when the system has no planned audit event. */
  @ApiRoute(readNextAuditEventRoute)
  async nextEvent(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('headers') headers: Headers,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NextAuditEvent | undefined> {
    const event = await this.screens.nextEvent(required(principal), params.ms, lang(headers));
    if (event) return event;
    reply.status(204);
    return undefined;
  }

  @ApiRoute(readAuditStagesRoute)
  stages(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('headers') headers: Headers,
  ): Promise<StageReadiness[]> {
    return this.screens.stages(required(principal), params.ms, lang(headers));
  }

  @ApiRoute(readStageRecordsRoute)
  stageRecords(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: StageParams,
    @RouteInputParam('query') query: StageRecordsQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<Page<PendingRecord>> {
    return this.screens.stageRecords(required(principal), params.ms, lang(headers), params.key, query);
  }

  @ApiRoute(readChainRoute)
  chain(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: ChainQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<ChainResponse> {
    return this.screens.chain(required(principal), params.ms, lang(headers), query.anchor_id);
  }

  @ApiRoute(readPendingRoute)
  pending(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: PendingQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<PendingPerson[] | Page<PendingRecord> | PendingAggregate[]> {
    return this.screens.pending(required(principal), params.ms, lang(headers), query);
  }

  @ApiRoute(readSurveillanceEventRoute)
  event(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<SurveillanceEvent> {
    return this.screens.event(required(principal), params.ms, lang(headers), params.id);
  }

  @ApiRoute(readCycleRoute)
  cycle(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: CycleQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<CycleItem[]> {
    return this.screens.cycle(required(principal), params.ms, lang(headers), query.cycle_id);
  }

  @ApiRoute(readDriftRoute)
  drift(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: DriftQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<DriftPattern[]> {
    return this.screens.drift(required(principal), params.ms, lang(headers), query.rule);
  }

  @ApiRoute(readEvidenceRoute)
  evidence(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: EvidenceQuery,
    @RouteInputParam('headers') headers: Headers,
  ): Promise<Page<EvidenceItem>> {
    return this.screens.evidence(required(principal), params.ms, lang(headers), query);
  }
}
