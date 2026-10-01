// What every sign-in page receives from the router (AuthRouter.tsx): the api, the display settings, the system
// profile, navigation between the pages and the hand-over to the application once a session is active.
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { LoginResponse, Me, SystemProfile } from '@mscd/shared';
import type { AuthApi } from './api';
import type { Lang } from './i18n';
import type { AuthPage, StorageLike } from './routes';
import { storeStep } from './routes';
import type { Notice } from './ui';

export interface NavigateOptions {
  replace?: boolean;
  /** A message the target page shows on arrival (for example "Your password was changed"). */
  notice?: Notice | null;
  /** The navigation continues a sign-in (a new session replaced any earlier one). */
  signInStep?: boolean;
  /** The sign-in is a guest sign-in (F.14). */
  guest?: boolean;
}

export interface AuthEnv {
  api: AuthApi;
  lang: Lang;
  theme: 'light' | 'dark';
  profile: SystemProfile | null;
  /** Footer facts of the brand panel. */
  facts: string[];
  store: StorageLike | null;
  /** Relative URL the application opens after sign-in; also the `returnTo` of identity provider sign-in. */
  returnTo: string;
  navigate(page: AuthPage, options?: NavigateOptions): void;
  /** The session is active: open the application. */
  signedIn(me: Me): void;
}

/**
 * Continues after a sign-in step answered `LoginResponse` (D.2): `ok` opens the application, `mfa_required` the
 * code page and `mfa_enrolment_required` the enrolment page. The step and its CSRF token are kept for this tab so
 * the next page also works after a reload.
 */
export function continueSignIn(env: AuthEnv, response: LoginResponse, options: { guest?: boolean } = {}): void {
  if (response.status === 'ok' && response.me) {
    storeStep(env.store, null);
    env.signedIn(response.me);
    return;
  }
  const stage = response.status === 'mfa_required' ? 'mfa' : 'enrol';
  storeStep(env.store, { stage, csrfToken: response.csrfToken, ...(options.guest ? { guest: true } : {}) });
  env.navigate(stage, { replace: true, signInStep: true, guest: Boolean(options.guest) });
}

/** False once the component unmounted, so late answers do not update a page that is gone. */
export function useMountedRef(): MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
