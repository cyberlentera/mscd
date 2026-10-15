// ApiClient (BUILD-PLAN H.4, D.1, F.2) with a fake fetch: CSRF header, JSON, language, problem mapping, network
// failures, the 401 listeners, `reauth-required` and sign-out.
import { describe, expect, it, vi } from 'vitest';
import {
  ApiClient, CONNECTION_LOST, SERVER_UNREACHABLE, buildPath, buildQuery, csrfTokenIn, parseRetryAfter, problemSlug, toApiError,
} from '../../src/data/api/ApiClient';
import { ME, fakeFetch, json, problem } from './helpers';

const LOGIN = { method: 'POST' as const, path: '/api/v1/auth/login', auth: 'public' };
const UI_MS = { method: 'GET' as const, path: '/api/v1/ui/ms/:ms', auth: 'session' };
const SWITCH_ORG = { method: 'PUT' as const, path: '/api/v1/me/org', auth: 'session' };

describe('requests', () => {
  it('sends same-origin credentials, JSON and the interface language', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/v1/x': json({ ok: true }) });
    const client = new ApiClient({ fetch, lang: 'id' });
    const r = await client.post('/api/v1/x', { a: 1 });
    expect(r).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(calls[0].credentials).toBe('same-origin');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers['accept']).toContain('application/problem+json');
    expect(calls[0].headers['accept-language']).toBe('id');
    expect(calls[0].body).toEqual({ a: 1 });
    client.setLanguage('en');
    await client.post('/api/v1/x', {});
    expect(calls[1].headers['accept-language']).toBe('en');
  });

  it('sends X-CSRF-Token on every non-GET request once a token is known, never on GET', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/v1/me': json(ME), 'POST /api/v1/x': json({}), 'PUT /api/v1/x': json({}), 'PATCH /api/v1/x': json({}) });
    const client = new ApiClient({ fetch });
    await client.post('/api/v1/x', {});
    expect(calls[0].headers['x-csrf-token']).toBeUndefined();
    await client.get('/api/v1/me');
    expect(client.csrfToken).toBe(ME.csrfToken);
    expect(calls[1].headers['x-csrf-token']).toBeUndefined();
    await client.post('/api/v1/x', {});
    await client.put('/api/v1/x', {});
    await client.patch('/api/v1/x', {});
    for (const c of calls.slice(2)) expect(c.headers['x-csrf-token']).toBe(ME.csrfToken);
  });

  it('takes the rotated token of every answer that carries one (LoginResponse, Me, me.csrfToken)', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /api/v1/auth/login': json({ status: 'mfa_required', csrfToken: 'pending-token-0123456789' }),
      'POST /api/v1/auth/mfa/enrol/confirm': json({ recoveryCodes: [], me: { ...ME, csrfToken: 'active-token-0123456789' } }),
      'PUT /api/v1/me/org': json({ ...ME, csrfToken: 'switched-token-0123456789' }),
      'POST /api/v1/x': json({}),
    });
    const client = new ApiClient({ fetch });
    await client.call(LOGIN, { body: { email: 'a@b.co', password: 'x', remember: false } });
    expect(client.csrfToken).toBe('pending-token-0123456789');
    await client.post('/api/v1/auth/mfa/enrol/confirm', { code: '123456' });
    expect(calls[1].headers['x-csrf-token']).toBe('pending-token-0123456789');
    expect(client.csrfToken).toBe('active-token-0123456789');
    await client.call(SWITCH_ORG, { body: { org: 'bsd' } });
    expect(client.csrfToken).toBe('switched-token-0123456789');
    await client.post('/api/v1/x', {});
    expect(calls[3].headers['x-csrf-token']).toBe('switched-token-0123456789');
    client.rememberMe({ csrfToken: 'remembered-token-0123456789' });
    expect(client.csrfToken).toBe('remembered-token-0123456789');
  });

  it('fills path parameters (encoded) and drops empty query members', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/v1/ui/ms/a%2Fb': json({}) });
    const client = new ApiClient({ fetch });
    await client.call(UI_MS, { params: { ms: 'a/b' }, query: { q: 'x y', page: 2, none: undefined, empty: '', nil: null } });
    expect(calls[0].url).toBe('/api/v1/ui/ms/a%2Fb?q=x+y&page=2');
    expect(() => buildPath('/api/v1/ms/:ms/x/:id', { ms: 'isms' })).toThrow(/missing parameter id/);
    expect(buildQuery({})).toBe('');
  });

  it('passes raw bodies through without a JSON content type', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /api/v1/upload': { status: 204 } });
    const client = new ApiClient({ fetch });
    const blob = new Blob(['abc'], { type: 'text/plain' });
    const r = await client.put('/api/v1/upload', blob);
    expect(r).toEqual({ ok: true, status: 204, data: undefined });
    expect(calls[0].body).toBe(blob);
    expect(calls[0].headers['content-type']).toBeUndefined();
  });

  it('prefixes a base URL', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/v1/system/profile': json({}) });
    await new ApiClient({ fetch, baseUrl: 'https://mscd.example.internal/' }).get('/api/v1/system/profile');
    expect(calls[0].url).toBe('https://mscd.example.internal/api/v1/system/profile');
  });
});

