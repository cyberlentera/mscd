// Routes of D.3 "Evidence packs, auditor access" owned by WP-26 for evidence packs (E.7, D-34, F.13).
import { Controller, Req, Res } from '@nestjs/common';
import {
  evidencePacksBuildRoute,
  evidencePacksDownloadRoute,
  evidencePacksGetRoute,
  evidencePacksListRoute,
  type CommandResult,
  type EvidencePackDownloadQuery,
  type EvidencePackRequest,
  type EvidencePackView,
  type MsParams,
  type MsRecordParams,
  type Page,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { EvidencePacksService } from './evidence-packs.service';

@Controller()
export class EvidencePacksController {
  constructor(private readonly packs: EvidencePacksService) {}

  @ApiRoute(evidencePacksBuildRoute)
  build(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: EvidencePackRequest,
  ): Promise<CommandResult> {
    return this.packs.request(principal, params.ms, body);
  }

  @ApiRoute(evidencePacksListRoute)
  list(
    @Req() request: FastifyRequest,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: { page: number; pageSize: number },
  ): Promise<Page<EvidencePackView>> {
    return this.packs.list(request, principal, params.ms, query);
  }

  @ApiRoute(evidencePacksGetRoute)
  get(@Req() request: FastifyRequest, @CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<EvidencePackView> {
    return this.packs.get(request, principal, params.ms, params.id);
  }

  @ApiRoute(evidencePacksDownloadRoute)
  async download(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('query') query: EvidencePackDownloadQuery,
  ): Promise<void> {
    await this.packs.download(request, reply, principal, params.ms, params.id, query);
  }
}
