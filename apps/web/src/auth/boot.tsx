// Boot of the API build (BUILD-PLAN H.7). main.jsx loads this module only when VITE_DATA_SOURCE is `api`; the
// sample build renders MscdApp directly as before.
//
// - Start: `GET /system/profile`, then `GET /me` (session.ts). Without a session the sign-in pages render; with one
//   the application renders with the data source of `createDataSource()`.
// - A 401 while the application is in use stores the current address in sessionStorage, shows the sign-in page
//   with "Your session has ended. Sign in again." and returns to the stored address after sign-in.
// - A 409 `reauth-required` of an organisation switch (D-26) shows the sign-in page with the accepted methods and,
//   after sign-in, asks for the switch once more.
// - Signing out shows the sign-in page with "You have signed out."
// - Display settings in the address (`drill`, `density`, `layout`, `font`, `lang`, `theme`) keep working on every
//   page; `deploy` stays a demo override (only when the profile says demo mode is on).
import React, { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GuestStartResponse, Me, SystemProfile } from '@mscd/shared';
import { ApiClient } from '../data/api/ApiClient';
import type { ApiResult, Lang, Pair, ReauthEvent } from '../data/api/ApiClient';
import type { DataSource } from '../data/types';
import { AuthApi } from './api';
import { AuthRouter } from './AuthRouter';
import type { AuthEnv, NavigateOptions } from './context';
import type { EnrolMode } from './EnrolPage';
import { TEXT, detectLang, li } from './i18n';
import {
  AUTH_PATHS, authPageOf, beginGuestAccess, keptSearch, peekReturnTo, readReauth, sessionStore, storeReauth, storeReturnTo,
  storeStep, takeCsrfFragment, takeFragmentToken, takeReturnTo,
} from './routes';
import type { AuthPage, PendingReauth, StorageLike } from './routes';
import { decideBoot } from './session';
import { brandFacts } from './ui';
import type { Notice } from './ui';
import './auth.css';

/** Display settings main.jsx reads from the address (the props of MscdApp). */
export interface DisplaySettings {
  drillPattern: 'panel' | 'page' | 'inline';
  density: 'dense' | 'comfortable' | 'airy';
  overviewLayout: 'cards' | 'rows';
  font: 'plex' | 'source' | 'public' | 'instrument';
  lang: Lang;
  theme: 'light' | 'dark';
  deploy: 'saas' | 'onprem';
}

export type AppProps = DisplaySettings & { dataSource: DataSource };

export interface DataSourceOptions {
  client: ApiClient;
  me: Me;
  profile: SystemProfile;
}

export interface BootOptions {
  container: Element;
  settings: DisplaySettings;
  /** The application controller (MscdApp). */
  App: React.ComponentType<AppProps>;
  /** `createDataSource` of src/data (the API source of WP-25 in this build). */
  createDataSource: (options: DataSourceOptions) => Promise<DataSource>;
}

type Mode =
  | { kind: 'loading' }
  | { kind: 'failed'; message: Pair; detail?: string; canSignOut?: boolean }
  | { kind: 'auth'; page: AuthPage }
  | { kind: 'app'; ds: DataSource | null };

interface Initial {
  errorCode: string | null;
  org: string | null;
  linkToken: string | null;
  guestStart: Promise<ApiResult<GuestStartResponse> | null> | null;
  csrf: string | null;
}

/** Reads what the first address carries, once, before React renders (fragments are removed from the address). */
export function readInitial(api: AuthApi, location: Location, history: History): Initial {
  const page = authPageOf(location.pathname);
  const query = new URLSearchParams(location.search);
  const errorCode = query.get('error');
  if (errorCode) {
    query.delete('error');
    const rest = query.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }
  return {
    errorCode: page === 'login' ? errorCode : null,
    org: query.get('org'),
    linkToken: page === 'reset' || page === 'invite' ? takeFragmentToken(location, history) : null,
    guestStart: page === 'guest' ? beginGuestAccess((token) => api.guestStart(token), location, history) : null,
    csrf: page === 'mfa' || page === 'enrol' ? takeCsrfFragment(location, history) : null,
  };
}

function LoadingPanel({ lang, theme }: { lang: Lang; theme: 'light' | 'dark' }) {
  return (
    <div className="au-boot" data-theme={theme} role="status" lang={lang}>
      <span>{li(TEXT.loading, lang)}</span>
    </div>
  );
}

function FailedPanel({ lang, theme, message, detail, onRetry, onSignOut }: {
  lang: Lang; theme: 'light' | 'dark'; message: Pair; detail?: string; onRetry: () => void; onSignOut?: () => void;
}) {
  return (
    <div className="au-boot" data-theme={theme} lang={lang}>
      <div className="au-boot-box" role="alert">
        <h1>{li(TEXT.bootFailed, lang)}</h1>
        <p>{li(message, lang)}</p>
        {detail ? <p>{detail}</p> : null}
        <div className="au-boot-actions">
          <button type="button" className="au-boot-primary" onClick={onRetry}>{li(TEXT.tryAgain, lang)}</button>
          {onSignOut ? <button type="button" onClick={onSignOut}>{li(TEXT.signOut, lang)}</button> : null}
        </div>
      </div>
    </div>
  );
}

