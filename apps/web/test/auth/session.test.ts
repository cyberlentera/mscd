// Boot decision of the API build (H.7) and the hand-over between sign-in steps, with a fake fetch.
import { describe, expect, it } from 'vitest';
import { continueSignIn } from '../../src/auth/context';
import { normaliseRecoveryCode } from '../../src/auth/MfaPage';
import { checkNewPassword } from '../../src/auth/ResetPasswordPage';
import { emailDomain } from '../../src/auth/LoginPage';
import { groupSecret, qrPath } from '../../src/auth/QrCode';
import { looksLikeEmail } from '../../src/auth/api';
import { readStep, storeReturnTo, storeStep, takeReturnTo } from '../../src/auth/routes';
import { decideBoot } from '../../src/auth/session';
import { ME, PROFILE, fakeEnv, json, makeApi, memoryStore, problem } from './helpers';

const unauthenticated = problem(401, 'unauthenticated');

describe('decideBoot', () => {
  it('reads the profile, then the session; an active session opens the application where it is', async () => {
    const { api, calls, client } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE), 'GET /api/v1/me': json(ME) });
    const store = memoryStore();
    storeStep(store, { stage: 'mfa', csrfToken: 'stale-token-0123456789' });
    const d = await decideBoot({ api, pathname: '/', search: '?theme=dark', store });
    expect(d).toEqual({ kind: 'app', me: ME, profile: PROFILE, url: null });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/system/profile', 'GET /api/v1/me']);
    expect(client.csrfToken).toBe(ME.csrfToken);
    expect(readStep(store)).toBeNull();
  });

  it('without a session shows the sign-in page and remembers the requested address', async () => {
    const { api } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE), 'GET /api/v1/me': unauthenticated });
    const store = memoryStore();
    const seen: number[] = [];
    api.client.onUnauthenticated((e) => seen.push(e.status));
    const d = await decideBoot({ api, pathname: '/', search: '?lang=id&theme=dark', store });
    expect(d).toEqual({ kind: 'auth', page: 'login', profile: PROFILE });
    expect(takeReturnTo(store)).toBe('/?lang=id&theme=dark');
    expect(seen).toEqual([]); // not "session ended": there was no session
  });

  it('an auth page with an active session opens the application at the remembered address', async () => {
    const { api } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE), 'GET /api/v1/me': json(ME) });
    const store = memoryStore();
    storeReturnTo(store, '/?drill=page');
    expect(await decideBoot({ api, pathname: '/login', search: '', store })).toEqual({ kind: 'app', me: ME, profile: PROFILE, url: '/?drill=page' });
    expect(await decideBoot({ api, pathname: '/login/mfa', search: '', store })).toEqual({ kind: 'app', me: ME, profile: PROFILE, url: '/' });
  });

  it('the enrolment page with an active session is a re-enrolment', async () => {
    const { api } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE), 'GET /api/v1/me': json(ME) });
    expect(await decideBoot({ api, pathname: '/login/enrol', search: '', store: memoryStore() })).toEqual({ kind: 'auth', page: 'enrol', profile: PROFILE, enrolMode: 'reenrol', me: ME });
  });

  it('pages of emailed links need no session check', async () => {
    for (const [pathname, page] of [['/reset-password', 'reset'], ['/invite', 'invite'], ['/guest', 'guest'], ['/forgot-password', 'forgot']] as const) {
      const { api, calls } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE) });
      expect(await decideBoot({ api, pathname, search: '', store: memoryStore() })).toEqual({ kind: 'auth', page, profile: PROFILE });
      expect(calls.map((c) => c.path)).toEqual(['/api/v1/system/profile']);
    }
  });

  it('a reloaded second-factor page continues the step kept for this tab, with its CSRF token', async () => {
    const { api, calls } = makeApi({
      'GET /api/v1/system/profile': json(PROFILE),
      'POST /api/v1/auth/mfa/verify': json({ status: 'ok', csrfToken: ME.csrfToken, me: ME }),
    });
    const store = memoryStore();
    storeStep(store, { stage: 'mfa', csrfToken: 'pending-token-0123456789', guest: true });
    expect(await decideBoot({ api, pathname: '/login/mfa', search: '', store })).toEqual({ kind: 'auth', page: 'mfa', profile: PROFILE, enrolMode: 'enrol', guest: true });
    await api.verifyMfa({ code: '123456' });
    expect(calls[1].headers['x-csrf-token']).toBe('pending-token-0123456789');
  });

  it('takes the CSRF token an identity provider callback handed over in the fragment', async () => {
    const { api } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE) });
    const store = memoryStore();
    const d = await decideBoot({ api, pathname: '/login/enrol', search: '', store, csrfFromFragment: 'handed-over-token-0123456789' });
    expect(d).toEqual({ kind: 'auth', page: 'enrol', profile: PROFILE, enrolMode: 'enrol' });
    expect(api.client.csrfToken).toBe('handed-over-token-0123456789');
    expect(readStep(store)).toEqual({ stage: 'enrol', csrfToken: 'handed-over-token-0123456789' });
  });

  it('a second-factor page without a step falls back to the sign-in page', async () => {
    const { api } = makeApi({ 'GET /api/v1/system/profile': json(PROFILE), 'GET /api/v1/me': unauthenticated });
    const store = memoryStore();
    storeStep(store, { stage: 'enrol', csrfToken: 'other-stage-0123456789' });
    expect(await decideBoot({ api, pathname: '/login/mfa', search: '', store })).toEqual({ kind: 'auth', page: 'login', profile: PROFILE });
    expect(takeReturnTo(store)).toBe('/');
  });

  it('fails when the profile or the session check fails for another reason', async () => {
    const down = makeApi({ 'GET /api/v1/system/profile': 'network-error' });
    const d1 = await decideBoot({ api: down.api, pathname: '/', search: '', store: null });
    expect(d1.kind).toBe('failed');
    if (d1.kind === 'failed') expect(d1.error.message).toEqual(['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.']);
    const broken = makeApi({ 'GET /api/v1/system/profile': json(PROFILE), 'GET /api/v1/me': problem(500, 'internal') });
    const d2 = await decideBoot({ api: broken.api, pathname: '/', search: '', store: null });
    expect(d2).toMatchObject({ kind: 'failed', profile: PROFILE, error: { status: 500, slug: 'internal' } });
  });
});

