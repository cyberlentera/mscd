// Paths of the sign-in and account pages (BUILD-PLAN H.6), the helpers that read single-use tokens from the URL
// fragment, and the small per-tab state that survives a reload during sign-in (the URL to return to, the pending
// second-factor step and an organisation switch that needs a new sign-in). Nothing here imports React.
import type { ReauthMethods } from '@mscd/shared';

export type AuthPage = 'login' | 'mfa' | 'enrol' | 'forgot' | 'reset' | 'invite' | 'guest';

export const AUTH_PATHS: Record<AuthPage, string> = {
  login: '/login',
  mfa: '/login/mfa',
  enrol: '/login/enrol',
  forgot: '/forgot-password',
  reset: '/reset-password',
  invite: '/invite',
  guest: '/guest',
};

/** The page of a path, or null for an application path. A trailing slash is ignored. */
export function authPageOf(pathname: string): AuthPage | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [page, p] of Object.entries(AUTH_PATHS) as [AuthPage, string][]) if (p === path) return page;
  return null;
}

/** Pages that work without a session and need no `GET /me` first: their links come from emails. */
export const LINK_PAGES: ReadonlySet<AuthPage> = new Set(['forgot', 'reset', 'invite', 'guest']);

/** Single-use link tokens (F.4, F.14): base64url, 32 to 128 characters. */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export interface LocationLike {
  pathname: string;
  search: string;
  hash: string;
}
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Reads the single-use token of the URL fragment (`#token=<value>` for reset and invitation links, `#<value>` for
 * guest links), then replaces the address without the fragment so the token stays out of the history, bookmarks
 * and screenshots (F.4, F.14). Returns the token, or null when the fragment holds no valid token (the fragment is
 * removed either way).
 */
export function takeFragmentToken(location: LocationLike, history: HistoryLike): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hash) return null;
  let token: string | null = hash;
  if (hash.includes('=')) token = new URLSearchParams(hash).get('token');
  history.replaceState(null, '', location.pathname + location.search);
  return token && LINK_TOKEN.test(token) ? token : null;
}

/**
 * Guest link start (F.14 step 2): reads the token from the fragment, removes the fragment from the address bar,
 * then posts the token. Resolves with null when the address held no token (nothing is posted).
 */
export async function beginGuestAccess<T>(
  post: (token: string) => Promise<T>,
  location: LocationLike,
  history: HistoryLike,
): Promise<T | null> {
  const token = takeFragmentToken(location, history);
  if (!token) return null;
  return post(token);
}

/** Only a relative path inside the app may be a return target (never another origin or an auth page). */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\s]/.test(value) || value.length > 2048) return null;
  const pathname = value.split(/[?#]/)[0];
  if (authPageOf(pathname)) return null;
  return value;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const RETURN_KEY = 'mscd.auth.returnTo';
const STEP_KEY = 'mscd.auth.step';
const REAUTH_KEY = 'mscd.auth.reauth';

/** `sessionStorage`, or null where it is not available (private modes, tests). */
export function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(store: StorageLike | null, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}
function write(store: StorageLike | null, key: string, value: string | null): void {
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // storage full or blocked: the flow still works within this page
  }
}

/** Remembers the application URL to open after the next sign-in (H.7). */
export function storeReturnTo(store: StorageLike | null, url: string): void {
  const safe = safeReturnTo(url);
  if (safe) write(store, RETURN_KEY, safe);
}

/** The stored return URL (removed from storage), or '/'. */
export function takeReturnTo(store: StorageLike | null): string {
  const value = safeReturnTo(read(store, RETURN_KEY));
  write(store, RETURN_KEY, null);
  return value ?? '/';
}

/** The stored return URL without removing it, or '/' (the `returnTo` of identity provider sign-in). */
export function peekReturnTo(store: StorageLike | null): string {
  return safeReturnTo(read(store, RETURN_KEY)) ?? '/';
}

/**
 * The CSRF token an identity provider callback hands to the second-factor or enrolment page in the fragment
 * (`#csrf=<token>`), when the sign-in continues with the local TOTP step (F.5). The fragment is removed.
 */
export function takeCsrfFragment(location: LocationLike, history: HistoryLike): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hash.includes('csrf=')) return null;
  const token = new URLSearchParams(hash).get('csrf');
  history.replaceState(null, '', location.pathname + location.search);
  return token && /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : null;
}

/** Display settings of the address that every page keeps (H.7), plus `org` for the provider lookup. */
export const KEPT_PARAMS = ['drill', 'density', 'layout', 'font', 'lang', 'theme', 'deploy', 'org'] as const;

/** The query string with only the kept parameters ('' when none). */
export function keptSearch(search: string): string {
  const from = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const key of KEPT_PARAMS) {
    const value = from.get(key);
    if (value) out.set(key, value);
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

/**
 * The sign-in step in progress: the session state the server reported and the CSRF token of that session, so the
 * second-factor page still works after a reload (the token is needed for `POST /auth/mfa/*`, F.2).
 */
export interface PendingStep {
  stage: 'mfa' | 'enrol';
  csrfToken: string;
  /** Set for guest sign-ins (F.14). */
  guest?: boolean;
}

export function storeStep(store: StorageLike | null, step: PendingStep | null): void {
  write(store, STEP_KEY, step ? JSON.stringify(step) : null);
}

export function readStep(store: StorageLike | null): PendingStep | null {
  const raw = read(store, STEP_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingStep>;
    if ((v.stage === 'mfa' || v.stage === 'enrol') && typeof v.csrfToken === 'string' && v.csrfToken) {
      return { stage: v.stage, csrfToken: v.csrfToken, ...(v.guest ? { guest: true } : {}) };
    }
  } catch {
    // ignore a damaged entry
  }
  return null;
}

/** An organisation switch that needs a new sign-in (D-26): the accepted methods and the organisation asked for. */
export interface PendingReauth {
  methods: ReauthMethods;
  org?: string;
}

export function storeReauth(store: StorageLike | null, reauth: PendingReauth | null): void {
  write(store, REAUTH_KEY, reauth ? JSON.stringify(reauth) : null);
}

export function readReauth(store: StorageLike | null): PendingReauth | null {
  const raw = read(store, REAUTH_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PendingReauth;
    if (v && v.methods && typeof v.methods.local === 'boolean' && Array.isArray(v.methods.providers)) return v;
  } catch {
    // ignore a damaged entry
  }
  return null;
}

/** URL of the start route of an identity provider (F.8 step 1, F.9), with a relative return path and an invitation. */
export function ssoStartUrl(provider: { slug: string; kind: string }, options: { returnTo?: string; invitation?: string } = {}): string {
  const kind = provider.kind === 'saml' ? 'saml' : 'oidc';
  const search = new URLSearchParams();
  const returnTo = safeReturnTo(options.returnTo);
  if (returnTo) search.set('returnTo', returnTo);
  if (options.invitation && LINK_TOKEN.test(options.invitation)) search.set('invitation', options.invitation);
  const query = search.toString();
  return `/api/v1/auth/${kind}/${encodeURIComponent(provider.slug)}/start${query ? `?${query}` : ''}`;
}
