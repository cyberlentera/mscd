// HTTP client of the web app for the MSCD API (BUILD-PLAN H.4, D.1, F.2). Shared by the sign-in pages (src/auth) and
// the API data source (ApiDataSource.ts, WP-25).
//
// - Requests go to the same origin with the session cookie (`credentials: 'same-origin'`), JSON bodies and
//   `Accept-Language` from the interface language.
// - Every non-GET request carries `X-CSRF-Token` with the token of the last `Me` or sign-in step (F.2). The token
//   changes whenever the server rotates the session (sign-in steps, organisation switch, persona switch), so every
//   successful JSON response that carries a `csrfToken` (Me, LoginResponse) or `me.csrfToken`
//   (MfaEnrolConfirmResponse) replaces it.
// - Errors never throw: a problem response (RFC 9457, D.1) becomes `ApiError` with `message` as an
//   [English, Indonesian] pair from `messages`, falling back to `[title, title]`; a network failure becomes status 0
//   with "Connection lost. Try again." (H.5 step 10).
// - A 401 on a request made with a session tells the `onUnauthenticated` listeners (the boot router then shows the
//   sign-in page, H.7). Sign-in steps answer 401 for a wrong password or code, so they do not notify.
// - A 409 `reauth-required` (D-26) is returned with its `methods`, and the `onReauthRequired` listeners learn the
//   accepted methods and the organisation the request asked for.
// - A successful `POST /auth/logout` clears the token and tells the `onSignedOut` listeners.
//
// Types of the shared contract are imported as types only, so neither the web bundle nor the unit tests load the
// schema package at run time.
import type { Me, Problem, ReauthMethods } from '@mscd/shared';

export type Lang = 'en' | 'id';
export type Pair = [en: string, id: string];
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Prefix of every api route (D.1). */
export const API_PREFIX = '/api/v1';

/** Problem type base of D.1; the slug follows it. */
export const PROBLEM_TYPE_BASE = 'https://mscd.cyberlentera.com/problems/';

export const CONNECTION_LOST: Pair = ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'];
export const SERVER_UNREACHABLE: Pair = [
  'The server is not reachable. Try again in a moment.',
  'Server tidak dapat dijangkau. Coba lagi sebentar lagi.',
];

/** An error answer of the api in the form the controller shows (`CommandResult.error`, H.4). */
export interface ApiError {
  /** HTTP status; 0 when the request did not reach the server. */
  status: number;
  /** Problem slug of D.1 (`validation`, `unauthenticated`, `reauth-required`, ...), when the answer was a problem. */
  slug?: string;
  rule?: string;
  /** Text to show: `[messages.en, messages.id]`, else `[title, title]`. */
  message: Pair;
  messageKey?: string;
  detail?: string;
  /** Accepted sign-in methods of `reauth-required` and `auth.sso_required`. */
  methods?: ReauthMethods;
  /** Seconds to wait, from the problem or the `Retry-After` header (429). */
  retryAfter?: number;
  errors?: { path: string; message: string }[];
  requestId?: string;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError };

/** A route of the shared table (`RouteDef` of @mscd/shared) or any object with the same three members. */
export interface RouteLike {
  method: HttpMethod;
  path: string;
  auth?: string;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  /** Path parameters for `:name` segments; each value is URL-encoded. */
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  /** A plain value is sent as JSON; `Blob`, `FormData`, `ArrayBuffer`, `URLSearchParams` and streams as they are. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Whether a 401 tells the `onUnauthenticated` listeners. Default: true, except for routes of the shared table whose
   * auth level is a sign-in step (`public`, `mfa_pending`, `enrolment`, `guest_otp`).
   */
  notifyUnauthenticated?: boolean;
}

export interface ReauthEvent {
  methods: ReauthMethods;
  /** The organisation slug the refused request asked for (`PUT /me/org {org}`), when known. */
  org?: string;
}

export interface ApiClientOptions {
  /** The fetch implementation (tests pass a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Origin and path in front of the route paths; default '' (same origin). */
  baseUrl?: string;
  /** Interface language for `Accept-Language`; can be changed later with `setLanguage`. */
  lang?: Lang;
}

type Listener<T> = (value: T) => void;

/** Auth levels whose 401 means "wrong credentials or code" rather than "the session ended". */
const SIGN_IN_STEP_AUTH = new Set(['public', 'mfa_pending', 'enrolment', 'guest_otp']);

