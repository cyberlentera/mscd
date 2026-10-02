// HTTP hardening of the full api application (build plan J.5 "HTTP", F.1, F.2, F.3, F.5, F.7, F.12): CSRF on every
// signed-in write, the login lockout after 10 failures, TOTP replay, a new session id after the password and after
// the second factor (no session fixation), `Cache-Control: no-store` and the F.12 CSP on API answers, licence
// read-only mode on writes (BR-37), a spoofed `X-Forwarded-For` from an untrusted peer changing neither the rate
// limit key nor the audited source address, `X-Request-Id` validation, and log lines of guest, reset, calendar and
// OIDC callback requests without their token, code or state values.
import { randomBytes } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { totpAt } from '../../../src/modules/identity/totp';
import { LOG_RING } from '../../../src/modules/observability/log-ring';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { addUser, PASSWORD, type TestUser } from '../identity/helpers';
import { devLicence } from '../packs/fixtures';
import {
  addFixtureUser, anonymous, APP_ORIGIN, Client, COOKIE, createFullApp, demoSession, ORG_IDS, resetRateLimits, sessionFor,
  type FullApp,
} from '../contract/harness';

const CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session cookie a response sets, if any. */
function sessionCookie(response: LightMyRequestResponse): string | undefined {
  const cookies = response.cookies as { name: string; value: string }[];
  return cookies.find((c) => c.name === COOKIE && c.value !== '')?.value;
}

