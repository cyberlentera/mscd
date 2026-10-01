// The user, organisation policy and role grant routes of D.3 "Administration" owned by WP-39.
import { Controller, Req, Res } from '@nestjs/common';
import {
  adminOrganizationUpdateRoute,
  adminRolesApproveRoute,
  adminRolesGrantRoute,
  adminRolesRejectRoute,
  adminRolesRevokeRoute,
  adminUsersCreateRoute,
  adminUsersListRoute,
  adminUsersRegisterIdentityRoute,
  adminUsersResetMfaRoute,
  adminUsersUpdateRoute,
  type CommandResult,
  type OrgPolicyPatch,
  type Page,
  type RoleGrant,
  type RoleGrantResult,
  type UserCreate,
  type UserIdentityRegistration,
  type UserListQuery,
  type UserPatch,
  type UserView,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { AuthzState, Principal } from '../../common/tokens';
import { OrganizationService } from './organization.service';
import { RoleGrantsService } from './role-grants.service';
import { UsersService } from './users.service';

@Controller()
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly organization: OrganizationService,
    private readonly grants: RoleGrantsService,
  ) {}

  @ApiRoute(adminUsersListRoute)
  list(@CurrentPrincipal() principal: Principal, @RouteInputParam('query') query: UserListQuery): Promise<Page<UserView>> {
    return this.users.list(principal, query);
  }

  @ApiRoute(adminUsersCreateRoute)
  create(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: UserCreate): Promise<{ status: 'invited' }> {
    return this.users.create(principal, body);
  }

  @ApiRoute(adminUsersUpdateRoute)
  update(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string },
    @RouteInputParam('body') body: UserPatch,
  ): Promise<UserView> {
    return this.users.update(request, reply, principal, params.id, body);
  }

  @ApiRoute(adminUsersResetMfaRoute)
  resetMfa(@CurrentPrincipal() principal: Principal, @CurrentAuthz() authz: AuthzState, @RouteInputParam('params') params: { id: string }): Promise<void> {
    return this.users.resetMfa(principal, authz, params.id);
  }

  @ApiRoute(adminUsersRegisterIdentityRoute)
  async registerIdentity(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string },
    @RouteInputParam('body') body: UserIdentityRegistration,
  ): Promise<CommandResult> {
    await this.users.registerIdentity(principal, params.id, body);
    return { ok: true, changed: [] };
  }

  @ApiRoute(adminOrganizationUpdateRoute)
  updateOrganization(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: OrgPolicyPatch): Promise<void> {
    return this.organization.update(principal, body);
  }

  @ApiRoute(adminRolesGrantRoute)
  grant(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string },
    @RouteInputParam('body') body: RoleGrant,
  ): Promise<RoleGrantResult> {
    return this.grants.grant(principal, params.id, body);
  }

  @ApiRoute(adminRolesApproveRoute)
  approve(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { id: string; roleId: string }): Promise<CommandResult> {
    return this.grants.decide(principal, params.id, params.roleId, 'active');
  }

  @ApiRoute(adminRolesRejectRoute)
  reject(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { id: string; roleId: string }): Promise<CommandResult> {
    return this.grants.decide(principal, params.id, params.roleId, 'rejected');
  }

  @ApiRoute(adminRolesRevokeRoute)
  revoke(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string; roleId: string },
  ): Promise<void> {
    return this.grants.revoke(request, reply, principal, params.id, params.roleId);
  }
}
