// `GET /admin/packs`, `POST /admin/packs/import` and `POST /admin/packs/check-updates` (build plan D.3, E.8, D-17).
import { Controller, Req } from '@nestjs/common';
import {
  packsCheckUpdatesRoute,
  packsImportRoute,
  packsListRoute,
  type CheckUpdatesResult,
  type CommandResult,
  type PackSummary,
} from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, StreamedIdempotencyParam } from '../../common/api-route';
import type { StreamedIdempotency } from '../../common/route-state';
import type { Principal } from '../../common/tokens';
import { PacksService } from './packs.service';

@Controller()
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  @ApiRoute(packsListRoute)
  list(@CurrentPrincipal() principal: Principal): Promise<PackSummary[]> {
    return this.packs.list(principal);
  }

  /** Multipart upload: the handler claims the idempotency key with a digest of the bundle and the form fields. */
  @ApiRoute(packsImportRoute)
  import(
    @Req() request: FastifyRequest,
    @CurrentPrincipal() principal: Principal,
    @StreamedIdempotencyParam() idempotency: StreamedIdempotency,
  ): Promise<CommandResult> {
    return this.packs.import(request, principal, idempotency);
  }

  @ApiRoute(packsCheckUpdatesRoute)
  checkUpdates(@CurrentPrincipal() principal: Principal): Promise<CheckUpdatesResult> {
    return this.packs.checkUpdates(principal);
  }
}
