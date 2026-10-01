// Passwords and invitations against PostgreSQL and Mailpit (F.4): reset links (fragment token, 30 minutes, single
// use, revocation of every session, no email for users whose organisations require SSO), password change
// (revocation of the other sessions), `admin create-user` (invited user and membership through the licence gate,
// one-time link), invitation acceptance with a password, followed by MFA enrolment, and invitations of existing
// accounts (membership only, or an operator link accepted with the current password).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCreateUser } from '../../../src/cli/admin';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { InvitationService } from '../../../src/modules/identity/invitation.service';
import { base32Decode, totpAt } from '../../../src/modules/identity/totp';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  addProvider,
  addUser,
  APP_ORIGIN,
  auditActions,
  Browser,
  createIdentityApp,
  openSessions,
  PASSWORD,
  resetRateLimits,
  sessionRow,
  setLocalLogin,
  signIn,
  startMailpit,
  type IdentityApp,
  type Mailpit,
} from './helpers';

const RESET_REQUEST = '/api/v1/auth/password/reset-request';
const RESET = '/api/v1/auth/password/reset';
const CHANGE = '/api/v1/auth/password/change';
const ACCEPT = '/api/v1/auth/invitations/accept';
const PREFERENCES = '/api/v1/me/preferences';
const NEW_PASSWORD = 'Another-Strong-Passphrase-42';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tokenOf(text: string, path: string): string {
  const match = new RegExp(`${APP_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}${path}#token=([A-Za-z0-9_-]{43})`).exec(text);
  if (!match) throw new Error(`No ${path} link in: ${text}`);
  return match[1]!;
}

