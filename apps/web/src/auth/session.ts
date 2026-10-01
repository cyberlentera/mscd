// Boot decision of the API build (BUILD-PLAN H.7), without React so the unit tests can run it with a fake fetch:
// `GET /system/profile`, then (except on the pages of emailed links) `GET /me`. An active session opens the
// application; no session opens the sign-in page and remembers the requested address; a second-factor or
// enrolment page reloaded in the middle of a sign-in continues with the step kept for this tab.
import type { Me, SystemProfile } from '@mscd/shared';
import type { ApiError } from '../data/api/ApiClient';
import type { AuthApi } from './api';
import type { EnrolMode } from './EnrolPage';
import { LINK_PAGES, authPageOf, readStep, storeReturnTo, storeStep, takeReturnTo } from './routes';
import type { AuthPage, StorageLike } from './routes';

export type BootDecision =
  | { kind: 'failed'; error: ApiError; profile: SystemProfile | null }
  | { kind: 'auth'; page: AuthPage; profile: SystemProfile; enrolMode?: EnrolMode; guest?: boolean; me?: Me }
  /** `url`: the address to show before the application renders, or null to keep the current one. */
  | { kind: 'app'; me: Me; profile: SystemProfile; url: string | null };

export interface BootInput {
  api: AuthApi;
  pathname: string;
  search: string;
  store: StorageLike | null;
  /** CSRF token handed over in the fragment of `/login/mfa` or `/login/enrol` (routes.ts `takeCsrfFragment`). */
  csrfFromFragment?: string | null;
}

export async function decideBoot({ api, pathname, search, store, csrfFromFragment = null }: BootInput): Promise<BootDecision> {
  const profileResult = await api.profile();
  if (!profileResult.ok) return { kind: 'failed', error: profileResult.error, profile: null };
  const profile = profileResult.data;
  const page = authPageOf(pathname);

  if (page && LINK_PAGES.has(page)) return { kind: 'auth', page, profile };

  if (page === 'mfa' || page === 'enrol') {
    if (csrfFromFragment) {
      storeStep(store, { stage: page, csrfToken: csrfFromFragment });
      api.client.setCsrfToken(csrfFromFragment);
      return { kind: 'auth', page, profile, enrolMode: 'enrol' };
    }
    const step = readStep(store);
    if (step && step.stage === page) {
      api.client.setCsrfToken(step.csrfToken);
      return { kind: 'auth', page, profile, enrolMode: 'enrol', ...(step.guest ? { guest: true } : {}) };
    }
  }

  const meResult = await api.me();
  if (meResult.ok) {
    const me = meResult.data;
    api.client.rememberMe(me);
    storeStep(store, null);
    if (page === 'enrol') return { kind: 'auth', page, profile, enrolMode: 'reenrol', me };
    // Signed in already: an auth page opens the application at the remembered address.
    if (page) return { kind: 'app', me, profile, url: takeReturnTo(store) };
    return { kind: 'app', me, profile, url: null };
  }
  if (meResult.status === 401) {
    if (!page) storeReturnTo(store, pathname + search);
    return { kind: 'auth', page: 'login', profile };
  }
  return { kind: 'failed', error: meResult.error, profile };
}
