// Administration of members and role grants (build plan D.3, F.6 Tenant Admin limits, C.13, J.5): members of the
// organisation only; the same 202 for new and existing emails; membership fields by the Tenant Admin, global fields
// and the MFA reset only for users without another active membership (else 403); identity pre-registration; the
// local sign-in policy; role grants with the self-grant and admin-grantee approval flow and `SOD-SELF-GRANT`.
import { RoleGrantResult, UserView, type Page } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RolePermissionEvaluator } from '../../../src/modules/authz/permission-evaluator';
import { NO_APPROVER_MESSAGE } from '../../../src/modules/admin-users/role-grants.service';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { addFactor, startMailpit, type Mailpit } from '../identity/helpers';
import {
  addOrg,
  addProvider,
  addUser,
  createAuthzApp,
  grantRole,
  platformAudit,
  principalOf,
  resetRateLimits,
  sessionFor,
  tenantAudit,
  type AuthzApp,
  type Client,
  type Org,
  type User,
} from '../authz/helpers';

describe('WP-39 administration of users and role grants (F.6, C.13)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let ctx: AuthzApp;
  let ndt: Org;
  let bsd: Org;
  let rmn: Org;
  const u: Record<string, User> = {};
  let ta1: Client;
  let ta2: Client;

  const openSessions = (userId: string) =>
    inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.session').select(['organization_id', 'revoke_reason']).where('user_id', '=', userId).where('revoked_at', 'is', null).execute(),
    );
  const membership = (org: Org, userId: string) =>
    inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.org_membership').selectAll().where('organization_id', '=', org.tenant.id).where('user_id', '=', userId).executeTakeFirst(),
    );

  beforeAll(async () => {
    mail = await startMailpit();
    ndt = await addOrg(db, 'ndt', ['isms', 'qms']);
    bsd = await addOrg(db, 'bsd', ['isms']);
    rmn = await addOrg(db, 'rmn', ['isms']);
    u.ta1 = await addUser(db, 'ta.one', [{ org: ndt, adminRoles: ['tenant_admin'] }]);
    u.ta2 = await addUser(db, 'ta.two', [{ org: ndt, adminRoles: ['tenant_admin'] }]);
    u.solo = await addUser(db, 'ta.solo', [{ org: rmn, adminRoles: ['tenant_admin'] }]);
    u.dewi = await addUser(db, 'dewi', [{ org: ndt }], { jobTitle: 'Analyst' });
    u.shared = await addUser(db, 'shared', [{ org: ndt }, { org: bsd }]);
    u.invited = await addUser(db, 'invited.one', [{ org: ndt, status: 'invited' }]);
    u.storage = await addUser(db, 'storage', [{ org: ndt, adminRoles: ['storage_admin'] }]);
    u.bsdOnly = await addUser(db, 'bsd.only', [{ org: bsd }]);
    u.disabled = await addUser(db, 'gone', [{ org: bsd }], { status: 'disabled' });
    u.op = await addUser(db, 'ops', [], { platformOperator: true });
    await grantRole(db, ndt, u.shared, 'isms', 'domain_owner');
    await addProvider(db, ndt, 'kc-ndt');
    await addProvider(db, bsd, 'kc-bsd');
    ctx = await createAuthzApp(db, { mail });
    await addFactor(db, ctx.moduleRef, u.dewi.id);
    await addFactor(db, ctx.moduleRef, u.shared.id);
  });
  afterAll(async () => {
    await ctx?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
    ctx.licence.userLimitReached = false;
    ta1 = await sessionFor(ctx, u.ta1!, { org: ndt });
    ta2 = await sessionFor(ctx, u.ta2!, { org: ndt });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------------------------------------------

  it('lists the members of the organisation only, with roles, MFA and other memberships', async () => {
    const response = await ta1.get('/api/v1/admin/users');
    expect(response.statusCode).toBe(200);
    const page = response.json() as Page<UserView>;
    expect(page.items.every((i) => UserView.safeParse(i).success)).toBe(true);
    const handles = page.items.map((i) => i.handle);
    expect(handles).toEqual(expect.arrayContaining(['ta.one', 'ta.two', 'dewi', 'shared', 'invited.one', 'storage']));
    expect(handles).not.toContain('bsd.only');
    expect(handles).not.toContain('ta.solo');
    expect(page.total).toBe(page.items.length);
    const shared = page.items.find((i) => i.handle === 'shared')!;
    expect(shared).toMatchObject({ otherMemberships: true, mfaEnrolled: true, membershipStatus: 'active', roles: [{ ms: 'isms', role: 'domain_owner', approvalStatus: 'active', isPrimary: false }] });
    expect(page.items.find((i) => i.handle === 'dewi')).toMatchObject({ otherMemberships: false, mfaEnrolled: true, jobTitle: 'Analyst' });
    expect(page.items.find((i) => i.handle === 'invited.one')).toMatchObject({ membershipStatus: 'invited', mfaEnrolled: false });
    const searched = (await ta1.get('/api/v1/admin/users?q=dew')).json() as Page<UserView>;
    expect(searched.items.map((i) => i.handle)).toEqual(['dewi']);
    const paged = (await ta1.get('/api/v1/admin/users?pageSize=2&page=2')).json() as Page<UserView>;
    expect(paged).toMatchObject({ page: 2, pageSize: 2, total: page.total });
    expect(paged.items).toHaveLength(2);
    // Not a Tenant Admin: 403.
    const member = await sessionFor(ctx, u.dewi!, { org: ndt });
    expect((await member.get('/api/v1/admin/users')).statusCode).toBe(403);
  });

  it('answers the same 202 for new and existing emails and never reveals other tenants (F.6)', async () => {
    const created = await ta1.post('/api/v1/admin/users', { email: 'new.person@ndt.test', displayName: 'New Person', adminRoles: [] });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toEqual({ status: 'invited' });
    const message = await mail.waitFor('new.person@ndt.test');
    expect(message.mailKind).toBe('account:invitation');
    expect(message.text).toContain('/invite#token=');

    // An active account of another organisation: an invited membership, no email, the same answer.
    const existing = await ta1.post('/api/v1/admin/users', { email: u.bsdOnly!.email, displayName: 'Whatever', adminRoles: [] });
    expect(existing.statusCode).toBe(202);
    expect(existing.json()).toEqual({ status: 'invited' });
    expect(await membership(ndt, u.bsdOnly!.id)).toMatchObject({ status: 'invited' });
    // Already a member, and a disabled account elsewhere: nothing changes, the answer is the same.
    for (const email of [u.dewi!.email, u.disabled!.email]) {
      const again = await ta1.post('/api/v1/admin/users', { email, displayName: 'Again', adminRoles: [] });
      expect(again.statusCode, email).toBe(202);
      expect(again.json()).toEqual({ status: 'invited' });
    }
    // The disabled account gets the same invited membership as an active one (no link: it cannot sign in).
    expect(await membership(ndt, u.disabled!.id)).toMatchObject({ status: 'invited' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await mail.messages(u.bsdOnly!.email)).toHaveLength(0);
    expect(await mail.messages(u.dewi!.email)).toHaveLength(0);
    // The list shows the same row for a new email and for accounts of other organisations, active or disabled: only
    // what this organisation supplied or knows until the user accepts (F.6).
    await addFactor(db, ctx.moduleRef, u.bsdOnly!.id);
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.app_user').set({ job_title: 'Secret title', last_login_at: new Date() }).where('id', 'in', [u.bsdOnly!.id, u.disabled!.id]).execute(),
    );
    const listed = ((await ta1.get('/api/v1/admin/users?pageSize=100')).json() as Page<UserView>).items;
    const rowOf = (email: string) => {
      const row = listed.find((i) => i.email.toLowerCase() === email.toLowerCase());
      expect(row, email).toBeDefined();
      const { id: _id, handle: _handle, email: _email, ...rest } = row!;
      return { rest, email: row!.email, displayName: row!.displayName };
    };
    const fresh = rowOf('new.person@ndt.test');
    expect(fresh.rest).toEqual({
      displayName: 'new.person@ndt.test', jobTitle: null, kind: 'person', accountStatus: 'invited', membershipStatus: 'invited', adminRoles: [], roles: [],
      mfaEnrolled: false, otherMemberships: false, lastLoginAt: null,
    });
    for (const user of [u.bsdOnly!, u.disabled!]) {
      const other = rowOf(user.email);
      expect(other.displayName).toBe(other.email);
      expect({ ...other.rest, displayName: 'x' }).toEqual({ ...fresh.rest, displayName: 'x' });
    }
    // Search sees only the projected fields: the foreign account's name and title are not searchable.
    const foreignName = (await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.app_user').select('display_name').where('id', '=', u.bsdOnly!.id).executeTakeFirstOrThrow(),
    )).display_name;
    expect(((await ta1.get(`/api/v1/admin/users?q=${encodeURIComponent(foreignName)}`)).json() as Page<UserView>).items.map((i) => i.id)).not.toContain(u.bsdOnly!.id);
    // Global fields and the MFA reset of an invited member answer the same 400 whatever the account's other memberships.
    for (const id of [u.bsdOnly!.id, u.disabled!.id, listed.find((i) => i.email === 'new.person@ndt.test')!.id]) {
      expect((await ta1.patch(`/api/v1/admin/users/${id}`, { displayName: 'Renamed' })).statusCode, id).toBe(400);
      expect((await ta1.post(`/api/v1/admin/users/${id}/reset-mfa`)).statusCode, id).toBe(400);
    }
    // The licence user limit (D-15).
    ctx.licence.userLimitReached = true;
    const limited = await ta1.post('/api/v1/admin/users', { email: 'one.more@ndt.test', displayName: 'One More', adminRoles: [] });
    expect(limited.statusCode).toBe(422);
    expect(limited.json().rule).toBe('LIC-USERS');
  });

  it('changes membership fields; disabling a membership ends the sessions in the organisation (F.1, F.6)', async () => {
    const patched = await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { adminRoles: ['storage_admin'] });
    expect(patched.statusCode).toBe(200);
    expect(UserView.safeParse(patched.json()).success).toBe(true);
    expect(patched.json()).toMatchObject({ adminRoles: ['storage_admin'] });
    const audit = (await platformAudit(db, 'membership.updated')).at(-1)!;
    expect(audit).toMatchObject({ organization_id: ndt.tenant.id, entity_id: u.dewi!.id, actor_user_id: u.ta1!.id });
    expect(audit.after_data).toMatchObject({ adminRoles: ['storage_admin'] });

    await sessionFor(ctx, u.dewi!, { org: ndt });
    expect(await openSessions(u.dewi!.id)).not.toHaveLength(0);
    expect((await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { membershipStatus: 'disabled' })).statusCode).toBe(200);
    expect(await openSessions(u.dewi!.id)).toHaveLength(0);
    ctx.licence.userLimitReached = true;
    const limited = await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { membershipStatus: 'active' });
    expect(limited.statusCode).toBe(422);
    expect(limited.json().rule).toBe('LIC-USERS');
    ctx.licence.userLimitReached = false;
    expect((await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { membershipStatus: 'active', adminRoles: [] })).json()).toMatchObject({ membershipStatus: 'active', adminRoles: [] });
    // An invited membership is accepted by its user, not activated by the Tenant Admin.
    expect((await ta1.patch(`/api/v1/admin/users/${u.invited!.id}`, { membershipStatus: 'active' })).statusCode).toBe(400);
    // A member of another organisation only is not found here.
    expect((await ta1.patch(`/api/v1/admin/users/${u.solo!.id}`, { membershipStatus: 'disabled' })).statusCode).toBe(404);
  });

  it('changes global fields only for a user without another active membership; disabling the account ends every session (F.6, J.5)', async () => {
    const refused = await ta1.patch(`/api/v1/admin/users/${u.shared!.id}`, { displayName: 'Changed' });
    expect(refused.statusCode).toBe(403);
    await sessionFor(ctx, u.shared!, { org: bsd });
    expect((await ta1.patch(`/api/v1/admin/users/${u.shared!.id}`, { accountStatus: 'disabled' })).statusCode).toBe(403);
    expect(await openSessions(u.shared!.id)).not.toHaveLength(0);
    // The membership is still the Tenant Admin's to change.
    expect((await ta1.patch(`/api/v1/admin/users/${u.shared!.id}`, { adminRoles: [] })).statusCode).toBe(200);

    const renamed = await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { displayName: 'Dewi Lestari', jobTitle: null });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ displayName: 'Dewi Lestari', jobTitle: null });
    expect((await platformAudit(db, 'user.updated')).at(-1)!.after_data).toMatchObject({ displayName: 'Dewi Lestari', jobTitle: null });

    await sessionFor(ctx, u.dewi!, { org: ndt });
    expect((await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { accountStatus: 'disabled' })).json()).toMatchObject({ accountStatus: 'disabled' });
    expect(await openSessions(u.dewi!.id)).toHaveLength(0);
    expect((await ta1.patch(`/api/v1/admin/users/${u.dewi!.id}`, { accountStatus: 'active' })).json()).toMatchObject({ accountStatus: 'active' });
  });

  it('protects the caller and the last Tenant Admin; a change of the caller own roles rotates the session (F.1)', async () => {
    expect((await ta1.patch(`/api/v1/admin/users/${u.ta1!.id}`, { membershipStatus: 'disabled' })).statusCode).toBe(403);
    expect((await ta1.patch(`/api/v1/admin/users/${u.ta1!.id}`, { accountStatus: 'disabled' })).statusCode).toBe(403);
    const cookie = ta1.session;
    const rotated = await ta1.patch(`/api/v1/admin/users/${u.ta1!.id}`, { adminRoles: ['tenant_admin', 'storage_admin'] });
    expect(rotated.statusCode).toBe(200);
    expect(ta1.session).not.toBe(cookie);
    expect((await ta1.get('/api/v1/me')).json()).toMatchObject({ adminRoles: ['tenant_admin', 'storage_admin'] });
    const solo = await sessionFor(ctx, u.solo!, { org: rmn });
    const last = await solo.patch(`/api/v1/admin/users/${u.solo!.id}`, { adminRoles: [] });
    expect(last.statusCode).toBe(400);
    expect(last.json().errors[0].message).toContain('at least one active Tenant Admin');
  });

  it('resets the second factor only for a user without another membership, or as the platform operator (F.5, F.6, J.5)', async () => {
    expect((await ta1.post(`/api/v1/admin/users/${u.shared!.id}/reset-mfa`)).statusCode).toBe(403);
    await sessionFor(ctx, u.dewi!, { org: ndt });
    const reset = await ta1.post(`/api/v1/admin/users/${u.dewi!.id}/reset-mfa`);
    expect(reset.statusCode).toBe(204);
    expect(await openSessions(u.dewi!.id)).toHaveLength(0);
    const factors = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.mfa_factor').select('id').where('user_id', '=', u.dewi!.id).where('deleted_at', 'is', null).execute(),
    );
    expect(factors).toHaveLength(0);
    expect((await mail.waitFor(u.dewi!.email, (m) => m.mailKind === 'account:mfa_reset')).subject).toContain('[MSCD]');
    expect((await platformAudit(db, 'auth.mfa_reset')).at(-1)).toMatchObject({ entity_id: u.dewi!.id, actor_user_id: u.ta1!.id, organization_id: ndt.tenant.id });
    // Not a member of this organisation (only of rmn): 404.
    expect((await ta1.post(`/api/v1/admin/users/${u.solo!.id}/reset-mfa`)).statusCode).toBe(404);
    const member = await sessionFor(ctx, u.storage!, { org: ndt });
    expect((await member.post(`/api/v1/admin/users/${u.dewi!.id}/reset-mfa`)).statusCode).toBe(403);
    // The platform operator, without an organisation, for a user of two organisations.
    const operator = await sessionFor(ctx, u.op!, { org: null });
    expect((await operator.post(`/api/v1/admin/users/${u.shared!.id}/reset-mfa`)).statusCode).toBe(204);
    expect((await platformAudit(db, 'auth.mfa_reset')).at(-1)).toMatchObject({ entity_id: u.shared!.id, actor_user_id: u.op!.id, actor_kind: 'operator' });
  });

  it('pre-registers a provider subject of the organisation for a member (D-25)', async () => {
    const created = await ta1.post(`/api/v1/admin/users/${u.dewi!.id}/identities`, { provider: 'kc-ndt', subject: 'subject-dewi' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ ok: true, changed: [] });
    const identity = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.user_identity').selectAll().where('subject', '=', 'subject-dewi').executeTakeFirstOrThrow(),
    );
    expect(identity).toMatchObject({ user_id: u.dewi!.id, link_method: 'admin', linked_by: u.ta1!.id });
    expect((await platformAudit(db, 'identity.registered')).at(-1)!.after_data).toMatchObject({ provider: 'kc-ndt', subject: 'subject-dewi' });
    expect((await ta1.post(`/api/v1/admin/users/${u.storage!.id}/identities`, { provider: 'kc-ndt', subject: 'subject-dewi' })).statusCode).toBe(409);
    expect((await ta1.post(`/api/v1/admin/users/${u.dewi!.id}/identities`, { provider: 'kc-bsd', subject: 'subject-x' })).statusCode).toBe(404);
    expect((await ta1.post(`/api/v1/admin/users/${u.solo!.id}/identities`, { provider: 'kc-ndt', subject: 'subject-y' })).statusCode).toBe(404);
  });

  it('sets the local sign-in policy of the organisation and refreshes the tenant cache (F.4)', async () => {
    const resolver = ctx.moduleRef.get(TenantResolver);
    expect((await resolver.resolveById(ndt.tenant.id))?.localLogin).toBe('allowed');
    expect((await ta1.patch('/api/v1/admin/organization', { localLogin: 'admins_only' })).statusCode).toBe(204);
    expect((await resolver.resolveById(ndt.tenant.id))?.localLogin).toBe('admins_only');
    const audit = (await tenantAudit(db, ndt, 'org.settings_updated')).at(-1)!;
    expect(audit).toMatchObject({ actor_user_id: u.ta1!.id, entity_type: 'organization' });
    expect(audit.after_data).toEqual({ localLogin: 'admins_only' });
    const member = await sessionFor(ctx, u.storage!, { org: ndt });
    expect((await member.patch('/api/v1/admin/organization', { localLogin: 'disabled' })).statusCode).toBe(403);
    expect((await ta1.patch('/api/v1/admin/organization', { localLogin: 'allowed' })).statusCode).toBe(204);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Role grants
  // -------------------------------------------------------------------------------------------------------------

  it('grants a role at once to a member who is not an admin and not the caller', async () => {
    const isms = ndt.systems.isms!;
    const response = await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'dewi', role: 'risk_owner' });
    expect(response.statusCode).toBe(201);
    const result = response.json() as RoleGrantResult;
    expect(RoleGrantResult.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ok: true, changed: ['isms'], data: { approvalStatus: 'active' } });
    expect(result.message).toBeUndefined();
    const evaluator = ctx.moduleRef.get(RolePermissionEvaluator);
    expect(await evaluator.evaluate(principalOf(u.dewi!, ndt), 'risk.manage', { scope: 'ms', ms: 'isms' })).toBe('own');
    const audit = (await tenantAudit(db, ndt, 'role.granted')).at(-1)!;
    expect(audit).toMatchObject({ management_system_id: isms, entity_id: result.data.grantId, actor_user_id: u.ta1!.id });
    expect(audit.after_data).not.toHaveProperty('grantee_admin_roles');
    expect((await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'dewi', role: 'risk_owner' })).statusCode).toBe(409);
    const notMember = await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'bsd.only', role: 'risk_owner' });
    expect(notMember.statusCode).toBe(422);
    expect(notMember.json().rule).toBe('NOT-A-MEMBER');
    expect((await ta1.post(`/api/v1/admin/management-systems/${bsd.systems.isms}/roles`, { user: 'dewi', role: 'risk_owner' })).statusCode).toBe(404);
    expect((await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'dewi', role: 'external_auditor' })).statusCode).toBe(400);
    expect(
      (await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'dewi', role: 'external_auditor', validUntil: '2020-01-01T00:00:00Z' })).statusCode,
    ).toBe(400);
    const member = await sessionFor(ctx, u.storage!, { org: ndt });
    expect((await member.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'dewi', role: 'ms_manager' })).statusCode).toBe(403);
  });

  it('keeps a self-grant pending until a second Tenant Admin approves it (C.13, J.5)', async () => {
    const isms = ndt.systems.isms!;
    const requested = await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'ta.one', role: 'ms_manager' });
    expect(requested.statusCode).toBe(201);
    const grant = requested.json() as RoleGrantResult;
    expect(grant.data.approvalStatus).toBe('pending_approval');
    const evaluator = ctx.moduleRef.get(RolePermissionEvaluator);
    expect(await evaluator.evaluate(principalOf(u.ta1!, ndt), 'applicability.manage', { scope: 'ms', ms: 'isms' })).toBeNull();
    // The other Tenant Admin is notified.
    const notices = await inScope(db.migrator, { orgId: ndt.tenant.id, schema: ndt.tenant.schemaName }, (trx) =>
      trx.selectFrom('notification').select(['recipient_user_id', 'kind', 'management_system_id']).where('kind', '=', 'role_grant_pending').execute(),
    );
    expect(notices).toContainEqual({ recipient_user_id: u.ta2!.id, kind: 'role_grant_pending', management_system_id: isms });
    expect(notices.map((n) => n.recipient_user_id)).not.toContain(u.ta1!.id);
    const audited = (await tenantAudit(db, ndt, 'role.grant_requested')).at(-1)!;
    // ta.one holds both admin roles since the rotation test.
    expect(audited.after_data).toMatchObject({ approvalStatus: 'pending_approval', grantee_admin_roles: ['storage_admin', 'tenant_admin'] });

    // The requester (also the grantee) cannot approve.
    const own = await ta1.post(`/api/v1/admin/management-systems/${isms}/roles/${grant.data.grantId}/approve`);
    expect(own.statusCode).toBe(422);
    expect(own.json().rule).toBe('SOD-SELF-GRANT');
    const approved = await ta2.post(`/api/v1/admin/management-systems/${isms}/roles/${grant.data.grantId}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ ok: true, changed: ['isms'], data: { approvalStatus: 'active' } });
    expect(await evaluator.evaluate(principalOf(u.ta1!, ndt), 'applicability.manage', { scope: 'ms', ms: 'isms' })).toBe('full');
    expect((await tenantAudit(db, ndt, 'role.grant_approved')).at(-1)!.after_data).toMatchObject({ grantee_admin_roles: ['storage_admin', 'tenant_admin'] });
    const row = await inScope(db.migrator, { orgId: ndt.tenant.id, schema: ndt.tenant.schemaName }, (trx) =>
      trx.selectFrom('user_ms_role').select(['approval_status', 'requested_by', 'approved_by']).where('id', '=', grant.data.grantId).executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ approval_status: 'active', requested_by: u.ta1!.id, approved_by: u.ta2!.id });
    // Not pending any more.
    expect((await ta2.post(`/api/v1/admin/management-systems/${isms}/roles/${grant.data.grantId}/reject`)).statusCode).toBe(409);
  });

  it('needs approval for a grant to an admin user; the grantee cannot decide it; a rejection allows a new request', async () => {
    const qms = ndt.systems.qms!;
    const requested = (await ta1.post(`/api/v1/admin/management-systems/${qms}/roles`, { user: 'ta.two', role: 'programme_owner' })).json() as RoleGrantResult;
    expect(requested.data.approvalStatus).toBe('pending_approval');
    const byGrantee = await ta2.post(`/api/v1/admin/management-systems/${qms}/roles/${requested.data.grantId}/approve`);
    expect(byGrantee.statusCode).toBe(422);
    expect(byGrantee.json().rule).toBe('SOD-SELF-GRANT');
    // Storage Admin grantee: pending too, with the admin roles in the audit entry.
    const toStorage = (await ta1.post(`/api/v1/admin/management-systems/${qms}/roles`, { user: 'storage', role: 'domain_owner' })).json() as RoleGrantResult;
    expect(toStorage.data.approvalStatus).toBe('pending_approval');
    expect((await tenantAudit(db, ndt, 'role.grant_requested')).at(-1)!.after_data).toMatchObject({ grantee_admin_roles: ['storage_admin'] });
    const rejected = await ta2.post(`/api/v1/admin/management-systems/${qms}/roles/${toStorage.data.grantId}/reject`);
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ data: { approvalStatus: 'rejected' } });
    expect((await tenantAudit(db, ndt, 'role.grant_rejected')).at(-1)).toMatchObject({ actor_user_id: u.ta2!.id });
    const again = await ta1.post(`/api/v1/admin/management-systems/${qms}/roles`, { user: 'storage', role: 'domain_owner' });
    expect(again.statusCode).toBe(201);
    expect((again.json() as RoleGrantResult).data.approvalStatus).toBe('pending_approval');
    expect((await ta1.post(`/api/v1/admin/management-systems/${qms}/roles/00000000-0000-4000-8000-000000000000/approve`)).statusCode).toBe(404);
  });

  it('says when no other Tenant Admin can approve a pending grant (F.6, as A-50)', async () => {
    const solo = await sessionFor(ctx, u.solo!, { org: rmn });
    const response = await solo.post(`/api/v1/admin/management-systems/${rmn.systems.isms}/roles`, { user: 'ta.solo', role: 'ms_manager' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ data: { approvalStatus: 'pending_approval' }, message: NO_APPROVER_MESSAGE });
  });

  it('revokes a grant at once; revoking an own role rotates the session', async () => {
    const isms = ndt.systems.isms!;
    const grant = (await ta1.post(`/api/v1/admin/management-systems/${isms}/roles`, { user: 'dewi', role: 'compliance_investigator' })).json() as RoleGrantResult;
    expect((await ta1.post(`/api/v1/admin/management-systems/${isms}/roles/${grant.data.grantId}/revoke`)).statusCode).toBe(204);
    expect((await tenantAudit(db, ndt, 'role.revoked')).at(-1)).toMatchObject({ entity_id: grant.data.grantId, management_system_id: isms });
    expect((await ta1.post(`/api/v1/admin/management-systems/${isms}/roles/${grant.data.grantId}/revoke`)).statusCode).toBe(404);
    const evaluator = ctx.moduleRef.get(RolePermissionEvaluator);
    expect((await evaluator.rolesByMs(principalOf(u.dewi!, ndt))).isms).toEqual(['risk_owner']);

    // ta.one holds ms_manager in isms since the approval test: revoking it changes the caller's own roles.
    const own = await inScope(db.migrator, { orgId: ndt.tenant.id, schema: ndt.tenant.schemaName }, (trx) =>
      trx.selectFrom('user_ms_role').select('id').where('user_id', '=', u.ta1!.id).where('role', '=', 'ms_manager').where('deleted_at', 'is', null).executeTakeFirstOrThrow(),
    );
    const cookie = ta1.session;
    expect((await ta1.post(`/api/v1/admin/management-systems/${isms}/roles/${own.id}/revoke`)).statusCode).toBe(204);
    expect(ta1.session).not.toBe(cookie);
    expect((await ta1.get('/api/v1/me')).json()).toMatchObject({ rolesByMs: {} });
  });
});