describe('WP-11 passwords and invitations', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let ctx: IdentityApp;
  let ndt: CreatedTenant;
  let sso: CreatedTenant;

  beforeAll(async () => {
    mail = await startMailpit();
    ndt = await createTenant(db, 'ndt');
    sso = await createTenant(db, 'sso');
    ctx = await createIdentityApp(db, { mail });
    await setLocalLogin(db, ctx.moduleRef, sso.id, 'disabled');
    await addProvider(db, sso.id, 'entra', 'Sign in with Microsoft');
  });
  afterAll(async () => {
    await ctx?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
    ctx.licence.userLimitReached = false;
  });

  it('emails a reset link, sets the new password once and revokes every session of the user (F.4)', async () => {
    const user = await addUser(db, ctx.moduleRef, { handle: 'resetter', memberships: [{ org: ndt }], factor: true });
    const a = await signIn(ctx, user);
    const b = await signIn(ctx, user);
    const pending = new Browser(ctx.app);
    await pending.login(user.email);

    const requested = await new Browser(ctx.app).post(RESET_REQUEST, { email: user.email.toUpperCase() });
    expect(requested.statusCode).toBe(202);
    const message = await mail.waitFor(user.email, (m) => m.mailKind === 'account:password_reset');
    expect(message.subject).toBe('[MSCD] Reset your password');
    expect(message.text).toContain('within 30 minutes');
    const token = tokenOf(message.text, '/reset-password');

    const weak = await new Browser(ctx.app).post(RESET, { token, password: 'unbelievable' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().errors).toEqual([{ path: 'body.password', message: 'This password is too common; choose another one' }]);
    expect((await new Browser(ctx.app).post(RESET, { token, password: user.email })).statusCode).toBe(400);

    expect((await new Browser(ctx.app).post(RESET, { token, password: NEW_PASSWORD })).statusCode).toBe(204);
    for (const browser of [a, b]) expect((await browser.put(PREFERENCES, { x: 1 })).statusCode).toBe(401);
    expect(await openSessions(db, user.id)).toHaveLength(0);
    expect((await sessionRow(db, pending.session!)).revoke_reason).toBe('password_reset');
    expect((await auditActions(db, user.id)).at(-1)).toMatchObject({ action: 'auth.password_reset', after: { sessionsRevoked: 3 }, organization_id: ndt.id });
    expect((await mail.waitFor(user.email, (m) => m.mailKind === 'security:password_reset_done')).subject).toBe('[MSCD] Your password was reset');

    const reused = await new Browser(ctx.app).post(RESET, { token, password: 'Yet-Another-Passphrase-9' });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ messageKey: 'auth.reset_invalid', errors: [{ path: 'body.token' }] });
    expect((await new Browser(ctx.app).login(user.email, PASSWORD)).statusCode).toBe(401);
    expect((await new Browser(ctx.app).login(user.email, NEW_PASSWORD)).json().status).toBe('mfa_required');

    // A link is valid for 30 minutes.
    await mail.clear();
    expect((await new Browser(ctx.app).post(RESET_REQUEST, { email: user.email })).statusCode).toBe(202);
    const late = tokenOf((await mail.waitFor(user.email, (m) => m.mailKind === 'account:password_reset')).text, '/reset-password');
    ctx.clock.advance(31 * MINUTE);
    expect((await new Browser(ctx.app).post(RESET, { token: late, password: 'Yet-Another-Passphrase-9' })).json().messageKey).toBe('auth.reset_invalid');
  });

  it('answers 202 without an email for unknown addresses and for users whose organisations require SSO (F.4)', async () => {
    const ssoUser = await addUser(db, ctx.moduleRef, { handle: 'ssoreset', memberships: [{ org: sso }], factor: true });
    const control = await addUser(db, ctx.moduleRef, { handle: 'control', memberships: [{ org: ndt }], factor: true });
    for (const email of [ssoUser.email, 'nobody@identity.test', control.email]) {
      expect((await new Browser(ctx.app).post(RESET_REQUEST, { email })).statusCode, email).toBe(202);
    }
    // The control email was requested last; once it arrived, the others would have too.
    await mail.waitFor(control.email, (m) => m.mailKind === 'account:password_reset');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await mail.messages(ssoUser.email)).toHaveLength(0);
    expect(await mail.messages('nobody@identity.test')).toHaveLength(0);
    const tokens = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.password_reset_token').select('user_id').where('user_id', '=', ssoUser.id).execute(),
    );
    expect(tokens).toHaveLength(0);
  });

  it('limits reset requests to 5 per hour per email (F.3)', async () => {
    for (let i = 0; i < 5; i += 1) expect((await new Browser(ctx.app).post(RESET_REQUEST, { email: `limit${i}@identity.test` })).statusCode).toBe(202);
    expect((await new Browser(ctx.app).post(RESET_REQUEST, { email: 'limit-last@identity.test' })).statusCode).toBe(429);
  });

  it('changes the password after checking the current one and revokes the other sessions (F.4)', async () => {
    const user = await addUser(db, ctx.moduleRef, { handle: 'changer', memberships: [{ org: ndt }], factor: true });
    const a = await signIn(ctx, user);
    const b = await signIn(ctx, user);
    const wrong = await a.post(CHANGE, { currentPassword: 'Not-The-Password-1', newPassword: NEW_PASSWORD });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().messageKey).toBe('auth.password_invalid');
    expect((await a.post(CHANGE, { currentPassword: PASSWORD, newPassword: 'changer@identity.test' })).statusCode).toBe(400);
    expect((await a.post(CHANGE, { currentPassword: PASSWORD, newPassword: 'unbelievable' })).statusCode).toBe(400);
    expect((await a.post(CHANGE, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(204);
    expect((await a.put(PREFERENCES, { y: 1 })).statusCode).toBe(204);
    expect((await b.put(PREFERENCES, { y: 1 })).statusCode).toBe(401);
    expect((await sessionRow(db, b.session!)).revoke_reason).toBe('password_changed');
    expect((await auditActions(db, user.id)).at(-1)).toMatchObject({ action: 'auth.password_changed', after: { sessionsRevoked: 1 } });
    expect((await mail.waitFor(user.email, (m) => m.mailKind === 'security:password_changed')).subject).toBe('[MSCD] Your password was changed');
    expect((await new Browser(ctx.app).login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('creates an invited user with admin create-user and accepts the invitation by setting a password (F.4, D-15)', async () => {
    const created = await adminCreateUser(db.config({}, 'cli'), { email: 'Dewi.Lestari@identity.test', name: 'Dewi Lestari', tenantAdmin: true, org: 'ndt' }, ctx.moduleRef);
    expect(created).toMatchObject({ newAccount: true, handle: 'dewi.lestari', email: 'Dewi.Lestari@identity.test', orgSlug: 'ndt' });
    expect(created.link).toBe(`${APP_ORIGIN}/invite#token=${created.token}`);
    expect(created.expiresAt.getTime()).toBe(ctx.clock.now().getTime() + 72 * HOUR);
    expect(ctx.licence.userChecks).toContain(ndt.id);
    const stored = await inScope(db.migrator, { platformScope: true }, async (trx) => ({
      user: await trx.selectFrom('platform.app_user').select(['status', 'password_hash', 'display_name', 'kind']).where('id', '=', created.userId).executeTakeFirstOrThrow(),
      membership: await trx.selectFrom('platform.org_membership').select(['status', 'admin_roles', 'is_default']).where('user_id', '=', created.userId).executeTakeFirstOrThrow(),
    }));
    expect(stored).toEqual({
      user: { status: 'invited', password_hash: null, display_name: 'Dewi Lestari', kind: 'person' },
      membership: { status: 'invited', admin_roles: ['tenant_admin'], is_default: true },
    });
    const audit = await auditActions(db, created.userId);
    expect(audit.map((a) => a.action)).toContain('user.created');
    const invitedEntry = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select(['actor_kind', 'organization_id']).where('action', '=', 'user.invited').where('entity_id', '=', created.invitationId).executeTakeFirstOrThrow(),
    );
    expect(invitedEntry).toEqual({ actor_kind: 'operator', organization_id: ndt.id });

    // Not usable before acceptance.
    expect((await new Browser(ctx.app).login(created.email, PASSWORD)).statusCode).toBe(401);
    const browser = new Browser(ctx.app);
    expect((await browser.post(ACCEPT, { token: 'A'.repeat(43), password: PASSWORD })).json().messageKey).toBe('auth.invitation_invalid');
    expect((await browser.post(ACCEPT, { token: created.token })).json().errors).toEqual([{ path: 'body.password', message: 'Choose a password to accept the invitation' }]);
    expect((await browser.post(ACCEPT, { token: created.token, password: 'DEWI.LESTARI@identity.test' })).statusCode).toBe(400);
    ctx.licence.userLimitReached = true;
    const limited = await browser.post(ACCEPT, { token: created.token, password: PASSWORD });
    expect(limited.statusCode).toBe(422);
    expect(limited.json()).toMatchObject({ rule: 'LIC-USERS' });
    ctx.licence.userLimitReached = false;

    const accepted = await browser.post(ACCEPT, { token: created.token, password: PASSWORD });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ status: 'mfa_enrolment_required', csrfToken: expect.any(String) });
    const after = await inScope(db.migrator, { platformScope: true }, async (trx) => ({
      user: await trx.selectFrom('platform.app_user').select('status').where('id', '=', created.userId).executeTakeFirstOrThrow(),
      membership: await trx.selectFrom('platform.org_membership').select(['status', 'accepted_at']).where('user_id', '=', created.userId).executeTakeFirstOrThrow(),
      invitation: await trx.selectFrom('platform.invitation').select('used_at').where('id', '=', created.invitationId).executeTakeFirstOrThrow(),
    }));
    expect(after).toEqual({
      user: { status: 'active' },
      membership: { status: 'active', accepted_at: ctx.clock.now() },
      invitation: { used_at: ctx.clock.now() },
    });
    expect((await auditActions(db, created.userId)).at(-1)).toMatchObject({ action: 'membership.updated', after: { status: 'active', via: 'invitation' } });
    expect((await openSessions(db, created.userId))[0]).toMatchObject({ state: 'mfa_enrolment', organization_id: ndt.id, auth_org_id: ndt.id });

    // The link works once.
    expect((await new Browser(ctx.app).post(ACCEPT, { token: created.token, password: PASSWORD })).json().messageKey).toBe('auth.invitation_invalid');

    // The session continues to enrolment and becomes active.
    const secret = base32Decode((await browser.post('/api/v1/auth/mfa/enrol/start', {})).json().secret);
    const confirmed = await browser.post('/api/v1/auth/mfa/enrol/confirm', { code: totpAt(secret, ctx.clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().me.user.handle).toBe('dewi.lestari');

    // Inviting an active member again is refused.
    await expect(adminCreateUser(db.config({}, 'cli'), { email: 'dewi.lestari@identity.test', org: 'ndt' }, ctx.moduleRef)).rejects.toThrow(/already an active member/);
  });

  it('refuses expired invitations, and invitations of an organisation that requires SSO keep working through its providers (F.4)', async () => {
    const late = await adminCreateUser(db.config({}, 'cli'), { email: 'late.comer@identity.test', org: 'ndt' }, ctx.moduleRef);
    const ssoInvite = await adminCreateUser(db.config({}, 'cli'), { email: 'sso.only@identity.test', org: 'sso' }, ctx.moduleRef);

    const refused = await new Browser(ctx.app).post(ACCEPT, { token: ssoInvite.token, password: PASSWORD });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ messageKey: 'auth.sso_required', methods: { local: false, providers: [{ slug: 'entra' }] } });
    const unused = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.invitation').select('used_at').where('id', '=', ssoInvite.invitationId).executeTakeFirstOrThrow(),
    );
    expect(unused.used_at).toBeNull();

    ctx.clock.advance(72 * HOUR + MINUTE);
    expect((await new Browser(ctx.app).post(ACCEPT, { token: late.token, password: PASSWORD })).json().messageKey).toBe('auth.invitation_invalid');
  });

  it('gives an active account only an invited membership; an operator link asks for the current password and never replaces it (F.6)', async () => {
    const other = await createTenant(db, 'oth');
    const user = await addUser(db, ctx.moduleRef, { handle: 'veteran', memberships: [{ org: ndt }], factor: true });
    const scope = ctx.moduleRef.get(TenantScope);
    const invitations = ctx.moduleRef.get(InvitationService);
    const invitationCount = () =>
      inScope(db.migrator, { platformScope: true }, async (trx) => (await trx.selectFrom('platform.invitation').select('id').where('user_id', '=', user.id).execute()).length);
    const account = () =>
      inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.selectFrom('platform.app_user').select(['password_hash', 'failed_login_count']).where('id', '=', user.id).executeTakeFirstOrThrow(),
      );
    const membershipInOther = async () =>
      (
        await inScope(db.migrator, { platformScope: true }, (trx) =>
          trx.selectFrom('platform.org_membership').select('status').where('user_id', '=', user.id).where('organization_id', '=', other.id).executeTakeFirstOrThrow(),
        )
      ).status;

    // A Tenant Admin's invitation (POST /admin/users, WP-39) of an existing active account: the membership only.
    const byAdmin = await scope.withPlatform(
      (trx) => invitations.inviteUser(trx, { orgId: other.id, email: user.email.toUpperCase(), actor: { userId: null, kind: 'system' } }),
      { scope: 'auth', orgId: other.id },
    );
    expect(byAdmin).toEqual({ userId: user.id, handle: 'veteran', email: user.email, newAccount: false, invitation: null });
    expect(await membershipInOther()).toBe('invited');
    expect(await invitationCount()).toBe(0);
    expect((await auditActions(db, user.id)).find((a) => a.action === 'user.invited')).toMatchObject({ organization_id: other.id, after: { link: false, newAccount: false } });

    // An account that was never activated still gets a link: its owner cannot sign in to accept a membership.
    const pending = await adminCreateUser(db.config({}, 'cli'), { email: 'pending.person@identity.test', org: 'ndt' }, ctx.moduleRef);
    const again = await scope.withPlatform(
      (trx) => invitations.inviteUser(trx, { orgId: other.id, email: 'pending.person@identity.test', actor: { userId: null, kind: 'system' } }),
      { scope: 'auth', orgId: other.id },
    );
    expect(again).toMatchObject({ userId: pending.userId, newAccount: false, invitation: { link: expect.stringMatching(/\/invite#token=/) } });

    // The operator's command line issues a link for the active account too.
    const existing = await signIn(ctx, user);
    const before = await account();
    const invited = await adminCreateUser(db.config({}, 'cli'), { email: user.email, org: 'oth' }, ctx.moduleRef);
    expect(invited).toMatchObject({ newAccount: false, userId: user.id, handle: 'veteran' });
    const browser = new Browser(ctx.app);
    const missing = await browser.post(ACCEPT, { token: invited.token });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errors).toEqual([{ path: 'body.password', message: 'Enter the password of your account to accept the invitation' }]);
    // A different password, even a strong new one, is a wrong password: counted, nothing replaced, link kept.
    const replace = await browser.post(ACCEPT, { token: invited.token, password: NEW_PASSWORD });
    expect(replace.statusCode).toBe(401);
    expect(replace.json().messageKey).toBe('auth.invalid_credentials');
    expect(await account()).toEqual({ password_hash: before.password_hash, failed_login_count: 1 });
    expect(await membershipInOther()).toBe('invited');
    expect((await auditActions(db, user.id)).at(-1)).toMatchObject({ action: 'auth.login_failed', after: { via: 'invitation', reason: 'wrong_password' } });

    const accepted = await browser.post(ACCEPT, { token: invited.token, password: PASSWORD });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('mfa_required');
    expect(await account()).toEqual({ password_hash: before.password_hash, failed_login_count: 0 });
    expect(await membershipInOther()).toBe('active');
    const sessions = await openSessions(db, user.id);
    expect(sessions.at(-1)).toMatchObject({ organization_id: other.id, auth_org_id: other.id, password_at: ctx.clock.now(), state: 'mfa_pending' });
    // No session was revoked and no password reset happened.
    expect(sessions.map((s) => s.id_hash.toString('hex'))).toContain((await sessionRow(db, existing.session!)).id_hash.toString('hex'));
    expect((await auditActions(db, user.id)).map((a) => a.action)).not.toContain('auth.password_reset');
    expect((await existing.put(PREFERENCES, { theme: 'dark' })).statusCode).toBe(204);
  });

  it('runs admin create-user in its own application context with the licence module', async () => {
    await createTenant(db, 'boot');
    const created = await adminCreateUser(db.config({}, 'cli'), { email: 'first.admin@identity.test', tenantAdmin: true, org: 'boot' });
    expect(created).toMatchObject({ newAccount: true, handle: 'first.admin', orgSlug: 'boot' });
    expect(created.link).toMatch(new RegExp(`^${APP_ORIGIN}/invite#token=[A-Za-z0-9_-]{43}$`));
    await expect(adminCreateUser(db.config({}, 'cli'), { email: 'x@identity.test' })).rejects.toThrow(/Several organisations exist/);
    await expect(adminCreateUser(db.config({}, 'cli'), { email: 'x@identity.test', org: 'nope' })).rejects.toThrow(/No organisation with slug nope/);
  });
});