describe('continueSignIn', () => {
  it('opens the application when the session is active', () => {
    const { api } = makeApi({});
    const { env, signedIn, navigations } = fakeEnv(api);
    storeStep(env.store, { stage: 'mfa', csrfToken: 'pending-token-0123456789' });
    continueSignIn(env, { status: 'ok', csrfToken: ME.csrfToken, me: ME });
    expect(signedIn).toEqual([ME]);
    expect(navigations).toEqual([]);
    expect(readStep(env.store)).toBeNull();
  });

  it('goes to the code page or the enrolment page and keeps the step', () => {
    const { api } = makeApi({});
    const a = fakeEnv(api);
    continueSignIn(a.env, { status: 'mfa_required', csrfToken: 'pending-token-0123456789' });
    expect(a.navigations).toEqual([{ page: 'mfa', options: { replace: true, signInStep: true, guest: false } }]);
    expect(readStep(a.env.store)).toEqual({ stage: 'mfa', csrfToken: 'pending-token-0123456789' });
    const b = fakeEnv(api);
    continueSignIn(b.env, { status: 'mfa_enrolment_required', csrfToken: 'pending-token-0123456789' }, { guest: true });
    expect(b.navigations).toEqual([{ page: 'enrol', options: { replace: true, signInStep: true, guest: true } }]);
    expect(readStep(b.env.store)).toEqual({ stage: 'enrol', csrfToken: 'pending-token-0123456789', guest: true });
  });
});

