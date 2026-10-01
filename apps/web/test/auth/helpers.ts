// Test doubles of the WP-38 unit tests: a fake `fetch` that answers from a route table and records every request,
// fake `location`, `history` and storage, and example answers in the shapes of the shared contract.
import { ApiClient } from '../../src/data/api/ApiClient';
import { AuthApi } from '../../src/auth/api';
import type { AuthEnv } from '../../src/auth/context';
import type { AuthPage, StorageLike } from '../../src/auth/routes';

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

export type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error';
export type Handler = (req: Recorded) => Answer;

export function json(body: unknown, status = 200): Answer {
  return { status, body, headers: { 'content-type': 'application/json' } };
}

export function problem(status: number, slug: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Answer {
  return {
    status,
    body: { type: `https://mscd.cyberlentera.com/problems/${slug}`, title: `Title of ${slug}`, status, requestId: 'req-12345678', ...extra },
    headers: { 'content-type': 'application/problem+json', ...headers },
  };
}

/** A fetch that answers `routes['METHOD /path']` (a function or a list used in order) and records the requests. */
export function fakeFetch(routes: Record<string, Handler | Answer | Answer[]>) {
  const calls: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const parsed = new URL(url, 'http://localhost');
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init.body;
    if (typeof init.body === 'string' && headers['content-type'] === 'application/json') body = JSON.parse(init.body);
    const req: Recorded = { method: init.method ?? 'GET', url, path: parsed.pathname, headers, body, credentials: init.credentials };
    calls.push(req);
    const route = routes[`${req.method} ${req.path}`];
    let answer: Answer;
    if (route === undefined) answer = problem(404, 'not-found');
    else if (typeof route === 'function') answer = route(req);
    else if (Array.isArray(route)) answer = route.length > 1 ? (route.shift() as Answer) : route[0];
    else answer = route;
    if (answer === 'network-error') throw new TypeError('Failed to fetch');
    const payload = answer.body === undefined ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(answer.status === 204 ? null : payload, { status: answer.status, headers: answer.headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export function makeApi(routes: Record<string, Handler | Answer | Answer[]>, lang: 'en' | 'id' = 'en') {
  const f = fakeFetch(routes);
  const client = new ApiClient({ fetch: f.fetch, lang });
  return { ...f, client, api: new AuthApi(client) };
}

export function memoryStore(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

export function fakeLocation(href: string) {
  const u = new URL(href, 'https://mscd.example.internal');
  return { pathname: u.pathname, search: u.search, hash: u.hash };
}

export function fakeHistory(events: string[] = []) {
  const urls: string[] = [];
  return {
    urls,
    replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
      urls.push(String(url));
      events.push(`replace ${String(url)}`);
    },
  };
}

export const PROFILE = {
  version: '1.0.0',
  revision: 'abc1234',
  deploy: 'saas' as const,
  capabilities: {
    licenseValidation: 'online' as const, updatesChannel: 'managed' as const, packsChannel: 'managed' as const, telemetry: false,
    identityProviders: ['local' as const, 'oidc' as const], storageAdapters: ['managed_vault' as const], mailTransport: 'smtp' as const, jobsDriver: 'pgboss' as const,
  },
  demo: { enabled: false, personas: false },
  login: { regionLabel: 'Jakarta', mfaEnforced: true },
};

export const ME = {
  user: { id: '8c0d6f1e-2a3b-4c5d-9e6f-7a8b9c0d1e2f', handle: 'rina', email: 'rina.kusuma@nusantaradigital.co.id', displayName: 'Rina Kusuma', jobTitle: 'ISMS Manager' },
  org: { id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi' },
  orgs: [{ id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: ['isms'], deploy: 'saas' as const, sites: 2 }],
  rolesByMs: { isms: ['ms_manager' as const] },
  uiRoleByMs: { isms: 'manager' as const },
  adminRoles: [],
  platformRoles: [],
  permissions: { org: [], ms: {} },
  csrfToken: 'csrf-active-0123456789abcdef',
  session: { authMethod: 'local' as const, idleExpiresAt: '2026-09-29T07:00:00Z', absoluteExpiresAt: '2026-09-29T14:00:00Z' },
  preferences: {},
};

export const RECOVERY_CODES = ['abcd-efgh-ij', 'bcde-fghi-jk', 'cdef-ghij-kl', 'defg-hijk-lm', 'efgh-ijkl-mn', 'fghi-jklm-no', 'ghij-klmn-op', 'hijk-lmno-pq', 'ijkl-mnop-qr', 'jklm-nopq-rs'];

/** An `AuthEnv` whose navigation and sign-in are recorded. */
export function fakeEnv(api: AuthApi, overrides: Partial<AuthEnv> = {}) {
  const navigations: { page: AuthPage; options?: unknown }[] = [];
  const signedIn: unknown[] = [];
  const env: AuthEnv = {
    api,
    lang: 'en',
    theme: 'light',
    profile: PROFILE,
    facts: ['v1.0.0', 'SaaS, region Jakarta', 'TLS 1.3', 'MFA enforced'],
    store: memoryStore(),
    returnTo: '/',
    navigate: (page, options) => void navigations.push({ page, options }),
    signedIn: (me) => void signedIn.push(me),
    ...overrides,
  };
  return { env, navigations, signedIn };
}
