// Multi-factor authentication against PostgreSQL and Mailpit (F.3, F.5): TOTP verification with replay protection,
// recovery codes (single use, audit, email), the per-user second-factor lock across sessions with doubling, decay
// and email, the per-session revocation after 10 failures, enrolment, re-enrolment without and with a proof and the
// revocation of the other sessions, the sessions of the same user still waiting to enrol (revoked at the first
// confirmation; a factor confirmed meanwhile is replaced only with its current code), and the factor reset.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { MfaService } from '../../../src/modules/identity/mfa.service';
import { hashSecret } from '../../../src/modules/identity/password-hasher';
import { RECOVERY_CODE_PATTERN, recoveryCodeKey } from '../../../src/modules/identity/recovery-codes';
import { SessionService } from '../../../src/modules/identity/session.service';
import { base32Decode, totpAt } from '../../../src/modules/identity/totp';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  addUser,
  auditActions,
  Browser,
  codeAt,
  COOKIE,
  createIdentityApp,
  openSessions,
  PASSWORD,
  resetRateLimits,
  sessionRow,
  signIn,
  startMailpit,
  type IdentityApp,
  type Mailpit,
  type TestUser,
} from './helpers';

const VERIFY = '/api/v1/auth/mfa/verify';
const ENROL_START = '/api/v1/auth/mfa/enrol/start';
const ENROL_CONFIRM = '/api/v1/auth/mfa/enrol/confirm';
const PREFERENCES = '/api/v1/me/preferences';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WRONG = '000000';

