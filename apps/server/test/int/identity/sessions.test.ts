// Local sign-in and sessions against PostgreSQL (F.1 to F.4, F.7 session resolution): the password step, the
// generic failure, the account lockout and the login rate limit, the local sign-in policy (`auth.sso_required`,
// `admins_only`, the organisation pin), cookie rotation, idle and absolute expiry with a mocked clock, "keep me
// signed in", logout, the CSRF token and the Origin check, the organisation status rule and preferences.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { Controller } from '@nestjs/common';
import { defineRoute, NoBody } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiRoute } from '../../../src/common/api-route';
import { sql } from 'kysely';
import { SESSION_RESOLVER, type Principal, type SessionResolver } from '../../../src/common/tokens';
import { GuestOtpResolverRegistry } from '../../../src/modules/identity/guest-otp';
import { PreferencesService } from '../../../src/modules/identity/preferences.service';
import { SessionService } from '../../../src/modules/identity/session.service';
import { csrfTokenFor, sha256 } from '../../../src/modules/identity/tokens';
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
  codeAt,
  COOKIE,
  createIdentityApp,
  openSessions,
  PASSWORD,
  resetRateLimits,
  sessionRow,
  setLocalLogin,
  setOrgStatus,
  signIn,
  type IdentityApp,
  type TestUser,
} from './helpers';

const PREFERENCES = '/api/v1/me/preferences';

/** Business routes of no other work package, to probe the organisation status rule (F.7). */
const probeRead = defineRoute({ id: 'probe.read', owner: 'WP-11', method: 'GET', path: '/api/v1/probe/read', summary: 'Probe business read', auth: 'session', response: z.object({ ok: z.boolean() }), errors: [] });
const probeWrite = defineRoute({ id: 'probe.write', owner: 'WP-11', method: 'POST', path: '/api/v1/probe/write', summary: 'Probe business write', auth: 'session', response: NoBody, status: 204, errors: [] });

@Controller()
class ProbeController {
  @ApiRoute(probeRead)
  read() {
    return { ok: true };
  }

