// Guest auditor page `/guest#<token>` (BUILD-PLAN H.6, F.14). The boot reads the token from the fragment, removes
// the fragment from the address bar and posts it (`beginGuestAccess`); this page shows the answer, then asks for
// the emailed 6-digit code, then continues to TOTP enrolment (first visit) or the TOTP code. Returning guests ask
// for a new code with "Send me a code".
import React, { useEffect, useRef, useState } from 'react';
import type { GuestStartResponse } from '@mscd/shared';
import type { ApiResult } from '../data/api/ApiClient';
import { looksLikeEmail } from './api';
import { continueSignIn, useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, fill, li } from './i18n';
import { AUTH_PATHS } from './routes';
import { Alert, AuthLayout, CodeField, EmailField, NoticeView, PageHead, SubmitButton } from './ui';
import type { Notice } from './ui';

type Phase = 'checking' | 'email' | 'code';

export interface GuestPageProps {
  env: AuthEnv;
  /** The answer of `POST /auth/guest/start` for the token of the link, or null when the address held no token. */
  start?: Promise<ApiResult<GuestStartResponse> | null> | null;
}

export function GuestPage({ env, start = null }: GuestPageProps) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [phase, setPhase] = useState<Phase>(start ? 'checking' : 'email');
  const [email, setEmail] = useState('');
  const [hint, setHint] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(null);
  const handled = useRef(false);

  function codeSent(result: ApiResult<GuestStartResponse>, linkFailed: Notice['text']) {
    if (result.ok) {
      setHint(result.data.emailHint);
      setCode('');
      setPhase('code');
      return;
    }
    setPhase('email');
    setProblem({ kind: 'error', text: result.error.status === 401 ? linkFailed : errorMessage(result.error) });
  }

  useEffect(() => {
    if (!start || handled.current) return;
    handled.current = true;
    void start.then((result) => {
      if (!mounted.current) return;
      if (result === null) setPhase('email');
      else codeSent(result, TEXT.guestLinkInvalid);
    });
    // The boot creates the start promise once; it is read once (`codeSent` only sets state).
  }, [start, mounted]);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!looksLikeEmail(email)) {
      setProblem({ kind: 'error', text: TEXT.enterEmail });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.guestLogin(email);
    if (!mounted.current) return;
    setBusy(false);
    codeSent(result, TEXT.guestCodeInvalid);
  }

  async function verify(value: string) {
    if (busy) return;
    if (!/^\d{6}$/.test(value)) {
      setProblem({ kind: 'error', text: TEXT.codeFormat });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.guestVerify(value);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      continueSignIn(env, result.data, { guest: true });
      return;
    }
    setCode('');
    setProblem({ kind: 'error', text: result.error.status === 401 ? TEXT.guestCodeInvalid : errorMessage(result.error) });
  }

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.guestEyebrow, lang)} title={li(TEXT.guestTitle, lang)} lead={phase === 'email' ? li(TEXT.guestReturningLead, lang) : undefined} />
      <NoticeView notice={problem} lang={lang} />

      {phase === 'checking' ? <p className="au-lead" role="status">{li(TEXT.guestChecking, lang)}</p> : null}

      {phase === 'code' ? (
        <>
          <Alert kind="info">{li(fill(TEXT.guestCodeSent, { hint }), lang)}</Alert>
          <form className="au-form" onSubmit={(e) => { e.preventDefault(); void verify(code); }} noValidate>
            <CodeField id="au-guest-code" label={li(TEXT.guestCodeLabel, lang)} value={code} onChange={setCode} invalid={problem !== null} onComplete={(v) => void verify(v)} />
            <SubmitButton busy={busy} label={li(TEXT.verify, lang)} busyLabel={li(TEXT.working, lang)} />
          </form>
          <div className="au-actions">
            <button type="button" className="au-link-btn" onClick={() => { setPhase('email'); setProblem(null); }}>{li(TEXT.sendNewCode, lang)}</button>
          </div>
        </>
      ) : null}

      {phase === 'email' ? (
        <form className="au-form" onSubmit={sendCode} noValidate>
          <EmailField id="au-guest-email" lang={lang} value={email} onChange={setEmail} invalid={problem !== null} autoFocus />
          <SubmitButton busy={busy} label={li(TEXT.sendMeCode, lang)} busyLabel={li(TEXT.working, lang)} />
        </form>
      ) : null}

      <div className="au-foot">
        <a href={AUTH_PATHS.login} onClick={(e) => { e.preventDefault(); env.navigate('login'); }}>{li(TEXT.backToSignIn, lang)}</a>
      </div>
    </AuthLayout>
  );
}
