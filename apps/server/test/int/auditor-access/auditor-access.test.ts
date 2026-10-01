// Guest auditor access (build plan F.14, D-27, D-34, F.3, F.5, D-15): a grant creates its own guest account and
// emails a single-use link; the link starts an emailed one-time code (10 minutes, 5 attempts) bound to the browser
// that used it; the guest then enrols TOTP; the guest only reads; revocation signs the guest out at once; an auditor
// with an existing account elsewhere gets a separate guest account; guests do not count towards max_users; the link
// never reaches the api log or the requester.
import type { AuditorAccessGrantView, AuditorAccessResult, LicenceView, LoginResponse, MfaEnrolConfirmResponse, MfaEnrolStartResponse } from '@mscd/shared';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totpAt } from '../../../src/modules/identity/totp';
import { SessionService } from '../../../src/modules/identity/session.service';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { Browser, resetRateLimits, startMailpit, type Mailpit } from '../identity/helpers';
import { createPackApp, ORG_IDS, type PackApp } from '../evidence-packs/helpers';

const GRANTS = '/api/v1/ms/isms/auditor-access';
const AUDITOR = 'lead.auditor@certifier.co.id';

describe('guest auditor access (F.14, D-27)', () => {
  const db = useTestDatabase('demo');
  let mail: Mailpit;
  let ctx: PackApp;
  let rina: Browser;

  const tst = <T>(fn: Parameters<typeof inScope<T>>[2]) => inScope(db.migrator, { orgId: ORG_IDS.tst, schema: 'org_tst' }, fn);
  const platform = <T>(fn: Parameters<typeof inScope<T>>[2]) => inScope(db.migrator, { platformScope: true }, fn);

  /** A browser holding an active session of a demo user in tst (written through SessionService). */
  const sessionOf = async (handle: string): Promise<Browser> => {
    const user = await platform((trx) => trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirstOrThrow());
    const now = ctx.clock.now();
    const issued = await ctx.moduleRef.get(TenantScope).withTenant({ orgId: ORG_IDS.tst, schema: 'org_tst', userId: user.id }, (trx) =>
      ctx.moduleRef.get(SessionService).create(trx, { userId: user.id, organizationId: ORG_IDS.tst, authOrgId: ORG_IDS.tst, state: 'active', authMethod: 'local', passwordAt: now, mfaAt: now }),
    );
    const browser = new Browser(ctx.app);
    browser.cookies.set('mscd_session', issued.cookieValue);
    browser.csrfToken = issued.csrfToken;
    return browser;
  };

  const linkFromMail = async (to: string): Promise<string> => {
    const message = await mail.waitFor(to, (m) => m.mailKind === 'account:guest_access_link');
    const match = /\/guest#([A-Za-z0-9_-]+)/.exec(message.text);
    if (!match) throw new Error(`No access link in ${message.text}`);
    return match[1]!;
  };

  /** The code of the guest_code email number `index` (0 = the first) to `to`, waiting until it arrives. */
  const codeFromMail = async (to: string, index: number): Promise<string> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const codes = (await mail.messages(to)).filter((m) => m.mailKind === 'account:guest_code');
      const message = codes[index];
      if (message) {
        const match = /one-time code is (\d{6})/.exec(message.text);
        if (!match) throw new Error(`No code in ${message.text}`);
        return match[1]!;
      }
      if (Date.now() > deadline) throw new Error(`Code email ${index} to ${to} did not arrive`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const codeMails = async (to: string) => (await mail.messages(to)).filter((m) => m.mailKind === 'account:guest_code').length;

  const grant = async (email: string, days?: number) => {
    const answer = await rina.post(GRANTS, { email, ...(days ? { expiresInDays: days } : {}) });
    expect(answer.statusCode).toBe(201);
    return answer.json() as AuditorAccessResult;
  };

  /** Enrols TOTP from an `mfa_enrolment` guest session and returns the secret. */
  const enrol = async (browser: Browser): Promise<Buffer> => {
    const start = await browser.post('/api/v1/auth/mfa/enrol/start', {});
    expect(start.statusCode).toBe(200);
    const secret = base32Decode((start.json() as MfaEnrolStartResponse).secret);
    ctx.clock.advance(30_000);
    const confirm = await browser.post('/api/v1/auth/mfa/enrol/confirm', { code: totpAt(secret, ctx.clock.now()) });
    expect(confirm.statusCode).toBe(200);
    const body = confirm.json() as MfaEnrolConfirmResponse;
    expect(body.me.user.handle).toMatch(/^guest-[0-9a-f]{8}$/);
    return secret;
  };

  beforeAll(async () => {
    mail = await startMailpit();
    ctx = await createPackApp(db, { mail });
    rina = await sessionOf('rina');
  });

  afterAll(async () => {
    await ctx?.close();
    await mail?.stop();
  });

  beforeEach(async () => {
    await resetRateLimits(db);
    // A new session for every test: tests move the clock past the idle timeout.
    rina = await sessionOf('rina');
  });

  it('a grant creates a guest account, an auditor role until the expiry and emails the link only to the auditor', async () => {
    const before = await rina.get('/api/v1/license');
    expect(before.statusCode).toBe(200);
    const activeBefore = (before.json() as LicenceView).activeUsers;

    const answer = await rina.post(GRANTS, { email: AUDITOR, expiresInDays: 10 });
    expect(answer.statusCode).toBe(201);
    const result = answer.json() as AuditorAccessResult;
    const token = await linkFromMail(AUDITOR);
    expect(answer.body).not.toContain(token);
    expect(answer.body).not.toMatch(/guest#/);
    expect(Date.parse(result.data!.expiresAt) - ctx.clock.now().getTime()).toBe(10 * 86_400_000);

    const row = await tst((trx) => trx.selectFrom('auditor_access_grant').selectAll().where('id', '=', result.data!.grantId).executeTakeFirstOrThrow());
    expect(row.token_hash.toString('hex')).not.toContain(token);
    const guest = await platform((trx) => trx.selectFrom('platform.app_user').selectAll().where('id', '=', row.user_id!).executeTakeFirstOrThrow());
    expect(guest).toMatchObject({ kind: 'guest', email: AUDITOR, mfa_required: true, password_hash: null, status: 'active' });
    expect(guest.handle).toMatch(/^guest-[0-9a-f]{8}$/);
    const role = await tst((trx) => trx.selectFrom('user_ms_role').selectAll().where('id', '=', row.user_ms_role_id!).executeTakeFirstOrThrow());
    expect(role.role).toBe('external_auditor');
    expect(role.valid_until?.getTime()).toBe(row.expires_at.getTime());
    const membership = await platform((trx) =>
      trx.selectFrom('platform.org_membership').selectAll().where('user_id', '=', guest.id).where('organization_id', '=', ORG_IDS.tst).executeTakeFirstOrThrow(),
    );
    expect(membership.status).toBe('active');

    // Guests are not counted towards max_users (D-15).
    const after = await rina.get('/api/v1/license');
    expect((after.json() as LicenceView).activeUsers).toBe(activeBefore);

    const list = await rina.get(GRANTS);
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as AuditorAccessGrantView[]).find((g) => g.id === row.id)!;
    expect(listed).toMatchObject({ email: AUDITOR, guestHandle: guest.handle, createdBy: 'rina', active: true, linkUsedAt: null, revokedAt: null });
    expect(list.body).not.toContain(token);

    const audit = await tst(async (trx) => (await sql<{ action: string }>`select action from audit_trail where entity_id = ${row.id}::uuid order by seq`.execute(trx)).rows);
    expect(audit.map((a) => a.action)).toEqual(['auditor_access.granted']);
  });

  it('the link works once, only in the browser that used it; the code expires and allows five attempts; then TOTP enrolment', async () => {
    const email = 'second.auditor@certifier.co.id';
    await grant(email);
    const token = await linkFromMail(email);

    const first = new Browser(ctx.app);
    const started = await first.post('/api/v1/auth/guest/start', { token });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ status: 'code_sent', emailHint: 's***@certifier.co.id' });
    expect(first.cookies.get('mscd_guest_tx')).toBeTruthy();
    const setCookie = String(started.headers['set-cookie']);
    expect(setCookie).toMatch(/mscd_guest_tx=.*Path=\/api\/v1\/auth\/guest\/.*HttpOnly/i);

    // A second browser with the same link fails: the link was used.
    const second = new Browser(ctx.app);
    expect((await second.post('/api/v1/auth/guest/start', { token })).statusCode).toBe(401);
    expect((await first.post('/api/v1/auth/guest/start', { token })).statusCode).toBe(401);
    // Without the binding cookie the code cannot be checked.
    const code = await codeFromMail(email, 0);
    expect((await second.post('/api/v1/auth/guest/verify', { code })).statusCode).toBe(401);
    // A public route needs the application's Origin (F.2).
    expect((await first.post('/api/v1/auth/guest/verify', { code }, { origin: 'https://evil.example' })).statusCode).toBe(403);

    // Five wrong codes end the transaction; the right code is refused afterwards.
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await first.post('/api/v1/auth/guest/verify', { code: wrong })).statusCode).toBe(401);
    expect((await first.post('/api/v1/auth/guest/verify', { code })).statusCode).toBe(401);

    // A returning guest asks for a new code; it expires after 10 minutes.
    const sent = await codeMails(email);
    const again = await first.post('/api/v1/auth/guest/login', { email });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'code_sent', emailHint: 's***@certifier.co.id' });
    const late = await codeFromMail(email, sent);
    ctx.clock.advance(10 * 60_000 + 1_000);
    expect((await first.post('/api/v1/auth/guest/verify', { code: late })).statusCode).toBe(401);

    // A fresh code within the window signs in to TOTP enrolment, then the session is active.
    const sentNow = await codeMails(email);
    await first.post('/api/v1/auth/guest/login', { email });
    const fresh = await codeFromMail(email, sentNow);
    const verified = await first.post('/api/v1/auth/guest/verify', { code: fresh });
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as LoginResponse).status).toBe('mfa_enrolment_required');
    expect(first.cookies.has('mscd_guest_tx')).toBe(false);
    await enrol(first);
    const me = await first.get('/api/v1/me');
    expect(me.statusCode).toBe(200);
    expect((me.json() as { rolesByMs: Record<string, string[]> }).rolesByMs.isms).toEqual(['external_auditor']);

    const session = await platform((trx) =>
      trx.selectFrom('platform.session').selectAll().where('id_hash', '=', createHash('sha256').update(first.session!, 'utf8').digest()).executeTakeFirstOrThrow(),
    );
    expect(session).toMatchObject({ auth_method: 'guest', auth_org_id: ORG_IDS.tst, state: 'active' });
    expect(session.auth_grant_id).toBeTruthy();
    expect(session.absolute_expires_at.getTime() - session.created_at.getTime()).toBeLessThanOrEqual(4 * 3_600_000 + 60_000);

    // The guest reads its system and cannot write.
    expect((await first.get('/api/v1/ui/ms/isms')).statusCode).toBe(200);
    expect((await first.post('/api/v1/ms/isms/evidence-packs', {})).statusCode).toBe(403);
    expect((await first.post(GRANTS, { email: 'x@y.co' })).statusCode).toBe(403);
    expect((await first.get('/api/v1/ui/ms/qms')).statusCode).toBeGreaterThanOrEqual(403);

    // A later visit (in another hour: the link uses above count towards the per-grant limit): code, then TOTP.
    await resetRateLimits(db);
    const later = new Browser(ctx.app);
    const count = await codeMails(email);
    await later.post('/api/v1/auth/guest/login', { email });
    const code2 = await codeFromMail(email, count);
    const pending = await later.post('/api/v1/auth/guest/verify', { code: code2 });
    expect((pending.json() as LoginResponse).status).toBe('mfa_required');
  });

  it('revocation signs the guest out at once and ends the role and membership; a second revocation is 409', async () => {
    const email = 'third.auditor@certifier.co.id';
    const result = await grant(email);
    const token = await linkFromMail(email);
    const guest = new Browser(ctx.app);
    expect((await guest.post('/api/v1/auth/guest/start', { token })).statusCode).toBe(200);
    const code = await codeFromMail(email, 0);
    expect((await guest.post('/api/v1/auth/guest/verify', { code })).statusCode).toBe(200);
    await enrol(guest);
    expect((await guest.get('/api/v1/ui/ms/isms')).statusCode).toBe(200);

    // A pending code transaction of another browser ends too.
    const other = new Browser(ctx.app);
    const count = await codeMails(email);
    await other.post('/api/v1/auth/guest/login', { email });
    const pendingCode = await codeFromMail(email, count);

    const revoked = await rina.post(`${GRANTS}/${result.data!.grantId}/revoke`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ ok: true, changed: ['isms'], count: 1 });
    expect((await guest.get('/api/v1/me')).statusCode).toBe(401);
    expect((await guest.get('/api/v1/ui/ms/isms')).statusCode).toBe(401);
    expect((await other.post('/api/v1/auth/guest/verify', { code: pendingCode })).statusCode).toBe(401);

    const row = await tst((trx) => trx.selectFrom('auditor_access_grant').selectAll().where('id', '=', result.data!.grantId).executeTakeFirstOrThrow());
    expect(row.revoked_at).not.toBeNull();
    const role = await tst((trx) => trx.selectFrom('user_ms_role').selectAll().where('id', '=', row.user_ms_role_id!).executeTakeFirstOrThrow());
    expect(role.valid_until!.getTime()).toBeLessThanOrEqual(ctx.clock.now().getTime());
    const membership = await platform((trx) =>
      trx.selectFrom('platform.org_membership').select('status').where('user_id', '=', row.user_id!).where('organization_id', '=', ORG_IDS.tst).executeTakeFirstOrThrow(),
    );
    expect(membership.status).toBe('disabled');
    const open = await platform((trx) => trx.selectFrom('platform.session').select('id_hash').where('auth_grant_id', '=', row.id).where('revoked_at', 'is', null).execute());
    expect(open).toHaveLength(0);

    // A returning guest gets the same answer and no code.
    const before = await codeMails(email);
    const login = await other.post('/api/v1/auth/guest/login', { email });
    expect(login.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await codeMails(email)).toBe(before);

    expect((await rina.post(`${GRANTS}/${row.id}/revoke`)).statusCode).toBe(409);
    expect((await rina.post(`${GRANTS}/00000000-0000-4000-8000-000000000999/revoke`)).statusCode).toBe(404);
    const audit = await tst(async (trx) => (await sql<{ action: string; after_data: { reason?: string } }>`select action, after_data from audit_trail where entity_id = ${row.id}::uuid order by seq`.execute(trx)).rows);
    expect(audit.map((a) => a.action)).toEqual(['auditor_access.granted', 'auditor_access.revoked']);
    expect(audit[1]!.after_data.reason).toBe('revoked');
  });

  it('an expired grant ends like a revoked one when grants are read', async () => {
    const email = 'fourth.auditor@certifier.co.id';
    const result = await grant(email, 1);
    const token = await linkFromMail(email);
    const guest = new Browser(ctx.app);
    await guest.post('/api/v1/auth/guest/start', { token });
    const code = await codeFromMail(email, 0);
    expect((await guest.post('/api/v1/auth/guest/verify', { code })).statusCode).toBe(200);
    ctx.clock.advance(86_400_000 + 60_000);
    rina = await sessionOf('rina');
    // Reading the grants closes the expired grant (its sessions, membership and role end).
    expect((await rina.get(GRANTS)).statusCode).toBe(200);
    const listed = ((await rina.get(GRANTS)).json() as AuditorAccessGrantView[]).find((g) => g.id === result.data!.grantId)!;
    expect(listed.active).toBe(false);
    const open = await platform((trx) => trx.selectFrom('platform.session').select('id_hash').where('auth_grant_id', '=', result.data!.grantId).where('revoked_at', 'is', null).execute());
    expect(open).toHaveLength(0);
    const audit = await tst(async (trx) => (await sql<{ after_data: { reason?: string } }>`select after_data from audit_trail where entity_id = ${result.data!.grantId}::uuid and action = 'auditor_access.revoked'`.execute(trx)).rows);
    expect(audit.map((a) => a.after_data.reason)).toEqual(['expired']);
  });

  it('a guest session never outlives its grant, even when nobody reads the grants', async () => {
    const email = 'late.auditor@certifier.co.id';
    const result = await grant(email, 1);
    const token = await linkFromMail(email);
    // Sign in two hours before the grant ends: the 4 hour guest limit would run past it.
    ctx.clock.advance(22 * 3_600_000);
    const guest = new Browser(ctx.app);
    expect((await guest.post('/api/v1/auth/guest/start', { token })).statusCode).toBe(200);
    const code = await codeFromMail(email, 0);
    expect((await guest.post('/api/v1/auth/guest/verify', { code })).statusCode).toBe(200);
    const row = await tst((trx) => trx.selectFrom('auditor_access_grant').select('expires_at').where('id', '=', result.data!.grantId).executeTakeFirstOrThrow());
    const session = await platform((trx) =>
      trx.selectFrom('platform.session').select(['absolute_expires_at', 'idle_expires_at']).where('auth_grant_id', '=', result.data!.grantId).where('revoked_at', 'is', null).executeTakeFirstOrThrow(),
    );
    expect(session.absolute_expires_at.getTime()).toBe(row.expires_at.getTime());
    expect(session.idle_expires_at.getTime()).toBeLessThanOrEqual(row.expires_at.getTime());
    // The session resolver refuses a session past its absolute expiry, and cleanup.expired revokes it.
  });

  it('an auditor who has an account in another organisation gets a separate guest account', async () => {
    const sari = await platform((trx) => trx.selectFrom('platform.app_user').select(['id', 'email']).where('handle', '=', 'sari').executeTakeFirstOrThrow());
    const result = await grant(sari.email);
    const row = await tst((trx) => trx.selectFrom('auditor_access_grant').selectAll().where('id', '=', result.data!.grantId).executeTakeFirstOrThrow());
    expect(row.user_id).not.toBe(sari.id);
    const guest = await platform((trx) => trx.selectFrom('platform.app_user').select(['kind', 'email']).where('id', '=', row.user_id!).executeTakeFirstOrThrow());
    expect(guest).toEqual({ kind: 'guest', email: sari.email });
    // Sari's own account gets no membership of tst and no role.
    const membership = await platform((trx) => trx.selectFrom('platform.org_membership').select('status').where('user_id', '=', sari.id).where('organization_id', '=', ORG_IDS.tst).executeTakeFirst());
    expect(membership).toBeUndefined();
  });

  it('only MS Managers grant; validation of the request', async () => {
    const maya = await sessionOf('maya');
    expect((await maya.post(GRANTS, { email: 'x@certifier.co.id' })).statusCode).toBe(403);
    expect((await maya.get(GRANTS)).statusCode).toBe(403);
    expect((await rina.post(GRANTS, { email: 'not-an-email' })).statusCode).toBe(400);
    expect((await rina.post(GRANTS, { email: 'a@b.co', expiresInDays: 31 })).statusCode).toBe(400);
    expect((await rina.post('/api/v1/ms/unknown/auditor-access', { email: 'a@b.co' })).statusCode).toBe(404);
  });

  it('per-grant limit: at most five codes an hour; the answer stays the same', async () => {
    const email = 'fifth.auditor@certifier.co.id';
    await grant(email);
    const browser = new Browser(ctx.app);
    for (let i = 0; i < 7; i += 1) {
      const answer = await browser.post('/api/v1/auth/guest/login', { email });
      expect(answer.statusCode).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await codeMails(email)).toBe(5);
    // An address without a grant gets the same answer and no email.
    const none = await browser.post('/api/v1/auth/guest/login', { email: 'nobody@certifier.co.id' });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ status: 'code_sent', emailHint: 'n***@certifier.co.id' });
  });

  it('no access link, token or code ever appears in the api log', async () => {
    const links = (await mail.messages())
      .map((m) => /\/guest#([A-Za-z0-9_-]+)/.exec(m.text)?.[1] ?? /one-time code is (\d{6})/.exec(m.text)?.[1])
      .filter((v): v is string => Boolean(v));
    expect(links.length).toBeGreaterThan(5);
    expect(ctx.logs.length).toBeGreaterThan(10);
    const log = ctx.logs.join('\n');
    expect(log).toContain('/api/v1/auth/guest/start');
    for (const value of links) {
      // A leaked code would appear as a JSON string value; a leaked token anywhere.
      if (value.length === 6) expect(log).not.toContain(`"${value}"`);
      else expect(log).not.toContain(value);
    }
  });
});
