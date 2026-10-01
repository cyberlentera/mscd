// Calls of the sign-in and account pages (BUILD-PLAN D.3 "System, session and identity"). Paths and methods follow
// the shared route table (`packages/shared/src/api/{system,auth,me}.ts`; test/auth/api.test.ts compares them);
// shapes are the shared types. Sign-in steps never tell the client's `onUnauthenticated` listeners: their 401
// means a wrong password or code, not an ended session.
import type {
  AuthProviders, GuestStartResponse, LoginResponse, Me, MfaEnrolConfirmResponse, MfaEnrolStartRequest,
  MfaEnrolStartResponse, MfaVerifyRequest, SystemProfile,
} from '@mscd/shared';
import { API_PREFIX } from '../data/api/ApiClient';
import type { ApiClient, ApiResult, HttpMethod } from '../data/api/ApiClient';

export type { ApiResult };

/** The identity routes the pages call, as `[method, path]` (D.3). */
export const AUTH_ROUTES = {
  profile: ['GET', `${API_PREFIX}/system/profile`],
  me: ['GET', `${API_PREFIX}/me`],
  switchOrg: ['PUT', `${API_PREFIX}/me/org`],
  providers: ['GET', `${API_PREFIX}/auth/providers`],
  login: ['POST', `${API_PREFIX}/auth/login`],
  mfaVerify: ['POST', `${API_PREFIX}/auth/mfa/verify`],
  enrolStart: ['POST', `${API_PREFIX}/auth/mfa/enrol/start`],
  enrolConfirm: ['POST', `${API_PREFIX}/auth/mfa/enrol/confirm`],
  logout: ['POST', `${API_PREFIX}/auth/logout`],
  resetRequest: ['POST', `${API_PREFIX}/auth/password/reset-request`],
  reset: ['POST', `${API_PREFIX}/auth/password/reset`],
  invitationAccept: ['POST', `${API_PREFIX}/auth/invitations/accept`],
  guestStart: ['POST', `${API_PREFIX}/auth/guest/start`],
  guestLogin: ['POST', `${API_PREFIX}/auth/guest/login`],
  guestVerify: ['POST', `${API_PREFIX}/auth/guest/verify`],
} as const satisfies Record<string, readonly [HttpMethod, string]>;

type RouteName = keyof typeof AUTH_ROUTES;

export class AuthApi {
  constructor(readonly client: ApiClient) {}

  private send<T>(name: RouteName, body?: unknown, query?: Record<string, string | undefined>, notify = false): Promise<ApiResult<T>> {
    const [method, path] = AUTH_ROUTES[name];
    return this.client.request<T>(method, path, { body, query, notifyUnauthenticated: notify });
  }

  profile(): Promise<ApiResult<SystemProfile>> {
    return this.send('profile');
  }

  /** `GET /me`: 401 when there is no active session (not an ended session: the boot asks first). */
  me(): Promise<ApiResult<Me>> {
    return this.send('me');
  }

  /** `PUT /me/org` after a sign-in that an organisation switch asked for (D-26). */
  switchOrg(org: string): Promise<ApiResult<Me>> {
    return this.send('switchOrg', { org });
  }

  /** Sign-in methods; in multi-tenant mode by `org` or by the domain of `email` (D.2). */
  providers(query: { org?: string; email?: string } = {}): Promise<ApiResult<AuthProviders>> {
    return this.send('providers', undefined, query);
  }

  login(email: string, password: string, remember: boolean): Promise<ApiResult<LoginResponse>> {
    return this.send('login', { email: email.trim(), password, remember });
  }

  verifyMfa(body: MfaVerifyRequest): Promise<ApiResult<LoginResponse>> {
    return this.send('mfaVerify', body);
  }

  enrolStart(body: MfaEnrolStartRequest = {}): Promise<ApiResult<MfaEnrolStartResponse>> {
    return this.send('enrolStart', body);
  }

  enrolConfirm(code: string): Promise<ApiResult<MfaEnrolConfirmResponse>> {
    return this.send('enrolConfirm', { code });
  }

  logout(): Promise<ApiResult<void>> {
    return this.client.logout();
  }

  requestPasswordReset(email: string): Promise<ApiResult<void>> {
    return this.send('resetRequest', { email: email.trim() });
  }

  resetPassword(token: string, password: string): Promise<ApiResult<void>> {
    return this.send('reset', { token, password });
  }

  acceptInvitation(token: string, password?: string): Promise<ApiResult<LoginResponse>> {
    return this.send('invitationAccept', password === undefined ? { token } : { token, password });
  }

  guestStart(token: string): Promise<ApiResult<GuestStartResponse>> {
    return this.send('guestStart', { token });
  }

  guestLogin(email: string): Promise<ApiResult<GuestStartResponse>> {
    return this.send('guestLogin', { email: email.trim() });
  }

  guestVerify(code: string): Promise<ApiResult<LoginResponse>> {
    return this.send('guestVerify', { code });
  }
}

/** A plausible email address (the server validates it again): one `@`, no spaces, a dot in the domain. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}
