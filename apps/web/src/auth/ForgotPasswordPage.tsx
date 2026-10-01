// Forgotten password page `/forgot-password` (BUILD-PLAN H.6, F.4): the api always answers 202, so the page says
// the same thing for every address (no account enumeration).
import React, { useState } from 'react';
import { looksLikeEmail } from './api';
import { useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, li } from './i18n';
import { AUTH_PATHS } from './routes';
import { Alert, AuthLayout, EmailField, NoticeView, PageHead, SubmitButton } from './ui';
import type { Notice } from './ui';

export function ForgotPasswordPage({ env, notice = null }: { env: AuthEnv; notice?: Notice | null }) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(notice);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!looksLikeEmail(email)) {
      setProblem({ kind: 'error', text: TEXT.enterEmail });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.requestPasswordReset(email);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) setSent(true);
    else setProblem({ kind: 'error', text: result.error.slug === 'validation' ? TEXT.enterEmail : errorMessage(result.error) });
  }

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.passwordEyebrow, lang)} title={li(TEXT.forgotTitle, lang)} lead={li(TEXT.forgotLead, lang)} />
      <NoticeView notice={problem} lang={lang} />
      {sent ? (
        <Alert kind="ok">{li(TEXT.forgotDone, lang)}</Alert>
      ) : (
        <form className="au-form" onSubmit={submit} noValidate>
          <EmailField id="au-email" lang={lang} value={email} onChange={setEmail} invalid={problem !== null} autoFocus />
          <SubmitButton busy={busy} label={li(TEXT.sendLink, lang)} busyLabel={li(TEXT.working, lang)} />
        </form>
      )}
      <div className="au-actions">
        <a href={AUTH_PATHS.login} onClick={(e) => { e.preventDefault(); env.navigate('login'); }}>{li(TEXT.backToSignIn, lang)}</a>
      </div>
    </AuthLayout>
  );
}