function isRawBody(body: unknown): body is BodyInit {
  if (body === null || typeof body !== 'object') return false;
  const tests: [string, (b: unknown) => boolean][] = [
    ['Blob', (b) => typeof Blob !== 'undefined' && b instanceof Blob],
    ['FormData', (b) => typeof FormData !== 'undefined' && b instanceof FormData],
    ['URLSearchParams', (b) => b instanceof URLSearchParams],
    ['ArrayBuffer', (b) => b instanceof ArrayBuffer || ArrayBuffer.isView(b)],
    ['ReadableStream', (b) => typeof ReadableStream !== 'undefined' && b instanceof ReadableStream],
  ];
  return tests.some(([, test]) => test(body));
}

/** Replaces each `:name` segment of a route path with the URL-encoded parameter; a missing parameter throws. */
export function buildPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') throw new Error(`buildPath: missing parameter ${name} for ${path}`);
    return encodeURIComponent(String(value));
  });
}

/** Query string with the members that are not null, undefined or empty, in insertion order ('' when none). */
export function buildQuery(query: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Seconds of a `Retry-After` header (seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

function isProblem(value: unknown): value is Problem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && typeof v.title === 'string' && typeof v.status === 'number';
}

/** Problem slug of a problem type URI (`.../problems/<slug>`), or undefined for another URI. */
export function problemSlug(type: string): string | undefined {
  return type.startsWith(PROBLEM_TYPE_BASE) ? type.slice(PROBLEM_TYPE_BASE.length) : undefined;
}

/**
 * The `ApiError` of an error answer (H.4): a problem body gives its slug, rule, messages (or `[title, title]`),
 * message key, methods, retry time and field errors; any other body gives a generic text for the status.
 */
export function toApiError(status: number, body: unknown, headers?: { get(name: string): string | null }): ApiError {
  const retryHeader = parseRetryAfter(headers?.get('retry-after') ?? null);
  if (isProblem(body)) {
    const error: ApiError = {
      status: body.status || status,
      message: body.messages ? [body.messages.en, body.messages.id] : [body.title, body.title],
    };
    const slug = problemSlug(body.type);
    if (slug) error.slug = slug;
    if (body.rule) error.rule = body.rule;
    if (body.messageKey) error.messageKey = body.messageKey;
    if (body.detail) error.detail = body.detail;
    if (body.methods) error.methods = body.methods;
    if (body.errors) error.errors = body.errors;
    if (body.requestId) error.requestId = body.requestId;
    const retryAfter = body.retryAfter ?? retryHeader;
    if (retryAfter !== undefined) error.retryAfter = retryAfter;
    return error;
  }
  const message: Pair = status >= 502 && status <= 504
    ? SERVER_UNREACHABLE
    : [`The request failed (HTTP ${status}).`, `Permintaan gagal (HTTP ${status}).`];
  const error: ApiError = { status, message };
  if (retryHeader !== undefined) error.retryAfter = retryHeader;
  return error;
}

/** The CSRF token a successful answer carries: `csrfToken` (Me, LoginResponse) or `me.csrfToken`. */
export function csrfTokenIn(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const v = body as { csrfToken?: unknown; me?: { csrfToken?: unknown } };
  if (typeof v.csrfToken === 'string' && v.csrfToken) return v.csrfToken;
  if (v.me && typeof v.me.csrfToken === 'string' && v.me.csrfToken) return v.me.csrfToken;
  return null;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private lang: Lang;
  private csrf: string | null = null;
  private readonly unauthenticated = new Set<Listener<ApiError>>();
  private readonly reauth = new Set<Listener<ReauthEvent>>();
  private readonly signedOut = new Set<Listener<void>>();

  constructor(options: ApiClientOptions = {}) {
    const f = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('ApiClient: no fetch implementation');
    // A bare reference to window.fetch must be called with the global object as `this`.
    this.fetchImpl = options.fetch ? options.fetch : (input, init) => f.call(globalThis, input, init);
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.lang = options.lang ?? 'en';
  }

  /** The token sent as `X-CSRF-Token`, or null before the first sign-in step or `Me`. */
  get csrfToken(): string | null {
    return this.csrf;
  }

  setCsrfToken(token: string | null): void {
    this.csrf = token || null;
  }

  /** Takes the CSRF token of a `Me` (after `GET /me`, an organisation switch or a persona switch). */
  rememberMe(me: Pick<Me, 'csrfToken'>): void {
    this.setCsrfToken(me.csrfToken);
  }

  get language(): Lang {
    return this.lang;
  }

  setLanguage(lang: Lang): void {
    this.lang = lang === 'id' ? 'id' : 'en';
  }

  /** Called with the error of every 401 on a request made with a session; returns the unsubscribe function. */
  onUnauthenticated(listener: Listener<ApiError>): () => void {
    this.unauthenticated.add(listener);
    return () => this.unauthenticated.delete(listener);
  }

  /** Called when the api answers 409 `reauth-required` (D-26); returns the unsubscribe function. */
  onReauthRequired(listener: Listener<ReauthEvent>): () => void {
    this.reauth.add(listener);
    return () => this.reauth.delete(listener);
  }

  /** Called after a successful sign-out; returns the unsubscribe function. */
  onSignedOut(listener: Listener<void>): () => void {
    this.signedOut.add(listener);
    return () => this.signedOut.delete(listener);
  }

  /** Calls a route of the shared table (`RouteDef`) with its path parameters, query and body. */
  call<T = unknown>(route: RouteLike, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const notify = options.notifyUnauthenticated ?? !(route.auth && SIGN_IN_STEP_AUTH.has(route.auth));
    return this.request<T>(route.method, buildPath(route.path, options.params), { ...options, notifyUnauthenticated: notify });
  }

  get<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>('POST', path, { ...options, body });
  }

  put<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  patch<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  /** Ends the session (`POST /auth/logout`); the token is cleared and the `onSignedOut` listeners run. */
  async logout(): Promise<ApiResult<void>> {
    return this.request<void>('POST', `${API_PREFIX}/auth/logout`, { notifyUnauthenticated: false });
  }

  /**
   * Sends one request. `path` is absolute on the api origin (`/api/v1/...`); `:name` segments are filled from
   * `options.params`. Never throws for HTTP or network errors.
   */
  async request<T = unknown>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const url = this.baseUrl + buildPath(path, options.params) + buildQuery(options.query);
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      'Accept-Language': this.lang,
      ...options.headers,
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (isRawBody(options.body)) body = options.body;
      else {
        body = JSON.stringify(options.body);
        headers['Content-Type'] = 'application/json';
      }
    }
    if (method !== 'GET' && this.csrf) headers['X-CSRF-Token'] = this.csrf;

    let response: Response;
    try {
      const init: RequestInit = { method, headers, credentials: 'same-origin' };
      if (body !== undefined) init.body = body;
      if (options.signal) init.signal = options.signal;
      response = await this.fetchImpl(url, init);
    } catch (e) {
      if (options.signal?.aborted) throw e;
      return { ok: false, status: 0, error: { status: 0, message: CONNECTION_LOST } };
    }

    const data = await readBody(response);
    // Signing out succeeded, or there was no session left to end: either way nobody is signed in now.
    const signedOut = method === 'POST' && path === `${API_PREFIX}/auth/logout` && (response.ok || response.status === 401);
    if (signedOut) this.csrf = null;
    if (response.ok) {
      const token = csrfTokenIn(data);
      if (token && !signedOut) this.csrf = token;
      if (signedOut) this.emit(this.signedOut, undefined);
      return { ok: true, status: response.status, data: data as T };
    }

    const error = toApiError(response.status, data, response.headers);
    if (signedOut) this.emit(this.signedOut, undefined);
    if (response.status === 401 && options.notifyUnauthenticated !== false && !signedOut) this.emit(this.unauthenticated, error);
    if (response.status === 409 && error.slug === 'reauth-required') {
      const event: ReauthEvent = { methods: error.methods ?? { local: false, providers: [] } };
      const org = (options.body as { org?: unknown } | undefined)?.org;
      if (typeof org === 'string') event.org = org;
      this.emit(this.reauth, event);
    }
    return { ok: false, status: response.status, error };
  }

  private emit<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (e) {
        console.error('ApiClient listener failed', e);
      }
    }
  }
}

/** The body of a response: parsed JSON for JSON types, else the text (undefined when empty). */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (/[/+]json\b/i.test(type)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** A client for this page: same origin, the global fetch. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return new ApiClient(options);
}
