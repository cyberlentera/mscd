// Invitation page `/invite#token=` (BUILD-PLAN H.6, F.4, D-25): set a password for the invited account (then MFA
// enrolment), or continue with one of the organisation's identity providers, which redeems the invitation on the
// provider's callback (F.8 step 4). The token comes out of the URL fragment before the page renders.
import React, { useEffect, useState } from 'react';
import type { AuthProviders } from '@mscd/shared';
import { looksLikeEmail } from './api';
import { continueSignIn, useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, li } from './i18n';
import { AUTH_PATHS, ssoStartUrl } from './routes';
import { checkNewPassword, NewPasswordFields } from './ResetPasswordPage';
import { Alert, AuthLayout, Divider, EmailField, NoticeView, PageHead, ProviderButtons, SubmitButton } from './ui';
import type { Notice, ProviderChoice } from './ui';

export function InvitePage({ env, token, org = null }: { env: AuthEnv; token: string | null; org?: string | null }) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(null);
  const [providers, setProviders] = useState<ProviderChoice[]>([]);
  const [lookup, setLookup] = useState<{ open: boolean; email: string; none: boolean }>({ open: false, email: '', none: false });
  const [invalidLink, setInvalidLink] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void api.providers(org ? { org } : {}).then((r) => {
      if (live && r.ok) setProviders(r.data.providers);
    });
    return () => {
      live = false;
    };
  }, [api, org, token]);

  async function findProviders(e: React.FormEvent) {
    e.preventDefault();
    if (!looksLikeEmail(lookup.email)) {
      setProblem({ kind: 'error', text: TEXT.enterEmail });
      return;
    }
    setProblem(null);
    const r = await api.providers({ email: lookup.email.trim() });
    if (!mounted.current) return;
    const found: AuthProviders['providers'] = r.ok ? r.data.providers : [];
    setProviders(found);
    setLookup({ ...lookup, none: found.length === 0 });
  }

  /** Accepts with a new password, or (an account that already has one) without, then continues to the second factor. */
  async function accept(withPassword: boolean) {
    if (busy || !token) return;
    if (withPassword) {
      const check = checkNewPassword(password, repeat);
      if (check) {
        setProblem({ kind: 'error', text: check });
        return;
      }
    }
    setBusy(true);
    setProblem(null);
    const result = await api.acceptInvitation(token, withPassword ? password : undefined);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      continueSignIn(env, result.data);
      return;
    }
    const error = result.error;
    if (error.messageKey === 'auth.sso_required' && error.methods) setProviders(error.methods.providers);
    const linkError = error.messageKey === 'auth.invitation_invalid' || error.errors?.some((f) => f.path === 'body.token');
    if (linkError) setInvalidLink(true);
    setProblem({ kind: 'error', text: errorMessage(error) });
  }

  const hrefOf = (p: ProviderChoice) => ssoStartUrl(p, { invitation: token ?? undefined, returnTo: '/' });
  const backToSignIn = (
    <div className="au-actions">
      <a href={AUTH_PATHS.login} onClick={(e) => { e.preventDefault(); env.navigate('login'); }}>{li(TEXT.backToSignIn, lang)}</a>
    </div>
  );

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.inviteEyebrow, lang)} title={li(TEXT.inviteTitle, lang)} lead={token && !invalidLink ? li(TEXT.inviteLead, lang) : undefined} />
      {!token ? (
        <>
          <Alert kind="error">{li(TEXT.linkIncomplete, lang)}</Alert>
          {backToSignIn}
        </>
      ) : invalidLink ? (
        <>
          <NoticeView notice={problem} lang={lang} />
          {backToSignIn}
        </>
      ) : (
        <>
          <NoticeView notice={problem} lang={lang} />
          <form className="au-form" onSubmit={(e) => { e.preventDefault(); void accept(true); }} noValidate>
            <NewPasswordFields env={env} password={password} repeat={repeat} onPassword={setPassword} onRepeat={setRepeat} invalid={problem !== null} />
            <SubmitButton busy={busy} label={li(TEXT.inviteSubmit, lang)} busyLabel={li(TEXT.working, lang)} />
            <button type="button" className="au-link-btn" onClick={() => void accept(false)}>{li(TEXT.haveAccount, lang)}</button>
          </form>
          <Divider text={li(TEXT.orContinueWith, lang)} />
          {providers.length ? (
            <ProviderButtons providers={providers} hrefOf={hrefOf} />
          ) : lookup.open ? (
            <form className="au-form" onSubmit={findProviders} noValidate>
              <EmailField id="au-lookup-email" lang={lang} value={lookup.email} onChange={(v) => setLookup({ open: true, email: v, none: false })} autoFocus />
              <button type="submit" className="au-btn au-btn-quiet">{li(TEXT.findSignIn, lang)}</button>
              {lookup.none ? <p className="au-muted" role="status" style={{ margin: 0 }}>{li(TEXT.noSso, lang)}</p> : null}
            </form>
          ) : (
            <button type="button" className="au-btn au-btn-quiet" onClick={() => setLookup({ ...lookup, open: true })}>{li(TEXT.findSignIn, lang)}</button>
          )}
        </>
      )}
    </AuthLayout>
  );
}
