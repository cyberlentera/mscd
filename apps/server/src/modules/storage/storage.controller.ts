// The storage administration routes of D.3 (WP-13): repositories, credentials, connection test, repository OAuth
// consent and callback, move requests, routing rules with approval, and the storage object metadata list.
import { Controller, Req, Res } from '@nestjs/common';
import {
  repositoriesCreateRoute,
  repositoriesCredentialsRoute,
  repositoriesListRoute,
  repositoriesMoveRequestRoute,
  repositoriesOauthCallbackRoute,
  repositoriesReauthorizeRoute,
  repositoriesTestRoute,
  repositoriesUpdateRoute,
  routingRulesApproveRoute,
  routingRulesCreateRoute,
  routingRulesListRoute,
  routingRulesRejectRoute,
  routingRulesUpdateRoute,
  storageObjectsListRoute,
  type CommandResult,
  type IdParams,
  type MoveRequest,
  type OAuthCallbackQuery,
  type Page,
  type RepositoryCreate,
  type RepositoryCredential,
  type RepositoryPatch,
  type RepositoryView,
  type RoutingRulePatch,
  type RoutingRuleRequest,
  type RoutingRuleView,
  type StorageObjectListQuery,
  type StorageObjectMeta,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { REPO_OAUTH_COOKIE, REPO_OAUTH_COOKIE_PATH, REPO_OAUTH_TTL_SECONDS } from './repo-oauth';
import { RepositoriesService } from './repositories.service';
import { RoutingService } from './routing.service';

@Controller()
export class StorageController {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly routing: RoutingService,
    private readonly config: MscdConfig,
  ) {}

  @ApiRoute(repositoriesListRoute)
  list(@CurrentPrincipal() principal: Principal): Promise<RepositoryView[]> {
    return this.repositories.list(principal);
  }

  @ApiRoute(repositoriesCreateRoute)
  create(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: RepositoryCreate): Promise<RepositoryView> {
    return this.repositories.create(principal, body);
  }

  @ApiRoute(repositoriesUpdateRoute)
  update(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: RepositoryPatch,
  ): Promise<RepositoryView> {
    return this.repositories.update(principal, params.id, body);
  }

  @ApiRoute(repositoriesCredentialsRoute)
  async credentials(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: RepositoryCredential,
  ): Promise<undefined> {
    await this.repositories.setCredential(principal, params.id, body);
    return undefined;
  }

  @ApiRoute(repositoriesTestRoute)
  test(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams): Promise<CommandResult> {
    return this.repositories.test(principal, params.id);
  }

  @ApiRoute(repositoriesReauthorizeRoute)
  async reauthorize(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CommandResult> {
    const { result, bindingCookie } = await this.repositories.reauthorize(principal, params.id);
    reply.setCookie(REPO_OAUTH_COOKIE, bindingCookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.profile.security.cookie_secure,
      path: REPO_OAUTH_COOKIE_PATH,
      maxAge: REPO_OAUTH_TTL_SECONDS,
    });
    return result;
  }

  @ApiRoute(repositoriesOauthCallbackRoute)
  async oauthCallback(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('query') query: OAuthCallbackQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const outcome = await this.repositories.oauthCallback(principal, query, request.cookies?.[REPO_OAUTH_COOKIE]);
    reply.clearCookie(REPO_OAUTH_COOKIE, { path: REPO_OAUTH_COOKIE_PATH });
    await reply.code(302).header('location', outcome.location).send();
  }

  @ApiRoute(repositoriesMoveRequestRoute)
  moveRequest(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: MoveRequest,
  ): Promise<CommandResult> {
    return this.repositories.moveRequest(principal, params.id, body);
  }

  @ApiRoute(routingRulesListRoute)
  routingRules(@CurrentPrincipal() principal: Principal): Promise<RoutingRuleView[]> {
    return this.routing.list(principal);
  }

  @ApiRoute(routingRulesCreateRoute)
  createRoutingRule(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: RoutingRuleRequest): Promise<CommandResult> {
    return this.routing.create(principal, body);
  }

  @ApiRoute(routingRulesUpdateRoute)
  updateRoutingRule(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: RoutingRulePatch,
  ): Promise<CommandResult> {
    return this.routing.update(principal, params.id, body);
  }

  @ApiRoute(routingRulesApproveRoute)
  approveRoutingRule(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams): Promise<CommandResult> {
    return this.routing.approve(principal, params.id);
  }

  @ApiRoute(routingRulesRejectRoute)
  rejectRoutingRule(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams): Promise<CommandResult> {
    return this.routing.reject(principal, params.id);
  }

  @ApiRoute(storageObjectsListRoute)
  objects(@CurrentPrincipal() principal: Principal, @RouteInputParam('query') query: StorageObjectListQuery): Promise<Page<StorageObjectMeta>> {
    return this.repositories.objects(principal, query);
  }
}
