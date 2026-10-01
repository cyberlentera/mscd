// Routes of D.3 "Page actions" owned by WP-24: exports and the review calendar feed (E.2, F.13, F.15).
import { Controller, Req, Res } from '@nestjs/common';
import {
  calendarFeedCreateRoute,
  calendarFeedIcsRoute,
  calendarFeedRevokeRoute,
  exportsCreateRoute,
  exportsDocumentsRoute,
  exportsDownloadRoute,
  exportsGetRoute,
  exportsSoaRoute,
  type BackgroundTask,
  type CalendarFeed,
  type CalendarFeedQuery,
  type CommandResult,
  type ExportRequest,
  type MsParams,
  type SheetExportQuery,
  type TaskIdParams,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { CalendarFeedService } from './calendar-feed.service';
import type { Lang } from './export-content.service';
import { ExportsService } from './exports.service';

/** The response language of D.1: `id` when `Accept-Language` prefers Indonesian, else English. */
export function languageOf(request: FastifyRequest): Lang {
  const header = String(request.headers['accept-language'] ?? '');
  const tags = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((t) => t.tag !== '' && Number.isFinite(t.q) && t.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const t of tags) {
    const primary = t.tag.split('-')[0];
    if (primary === 'id' || primary === 'en') return primary;
  }
  return 'en';
}

@Controller()
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly calendar: CalendarFeedService,
  ) {}

  @ApiRoute(exportsCreateRoute)
  create(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: ExportRequest): Promise<CommandResult> {
    return this.exports.request(principal, body);
  }

  @ApiRoute(exportsGetRoute)
  get(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: TaskIdParams): Promise<BackgroundTask> {
    return this.exports.get(principal, params.taskId);
  }

  @ApiRoute(exportsDownloadRoute)
  async download(@Res() reply: FastifyReply, @CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: TaskIdParams): Promise<void> {
    await this.exports.download(reply, principal, params.taskId);
  }

  @ApiRoute(exportsSoaRoute)
  async soa(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: SheetExportQuery,
  ): Promise<void> {
    await this.exports.sheet(reply, principal, 'soa', params.ms, query.format, languageOf(request));
  }

  @ApiRoute(exportsDocumentsRoute)
  async documents(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: SheetExportQuery,
  ): Promise<void> {
    await this.exports.sheet(reply, principal, 'document_register', params.ms, query.format, languageOf(request));
  }

  @ApiRoute(calendarFeedCreateRoute)
  createFeed(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsParams): Promise<CalendarFeed> {
    return this.calendar.create(principal, params.ms);
  }

  @ApiRoute(calendarFeedRevokeRoute)
  revokeFeed(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsParams): Promise<CommandResult> {
    return this.calendar.revoke(principal, params.ms);
  }

  @ApiRoute(calendarFeedIcsRoute)
  async feed(@Res() reply: FastifyReply, @RouteInputParam('params') params: MsParams, @RouteInputParam('query') query: CalendarFeedQuery): Promise<void> {
    await this.calendar.feed(reply, params.ms, query.token);
  }
}