describe('the identity calls of the pages', () => {
  it('send the request bodies of the shared contract and never notify the session listeners', async () => {
    const { api, calls } = makeApi({
      'GET /api/v1/auth/providers': json({ local: true, providers: [] }),
      'POST /api/v1/auth/login': problem(401, 'unauthenticated', { messageKey: 'auth.invalid_credentials' }),
      'POST /api/v1/auth/mfa/verify': problem(401, 'unauthenticated', { messageKey: 'auth.mfa_invalid' }),
      'POST /api/v1/auth/mfa/enrol/start': problem(401, 'unauthenticated', { messageKey: 'auth.proof_required' }),
      'POST /api/v1/auth/mfa/enrol/confirm': problem(401, 'unauthenticated', { messageKey: 'auth.mfa_invalid' }),
      'POST /api/v1/auth/password/reset-request': { status: 202 },
      'POST /api/v1/auth/password/reset': { status: 204 },
      'POST /api/v1/auth/invitations/accept': json({ status: 'mfa_enrolment_required', csrfToken: 'pending-token-0123456789' }),
      'POST /api/v1/auth/guest/start': json({ status: 'code_sent', emailHint: 'e***@mscd.test' }),
      'POST /api/v1/auth/guest/login': json({ status: 'code_sent', emailHint: 'e***@mscd.test' }),
      'POST /api/v1/auth/guest/verify': problem(401, 'unauthenticated'),
      'PUT /api/v1/me/org': json(ME),
    });
    const seen: unknown[] = [];
    api.client.onUnauthenticated((e) => seen.push(e));
    await api.providers({ email: 'rina.kusuma@nusantaradigital.co.id' });
    await api.login(' rina.kusuma@nusantaradigital.co.id ', 'pw', true);
    await api.verifyMfa({ recoveryCode: 'abcd-efgh-ij' });
    await api.enrolStart({ password: 'pw' });
    await api.enrolConfirm('123456');
    expect((await api.requestPasswordReset('a@b.co')).ok).toBe(true);
    expect((await api.resetPassword('t'.repeat(43), 'correct horse battery')).status).toBe(204);
    await api.acceptInvitation('i'.repeat(43), 'correct horse battery');
    await api.acceptInvitation('i'.repeat(43));
    await api.guestStart('g'.repeat(43));
    await api.guestLogin('ext.auditor@mscd.test');
    await api.guestVerify('482913');
    await api.switchOrg('bsd');
    expect(seen).toEqual([]);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/api/v1/auth/providers?email=rina.kusuma%40nusantaradigital.co.id', undefined],
      ['POST', '/api/v1/auth/login', { email: 'rina.kusuma@nusantaradigital.co.id', password: 'pw', remember: true }],
      ['POST', '/api/v1/auth/mfa/verify', { recoveryCode: 'abcd-efgh-ij' }],
      ['POST', '/api/v1/auth/mfa/enrol/start', { password: 'pw' }],
      ['POST', '/api/v1/auth/mfa/enrol/confirm', { code: '123456' }],
      ['POST', '/api/v1/auth/password/reset-request', { email: 'a@b.co' }],
      ['POST', '/api/v1/auth/password/reset', { token: 't'.repeat(43), password: 'correct horse battery' }],
      ['POST', '/api/v1/auth/invitations/accept', { token: 'i'.repeat(43), password: 'correct horse battery' }],
      ['POST', '/api/v1/auth/invitations/accept', { token: 'i'.repeat(43) }],
      ['POST', '/api/v1/auth/guest/start', { token: 'g'.repeat(43) }],
      ['POST', '/api/v1/auth/guest/login', { email: 'ext.auditor@mscd.test' }],
      ['POST', '/api/v1/auth/guest/verify', { code: '482913' }],
      ['PUT', '/api/v1/me/org', { org: 'bsd' }],
    ]);
  });
});

describe('page helpers', () => {
  it('normalise recovery codes and check new passwords', () => {
    expect(normaliseRecoveryCode('ABCD EFGH IJ')).toBe('abcd-efgh-ij');
    expect(normaliseRecoveryCode('abcdefghij')).toBe('abcd-efgh-ij');
    expect(normaliseRecoveryCode(' abcd-efgh-ij ')).toBe('abcd-efgh-ij');
    expect(normaliseRecoveryCode('short')).toBe('short');
    expect(checkNewPassword('short', 'short')?.[0]).toBe('Use at least 12 characters.');
    expect(checkNewPassword('x'.repeat(257), 'x'.repeat(257))?.[0]).toBe('Use at most 256 characters.');
    expect(checkNewPassword('correct horse battery', 'correct horse batterY')?.[0]).toBe('The two passwords are not the same.');
    expect(checkNewPassword('correct horse battery', 'correct horse battery')).toBeNull();
  });

  it('check emails and their domains', () => {
    expect(looksLikeEmail('rina.kusuma@nusantaradigital.co.id')).toBe(true);
    expect(looksLikeEmail('rina@localhost')).toBe(false);
    expect(looksLikeEmail('rina kusuma@x.co')).toBe(false);
    expect(emailDomain(' Rina@NusantaraDigital.CO.ID ')).toBe('nusantaradigital.co.id');
    expect(emailDomain('none')).toBe('');
  });

  it('draw the QR code of the otpauth URL and group the secret in fours', () => {
    const url = 'otpauth://totp/MSCD:rina.kusuma%40nusantaradigital.co.id?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=MSCD';
    const a = qrPath(url);
    expect(a.size).toBeGreaterThanOrEqual(21);
    expect((a.size - 17) % 4).toBe(0); // QR symbol sizes are 17 + 4 * version
    expect(a.d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    expect(qrPath(url)).toEqual(a);
    expect(qrPath(url.replace('MSCD', 'MSCX')).d).not.toBe(a.d);
    expect(groupSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });
});
