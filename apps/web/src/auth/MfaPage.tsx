// Second-factor page `/login/mfa` (BUILD-PLAN H.6, F.5): the 6-digit code is sent as soon as the sixth digit is
// typed; "Use a recovery code" switches to a recovery code `xxxx-xxxx-xx`. A wrong code clears the field; a 429
// (the per-user second-factor lock, F.3) says when to try again; a session that ended returns to the sign-in page.
import React, { useState } from 'react';
import { continueSignIn, useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, li } from './i18n';
import { storeStep } from './routes';
import { AuthLayout, CodeField, NoticeView, PageHead, SubmitButton } from './ui';
import type { Notice } from './ui';

const RECOVERY = /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/;

/** A typed recovery code in the stored form: lower case, the two dashes put back when they were left out. */
export function normaliseRecoveryCode(value: string): string {
  const plain = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (plain.length !== 10) return value.trim().toLowerCase();
  return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`;
}

export function MfaPage({ env, guest = false }: { env: AuthEnv; guest?: boolean }) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(null);

  async function send(body: { code: string } | { recoveryCode: string }) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.verifyMfa(body);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      continueSignIn(env, result.data, { guest });
      return;
    }
    const error = result.error;
    if (error.status === 401 && error.messageKey !== 'auth.mfa_invalid') {
      // The sign-in step is gone (expired, revoked after too many failures): start again.
      storeStep(env.store, null);
      env.navigate('login', { replace: true, notice: { kind: 'error', text: errorMessage(error, { stepExpired: true }) } });
      return;
    }
    setCode('');
    setProblem({ kind: 'error', text: errorMessage(error) });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (recovery) {
      const value = normaliseRecoveryCode(recoveryCode);
      if (!RECOVERY.test(value)) {
        setProblem({ kind: 'error', text: TEXT.recoveryFormat });
        return;
      }
      void send({ recoveryCode: value });
    } else {
      if (!/^\d{6}$/.test(code)) {
        setProblem({ kind: 'error', text: TEXT.codeFormat });
        return;
      }
      void send({ code });
    }
  }

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.mfaEyebrow, lang)} title={li(TEXT.mfaTitle, lang)} lead={li(recovery ? TEXT.mfaRecoveryLead : TEXT.mfaLead, lang)} />
      <NoticeView notice={problem} lang={lang} />
      <form className="au-form" onSubmit={submit} noValidate>
        {recovery ? (
          <label className="au-label" htmlFor="au-recovery">
            {li(TEXT.recoveryLabel, lang)}
            <input
              id="au-recovery" name="recoveryCode" className="au-input au-code au-code-recovery" type="text" autoComplete="off"
              spellCheck={false} autoCapitalize="none" placeholder="xxxx-xxxx-xx" maxLength={14} value={recoveryCode} autoFocus
              aria-invalid={problem ? true : undefined} onChange={(e) => setRecoveryCode(e.target.value)}
            />
          </label>
        ) : (
          <CodeField
            id="au-code" label={li(TEXT.codeLabel, lang)} value={code} onChange={setCode} invalid={problem !== null}
            onComplete={(digits) => void send({ code: digits })}
          />
        )}
        <SubmitButton busy={busy} label={li(TEXT.verify, lang)} busyLabel={li(TEXT.working, lang)} />
      </form>
      <div className="au-actions">
        <button type="button" className="au-link-btn" onClick={() => { setRecovery(!recovery); setProblem(null); }}>
          {li(recovery ? TEXT.useAuthenticator : TEXT.useRecovery, lang)}
        </button>
        <button type="button" className="au-link-btn" onClick={() => { storeStep(env.store, null); env.navigate('login', { replace: true }); }}>
          {li(TEXT.otherAccount, lang)}
        </button>
      </div>
    </AuthLayout>
  );
}