  @ApiRoute(probeWrite)
  write(): void {}
}
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('WP-11 local sign-in and sessions', () => {
  const db = useTestDatabase('empty');
  let ctx: IdentityApp;
  let ndt: CreatedTenant;
  let sso: CreatedTenant;
  let adm: CreatedTenant;
  let users: Record<string, TestUser>;

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt');
    sso = await createTenant(db, 'sso');
    adm = await createTenant(db, 'adm');
    ctx = await createIdentityApp(db, { controllers: [ProbeController] });
    await setLocalLogin(db, ctx.moduleRef, sso.id, 'disabled');
    await setLocalLogin(db, ctx.moduleRef, adm.id, 'admins_only');
    await addProvider(db, sso.id, 'entra', 'Sign in with Microsoft');
    const add = (handle: string, input: Omit<Parameters<typeof addUser>[2], 'handle'>) => addUser(db, ctx.moduleRef, { handle, ...input });
    users = {
      rina: await add('rina', { memberships: [{ org: ndt }], factor: true }),
      bagus: await add('bagus', { memberships: [{ org: ndt }], factor: true }),
      newbie: await add('newbie', { memberships: [{ org: ndt }] }),
      multi: await add('multi', { memberships: [{ org: sso, isDefault: true }, { org: ndt, isDefault: false }], factor: true }),
      ssoonly: await add('ssoonly', { memberships: [{ org: sso }], factor: true }),
      admin1: await add('admin1', { memberships: [{ org: adm, adminRoles: ['tenant_admin'] }], factor: true }),
      plain1: await add('plain1', { memberships: [{ org: adm }], factor: true }),
      disabled: await add('disabled', { memberships: [{ org: ndt }], factor: true, status: 'disabled' }),
      invited: await add('invited', { memberships: [{ org: ndt, status: 'invited' }], password: null, status: 'invited' }),
      locky: await add('locky', { memberships: [{ org: ndt }], factor: true }),
      operator: await add('operator', { memberships: [] }),
      suspendy: await add('suspendy', { memberships: [{ org: adm, adminRoles: ['tenant_admin'] }], factor: true }),
    };
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.platform_role').values({ user_id: users.operator!.id, role: 'platform_operator' }).execute(),
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('signs in with password, then TOTP, rotating the session cookie at each step (F.1)', async () => {
    const browser = new Browser(ctx.app);
    const first = await browser.login(users.rina!.email);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'mfa_required', csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const pending = browser.session!;
    expect(first.cookies).toContainEqual(expect.objectContaining({ name: COOKIE, httpOnly: true, sameSite: 'Lax', path: '/' }));
    expect((first.cookies as { name: string; maxAge?: number }[]).find((c) => c.name === COOKIE)?.maxAge).toBeUndefined();

    const [pendingRow] = await openSessions(db, users.rina!.id);
    expect(pendingRow).toMatchObject({ state: 'mfa_pending', auth_method: 'local', organization_id: ndt.id, auth_org_id: ndt.id, mfa_at: null, persistent: false });
    expect(pendingRow!.id_hash.equals(sha256(pending))).toBe(true);
    expect(pendingRow!.csrf_token_hash.equals(sha256(first.json().csrfToken))).toBe(true);
    expect(pendingRow!.password_at?.getTime()).toBe(ctx.clock.now().getTime());

    // A session in mfa_pending does not pass the guard of business routes.
    expect((await browser.put(PREFERENCES, { lang: 'en' })).statusCode).toBe(401);

    ctx.clock.advance(30_000);
    const second = await browser.post('/api/v1/auth/mfa/verify', { code: codeAt(users.rina!.secret!, ctx.clock) });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.status).toBe('ok');
    expect(body.me).toMatchObject({ user: { id: users.rina!.id, handle: 'rina', email: users.rina!.email }, org: { id: ndt.id, slug: 'ndt' }, session: { authMethod: 'local' } });
    expect(body.me.csrfToken).toBe(body.csrfToken);
    const active = browser.session!;
    expect(active).not.toBe(pending);
    expect(body.csrfToken).toBe(csrfTokenFor(active));
    expect(body.csrfToken).not.toBe(first.json().csrfToken);

    const rows = await openSessions(db, users.rina!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'active', auth_org_id: ndt.id });
    expect(rows[0]!.mfa_at?.getTime()).toBe(ctx.clock.now().getTime());
    expect((await sessionRow(db, pending)).revoke_reason).toBe('rotated');

    expect((await browser.put(PREFERENCES, { lang: 'en' })).statusCode).toBe(204);
    // The pre-MFA cookie is dead.
    const stale = new Browser(ctx.app);
    stale.cookies.set(COOKIE, pending);
    stale.csrfToken = first.json().csrfToken;
    expect((await stale.put(PREFERENCES, { lang: 'en' })).statusCode).toBe(401);

    const actions = await auditActions(db, users.rina!.id);
    expect(actions.at(-1)).toMatchObject({ action: 'auth.login', organization_id: ndt.id, after: { method: 'local', secondFactor: 'totp' } });
  });

  it('answers one generic 401 for an unknown email, a wrong password, a disabled and an invited account (D.3)', async () => {
    const problems = [];
    for (const [email, password] of [
      ['nobody@identity.test', PASSWORD],
      [users.bagus!.email, 'Wrong-Password-1234'],
      [users.disabled!.email, PASSWORD],
      [users.invited!.email, PASSWORD],
    ] as const) {
      const response = await new Browser(ctx.app).login(email, password);
      expect(response.statusCode, email).toBe(401);
      expect(response.cookies.find((c: { name: string }) => c.name === COOKIE), email).toBeUndefined();
      const { requestId, ...problem } = response.json();
      expect(requestId).toBeTruthy();
      problems.push(problem);
    }
    expect(problems[0]).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/unauthenticated', status: 401, messageKey: 'auth.invalid_credentials' });
    for (const problem of problems) expect(problem).toEqual(problems[0]);
    expect(await openSessions(db, users.disabled!.id)).toHaveLength(0);
    const failures = (await auditActions(db, users.bagus!.id)).filter((a) => a.action === 'auth.login_failed');
    expect(failures.at(-1)).toMatchObject({ after: { reason: 'wrong_password', method: 'local' }, organization_id: ndt.id });
    expect((await auditActions(db, users.disabled!.id)).at(-1)).toMatchObject({ action: 'auth.login_failed', after: { reason: 'account_disabled' } });
    // A later correct password clears the failure count.
    expect((await new Browser(ctx.app).login(users.bagus!.email)).statusCode).toBe(200);
  });

  it('locks an account for 15 minutes after 10 consecutive wrong passwords, behind the per-email rate limit (F.3)', async () => {
    const email = users.locky!.email;
    for (let i = 1; i <= 10; i += 1) {
      const response = await new Browser(ctx.app).login(email, `Wrong-Password-${i}x`);
      expect(response.statusCode, `attempt ${i}`).toBe(401);
      expect(response.headers['ratelimit-limit']).toBeDefined();
    }
    const limited = await new Browser(ctx.app).login(email);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/rate-limited' });

    await resetRateLimits(db);
    const locked = await new Browser(ctx.app).login(email);
    expect(locked.statusCode).toBe(401);
    expect(locked.json().messageKey).toBe('auth.invalid_credentials');
    const audit = (await auditActions(db, users.locky!.id)).filter((a) => a.action === 'auth.login_failed');
    expect(audit[9]?.after).toMatchObject({ reason: 'wrong_password', lockedUntil: new Date(ctx.clock.now().getTime() + 15 * MINUTE).toISOString() });
    expect(audit.at(-1)?.after).toMatchObject({ reason: 'locked' });

    ctx.clock.advance(15 * MINUTE + 1000);
    const after = await new Browser(ctx.app).login(email);
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe('mfa_required');
    const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.app_user').select(['failed_login_count', 'locked_until']).where('id', '=', users.locky!.id).executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ failed_login_count: 0, locked_until: null });
  });

  it('limits sign-in attempts per address to 30 in 15 minutes (F.3)', async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await new Browser(ctx.app).login(`probe${i}@identity.test`, 'Wrong-Password-1234');
      expect(response.statusCode, `attempt ${i + 1}`).toBe(401);
    }
    expect((await new Browser(ctx.app).login('probe-last@identity.test', 'Wrong-Password-1234')).statusCode).toBe(429);
  });

  it('refuses local sign-in with auth.sso_required and the providers, only after a correct password (F.4)', async () => {
    const wrong = await new Browser(ctx.app).login(users.ssoonly!.email, 'Wrong-Password-1234');
    expect(wrong.json().messageKey).toBe('auth.invalid_credentials');
    const refused = await new Browser(ctx.app).login(users.ssoonly!.email);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({
      messageKey: 'auth.sso_required',
      methods: { local: false, providers: [{ slug: 'entra', kind: 'oidc', label: 'Sign in with Microsoft', icon: 'microsoft' }] },
    });
    expect(await openSessions(db, users.ssoonly!.id)).toHaveLength(0);
    expect((await auditActions(db, users.ssoonly!.id)).at(-1)).toMatchObject({ action: 'auth.login_failed', after: { reason: 'sso_required' }, organization_id: sso.id });

    // admins_only: Tenant and Storage Admins only.
    expect((await new Browser(ctx.app).login(users.admin1!.email)).json().status).toBe('mfa_required');
    expect((await new Browser(ctx.app).login(users.plain1!.email)).json().messageKey).toBe('auth.sso_required');

    // A member of an SSO-only and a local organisation is pinned to the one that accepts the password (D-26).
    expect((await new Browser(ctx.app).login(users.multi!.email)).statusCode).toBe(200);
    const [pinned] = await openSessions(db, users.multi!.id);
    expect(pinned).toMatchObject({ organization_id: ndt.id, auth_org_id: ndt.id });
  });

  it('signs in a platform operator without memberships without an organisation, and starts enrolment for users without a factor', async () => {
    const op = await new Browser(ctx.app).login(users.operator!.email);
    expect(op.json().status).toBe('mfa_enrolment_required');
    const [row] = await openSessions(db, users.operator!.id);
    expect(row).toMatchObject({ state: 'mfa_enrolment', organization_id: null, auth_org_id: null });
    expect((await new Browser(ctx.app).login(users.newbie!.email)).json().status).toBe('mfa_enrolment_required');
  });

  it('ends sessions after 60 idle minutes and refreshes the idle expiry at most once per minute (F.1)', async () => {
    const browser = await signIn(ctx, users.bagus!);
    const cookie = browser.session!;
    const start = ctx.clock.now().getTime();
    let row = await sessionRow(db, cookie);
    expect(row.idle_expires_at.getTime()).toBe(start + 60 * MINUTE);
    expect(row.absolute_expires_at.getTime()).toBe(start - 30_000 + 8 * HOUR);

    ctx.clock.advance(30_000);
    expect((await browser.put(PREFERENCES, { a: 1 })).statusCode).toBe(204);
    row = await sessionRow(db, cookie);
    expect(row.last_seen_at.getTime()).toBe(start);

    ctx.clock.advance(59 * MINUTE);
    expect((await browser.put(PREFERENCES, { a: 2 })).statusCode).toBe(204);
    row = await sessionRow(db, cookie);
    expect(row.last_seen_at.getTime()).toBe(ctx.clock.now().getTime());
    expect(row.idle_expires_at.getTime()).toBe(ctx.clock.now().getTime() + 60 * MINUTE);

    ctx.clock.advance(60 * MINUTE);
    expect((await browser.put(PREFERENCES, { a: 3 })).statusCode).toBe(401);
    expect((await sessionRow(db, cookie)).revoke_reason).toBe('expired');
  });

  it('ends sessions at the absolute limit: 8 hours, or 12 hours with "keep me signed in" and a persistent cookie (F.1)', async () => {
    const normal = await signIn(ctx, users.bagus!);
    for (let i = 0; i < 9; i += 1) {
      ctx.clock.advance(50 * MINUTE);
      expect((await normal.put(PREFERENCES, { b: i })).statusCode, `after ${(i + 1) * 50} minutes`).toBe(204);
    }
    ctx.clock.advance(31 * MINUTE);
    expect((await normal.put(PREFERENCES, { b: 'late' })).statusCode).toBe(401);

    const remembered = new Browser(ctx.app);
    const first = await remembered.login(users.bagus!.email, PASSWORD, true);
    const cookie = (first.cookies as { name: string; maxAge?: number }[]).find((c) => c.name === COOKIE);
    expect(cookie?.maxAge).toBe(12 * 3600);
    ctx.clock.advance(30_000);
    const second = await remembered.post('/api/v1/auth/mfa/verify', { code: codeAt(users.bagus!.secret!, ctx.clock) });
    const rotated = (second.cookies as { name: string; maxAge?: number }[]).find((c) => c.name === COOKIE);
    expect(rotated?.maxAge).toBe(12 * 3600 - 30);
    for (let i = 0; i < 13; i += 1) {
      ctx.clock.advance(55 * MINUTE);
      expect((await remembered.put(PREFERENCES, { c: i })).statusCode, `after ${(i + 1) * 55} minutes`).toBe(204);
    }
    ctx.clock.advance(55 * MINUTE);
    expect((await remembered.put(PREFERENCES, { c: 'late' })).statusCode).toBe(401);
  });

  it('logs out: revokes the session, clears the cookie and audits auth.logout (D.3)', async () => {
    const browser = await signIn(ctx, users.bagus!);
    const session = browser.session!;
    expect((await browser.post('/api/v1/auth/logout', undefined, { csrf: false })).statusCode).toBe(403);
    const out = await browser.post('/api/v1/auth/logout');
    expect(out.statusCode).toBe(204);
    expect(out.cookies).toContainEqual(expect.objectContaining({ name: COOKIE, value: '' }));
    expect(browser.session).toBeUndefined();
    const stale = new Browser(ctx.app);
    stale.cookies.set(COOKIE, session);
    stale.csrfToken = browser.csrfToken;
    expect((await stale.put(PREFERENCES, { d: 1 })).statusCode).toBe(401);
    expect((await auditActions(db, users.bagus!.id)).at(-1)).toMatchObject({ action: 'auth.logout', organization_id: ndt.id });
    expect((await sessionRow(db, session)).revoke_reason).toBe('logout');
  });

  it('refuses non-GET requests of a session without the right X-CSRF-Token (F.2)', async () => {
    const browser = await signIn(ctx, users.bagus!);
    const other = await signIn(ctx, users.rina!);
    for (const csrf of [false, 'wrong-token-value-0123456789abcdef', other.csrfToken!] as const) {
      const response = await browser.put(PREFERENCES, { e: 1 }, { csrf });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/csrf' });
    }
    expect((await browser.put(PREFERENCES, { e: 1 })).statusCode).toBe(204);

    // A session in the second-factor step must send its token too.
    const pending = new Browser(ctx.app);
    await pending.login(users.rina!.email);
    ctx.clock.advance(30_000);
    expect((await pending.post('/api/v1/auth/mfa/verify', { code: codeAt(users.rina!.secret!, ctx.clock) }, { csrf: false })).statusCode).toBe(403);
  });

  it('checks the Origin of public POST routes (F.2)', async () => {
    const foreign = await new Browser(ctx.app).post('/api/v1/auth/login', { email: users.bagus!.email, password: PASSWORD, remember: false }, { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().type).toBe('https://mscd.cyberlentera.com/problems/csrf');
    expect((await new Browser(ctx.app).post('/api/v1/auth/login', { email: users.bagus!.email, password: PASSWORD, remember: false }, { origin: 'null' })).statusCode).toBe(403);
    expect(
      (await new Browser(ctx.app).post('/api/v1/auth/password/reset-request', { email: users.bagus!.email }, { origin: null, headers: { referer: 'https://evil.example/page' } })).statusCode,
    ).toBe(403);
    expect(
      (await new Browser(ctx.app).post('/api/v1/auth/password/reset-request', { email: users.bagus!.email }, { origin: null, headers: { referer: `${APP_ORIGIN}/forgot-password` } })).statusCode,
    ).toBe(202);
    // Without Origin and Referer: a body a page of another site could send (a form or text/plain, as older browsers
    // send them without Origin) is refused; a JSON body needs a CORS preflight, so it comes from a program.
    const login = { email: users.bagus!.email, password: PASSWORD, remember: false };
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const crossSite = await new Browser(ctx.app).post('/api/v1/auth/login', JSON.stringify(login), { origin: null, headers: { 'content-type': type } });
      expect(crossSite.statusCode, type).toBe(403);
      expect(crossSite.json().type).toBe('https://mscd.cyberlentera.com/problems/csrf');
    }
    // A body without a content type never reaches a route (Fastify refuses it before the CSRF hook).
    const untyped = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/reset-request', payload: Buffer.from(JSON.stringify({ email: users.bagus!.email })) });
    expect(untyped.statusCode).toBe(400);
    expect(untyped.json().detail).toBe('Unsupported Media Type');
    expect((await new Browser(ctx.app).post('/api/v1/auth/login', login, { origin: null })).statusCode).toBe(200);
  });

  it('answers 403 organisation-inactive on business routes of a suspended organisation, and allows reads while offboarding (F.7)', async () => {
    const browser = await signIn(ctx, users.suspendy!);
    const inactive = 'https://mscd.cyberlentera.com/problems/organisation-inactive';
    expect((await browser.post('/api/v1/probe/write')).statusCode).toBe(204);

    await setOrgStatus(db, ctx.moduleRef, adm.id, 'suspended');
    for (const response of [await browser.post('/api/v1/probe/write'), await browser.get('/api/v1/probe/read'), await browser.get('/api/v1/admin/audit-trail')]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().type).toBe(inactive);
    }
    // The user's own session routes are not business routes.
    expect((await browser.put(PREFERENCES, { f: 1 })).statusCode).toBe(204);

    await setOrgStatus(db, ctx.moduleRef, adm.id, 'offboarding');
    expect((await browser.get('/api/v1/probe/read')).json()).toEqual({ ok: true });
    expect((await browser.get('/api/v1/admin/audit-trail')).json().type).toBe('https://mscd.cyberlentera.com/problems/forbidden');
    expect((await browser.post('/api/v1/probe/write')).json().type).toBe(inactive);

    await setOrgStatus(db, ctx.moduleRef, adm.id, 'active');
    expect((await browser.post('/api/v1/probe/write')).statusCode).toBe(204);

    // A disabled membership in the session's organisation is refused the same way.
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.org_membership').set({ status: 'disabled' }).where('user_id', '=', users.suspendy!.id).execute(),
    );
    expect((await browser.get('/api/v1/probe/read')).json().type).toBe(inactive);

    // Sign-in steps are not business routes: logout still works.
    await setOrgStatus(db, ctx.moduleRef, adm.id, 'suspended');
    expect((await browser.post('/api/v1/auth/logout')).statusCode).toBe(204);
    await setOrgStatus(db, ctx.moduleRef, adm.id, 'active');
  });

  it('refuses the sessions of a user who was disabled', async () => {
    const browser = await signIn(ctx, users.bagus!);
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.app_user').set({ status: 'disabled' }).where('id', '=', users.bagus!.id).execute());
    expect((await browser.put(PREFERENCES, { g: 1 })).statusCode).toBe(401);
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.app_user').set({ status: 'active' }).where('id', '=', users.bagus!.id).execute());
  });

  it('revokes the session a browser presents when it signs in again', async () => {
    const browser = await signIn(ctx, users.bagus!);
    const before = browser.session!;
    expect((await browser.login(users.bagus!.email)).statusCode).toBe(200);
    expect(browser.session).not.toBe(before);
    expect((await sessionRow(db, before)).revoke_reason).toBe('signed_in_again');
  });

  it('merges preferences of up to 16 KiB in all (D.3 PUT /me/preferences)', async () => {
    const browser = await signIn(ctx, users.rina!);
    const service = ctx.moduleRef.get(PreferencesService);
    expect((await browser.put(PREFERENCES, { lang: 'id', density: 'compact' })).statusCode).toBe(204);
    expect((await browser.put(PREFERENCES, { density: null, theme: { mode: 'dark' } })).statusCode).toBe(204);
    expect(await service.get(users.rina!.id)).toMatchObject({ lang: 'id', theme: { mode: 'dark' } });
    expect(await service.get(users.rina!.id)).not.toHaveProperty('density');
    expect((await browser.put(PREFERENCES, { 'bad key': 1 })).statusCode).toBe(400);
    expect((await browser.put(PREFERENCES, { big1: 'x'.repeat(9000) })).statusCode).toBe(204);
    const tooMuch = await browser.put(PREFERENCES, { big2: 'x'.repeat(9000) });
    expect(tooMuch.statusCode).toBe(413);
    expect(await service.get(users.rina!.id)).not.toHaveProperty('big2');
  });

  describe('services for other modules', () => {
    it('revokes sessions by organisation, grant and provider from a tenant transaction, restoring the platform scope (F.1)', async () => {
      const sessions = ctx.moduleRef.get(SessionService);
      const scope = ctx.moduleRef.get(TenantScope);
      const providerId = await addProvider(db, ndt.id, 'keycloak', 'Sign in with Keycloak');
      const grantId = '6f1d2c3b-4a59-4e68-8d7c-0b1a2c3d4e5f';
      const issued = await scope.withPlatform(
        async (trx) => ({
          sso: await sessions.create(trx, { userId: users.rina!.id, organizationId: ndt.id, authOrgId: ndt.id, state: 'active', authMethod: 'oidc', identityProviderId: providerId, amr: ['pwd'] }),
          guest: await sessions.create(trx, { userId: users.bagus!.id, organizationId: ndt.id, authOrgId: ndt.id, state: 'mfa_pending', authMethod: 'guest', authGrantId: grantId }),
        }),
        { scope: 'auth' },
      );
      // Guest sessions get the guest timeouts (F.1): 30 minutes idle, 4 hours absolute.
      expect(issued.guest.row.absolute_expires_at.getTime() - ctx.clock.now().getTime()).toBe(4 * HOUR);
      expect(issued.guest.row.idle_expires_at.getTime() - ctx.clock.now().getTime()).toBe(30 * MINUTE);
      const bagus = await signIn(ctx, users.bagus!);

      const counts = await scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: users.rina!.id }, async (trx) => {
        const provider = await sessions.revokeProviderSessions(trx, providerId);
        const grant = await sessions.revokeGrantSessions(trx, grantId);
        const membership = await sessions.revokeOrganisationSessions(trx, ndt.id, 'membership_removed', { userId: users.bagus!.id });
        const { rows } = await sql<{ scope: string }>`select coalesce(current_setting('app.platform_scope', true), '') as scope`.execute(trx);
        return { provider, grant, membership, scope: rows[0]!.scope };
      });
      expect(counts).toMatchObject({ provider: 1, grant: 1, scope: '' });
      expect(counts.membership).toBeGreaterThanOrEqual(1);
      expect((await sessionRow(db, issued.sso.cookieValue)).revoke_reason).toBe('idp_disabled');
      expect((await sessionRow(db, issued.guest.cookieValue)).revoke_reason).toBe('grant_revoked');
      expect((await bagus.put(PREFERENCES, { h: 1 })).statusCode).toBe(401);
      expect((await sessionRow(db, bagus.session!)).revoke_reason).toBe('membership_removed');
    });

    it('rotates a session into another organisation for an organisation switch (D-26) and keeps its absolute expiry', async () => {
      const browser = await signIn(ctx, users.multi!);
      const sessions = ctx.moduleRef.get(SessionService);
      const before = await sessionRow(db, browser.session!);
      const issued = await ctx.moduleRef.get(TenantScope).withPlatform((trx) => sessions.rotate(trx, before, { organizationId: sso.id }), { scope: 'auth' });
      expect(issued.row).toMatchObject({ organization_id: sso.id, auth_org_id: ndt.id, state: 'active', absolute_expires_at: before.absolute_expires_at });
      expect((await sessionRow(db, browser.session!)).revoke_reason).toBe('rotated');
      expect(issued.csrfToken).toBe(csrfTokenFor(issued.cookieValue));
    });

    it('resolves the guest one-time code caller through the registered resolver only (F.14)', async () => {
      const resolver = ctx.moduleRef.get<SessionResolver>(SESSION_RESOLVER);
      const request = { headers: {}, cookies: {} } as unknown as FastifyRequest;
      expect(await resolver.resolve(request, 'guest_otp')).toBeNull();
      const guest = { user: { id: users.bagus!.id, handle: 'bagus', email: users.bagus!.email, displayName: 'Bagus', jobTitle: null, kind: 'guest' }, org: null, session: null, guestTransactionId: 'tx-1' } as Principal;
      ctx.moduleRef.get(GuestOtpResolverRegistry).register({ resolve: async () => guest });
      expect(await resolver.resolve(request, 'guest_otp')).toBe(guest);
      expect(await resolver.resolve(request, 'session')).toBeNull();
    });
  });
});
