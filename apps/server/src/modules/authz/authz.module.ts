import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MEMBERSHIP_SERVICE, ME_ASSEMBLER, PERMISSION_EVALUATOR, RECORD_RESOLVER, SCOPE_POLICY } from '../../common/tokens';
import { AuthzGuard } from './authz.guard';
import {
  DenyAllPermissionEvaluator,
  MinimalMeAssembler,
  PassThroughScopePolicy,
  TenantMembershipService,
  TenantRecordResolver,
} from './defaults';

/**
 * AuthzGuard, role resolution, ScopePolicy, RecordResolver and MembershipService (F.6, F.7). WP-08 registers the
 * global guard and the default providers (deny-all permission evaluator, pass-through scope policy that refuses
 * owner-scoped and external auditor reads, record resolver and membership service without roles, minimal Me);
 * WP-39 replaces them inside this folder.
 */
@Global()
@Module({
  providers: [
    { provide: PERMISSION_EVALUATOR, useClass: DenyAllPermissionEvaluator },
    { provide: SCOPE_POLICY, useClass: PassThroughScopePolicy },
    { provide: RECORD_RESOLVER, useClass: TenantRecordResolver },
    { provide: MEMBERSHIP_SERVICE, useClass: TenantMembershipService },
    { provide: ME_ASSEMBLER, useClass: MinimalMeAssembler },
    { provide: APP_GUARD, useClass: AuthzGuard },
  ],
  exports: [PERMISSION_EVALUATOR, SCOPE_POLICY, RECORD_RESOLVER, MEMBERSHIP_SERVICE, ME_ASSEMBLER],
})
export class AuthzModule {}
