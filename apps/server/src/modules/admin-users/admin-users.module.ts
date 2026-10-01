import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { OrganizationService } from './organization.service';
import { RoleGrantsService } from './role-grants.service';
import { UsersService } from './users.service';

/**
 * Users, memberships, identity pre-registration, the organisation's local sign-in policy and role grants with the
 * four-eyes approval flow (F.6, C.13, D-25, WP-39). Uses the global identity services (invitations, sessions, MFA
 * reset, mail), the authorisation services (`RoleResolver`, `MembershipDirectory`, `MEMBERSHIP_SERVICE`), tenancy,
 * audit, notifications and the licence gate.
 */
@Module({
  controllers: [AdminUsersController],
  providers: [UsersService, OrganizationService, RoleGrantsService],
})
export class AdminUsersModule {}