describe('errors', () => {
  it('maps a problem to {status, rule, message: [messages.en, messages.id]} with the D.1 members', async () => {
    const { fetch } = fakeFetch({
      'POST /api/v1/x': problem(422, 'business-rule', { rule: 'BR-01', messages: { en: 'No valid evidence', id: 'Tidak ada evidence valid' }, messageKey: 'br.01', detail: 'd', errors: [{ path: 'body.to', message: 'm' }] }),
    });
    const r = await new ApiClient({ fetch }).post('/api/v1/x', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.error).toMatchObject({
      status: 422, slug: 'business-rule', rule: 'BR-01', message: ['No valid evidence', 'Tidak ada evidence valid'], messageKey: 'br.01', detail: 'd',
      errors: [{ path: 'body.to', message: 'm' }], requestId: 'req-12345678',
    });
  });

  it('falls back to [title, title] without messages', () => {
    const e = toApiError(403, { type: 'https://mscd.cyberlentera.com/problems/csrf', title: 'Missing or invalid CSRF token', status: 403, requestId: 'r' });
    expect(e).toMatchObject({ status: 403, slug: 'csrf', message: ['Missing or invalid CSRF token', 'Missing or invalid CSRF token'] });
  });

  it('reads the retry time from the problem or from Retry-After', async () => {
    const { fetch } = fakeFetch({
      'POST /api/v1/a': problem(429, 'rate-limited', { retryAfter: 120 }),
      'POST /api/v1/b': problem(429, 'rate-limited', {}, { 'retry-after': '30' }),
    });
    const client = new ApiClient({ fetch });
    const a = await client.post('/api/v1/a', {});
    const b = await client.post('/api/v1/b', {});
    expect(!a.ok && a.error.retryAfter).toBe(120);
    expect(!b.ok && b.error.retryAfter).toBe(30);
    expect(parseRetryAfter('Wed, 01 Oct 2026 10:00:30 GMT', Date.parse('Wed, 01 Oct 2026 10:00:00 GMT'))).toBe(30);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('gives a generic text for an answer that is not a problem', async () => {
    const { fetch } = fakeFetch({
      'GET /api/v1/a': { status: 502, body: '<html>Bad gateway</html>', headers: { 'content-type': 'text/html' } },
      'GET /api/v1/b': { status: 500, body: 'oops', headers: { 'content-type': 'text/plain' } },
    });
    const client = new ApiClient({ fetch });
    const a = await client.get('/api/v1/a');
    const b = await client.get('/api/v1/b');
    expect(!a.ok && a.error).toEqual({ status: 502, message: SERVER_UNREACHABLE });
    expect(!b.ok && b.error.message).toEqual(['The request failed (HTTP 500).', 'Permintaan gagal (HTTP 500).']);
  });

  it('turns a network failure into status 0 "Connection lost. Try again."', async () => {
    const { fetch } = fakeFetch({ 'GET /api/v1/a': 'network-error' });
    const r = await new ApiClient({ fetch }).get('/api/v1/a');
    expect(r).toEqual({ ok: false, status: 0, error: { status: 0, message: CONNECTION_LOST } });
    expect(CONNECTION_LOST).toEqual(['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.']);
  });

  it('rethrows when the caller aborted the request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(new ApiClient({ fetch: fetch as unknown as typeof globalThis.fetch }).get('/api/v1/a', { signal: controller.signal })).rejects.toThrow('aborted');
  });

  it('recognises problem slugs and token members', () => {
    expect(problemSlug('https://mscd.cyberlentera.com/problems/reauth-required')).toBe('reauth-required');
    expect(problemSlug('about:blank')).toBeUndefined();
    expect(csrfTokenIn({ csrfToken: 'a' })).toBe('a');
    expect(csrfTokenIn({ me: { csrfToken: 'b' } })).toBe('b');
    expect(csrfTokenIn({ csrfToken: '' })).toBeNull();
    expect(csrfTokenIn(null)).toBeNull();
  });
});

describe('session events', () => {
  it('tells the onUnauthenticated listeners about a 401 of a session route, not of a sign-in step', async () => {
    const { fetch } = fakeFetch({
      'GET /api/v1/ui/ms/isms': problem(401, 'unauthenticated'),
      'POST /api/v1/auth/login': problem(401, 'unauthenticated', { messageKey: 'auth.invalid_credentials' }),
      'GET /api/v1/me': problem(401, 'unauthenticated'),
    });
    const client = new ApiClient({ fetch });
    const seen: number[] = [];
    const off = client.onUnauthenticated((e) => seen.push(e.status));
    await client.call(UI_MS, { params: { ms: 'isms' } });
    expect(seen).toEqual([401]);
    await client.call(LOGIN, { body: {} });
    expect(seen).toEqual([401]);
    await client.get('/api/v1/me', { notifyUnauthenticated: false });
    expect(seen).toEqual([401]);
    await client.get('/api/v1/me');
    expect(seen).toEqual([401, 401]);
    off();
    await client.get('/api/v1/me');
    expect(seen).toEqual([401, 401]);
  });

  it('keeps calling the other listeners when one throws', async () => {
    const { fetch } = fakeFetch({ 'GET /api/v1/me': problem(401, 'unauthenticated') });
    const client = new ApiClient({ fetch });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = vi.fn();
    client.onUnauthenticated(() => {
      throw new Error('boom');
    });
    client.onUnauthenticated(second);
    await client.get('/api/v1/me');
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('returns 409 reauth-required with its methods and tells the listeners the organisation asked for', async () => {
    const methods = { local: false, providers: [{ slug: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak' }] };
    const { fetch } = fakeFetch({ 'PUT /api/v1/me/org': problem(409, 'reauth-required', { methods }) });
    const client = new ApiClient({ fetch });
    const events: unknown[] = [];
    client.onReauthRequired((e) => events.push(e));
    const r = await client.call(SWITCH_ORG, { body: { org: 'bsd' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error.slug).toBe('reauth-required');
      expect(r.error.methods).toEqual(methods);
    }
    expect(events).toEqual([{ methods, org: 'bsd' }]);
  });

  it('a 409 of another kind is not a reauth event', async () => {
    const { fetch } = fakeFetch({ 'POST /api/v1/x': problem(409, 'conflict') });
    const client = new ApiClient({ fetch });
    const events: unknown[] = [];
    client.onReauthRequired((e) => events.push(e));
    await client.post('/api/v1/x', { org: 'bsd' });
    expect(events).toEqual([]);
  });

  it('sign-out clears the token and tells the onSignedOut listeners, also when the session was already gone', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/v1/auth/logout': [{ status: 204 }, problem(401, 'unauthenticated')] });
    const client = new ApiClient({ fetch });
    const out = vi.fn();
    const unauth = vi.fn();
    client.onSignedOut(out);
    client.onUnauthenticated(unauth);
    client.setCsrfToken('csrf-active-0123456789abcdef');
    const r = await client.logout();
    expect(r.ok).toBe(true);
    expect(calls[0].headers['x-csrf-token']).toBe('csrf-active-0123456789abcdef');
    expect(client.csrfToken).toBeNull();
    expect(out).toHaveBeenCalledTimes(1);
    client.setCsrfToken('csrf-other-0123456789abcdef');
    await client.request('POST', '/api/v1/auth/logout');
    expect(out).toHaveBeenCalledTimes(2);
    expect(unauth).not.toHaveBeenCalled();
    expect(client.csrfToken).toBeNull();
  });
});