/** A local sign-in step with an optional cookie and extra headers (the login and MFA routes are public POSTs). */
async function post(full: FullApp, url: string, body: unknown, options: { cookie?: string; csrf?: string; headers?: Record<string, string> } = {}) {
  return full.app.inject({
    method: 'POST',
    url,
    payload: body as Record<string, unknown>,
    headers: {
      origin: APP_ORIGIN,
      ...(options.cookie ? { cookie: `${COOKIE}=${options.cookie}` } : {}),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

/** The TOTP code of a secret now, or `step` steps away. */
function codeFor(secret: Buffer, step = 0): string {
  return totpAt(secret, Date.now() + step * 30_000);
}

describe('J.5 HTTP hardening of the api', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let rina: Client;
  let local: TestUser;
  let locky: TestUser;

  beforeAll(async () => {
    full = await createFullApp(db);
    rina = await demoSession(full, db, 'rina', 'tst');
    const tst = { id: ORG_IDS.tst } as CreatedTenant;
    const moduleRef = full.app as unknown as TestingModule;
    local = await addUser(db, moduleRef, { handle: 'wp30-local', memberships: [{ org: tst }], factor: true });
    locky = await addUser(db, moduleRef, { handle: 'wp30-locky', memberships: [{ org: tst }], factor: true });
  });

  afterAll(async () => {
    await full?.close();
  });

  it('refuses a signed-in write without the CSRF token or with a wrong one (403 csrf)', async () => {
    const url = '/api/v1/ms/isms/phases/1/verify';
    for (const csrf of [undefined, 'not-the-token', rina.csrf!.slice(0, -2) + (rina.csrf!.endsWith('AA') ? 'BB' : 'AA')]) {
      const response = await rina.request('POST', url, { csrf: false, headers: csrf ? { 'x-csrf-token': csrf } : {} });
      expect(response.status, String(csrf)).toBe(403);
      expect(response.body).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/csrf' });
    }
    expect((await rina.post(url)).status).not.toBe(403);
  });

  it('locks an account after 10 wrong passwords: a correct password is then refused with the same generic answer', async () => {
    await resetRateLimits(db);
    for (let i = 1; i <= 10; i += 1) {
      const wrong = await post(full, '/api/v1/auth/login', { email: locky.email, password: `Wrong-Password-${i}x`, remember: false });
      expect(wrong.statusCode, `attempt ${i}`).toBe(401);
    }
    await resetRateLimits(db);
    const locked = await post(full, '/api/v1/auth/login', { email: locky.email, password: PASSWORD, remember: false });
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toMatchObject({ messageKey: 'auth.invalid_credentials' });
    const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.app_user').select(['locked_until']).where('id', '=', locky.id).executeTakeFirstOrThrow(),
    );
    expect(row.locked_until!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('issues a new session id after the password and after the second factor, and rejects a replayed TOTP code', async () => {
    await resetRateLimits(db);
    // A cookie planted before sign-in is never adopted.
    const planted = randomBytes(32).toString('base64url');
    const first = await post(full, '/api/v1/auth/login', { email: local.email, password: PASSWORD, remember: false }, { cookie: planted });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'mfa_required' });
    const pending = sessionCookie(first);
    expect(pending).toBeDefined();
    expect(pending).not.toBe(planted);

    const code = codeFor(local.secret!);
    const second = await post(full, '/api/v1/auth/mfa/verify', { code }, { cookie: pending!, csrf: first.json().csrfToken });
    expect(second.statusCode, second.body).toBe(200);
    const active = sessionCookie(second);
    expect(active).toBeDefined();
    expect(active).not.toBe(pending);
    // The pre-MFA cookie is dead; the new one works.
    expect((await new Client(full.app, pending!, null).get('/api/v1/me')).status).toBe(401);
    expect((await new Client(full.app, active!, null).get('/api/v1/me')).status).toBe(200);

    // The same code (and an earlier step) is a replay in a second sign-in.
    const again = await post(full, '/api/v1/auth/login', { email: local.email, password: PASSWORD, remember: false });
    const replayCookie = sessionCookie(again)!;
    const replay = await post(full, '/api/v1/auth/mfa/verify', { code }, { cookie: replayCookie, csrf: again.json().csrfToken });
    expect(replay.statusCode).toBe(401);
    const earlier = await post(full, '/api/v1/auth/mfa/verify', { code: codeFor(local.secret!, -1) }, { cookie: replayCookie, csrf: again.json().csrfToken });
    expect(earlier.statusCode).toBe(401);
  });

  it('sends Cache-Control: no-store and the F.12 security headers on API answers, errors included', async () => {
    for (const response of [await rina.get('/api/v1/me'), await rina.get('/api/v1/ui/ms/isms'), await anonymous(full).get('/api/v1/me'), await rina.get('/api/v1/ms/nope/requirements')]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toBe(CSP);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('keeps the socket address as request.ip for a spoofed X-Forwarded-For (rate-limit key and audited source_ip)', async () => {
    await resetRateLimits(db);
    const spoofed = '203.0.113.9';
    const response = await post(full, '/api/v1/auth/login', { email: local.email, password: 'Wrong-Password-xff', remember: false }, { headers: { 'x-forwarded-for': spoofed } });
    expect(response.statusCode).toBe(401);
    const keys = (await sql<{ key: string }>`select key from platform.rate_limit_bucket`.execute(db.migrator)).rows.map((r) => r.key);
    expect(keys.some((k) => k.includes('127.0.0.1'))).toBe(true);
    expect(keys.filter((k) => k.includes(spoofed))).toEqual([]);
    const [entry] = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select(['source_ip']).where('action', '=', 'auth.login_failed').where('entity_id', '=', local.id).orderBy('seq', 'desc').limit(1).execute(),
    );
    expect(String(entry!.source_ip)).toMatch(/127\.0\.0\.1/);
  });

  it('accepts a valid X-Request-Id and replaces an invalid one', async () => {
    const valid = await rina.get('/api/v1/me', { 'x-request-id': 'wp30-request-0001' });
    expect(valid.headers['x-request-id']).toBe('wp30-request-0001');
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(65), "inject';drop"]) {
      const response = await rina.get('/api/v1/me', { 'x-request-id': bad });
      expect(response.headers['x-request-id'], bad).not.toBe(bad);
      expect(String(response.headers['x-request-id'])).toMatch(UUID);
    }
  });

  it('blocks writes but not reads in licence read-only mode (BR-37), and the licence upload ends it', async () => {
    const admin = await addFixtureUser(db, 'tst', 'wp30-licence-ta', { org: ['tenant_admin'] });
    const ta = await sessionFor(full, admin.id, 'tst');
    const late = await ta.put('/api/v1/admin/license', devLicence(ORG_IDS.tst, { license_id: 'LIC-WP30-RO', valid_from: '2025-01-01', valid_until: '2026-08-15', grace_days: 10 }));
    expect(late.status, late.text).toBe(200);
    expect(late.body).toMatchObject({ state: 'read_only' });
    try {
      const write = await rina.post('/api/v1/ms/isms/phases/1/verify');
      expect(write.status).toBe(403);
      expect(write.body).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/read-only-mode', rule: 'BR-37' });
      expect((await rina.get('/api/v1/ui/ms/isms')).status).toBe(200);
    } finally {
      const valid = await ta.put('/api/v1/admin/license', devLicence(ORG_IDS.tst, { license_id: 'LIC-WP30-OK' }));
      expect(valid.body).toMatchObject({ state: 'valid' });
    }
    expect((await rina.post('/api/v1/ms/isms/phases/1/verify')).status).not.toBe(403);
  });
});

describe('J.5 log redaction of token-bearing requests (F.12)', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;

  beforeAll(async () => {
    full = await createFullApp(db, { MSCD__OBSERVABILITY__LOG_LEVEL: 'info' });
  });

  afterAll(async () => {
    await full?.close();
  });

  it('writes guest, reset, calendar, invitation and OIDC callback requests without their token, code or state values', async () => {
    LOG_RING.clear();
    const secret = (label: string) => `${label}${randomBytes(24).toString('base64url')}`;
    const values = {
      guestToken: secret('GuestTok'),
      resetToken: secret('ResetTok'),
      calendarToken: secret('CalTok'),
      code: secret('OidcCode'),
      state: secret('OidcState'),
      invitation: secret('InviteTok'),
      relay: secret('Relay'),
    };
    const client = anonymous(full);
    await client.post('/api/v1/auth/guest/start', { token: values.guestToken });
    await client.post('/api/v1/auth/password/reset', { token: values.resetToken, password: 'a much longer passphrase' });
    await client.get(`/api/v1/ms/isms/surveillance/reviews.ics?token=${values.calendarToken}`);
    await client.get(`/api/v1/auth/oidc/nobody/callback?code=${values.code}&state=${values.state}`);
    await client.get(`/api/v1/auth/oidc/nobody/start?invitation=${values.invitation}&returnTo=%2F`);
    await client.get(`/api/v1/auth/saml/nobody/start?RelayState=${values.relay}`);
    // A signed-in request carries its cookie and CSRF token in headers; neither is logged.
    const rina = await demoSession(full, db, 'rina', 'ndt');
    await rina.post('/api/v1/ms/isms/phases/1/verify');

    const lines = LOG_RING.lines();
    const text = lines.join('\n');
    // The requests were logged (so the check below is not vacuous).
    for (const path of ['/auth/guest/start', '/auth/password/reset', 'reviews.ics', '/auth/oidc/nobody/callback', '/auth/oidc/nobody/start', '/phases/1/verify']) {
      expect(text, path).toContain(path);
    }
    expect(text).toContain('[redacted]');
    for (const [name, value] of Object.entries(values)) expect(text.includes(value), name).toBe(false);
    expect(text.includes(rina.cookie!)).toBe(false);
    expect(text.includes(rina.csrf!)).toBe(false);
  });
});