describe('WP-11 multi-factor authentication', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let ctx: IdentityApp;
  let ndt: CreatedTenant;

  const add = (handle: string, factor = true) => addUser(db, ctx.moduleRef, { handle, memberships: [{ org: ndt }], factor });
  /** A code that is surely wrong for the secret at the current time. */
  const wrongCode = (user: TestUser) => {
    const right = new Set([-1, 0, 1].map((o) => codeAt(user.secret!, ctx.clock, o)));
    let code = WRONG;
    while (right.has(code)) code = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    return code;
  };
  const appUser = (id: string) =>
    inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.app_user').select(['mfa_failed_count', 'mfa_lock_level', 'mfa_locked_until']).where('id', '=', id).executeTakeFirstOrThrow(),
    );
  const pendingBrowser = async (user: TestUser) => {
    const browser = new Browser(ctx.app);
    const response = await browser.login(user.email);
    expect(response.json().status).toBe('mfa_required');
    return browser;
  };

  beforeAll(async () => {
    mail = await startMailpit();
    ndt = await createTenant(db, 'ndt');
    ctx = await createIdentityApp(db, { mail });
  });
  afterAll(async () => {
    await ctx?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('accepts a TOTP code once and rejects a wrong or replayed code (F.5)', async () => {
    const user = await add('tess');
    const browser = await pendingBrowser(user);
    const wrong = await browser.post(VERIFY, { code: wrongCode(user) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ messageKey: 'auth.mfa_invalid' });
    expect((await appUser(user.id)).mfa_failed_count).toBe(1);
    expect((await auditActions(db, user.id)).at(-1)).toMatchObject({ action: 'auth.mfa_failed', after: { method: 'totp', consecutiveFailures: 1 }, organization_id: ndt.id });

    const code = codeAt(user.secret!, ctx.clock);
    expect((await browser.post(VERIFY, { code })).json().status).toBe('ok');
    expect((await appUser(user.id)).mfa_failed_count).toBe(0);

    // The same code, or one of an earlier step, never works again (last_used_step).
    const replay = await pendingBrowser(user);
    expect((await replay.post(VERIFY, { code })).statusCode).toBe(401);
    expect((await replay.post(VERIFY, { code: codeAt(user.secret!, ctx.clock, -1) })).statusCode).toBe(401);
    ctx.clock.advance(30_000);
    expect((await replay.post(VERIFY, { code: codeAt(user.secret!, ctx.clock) })).statusCode).toBe(200);
  });

  it('accepts each recovery code once, audits its use and emails the user (F.5)', async () => {
    const user = await add('reco');
    const codes = ['abcd-efgh-ij', 'bcde-fghi-jk', 'cdef-ghij-kl'];
    const hashes = await Promise.all(codes.map((c) => hashSecret(recoveryCodeKey(c))));
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.mfa_recovery_code').values(hashes.map((code_hash) => ({ user_id: user.id, code_hash }))).execute(),
    );
    const first = await pendingBrowser(user);
    const used = await first.post(VERIFY, { recoveryCode: 'bcde-fghi-jk' });
    expect(used.statusCode).toBe(200);
    expect(used.json().status).toBe('ok');
    const actions = await auditActions(db, user.id);
    expect(actions.find((a) => a.action === 'auth.recovery_code_used')).toMatchObject({ after: { remainingCodes: 2 }, organization_id: ndt.id });
    expect(actions.at(-1)).toMatchObject({ action: 'auth.login', after: { secondFactor: 'recovery_code' } });
    const message = await mail.waitFor(user.email, (m) => m.mailKind === 'security:recovery_code_used');
    expect(message.subject).toBe('[MSCD] A recovery code was used');
    expect(message.text).toContain('2 unused codes are left');

    const again = await pendingBrowser(user);
    expect((await again.post(VERIFY, { recoveryCode: 'bcde-fghi-jk' })).statusCode).toBe(401);
    expect((await again.post(VERIFY, { recoveryCode: 'zzzz-zzzz-zz' })).statusCode).toBe(401);
    expect((await again.post(VERIFY, { recoveryCode: 'cdef-ghij-kl' })).statusCode).toBe(200);
  });

  it('locks the second factor across sessions after 10 failures, doubling per lock and decaying per day, and emails the user (F.3)', async () => {
    const user = await add('locker');
    const lockAfterTenFailures = async () => {
      const a = await pendingBrowser(user);
      const b = await pendingBrowser(user);
      for (let i = 0; i < 5; i += 1) expect((await a.post(VERIFY, { code: wrongCode(user) })).statusCode).toBe(401);
      for (let i = 0; i < 5; i += 1) expect((await b.post(VERIFY, { code: wrongCode(user) })).statusCode).toBe(401);
      await resetRateLimits(db);
    };

    await lockAfterTenFailures();
    const firstLockAt = ctx.clock.now().getTime();
    expect(await appUser(user.id)).toEqual({ mfa_failed_count: 0, mfa_lock_level: 1, mfa_locked_until: new Date(firstLockAt + 15 * MINUTE) });
    const fresh = await pendingBrowser(user);
    const blocked = await fresh.post(VERIFY, { code: codeAt(user.secret!, ctx.clock) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/rate-limited', retryAfter: 900 });
    expect(blocked.headers['retry-after']).toBe('900');
    // The lock is checked before the code: no attempt was counted and no code was spent.
    expect((await appUser(user.id)).mfa_failed_count).toBe(0);
    const audit = await auditActions(db, user.id);
    expect(audit.filter((a) => a.action === 'auth.mfa_failed')).toHaveLength(10);
    expect(audit.filter((a) => a.action === 'auth.mfa_failed').map((a) => a.after?.consecutiveFailures)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(audit.find((a) => a.action === 'auth.mfa_locked')).toMatchObject({ after: { lockLevel: 1, lockMinutes: 15 }, organization_id: ndt.id });
    const email = await mail.waitFor(user.email, (m) => m.mailKind === 'security:mfa_locked');
    expect(email.subject).toBe('[MSCD] Two-step sign-in locked');

    ctx.clock.advance(15 * MINUTE + 1000);
    expect((await fresh.post(VERIFY, { code: codeAt(user.secret!, ctx.clock) })).statusCode).toBe(200);

    // A second lock within a day lasts twice as long.
    ctx.clock.advance(HOUR);
    await lockAfterTenFailures();
    const secondLockAt = ctx.clock.now().getTime();
    expect(await appUser(user.id)).toMatchObject({ mfa_lock_level: 2, mfa_locked_until: new Date(secondLockAt + 30 * MINUTE) });
    await mail.waitFor(user.email, (m) => m.mailKind === 'security:mfa_locked' && m.id !== email.id);
    expect((await mail.messages(user.email)).filter((m) => m.mailKind === 'security:mfa_locked')).toHaveLength(2);

    // Two days without a lock bring the level down by two: the next lock lasts 15 minutes again.
    ctx.clock.set(new Date(secondLockAt + 30 * MINUTE + 48 * HOUR + MINUTE));
    await lockAfterTenFailures();
    const thirdLockAt = ctx.clock.now().getTime();
    expect(await appUser(user.id)).toMatchObject({ mfa_lock_level: 1, mfa_locked_until: new Date(thirdLockAt + 15 * MINUTE) });
    ctx.clock.advance(16 * MINUTE);
  });

  it('revokes a session after 10 second-factor failures of that session (F.3)', async () => {
    const user = await add('stubborn');
    const browser = await pendingBrowser(user);
    const cookie = browser.session!;
    for (let i = 1; i <= 10; i += 1) {
      if (i === 6) await resetRateLimits(db);
      const response = await browser.post(VERIFY, { code: wrongCode(user) });
      expect(response.statusCode, `failure ${i}`).toBe(401);
    }
    expect((await sessionRow(db, cookie)).revoke_reason).toBe('mfa_failures');
    expect((await auditActions(db, user.id)).find((a) => a.action === 'auth.session_revoked')).toMatchObject({ after: { reason: 'mfa_failures' } });
    ctx.clock.advance(16 * MINUTE);
    expect((await browser.post(VERIFY, { code: codeAt(user.secret!, ctx.clock) })).statusCode).toBe(401);
  });

  it('answers database.pool_max and more concurrent wrong codes promptly and keeps serving requests (F.3)', async () => {
    const poolMax = db.config({}).profile.database.pool_max;
    const user = await add('crowd');
    // Four pending sessions with five wrong codes each (the route limit per session), all sent at once.
    const browsers = await Promise.all([1, 2, 3, 4].map(() => pendingBrowser(user)));
    const attempts = browsers.flatMap((b) => [1, 2, 3, 4, 5].map(() => b));
    expect(attempts.length).toBeGreaterThanOrEqual(poolMax);
    const code = wrongCode(user);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 15_000);
    });
    const all = Promise.all(attempts.map((b) => b.post(VERIFY, { code })));
    const settled = await Promise.race([all, deadline]);
    clearTimeout(timer);
    expect(settled, 'every second-factor request answers').not.toBe('timeout');
    const statuses = (settled as Awaited<typeof all>).map((r) => r.statusCode).sort();
    expect(Date.now() - started).toBeLessThan(10_000);
    // Ten failures lock the second factor; the attempts after the lock are 429 without a check.
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(attempts.length - 10);
    expect((await auditActions(db, user.id)).filter((a) => a.action === 'auth.mfa_failed')).toHaveLength(10);
    // The pool is free: a new sign-in answers at once.
    await resetRateLimits(db);
    const fresh = await new Browser(ctx.app).login(user.email);
    expect(fresh.statusCode).toBe(200);
    ctx.clock.advance(16 * MINUTE);
  }, 60_000);

  it('enrols a factor: new secret, confirmation, ten recovery codes, an active session and an email (F.5)', async () => {
    const user = await add('newbie', false);
    expect((await new Browser(ctx.app).post(ENROL_START, {})).statusCode).toBe(401);
    const browser = new Browser(ctx.app);
    expect((await browser.login(user.email)).json().status).toBe('mfa_enrolment_required');
    const pendingCookie = browser.session!;
    expect((await browser.post(VERIFY, { code: '123456' })).statusCode).toBe(401);
    expect((await browser.put(PREFERENCES, { a: 1 })).statusCode).toBe(401);

    const start = await browser.post(ENROL_START, {});
    expect(start.statusCode).toBe(200);
    const enrol = start.json();
    expect(enrol).toEqual({
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/),
      otpauthUrl: `otpauth://totp/MSCD:newbie%40identity.test?secret=${enrol.secret}&issuer=MSCD`,
      issuer: 'MSCD',
      account: user.email,
    });
    const secret = base32Decode(enrol.secret);
    // Starting again replaces the pending secret.
    const restart = (await browser.post(ENROL_START, {})).json();
    expect(restart.secret).not.toBe(enrol.secret);
    expect((await browser.post(ENROL_CONFIRM, { code: totpAt(secret, ctx.clock.now()) })).statusCode).toBe(401);
    const newSecret = base32Decode(restart.secret);

    const confirmed = await browser.post(ENROL_CONFIRM, { code: totpAt(newSecret, ctx.clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    const body = confirmed.json();
    expect(body.recoveryCodes).toHaveLength(10);
    for (const code of body.recoveryCodes) expect(code).toMatch(RECOVERY_CODE_PATTERN);
    expect(body.me.user.handle).toBe('newbie');
    expect(browser.session).not.toBe(pendingCookie);
    expect((await sessionRow(db, pendingCookie)).revoke_reason).toBe('rotated');
    expect((await sessionRow(db, browser.session!)).state).toBe('active');
    expect((await browser.put(PREFERENCES, { a: 1 })).statusCode).toBe(204);

    const factors = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.mfa_factor').select(['confirmed_at', 'deleted_at', 'last_used_step']).where('user_id', '=', user.id).orderBy('created_at').execute(),
    );
    expect(factors).toHaveLength(2);
    expect(factors[0]).toMatchObject({ confirmed_at: null, deleted_at: expect.any(Date) });
    expect(factors[1]).toMatchObject({ confirmed_at: expect.any(Date), deleted_at: null, last_used_step: String(Math.floor(ctx.clock.now().getTime() / 30_000)) });
    const actions = await auditActions(db, user.id);
    expect(actions.find((a) => a.action === 'auth.mfa_enrolled')).toMatchObject({ after: { replaced: false, recoveryCodes: 10 } });
    expect(actions.at(-1)).toMatchObject({ action: 'auth.login', after: { secondFactor: 'totp_enrolment' } });
    expect((await mail.waitFor(user.email, (m) => m.mailKind === 'security:mfa_enrolled')).subject).toBe('[MSCD] Authenticator added to your account');

    // The next sign-in asks for the second factor, and a recovery code of the enrolment works once.
    const later = await pendingBrowser(user);
    expect((await later.post(VERIFY, { recoveryCode: body.recoveryCodes[3] })).statusCode).toBe(200);
  });

  it('asks a recent proof for re-enrolment, then replaces the factor and revokes the other sessions (F.5)', async () => {
    const user = await add('reenrol');
    await inScope(db.migrator, { platformScope: true }, async (trx) =>
      trx.insertInto('platform.mfa_recovery_code').values({ user_id: user.id, code_hash: await hashSecret(recoveryCodeKey('aaaa-bbbb-cc')) }).execute(),
    );
    const a = await signIn(ctx, user);
    const b = await signIn(ctx, user);
    // Within 5 minutes of the sign-in no proof is needed.
    expect((await a.post(ENROL_START, {})).statusCode).toBe(200);

    ctx.clock.advance(6 * MINUTE);
    const missing = await a.post(ENROL_START, {});
    expect(missing.statusCode).toBe(401);
    expect(missing.json().messageKey).toBe('auth.proof_required');
    expect((await a.post(ENROL_START, { currentCode: wrongCode(user) })).json().messageKey).toBe('auth.proof_invalid');
    expect((await auditActions(db, user.id)).at(-1)).toMatchObject({ action: 'auth.mfa_failed' });
    expect((await a.post(ENROL_START, { password: 'Not-The-Password-1' })).json().messageKey).toBe('auth.proof_invalid');
    const withProof = await a.post(ENROL_START, { currentCode: codeAt(user.secret!, ctx.clock) });
    expect(withProof.statusCode).toBe(200);
    const secret = base32Decode(withProof.json().secret);

    const confirmed = await a.post(ENROL_CONFIRM, { code: totpAt(secret, ctx.clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    expect((await a.put(PREFERENCES, { r: 1 })).statusCode).toBe(204);
    expect((await b.put(PREFERENCES, { r: 1 })).statusCode).toBe(401);
    expect((await sessionRow(db, b.session!)).revoke_reason).toBe('mfa_reenrolled');
    expect(await openSessions(db, user.id)).toHaveLength(1);

    const actions = await auditActions(db, user.id);
    expect(actions.find((x) => x.action === 'auth.mfa_enrolled')).toMatchObject({ after: { replaced: true } });
    expect(actions.find((x) => x.action === 'auth.session_revoked')).toMatchObject({ after: { reason: 'mfa_reenrolled', sessions: 1 } });
    expect((await mail.waitFor(user.email, (m) => m.mailKind === 'security:mfa_replaced')).subject).toBe('[MSCD] Authenticator replaced');

    // The old factor and the old recovery codes are gone; the new factor works.
    ctx.clock.advance(30_000);
    const old = await pendingBrowser(user);
    expect((await old.post(VERIFY, { code: codeAt(user.secret!, ctx.clock) })).statusCode).toBe(401);
    expect((await old.post(VERIFY, { recoveryCode: 'aaaa-bbbb-cc' })).statusCode).toBe(401);
    expect((await old.post(VERIFY, { code: totpAt(secret, ctx.clock.now()) })).statusCode).toBe(200);

    // A password proof works too.
    ctx.clock.advance(6 * MINUTE);
    expect((await old.post(ENROL_START, { password: PASSWORD })).statusCode).toBe(200);
  });

  it('revokes the other sessions waiting to enrol when the first factor is confirmed, so none can replace it later (F.5)', async () => {
    const user = await add('twosess', false);
    // Someone who knows only the password signs in before the owner's first enrolment.
    const intruder = new Browser(ctx.app);
    expect((await intruder.login(user.email)).json().status).toBe('mfa_enrolment_required');
    const owner = new Browser(ctx.app);
    expect((await owner.login(user.email)).json().status).toBe('mfa_enrolment_required');
    const secret = base32Decode((await owner.post(ENROL_START, {})).json().secret);
    expect((await owner.post(ENROL_CONFIRM, { code: totpAt(secret, ctx.clock.now()) })).statusCode).toBe(200);

    expect((await sessionRow(db, intruder.session!)).revoke_reason).toBe('mfa_enrolled');
    expect((await openSessions(db, user.id)).map((s) => s.state)).toEqual(['active']);
    expect((await auditActions(db, user.id)).find((a) => a.action === 'auth.session_revoked')).toMatchObject({ after: { reason: 'mfa_enrolled', sessions: 1 } });

    // Past the recent-proof window the old session can neither start nor confirm an enrolment.
    ctx.clock.advance(10 * MINUTE);
    expect((await intruder.post(ENROL_START, {})).statusCode).toBe(401);
    expect((await intruder.post(ENROL_START, { password: PASSWORD })).statusCode).toBe(401);
    expect((await intruder.post(ENROL_CONFIRM, { code: totpAt(secret, ctx.clock.now()) })).statusCode).toBe(401);
    const enrolled = (await auditActions(db, user.id)).filter((a) => a.action === 'auth.mfa_enrolled');
    expect(enrolled.map((a) => a.after?.replaced)).toEqual([false]);
    expect((await owner.put(PREFERENCES, { kept: 1 })).statusCode).toBe(204);
    const later = await pendingBrowser(user);
    expect((await later.post(VERIFY, { code: totpAt(secret, ctx.clock.now()) })).statusCode).toBe(200);
  });

  it('asks a session still waiting to enrol for the current code before it replaces a factor confirmed meanwhile (F.5)', async () => {
    const user = await add('raced');
    const other = await signIn(ctx, user);
    // A session in mfa_enrolment although the user has a confirmed factor: a sign-in that read "no factor" just
    // before another session confirmed one. Its password proof is recent.
    const sessions = ctx.moduleRef.get(SessionService);
    const issued = await ctx.moduleRef
      .get(TenantScope)
      .withPlatform(
        (trx) => sessions.create(trx, { userId: user.id, organizationId: ndt.id, authOrgId: ndt.id, state: 'mfa_enrolment', authMethod: 'local', passwordAt: ctx.clock.now() }),
        { scope: 'auth' },
      );
    const raced = new Browser(ctx.app);
    raced.cookies.set(COOKIE, issued.cookieValue);
    raced.csrfToken = issued.csrfToken;
    const pendingFactors = () =>
      inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.selectFrom('platform.mfa_factor').select('id').where('user_id', '=', user.id).where('confirmed_at', 'is', null).where('deleted_at', 'is', null).execute(),
      );

    const empty = await raced.post(ENROL_START, {});
    expect(empty.statusCode).toBe(401);
    expect(empty.json().messageKey).toBe('auth.proof_required');
    // The password proves nothing the sign-in did not: it never replaces a factor from such a session.
    const password = await raced.post(ENROL_START, { password: PASSWORD });
    expect(password.statusCode).toBe(401);
    expect(password.json().messageKey).toBe('auth.proof_required');
    expect((await raced.post(ENROL_START, { currentCode: wrongCode(user) })).json().messageKey).toBe('auth.proof_invalid');
    expect(await pendingFactors()).toHaveLength(0);

    // With the current code it may start; the confirmation must follow within 5 minutes of that proof.
    ctx.clock.advance(30_000);
    const started = await raced.post(ENROL_START, { currentCode: codeAt(user.secret!, ctx.clock) });
    expect(started.statusCode).toBe(200);
    const secret = base32Decode(started.json().secret);
    ctx.clock.advance(6 * MINUTE);
    const late = await raced.post(ENROL_CONFIRM, { code: totpAt(secret, ctx.clock.now()) });
    expect(late.statusCode).toBe(401);
    expect(late.json().messageKey).toBe('auth.proof_required');
    expect((await auditActions(db, user.id)).some((a) => a.action === 'auth.mfa_enrolled')).toBe(false);
    expect((await other.put(PREFERENCES, { still: 1 })).statusCode).toBe(204);

    const again = await raced.post(ENROL_START, { currentCode: codeAt(user.secret!, ctx.clock) });
    expect(again.statusCode).toBe(200);
    const newSecret = base32Decode(again.json().secret);
    const confirmed = await raced.post(ENROL_CONFIRM, { code: totpAt(newSecret, ctx.clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    expect((await sessionRow(db, other.session!)).revoke_reason).toBe('mfa_reenrolled');
    expect((await auditActions(db, user.id)).find((a) => a.action === 'auth.mfa_enrolled')).toMatchObject({ after: { replaced: true } });
  });

  it('refuses enrolment from a session that still owes its second factor', async () => {
    const user = await add('owing');
    const browser = await pendingBrowser(user);
    expect((await browser.post(ENROL_START, {})).statusCode).toBe(401);
  });

  it('resets a factor: factors and codes removed, every session revoked, audited and emailed (F.5)', async () => {
    const user = await add('resetme');
    const browser = await signIn(ctx, user);
    const mfa = ctx.moduleRef.get(MfaService);
    await ctx.moduleRef.get(TenantScope).withPlatform((trx) => mfa.resetFactor(trx, user.id, { organizationId: ndt.id, actor: { userId: null, kind: 'operator' } }), {
      scope: 'operator',
    });
    expect((await browser.put(PREFERENCES, { z: 1 })).statusCode).toBe(401);
    expect(await openSessions(db, user.id)).toHaveLength(0);
    expect((await auditActions(db, user.id)).at(-1)).toMatchObject({ action: 'auth.mfa_reset', after: { sessionsRevoked: 1 }, organization_id: ndt.id });
    expect((await mail.waitFor(user.email, (m) => m.mailKind === 'account:mfa_reset')).subject).toBe('[MSCD] Your two-step sign-in was reset');
    expect((await new Browser(ctx.app).login(user.email)).json().status).toBe('mfa_enrolment_required');
  });
});
