// Invitation page `/invite#token=` (BUILD-PLAN H.6, F.4, F.6, D-25). The invitation is accepted with a password
// (shared contract `InvitationAcceptRequest`): a new one for an account without a password (then MFA enrolment), or
// the current password of an account that already has one, which the server checks and never replaces. The page
// offers both forms, and also the organisation's identity providers, which redeem the invitation on the provider's
// callback (F.8 step 4). The token comes out of the URL fragment before the page renders.
import React, { useEffect, useState } from 'react';
import type { AuthProviders } from '@mscd/shared';
import type { ApiError } from '../data/api/ApiClient';
import { looksLikeEmail } from './api';
import { continueSignIn, useMountedRef } from './context';
import type { AuthEnv } from './context';
import { MESSAGE_KEYS, TEXT, errorMessage, li, passwordProblemMessage } from './i18n';
import type { Pair } from './i18n';
import { AUTH_PATHS, ssoStartUrl } from './routes';
import { checkNewPassword, NewPasswordFields } from './ResetPasswordPage';
import { Alert, AuthLayout, Divider, EmailField, NoticeView, PageHead, PasswordField, ProviderButtons, SubmitButton } from './ui';
import type { Notice, ProviderChoice } from './ui';

/** `new`: choose a password for an account without one. `existing`: enter the current password of the account. */
export type InviteMode = 'new' | 'existing';

/** What the page shows after a refused acceptance: the message, the form to show next, and whether the link is spent. */
export interface InviteOutcome {
  text: Pair;
  mode: InviteMode;
  invalidLink: boolean;
}

/**
 * The page's reading of a refused `POST /auth/invitations/accept` (WP-11): a refused link; a 401 about the password,
 * which means the account has a password (the new-password form switches to the current-password form); a
 * `body.password` error asking for the account's password; and, in the current-password form, a password policy
 * error, which means the account has no password yet (the server checked the value as a new password).
 */
export function inviteOutcome(error: ApiError, mode: InviteMode): InviteOutcome {
  if (error.messageKey === 'auth.invitation_invalid' || error.errors?.some((f) => f.path === 'body.token')) {
    return { text: MESSAGE_KEYS['auth.invitation_invalid'], mode, invalidLink: true };
  }
  if (error.status === 401 && (!error.messageKey || error.messageKey === 'auth.invalid_credentials')) {
    return { text: mode === 'existing' ? TEXT.inviteWrongPassword : TEXT.inviteHasPassword, mode: 'existing', invalidLink: false };
  }
  const field = error.errors?.find((f) => f.path === 'body.password');
  if (field && passwordProblemMessage(field.message) === TEXT.inviteEnterPassword) {
    return { text: TEXT.inviteEnterPassword, mode: 'existing', invalidLink: false };
  }
  if (field && mode === 'existing') return { text: TEXT.inviteNoPassword, mode: 'new', invalidLink: false };
  return { text: errorMessage(error), mode, invalidLink: false };
}

export function InvitePage({
  env, token, org = null, initialMode = 'new',
}: { env: AuthEnv; token: string | null; org?: string | null; initialMode?: InviteMode }) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [mode, setMode] = useState<InviteMode>(initialMode);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [current, setCurrent] = useState('');
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

  function switchMode(next: InviteMode) {
    setMode(next);
    setProblem(null);
    setPassword('');
    setRepeat('');
    setCurrent('');
  }

  /** Accepts with the new password or the account's current password, then continues to the second factor. */
  async function accept(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    let value: string;
    if (mode === 'new') {
      const check = checkNewPassword(password, repeat);
      if (check) {
        setProblem({ kind: 'error', text: check });
        return;
      }
      value = password;
    } else {
      // No account password is longer than 256 characters (F.4), so a longer value cannot be the right one.
      if (!current || current.length > 256) {
        setProblem({ kind: 'error', text: current ? TEXT.inviteWrongPassword : TEXT.inviteEnterPassword });
        return;
      }
      value = current;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.acceptInvitation(token, value);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      continueSignIn(env, result.data);
      return;
    }
    const error = result.error;
    if (error.messageKey === 'auth.sso_required' && error.methods) setProviders(error.methods.providers);
    const outcome = inviteOutcome(error, mode);
    if (outcome.invalidLink) setInvalidLink(true);
    if (outcome.mode !== mode) {
      setMode(outcome.mode);
      setPassword('');
      setRepeat('');
    }
    setCurrent('');
    setProblem({ kind: 'error', text: outcome.text });
  }

  const hrefOf = (p: ProviderChoice) => ssoStartUrl(p, { invitation: token ?? undefined, returnTo: '/' });
  const backToSignIn = (
    <div className="au-actions">
      <a href={AUTH_PATHS.login} onClick={(e) => { e.preventDefault(); env.navigate('login'); }}>{li(TEXT.backToSignIn, lang)}</a>
    </div>
  );
  const lead = !token || invalidLink ? undefined : li(mode === 'existing' ? TEXT.inviteExistingLead : TEXT.inviteLead, lang);

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.inviteEyebrow, lang)} title={li(TEXT.inviteTitle, lang)} lead={lead} />
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
          {mode === 'new' ? (
            <form className="au-form" onSubmit={accept} noValidate>
              <NewPasswordFields env={env} password={password} repeat={repeat} onPassword={setPassword} onRepeat={setRepeat} invalid={problem !== null} />
              <SubmitButton busy={busy} label={li(TEXT.inviteSubmit, lang)} busyLabel={li(TEXT.working, lang)} />
              <button type="button" className="au-link-btn" onClick={() => switchMode('existing')}>{li(TEXT.haveAccount, lang)}</button>
            </form>
          ) : (
            <form className="au-form" onSubmit={accept} noValidate>
              <PasswordField
                id="au-current-password" label={li(TEXT.accountPassword, lang)} value={current} onChange={setCurrent}
                autoComplete="current-password" invalid={problem !== null} placeholder={li(TEXT.passwordPlaceholder, lang)} autoFocus
                extra={<a href={AUTH_PATHS.forgot} onClick={(e) => { e.preventDefault(); env.navigate('forgot'); }}>{li(TEXT.forgot, lang)}</a>}
              />
              <SubmitButton busy={busy} label={li(TEXT.inviteAccept, lang)} busyLabel={li(TEXT.working, lang)} />
              <button type="button" className="au-link-btn" onClick={() => switchMode('new')}>{li(TEXT.noPasswordYet, lang)}</button>
            </form>
          )}
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