const CANNOT_LOAD: Pair = ['The application could not load its data.', 'Aplikasi tidak dapat memuat datanya.'];

export interface ApiRootProps extends Omit<BootOptions, 'container'> {
  api: AuthApi;
  store: StorageLike | null;
  /** Language of the sign-in pages: `?lang=` or the browser language (H.6). */
  authLang: Lang;
  initial: Initial;
}

export function ApiRoot({ api, store, authLang, initial, settings, App, createDataSource }: ApiRootProps) {
  const client = api.client;
  const theme = settings.theme;
  const [mode, setModeState] = useState<Mode>({ kind: 'loading' });
  const [profile, setProfile] = useState<SystemProfile | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reauth, setReauth] = useState<PendingReauth | null>(() => readReauth(store));
  const [enrolMode, setEnrolMode] = useState<EnrolMode>('enrol');
  const [guestStep, setGuestStep] = useState(false);
  const [appKey, setAppKey] = useState(0);
  // The `?error=` code is shown once, on the first sign-in page.
  const [errorCode, setErrorCode] = useState<string | null>(initial.errorCode);
  const modeRef = useRef<Mode>(mode);
  const meRef = useRef<Me | null>(null);
  const booted = useRef(false);
  const appGeneration = useRef(0);

  const setMode = useCallback((next: Mode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const currentUrl = () => window.location.pathname + window.location.search;

  const showAuth = useCallback((page: AuthPage, options: NavigateOptions = {}) => {
    const url = AUTH_PATHS[page] + keptSearch(window.location.search);
    if (options.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    client.setLanguage(authLang);
    setNotice(options.notice ?? null);
    setMode({ kind: 'auth', page });
  }, [client, authLang, setMode]);

  const openApp = useCallback((me: Me, prof: SystemProfile, url: string | null) => {
    meRef.current = me;
    client.rememberMe(me);
    client.setLanguage(settings.lang);
    if (url !== null) window.history.replaceState(null, '', url);
    setMode({ kind: 'app', ds: null });
    setAppKey((k) => k + 1);
    const generation = ++appGeneration.current;
    const current = () => generation === appGeneration.current && modeRef.current.kind === 'app';
    createDataSource({ client, me, profile: prof }).then(
      (ds) => {
        if (current()) setMode({ kind: 'app', ds });
      },
      (e: unknown) => {
        console.error('MSCD data source failed', e);
        if (current()) setMode({ kind: 'failed', message: CANNOT_LOAD, detail: e instanceof Error ? e.message : String(e), canSignOut: true });
      },
    );
  }, [client, createDataSource, settings.lang, setMode]);

  const start = useCallback(async () => {
    setMode({ kind: 'loading' });
    const decision = await decideBoot({ api, pathname: window.location.pathname, search: window.location.search, store, csrfFromFragment: initial.csrf });
    if (decision.profile) setProfile(decision.profile);
    if (decision.kind === 'failed') {
      setMode({ kind: 'failed', message: decision.error.message });
      return;
    }
    if (decision.kind === 'app') {
      // An organisation switch that asked for a new sign-in is dropped once the old session is in use again.
      storeReauth(store, null);
      setReauth(null);
      openApp(decision.me, decision.profile, decision.url);
      return;
    }
    meRef.current = decision.me ?? null;
    setEnrolMode(decision.enrolMode ?? 'enrol');
    setGuestStep(Boolean(decision.guest));
    showAuth(decision.page, { replace: true });
  }, [api, store, initial.csrf, openApp, showAuth, setMode]);

  // Boot once (React may run effects twice in development).
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void start();
  }, [start]);

  // Session events of the client while the application is in use.
  useEffect(() => {
    const sessionEnded = () => {
      if (modeRef.current.kind !== 'app') return;
      meRef.current = null;
      client.setCsrfToken(null);
      storeReturnTo(store, currentUrl());
      showAuth('login', { replace: true, notice: { kind: 'info', text: TEXT.sessionEnded } });
    };
    const reauthRequired = (event: ReauthEvent) => {
      if (modeRef.current.kind !== 'app') return;
      storeReturnTo(store, currentUrl());
      storeReauth(store, event);
      setReauth(event);
      showAuth('login', { replace: true });
    };
    const signedOut = () => {
      meRef.current = null;
      storeStep(store, null);
      storeReauth(store, null);
      setReauth(null);
      showAuth('login', { replace: true, notice: { kind: 'ok', text: TEXT.signedOut } });
    };
    const offs = [client.onUnauthenticated(sessionEnded), client.onReauthRequired(reauthRequired), client.onSignedOut(signedOut)];
    const ds = mode.kind === 'app' ? mode.ds : null;
    if (ds && typeof ds.onUnauthenticated === 'function') offs.push(ds.onUnauthenticated(sessionEnded));
    return () => offs.forEach((off) => off());
  }, [client, store, showAuth, mode]);

  // Back and forward between the pages.
  useEffect(() => {
    const onPop = () => {
      const page = authPageOf(window.location.pathname);
      const current = modeRef.current;
      if (current.kind === 'auth') {
        if (page) {
          setNotice(null);
          setMode({ kind: 'auth', page });
        } else if (meRef.current && profile) {
          openApp(meRef.current, profile, null);
        } else {
          showAuth('login', { replace: true });
        }
      } else if (current.kind === 'app' && page) {
        if (page === 'enrol') {
          setEnrolMode('reenrol');
          setMode({ kind: 'auth', page });
        } else {
          window.history.replaceState(null, '', '/' + keptSearch(window.location.search));
        }
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [openApp, profile, setMode, showAuth]);

  const signedIn = useCallback(async (me: Me) => {
    client.rememberMe(me);
    storeStep(store, null);
    let current = me;
    const pending = readReauth(store);
    if (pending?.org && me.org?.slug !== pending.org) {
      const switched = await api.switchOrg(pending.org);
      if (switched.ok) current = switched.data;
    }
    storeReauth(store, null);
    setReauth(null);
    if (profile) openApp(current, profile, takeReturnTo(store));
  }, [api, client, store, profile, openApp]);

  const cancelReauth = useCallback(() => {
    storeReauth(store, null);
    setReauth(null);
    if (meRef.current && profile) openApp(meRef.current, profile, takeReturnTo(store));
    else showAuth('login', { replace: true });
  }, [store, profile, openApp, showAuth]);

  // A successful sign-out reaches the `onSignedOut` listener above; only a failed request starts over here.
  const signOut = useCallback(async () => {
    const result = await api.logout();
    if (!result.ok && result.status !== 401) void start();
  }, [api, start]);

  const deployParam = new URLSearchParams(window.location.search).get('deploy');
  const deployOverride = profile?.demo.enabled && (deployParam === 'saas' || deployParam === 'onprem') ? deployParam : null;

  const env: AuthEnv = {
    api,
    lang: authLang,
    theme,
    profile,
    facts: brandFacts(profile, authLang, deployOverride),
    store,
    returnTo: peekReturnTo(store),
    navigate: (page, options = {}) => {
      setErrorCode(null);
      // A new sign-in replaces the session cookie, so an earlier session is gone from here on.
      if (options.signInStep) meRef.current = null;
      if (page === 'enrol') setEnrolMode(meRef.current ? 'reenrol' : 'enrol');
      if (page === 'mfa' || page === 'enrol') setGuestStep(Boolean(options.guest));
      showAuth(page, options);
    },
    signedIn: (me) => void signedIn(me),
  };

  if (mode.kind === 'loading') return <LoadingPanel lang={authLang} theme={theme} />;
  if (mode.kind === 'failed') {
    return (
      <FailedPanel
        lang={authLang} theme={theme} message={mode.message} detail={mode.detail} onRetry={() => void start()}
        onSignOut={mode.canSignOut ? () => void signOut() : undefined}
      />
    );
  }
  if (mode.kind === 'app') {
    if (!mode.ds) return <LoadingPanel lang={settings.lang} theme={theme} />;
    const deploy = deployOverride ?? profile?.deploy ?? settings.deploy;
    return <App key={appKey} {...settings} deploy={deploy} dataSource={mode.ds} />;
  }
  return (
    <AuthRouter
      key={mode.page}
      page={mode.page}
      env={env}
      notice={notice}
      errorCode={errorCode}
      org={initial.org}
      reauth={mode.page === 'login' ? reauth : null}
      onCancelReauth={reauth && meRef.current ? cancelReauth : undefined}
      enrolMode={enrolMode}
      guest={guestStep}
      linkToken={initial.linkToken}
      guestStart={initial.guestStart}
    />
  );
}

/** Renders the API build into `container` (called by main.jsx). */
export function boot({ container, settings, App, createDataSource }: BootOptions): void {
  const authLang = detectLang(window.location.search, typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]);
  const api = new AuthApi(new ApiClient({ lang: authLang }));
  const store = sessionStore();
  const initial = readInitial(api, window.location, window.history);
  createRoot(container).render(
    <StrictMode>
      <ApiRoot api={api} store={store} authLang={authLang} initial={initial} settings={settings} App={App} createDataSource={createDataSource} />
    </StrictMode>,
  );
}
