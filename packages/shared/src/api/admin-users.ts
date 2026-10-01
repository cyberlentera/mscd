// Area `admin-users` (owner from wave 6: WP-39): members of the organisation, identity pre-registration, the local
// sign-in policy, and role grants with the four-eyes approval flow (D.2, D.3 "Administration", F.6 Tenant Admin
// limits, C.13 `user_ms_role.approval_status`).
import { z } from 'zod';
import {
  AccountStatus, ApprovalStatus, BusinessRole, LocalLoginPolicy, MembershipStatus, OrgRole, UserKind,
} from '../enums.js';
import {
  CommandResult, Handle, IdParams, Instant, MsId, NoBody, ProviderSlug, Uuid, commandResultWith, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

const EXAMPLE_USER_VIEW = {
  id: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a', handle: 'bagus', email: 'bagus.prasetyo@nusantaradigital.co.id', displayName: 'Bagus Prasetyo',
  jobTitle: 'IT Infrastructure Lead', kind: 'person', accountStatus: 'active', membershipStatus: 'active', adminRoles: [],
  roles: [{ grantId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', ms: 'isms', role: 'domain_owner', isPrimary: false, approvalStatus: 'active', validUntil: null }],
  mfaEnrolled: true, otherMemberships: true, lastLoginAt: '2026-09-28T02:15:00Z',
} as const;

export const UserRoleGrantView = named(
  'UserRoleGrantView',
  z.object({ grantId: Uuid, ms: MsId, role: BusinessRole, isPrimary: z.boolean(), approvalStatus: ApprovalStatus, validUntil: Instant.nullable() }),
  'One role grant of a member (user_ms_role)',
  { valid: [EXAMPLE_USER_VIEW.roles[0]], invalid: [{ ...EXAMPLE_USER_VIEW.roles[0], role: 'manager' }] },
);
export type UserRoleGrantView = z.infer<typeof UserRoleGrantView>;

export const UserView = named(
  'UserView',
  z.object({
    id: Uuid,
    handle: Handle,
    email: z.string(),
    displayName: z.string(),
    jobTitle: z.string().nullable(),
    kind: UserKind,
    accountStatus: AccountStatus,
    membershipStatus: MembershipStatus,
    adminRoles: z.array(OrgRole),
    roles: z.array(UserRoleGrantView),
    mfaEnrolled: z.boolean(),
    otherMemberships: z.boolean(),
    lastLoginAt: Instant.nullable(),
  }),
  'Member of the organisation as the Tenant Admin sees it; otherMemberships tells whether global fields are read-only (F.6)',
  { valid: [EXAMPLE_USER_VIEW, { ...EXAMPLE_USER_VIEW, roles: [], lastLoginAt: null, jobTitle: null }], invalid: [{ ...EXAMPLE_USER_VIEW, kind: 'robot' }, { ...EXAMPLE_USER_VIEW, adminRoles: ['owner'] }] },
);
export type UserView = z.infer<typeof UserView>;

export const UserListQuery = named('UserListQuery', z.strictObject({ ...pageQueryShape, q: z.string().max(100).optional() }), 'GET /admin/users query', {
  valid: [{}, { q: 'rina', page: '2' }],
  invalid: [{ role: 'x' }, { page: '0' }],
});
export type UserListQuery = z.infer<typeof UserListQuery>;

export const UserCreate = named(
  'UserCreate',
  z.strictObject({ email: z.email().max(254), displayName: z.string().trim().min(1).max(150), jobTitle: z.string().trim().max(150).optional(), adminRoles: z.array(OrgRole) }),
  'POST /admin/users body; the answer is 202 invited for a new and an existing account alike (F.6)',
  {
    valid: [{ email: 'new.user@nusantaradigital.co.id', displayName: 'New User', adminRoles: [] }, { email: 'a@b.co', displayName: 'A', jobTitle: 'Analyst', adminRoles: ['storage_admin'] }],
    invalid: [{ email: 'x', displayName: 'A', adminRoles: [] }, { email: 'a@b.co', displayName: '', adminRoles: [] }, { email: 'a@b.co', displayName: 'A' }],
  },
);
export type UserCreate = z.infer<typeof UserCreate>;

export const UserCreateResponse = named('UserCreateResponse', z.object({ status: z.literal('invited') }), 'Answer of POST /admin/users (no account enumeration, F.6)', {
  valid: [{ status: 'invited' }],
  invalid: [{ status: 'created' }],
});
export type UserCreateResponse = z.infer<typeof UserCreateResponse>;

export const UserPatch = named(
  'UserPatch',
  z.strictObject({
    membershipStatus: z.enum(['active', 'disabled']).optional(),
    adminRoles: z.array(OrgRole).optional(),
    displayName: z.string().trim().min(1).max(150).optional(),
    jobTitle: z.string().trim().max(150).nullable().optional(),
    accountStatus: z.enum(['active', 'disabled']).optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /admin/users/{id} body: membership fields, and global fields only when the user has no other active membership (F.6)',
  {
    valid: [{ membershipStatus: 'disabled' }, { adminRoles: ['tenant_admin'], displayName: 'Bagus P.' }],
    invalid: [{}, { membershipStatus: 'invited' }, { email: 'x@y.z' }],
  },
);
export type UserPatch = z.infer<typeof UserPatch>;

export const UserIdentityRegistration = named(
  'UserIdentityRegistration',
  z.strictObject({ provider: ProviderSlug, subject: z.string().min(1).max(255) }),
  'POST /admin/users/{id}/identities body: Tenant Admin pre-registration of a provider subject (D-25)',
  { valid: [{ provider: 'keycloak', subject: '00000000-0000-4000-8000-0000000000c2' }], invalid: [{ provider: 'keycloak', subject: '' }, { subject: 'x' }] },
);
export type UserIdentityRegistration = z.infer<typeof UserIdentityRegistration>;

export const OrgPolicyPatch = named('OrgPolicyPatch', z.strictObject({ localLogin: LocalLoginPolicy }), 'PATCH /admin/organization body (F.4)', {
  valid: [{ localLogin: 'admins_only' }],
  invalid: [{ localLogin: 'never' }, {}],
});
export type OrgPolicyPatch = z.infer<typeof OrgPolicyPatch>;

export const RoleGrant = named(
  'RoleGrant',
  z.strictObject({ user: Handle, role: BusinessRole, isPrimary: z.boolean().optional(), validUntil: Instant.optional() })
    .refine((g) => g.role !== 'external_auditor' || g.validUntil !== undefined, { message: 'external_auditor grants need validUntil', path: ['validUntil'] }),
  'POST /admin/management-systems/{id}/roles body; self-grants and grants to admin users wait for a second Tenant Admin (F.6)',
  {
    valid: [{ user: 'bagus', role: 'domain_owner' }, { user: 'sari', role: 'ms_manager', isPrimary: true }, { user: 'eko', role: 'external_auditor', validUntil: '2026-10-13T00:00:00Z' }],
    invalid: [{ user: 'eko', role: 'external_auditor' }, { user: 'none', role: 'domain_owner' }, { user: 'bagus', role: 'tenant_admin' }],
  },
);
export type RoleGrant = z.infer<typeof RoleGrant>;

export const RoleGrantResult = named(
  'RoleGrantResult',
  commandResultWith(z.object({ approvalStatus: z.enum(['active', 'pending_approval']), grantId: Uuid })),
  'Result of a role grant: active, or pending the approval of another Tenant Admin (D.2 RoleGrant)',
  {
    valid: [{ ok: true, changed: ['isms'], data: { approvalStatus: 'pending_approval', grantId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' } }],
    invalid: [{ ok: true, changed: ['isms'] }, { ok: true, changed: ['isms'], data: { approvalStatus: 'rejected', grantId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' } }],
  },
);
export type RoleGrantResult = z.infer<typeof RoleGrantResult>;

export const RoleGrantParams = named('RoleGrantParams', z.strictObject({ id: Uuid, roleId: Uuid }), 'Path parameters {id} (management system) and {roleId} (user_ms_role)', {
  valid: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', roleId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' }],
  invalid: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' }],
});
export type RoleGrantParams = z.infer<typeof RoleGrantParams>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

export const adminUsersListRoute = defineRoute({
  id: 'admin.users.list',
  owner: 'WP-39',
  method: 'GET',
  path: '/api/v1/admin/users',
  summary: 'Members of the organisation',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  query: UserListQuery,
  response: pageOf(UserView),
  errors: [],
});

export const adminUsersCreateRoute = defineRoute({
  id: 'admin.users.create',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/users',
  summary: 'Invite a user (new account, or an invited membership for an existing one); same answer either way',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  body: UserCreate,
  response: UserCreateResponse,
  status: 202,
  errors: [422],
  idempotent: true,
});

export const adminUsersUpdateRoute = defineRoute({
  id: 'admin.users.update',
  owner: 'WP-39',
  method: 'PATCH',
  path: '/api/v1/admin/users/:id',
  summary: 'Change membership fields, or global fields of a user without other active memberships',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  params: IdParams,
  body: UserPatch,
  response: UserView,
  errors: [404, 422],
});

export const adminUsersResetMfaRoute = defineRoute({
  id: 'admin.users.reset-mfa',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/users/:id/reset-mfa',
  summary: 'Reset the second factor: Tenant Admin when the user has no other active membership, else the platform operator',
  auth: 'session',
  anyOf: [
    { permission: 'user.manage', scope: 'org' },
    { permission: 'ops.users.manage', scope: 'platform' },
  ],
  params: IdParams,
  response: NoBody,
  status: 204,
  errors: [404],
});

export const adminUsersRegisterIdentityRoute = defineRoute({
  id: 'admin.users.identities.create',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/users/:id/identities',
  summary: 'Pre-register the subject of an identity provider for a member (D-25)',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  params: IdParams,
  body: UserIdentityRegistration,
  response: CommandResult,
  status: 201,
  errors: [404, 409],
  idempotent: true,
});

export const adminOrganizationUpdateRoute = defineRoute({
  id: 'admin.organization.update',
  owner: 'WP-39',
  method: 'PATCH',
  path: '/api/v1/admin/organization',
  summary: 'Set the local sign-in policy of the organisation',
  auth: 'session',
  permission: 'org.settings.manage',
  scope: 'org',
  body: OrgPolicyPatch,
  response: NoBody,
  status: 204,
  errors: [],
});

export const adminRolesGrantRoute = defineRoute({
  id: 'admin.roles.grant',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/management-systems/:id/roles',
  summary: 'Grant a business role in a management system (pending approval for self-grants and admin grantees)',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  params: IdParams,
  body: RoleGrant,
  response: RoleGrantResult,
  status: 201,
  errors: [404, 409, 422],
  idempotent: true,
});

export const adminRolesApproveRoute = defineRoute({
  id: 'admin.roles.approve',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/management-systems/:id/roles/:roleId/approve',
  summary: 'Approve a pending role grant (not the requester, not the grantee)',
  auth: 'session',
  permission: 'user.manage',
  machine: 'user_ms_role.approval_status',
  scope: 'org',
  params: RoleGrantParams,
  response: CommandResult,
  errors: [404, 409, 422],
});

export const adminRolesRejectRoute = defineRoute({
  id: 'admin.roles.reject',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/management-systems/:id/roles/:roleId/reject',
  summary: 'Reject a pending role grant (not the requester, not the grantee)',
  auth: 'session',
  permission: 'user.manage',
  machine: 'user_ms_role.approval_status',
  scope: 'org',
  params: RoleGrantParams,
  response: CommandResult,
  errors: [404, 409, 422],
});

export const adminRolesRevokeRoute = defineRoute({
  id: 'admin.roles.revoke',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/admin/management-systems/:id/roles/:roleId/revoke',
  summary: 'Revoke a role grant',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  params: RoleGrantParams,
  response: NoBody,
  status: 204,
  errors: [404],
});

export const routes: RouteDef[] = [
  adminUsersListRoute, adminUsersCreateRoute, adminUsersUpdateRoute, adminUsersResetMfaRoute, adminUsersRegisterIdentityRoute,
  adminOrganizationUpdateRoute, adminRolesGrantRoute, adminRolesApproveRoute, adminRolesRejectRoute, adminRolesRevokeRoute,
];
