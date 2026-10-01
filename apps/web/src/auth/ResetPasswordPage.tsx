// Password reset page `/reset-password#token=` (BUILD-PLAN H.6, F.4). The boot takes the token out of the URL
// fragment before the page renders (routes.ts `takeFragmentToken`), so it is never in the history. Success revokes
// every session of the user (D.3) and the sign-in page says so.
import React, { useState } from 'react';
import { useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, li } from './i18n';
import type { Pair } from './i18n';
import { AUTH_PATHS } from './routes';
import { Alert, AuthLayout, NoticeView, PageHead, PasswordField, SubmitButton } from './ui';
import type { Notice } from './ui';

/** Client-side check of a new password (F.4 length rule and the repeat); the server checks the rest. */
export function checkNewPassword(password: string, repeat: string): Pair | null {
  if (password.length < 12) return TEXT.passwordTooShort;
  if (password.length > 256) return TEXT.passwordTooLong;
  if (password !== repeat) return TEXT.passwordMismatch;
  return null;
}

/** The two fields of a new password with the policy as the hint. */
export function NewPasswordFields({
  env, password, repeat, onPassword, onRepeat, invalid,
}: { env: AuthEnv; password: string; repeat: string; onPassword: (v: string) => void; onRepeat: (v: string) => void; invalid: boolean }) {
  const { lang } = env;
  return (
    <>
      <PasswordField id="au-new-password" label={li(TEXT.newPassword, lang)} value={password} onChange={onPassword} autoComplete="new-password" invalid={invalid} autoFocus />
      <PasswordField id="au-repeat-password" label={li(TEXT.repeatPassword, lang)} value={repeat} onChange={onRepeat} autoComplete="new-password" invalid={invalid} />
      <p className="au-muted" style={{ margin: 0 }}>{li(TEXT.passwordRules, lang)}</p>
    </>
  );
}

export function ResetPasswordPage({ env, token }: { env: AuthEnv; token: string | null }) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(null);
  const [tokenBad, setTokenBad] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    const check = checkNewPassword(password, repeat);
    if (check) {
      setProblem({ kind: 'error', text: check });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.resetPassword(token, password);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      env.navigate('login', { replace: true, notice: { kind: 'ok', text: TEXT.passwordChanged } });
      return;
    }
    const error = result.error;
    const linkError = error.messageKey === 'auth.reset_invalid' || error.errors?.some((f) => f.path === 'body.token');
    if (linkError) setTokenBad(true);
    setProblem({ kind: 'error', text: linkError ? TEXT.resetInvalid : errorMessage(error) });
  }

  const askNew = (
    <div className="au-actions">
      <a href={AUTH_PATHS.forgot} onClick={(e) => { e.preventDefault(); env.navigate('forgot'); }}>{li(TEXT.askNewLink, lang)}</a>
      <a href={AUTH_PATHS.login} onClick={(e) => { e.preventDefault(); env.navigate('login'); }}>{li(TEXT.backToSignIn, lang)}</a>
    </div>
  );

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.passwordEyebrow, lang)} title={li(TEXT.resetTitle, lang)} />
      {!token ? (
        <>
          <Alert kind="error">{li(TEXT.linkIncomplete, lang)}</Alert>
          {askNew}
        </>
      ) : (
        <>
          <NoticeView notice={problem} lang={lang} />
          {tokenBad ? askNew : (
            <form className="au-form" onSubmit={submit} noValidate>
              <NewPasswordFields env={env} password={password} repeat={repeat} onPassword={setPassword} onRepeat={setRepeat} invalid={problem !== null} />
              <SubmitButton busy={busy} label={li(TEXT.setPassword, lang)} busyLabel={li(TEXT.working, lang)} />
            </form>
          )}
        </>
      )}
    </AuthLayout>
  );
}
