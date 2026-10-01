// Sign-in page `/login` (BUILD-PLAN H.6), ported from project/MSCD Login.dc.html: identity provider buttons from
// `GET /auth/providers` (by `?org=`, and by the domain of the email once it is filled in), the "or with email"
// divider when both kinds exist, email and password, "Keep me signed in", Continue, the second-factor note, the
// auditor guest note and the "Forgot?" link. Errors of `/login?error=<code>` and of the api appear in a red note
// above the form; an organisation switch that needs a new sign-in (D-26) lists the accepted methods.
import React, { useEffect, useRef, useState } from 'react';
import type { AuthProviders } from '@mscd/shared';
import { looksLikeEmail } from './api';
import { continueSignIn, useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, fill, li, loginErrorMessage, methodsText } from './i18n';
import { AUTH_PATHS, ssoStartUrl } from './routes';
import type { PendingReauth } from './routes';
import {
  Alert, AuthLayout, Divider, EmailField, NoticeView, PageHead, PasswordField, ProviderButtons, SecondFactorNote, SubmitButton,
} from './ui';
import type { Notice, ProviderChoice } from './ui';

export interface LoginPageProps {
  env: AuthEnv;
  /** Message on arrival: session ended, signed out, password changed, or the `?error=` code. */
  notice?: Notice | null;
  /** `?error=<code>` of an identity provider callback (F.8 step 6). */
  errorCode?: string | null;
  /** `?org=<slug>`: the organisation whose providers to offer in multi-tenant mode (D.2). */
  org?: string | null;
  /** An organisation switch asked for a new sign-in with these methods (D-26). */
  reauth?: PendingReauth | null;
  onCancelReauth?: () => void;
  /** Debounce of the provider lookup by email, in milliseconds. */
  lookupDelay?: number;
}

/** Domain of an email address in lower case, or ''. */
export function emailDomain(email: string): string {
  const at = email.trim().lastIndexOf('@');
  return at < 0 ? '' : email.trim().slice(at + 1).toLowerCase();
}

export function LoginPage({ env, notice = null, errorCode = null, org = null, reauth = null, onCancelReauth, lookupDelay = 450 }: LoginPageProps) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(errorCode ? { kind: 'error', text: loginErrorMessage(errorCode) } : null);
  const [invalid, setInvalid] = useState<{ email?: boolean; password?: boolean }>({});
  const [found, setFound] = useState<AuthProviders | null>(null);
  // Providers named by an `auth.sso_required` answer (F.4): the ones to use instead of the password.
  const [ssoMethods, setSsoMethods] = useState<ProviderChoice[] | null>(null);
  const lookedUp = useRef<string | null>(null);

  // Providers of the installation, or of the organisation named in the URL.
  useEffect(() => {
    if (reauth) return;
    let live = true;
    void api.providers(org ? { org } : {}).then((r) => {
      if (live && r.ok) setFound(r.data);
    });
    return () => {
      live = false;
    };
  }, [api, org, reauth]);

  // In multi-tenant mode the providers follow the domain of the email (D.2); one lookup per domain.
  useEffect(() => {
    if (reauth || org || !looksLikeEmail(email)) return;
    const domain = emailDomain(email);
    if (!domain || lookedUp.current === domain) return;
    const timer = setTimeout(() => {
      lookedUp.current = domain;
      void api.providers({ email: email.trim() }).then((r) => {
        if (mounted.current && r.ok && emailDomain(email) === domain) setFound(r.data);
      });
    }, lookupDelay);
    return () => clearTimeout(timer);
  }, [api, email, org, reauth, lookupDelay, mounted]);

  const providers: ProviderChoice[] = reauth ? reauth.methods.providers : ssoMethods ?? found?.providers ?? [];
  // The email field stays while providers are looked up by its domain; only a switch that names the accepted
  // methods hides the password form when local sign-in is not one of them.
  const showForm = reauth ? reauth.methods.local || providers.length === 0 : true;
  const ssoOnly = !reauth && found !== null && !found.local && providers.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const bad = { email: !looksLikeEmail(email), password: password.length === 0 };
    setInvalid(bad);
    if (bad.email || bad.password) {
      setProblem({ kind: 'error', text: bad.email ? TEXT.enterEmail : TEXT.enterPassword });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.login(email, password, remember);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      continueSignIn(env, result.data);
      return;
    }
    const error = result.error;
    if (error.messageKey === 'auth.sso_required' && error.methods) {
      setSsoMethods(error.methods.providers);
    } else {
      setPassword('');
    }
    setProblem({ kind: 'error', text: errorMessage(error) });
  }

  const hrefOf = (p: ProviderChoice) => ssoStartUrl(p, { returnTo: env.returnTo });

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.signInEyebrow, lang)} title={li(TEXT.signInTitle, lang)} lead={li(TEXT.signInLead, lang)} />
      {reauth ? <Alert kind="info">{li(fill(TEXT.reauthLead, { methods: methodsText(reauth.methods, lang) }), lang)}</Alert> : null}
      {problem ? <NoticeView notice={problem} lang={lang} /> : <NoticeView notice={notice} lang={lang} />}
      <ProviderButtons providers={providers} hrefOf={hrefOf} />
      {ssoOnly ? <Alert kind="info">{li(TEXT.ssoOnly, lang)}</Alert> : null}
      {providers.length > 0 && showForm ? <Divider text={li(TEXT.orWithEmail, lang)} /> : null}
      {showForm ? (
        <form className="au-form" onSubmit={submit} noValidate>
          <EmailField id="au-email" lang={lang} value={email} onChange={setEmail} invalid={invalid.email} autoFocus />
          <PasswordField
            id="au-password" label={li(TEXT.password, lang)} value={password} onChange={setPassword} autoComplete="current-password"
            invalid={invalid.password} placeholder={li(TEXT.passwordPlaceholder, lang)}
            extra={<a href={AUTH_PATHS.forgot} onClick={(e) => { e.preventDefault(); env.navigate('forgot'); }}>{li(TEXT.forgot, lang)}</a>}
          />
          <label className="au-check">
            <input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {li(TEXT.remember, lang)}
          </label>
          <SubmitButton busy={busy} label={li(TEXT.continue, lang)} busyLabel={li(TEXT.working, lang)} />
        </form>
      ) : (
        <p className="au-lead">{li(TEXT.ssoOnly, lang)}</p>
      )}
      <SecondFactorNote lang={lang} />
      <div className="au-foot">
        <span>
          {li(TEXT.guestQuestion, lang)}{' '}
          <a href={AUTH_PATHS.guest} onClick={(e) => { e.preventDefault(); env.navigate('guest'); }}>{li(TEXT.guestLink, lang)}</a>
        </span>
        {reauth && onCancelReauth ? (
          <button type="button" className="au-link-btn" onClick={onCancelReauth}>{li(TEXT.reauthCancel, lang)}</button>
        ) : null}
      </div>
    </AuthLayout>
  );
}
