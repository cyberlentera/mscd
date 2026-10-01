import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MEMBERSHIP_SERVICE, ME_ASSEMBLER, PERMISSION_EVALUATOR, RECORD_RESOLVER, SCOPE_POLICY } from '../../common/tokens';
import { AuditorReadInterceptor } from './auditor-read';
import { AuthzGuard } from './authz.guard';
import { AuthzInfra } from './authz-infra';
import { MeAssemblerService } from './me-assembler';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { MembershipDirectory } from './membership-directory';
import { TenantMembershipService } from './membership.service';
import { RolePermissionEvaluator } from './permission-evaluator';
import { TenantRecordResolver } from './record-resolver';
import { RoleResolver } from './role-resolver';
import { ScopePolicyService } from './scope-policy';

/**
 * Authorisation (F.6, F.7, WP-39): the global `AuthzGuard`, role resolution, the role-based `PERMISSION_EVALUATOR`,
 * `SCOPE_POLICY` (owner scoping, classification, the external auditor projection), `RECORD_RESOLVER`,
 * `MEMBERSHIP_SERVICE`, `ME_ASSEMBLER`, the `auditor.read` interceptor, and the routes of the session user
 * (`GET /me`, `PUT /me/org`, membership acceptance, demo persona switch).
 *
 * Exported service classes for other modules: `RoleResolver` (roles of a principal, cached per request),
 * `MembershipDirectory` (whether a user has an active membership elsewhere, F.6) and
 * `ScopePolicyService` (the `SCOPE_POLICY` implementation with `scopeContext`, `filterRecords`, `projectSnapshot`,
 * `orgScopeContext`, `filterOrgSnapshot` and `canReadObjectIn` for the readers of WP-17, WP-21, WP-26 and WP-32).
 */
@Global()
@Module({
  controllers: [MeController],
  providers: [
    AuthzInfra,
    RoleResolver,
    RolePermissionEvaluator,
    ScopePolicyService,
    MeAssemblerService,
    MeService,
    MembershipDirectory,
    { provide: PERMISSION_EVALUATOR, useExisting: RolePermissionEvaluator },
    { provide: SCOPE_POLICY, useExisting: ScopePolicyService },
    { provide: RECORD_RESOLVER, useClass: TenantRecordResolver },
    { provide: MEMBERSHIP_SERVICE, useClass: TenantMembershipService },
    { provide: ME_ASSEMBLER, useExisting: MeAssemblerService },
    { provide: APP_GUARD, useClass: AuthzGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditorReadInterceptor },
  ],
  exports: [PERMISSION_EVALUATOR, SCOPE_POLICY, RECORD_RESOLVER, MEMBERSHIP_SERVICE, ME_ASSEMBLER, RoleResolver, ScopePolicyService, MembershipDirectory],
})
export class AuthzModule {}
