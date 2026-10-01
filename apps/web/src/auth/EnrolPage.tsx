// Enrolment page `/login/enrol` (BUILD-PLAN H.6, F.5). During sign-in (session in `mfa_enrolment`) it starts at
// once; from an active session (re-enrolment) it first asks for the current code or the password. Then: the QR code
// (rendered to SVG with `qrcode`), the secret in groups of four, the confirmation code, and the ten recovery codes
// with Copy and "I saved them" before the application opens.
import React, { useEffect, useRef, useState } from 'react';
import type { Me, MfaEnrolStartRequest, MfaEnrolStartResponse } from '@mscd/shared';
import { useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, li } from './i18n';
import type { ApiError } from '../data/api/ApiClient';
import { QrCode, groupSecret } from './QrCode';
import { storeStep } from './routes';
import { Alert, AuthLayout, CodeField, NoticeView, PageHead, PasswordField, SubmitButton } from './ui';
import type { Notice } from './ui';

export type EnrolMode = 'enrol' | 'reenrol';
type Phase = 'proof' | 'starting' | 'scan' | 'codes';

export interface EnrolPageProps {
  env: AuthEnv;
  /** `enrol` during sign-in; `reenrol` from an active session (asks for a proof first). */
  mode: EnrolMode;
  /** Copies text; default `navigator.clipboard.writeText`. */
  copy?: (text: string) => Promise<void>;
}

const PROOF_KEYS = new Set(['auth.proof_invalid', 'auth.proof_required']);

function defaultCopy(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard not available'));
}

export function EnrolPage({ env, mode, copy = defaultCopy }: EnrolPageProps) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [phase, setPhase] = useState<Phase>(mode === 'reenrol' ? 'proof' : 'starting');
  const [proofKind, setProofKind] = useState<'code' | 'password'>('code');
  const [proof, setProof] = useState('');
  const [secret, setSecret] = useState<MfaEnrolStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(null);
  const started = useRef(false);

  /** A 401 that is not about the code or the proof: the sign-in step ended, so the user signs in again. */
  function stepEnded(error: ApiError): boolean {
    if (error.status !== 401 || error.messageKey === 'auth.mfa_invalid' || (error.messageKey && PROOF_KEYS.has(error.messageKey))) return false;
    storeStep(env.store, null);
    env.navigate('login', { replace: true, notice: { kind: 'error', text: errorMessage(error, { stepExpired: true }) } });
    return true;
  }

  async function start(body: MfaEnrolStartRequest) {
    setBusy(true);
    setProblem(null);
    const result = await api.enrolStart(body);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      setSecret(result.data);
      setPhase('scan');
      return;
    }
    if (stepEnded(result.error)) return;
    setProof('');
    setProblem({ kind: 'error', text: errorMessage(result.error) });
  }

  useEffect(() => {
    if (mode !== 'enrol' || started.current) return;
    started.current = true;
    // Once per page (React may run effects twice in development); later starts come from the buttons.
    void start({});
  }, [mode]);

  function submitProof(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (proofKind === 'code') {
      if (!/^\d{6}$/.test(proof)) {
        setProblem({ kind: 'error', text: TEXT.codeFormat });
        return;
      }
      void start({ currentCode: proof });
    } else {
      if (!proof) {
        setProblem({ kind: 'error', text: TEXT.enterPassword });
        return;
      }
      void start({ password: proof });
    }
  }

  async function confirm(value: string) {
    if (busy) return;
    if (!/^\d{6}$/.test(value)) {
      setProblem({ kind: 'error', text: TEXT.codeFormat });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.enrolConfirm(value);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      storeStep(env.store, null);
      setCodes(result.data.recoveryCodes);
      setMe(result.data.me);
      setPhase('codes');
      return;
    }
    if (stepEnded(result.error)) return;
    setCode('');
    setProblem({ kind: 'error', text: errorMessage(result.error) });
  }

  async function copyCodes() {
    try {
      await copy(codes.join('\n'));
      if (mounted.current) setCopied({ kind: 'ok', text: TEXT.copied });
    } catch {
      if (mounted.current) setCopied({ kind: 'info', text: TEXT.copyFailed });
    }
  }

  const reenrol = mode === 'reenrol';
  const title = phase === 'codes' ? TEXT.recoveryTitle : reenrol ? TEXT.reenrolTitle : TEXT.enrolTitle;
  const lead = phase === 'codes' ? TEXT.recoveryLead : phase === 'proof' ? TEXT.reenrolLead : TEXT.enrolLead;

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.enrolEyebrow, lang)} title={li(title, lang)} lead={li(lead, lang)} />
      <NoticeView notice={problem} lang={lang} />

      {phase === 'proof' ? (
        <form className="au-form" onSubmit={submitProof} noValidate>
          {proofKind === 'code' ? (
            <CodeField id="au-proof-code" label={li(TEXT.currentCode, lang)} value={proof} onChange={setProof} invalid={problem !== null} />
          ) : (
            <PasswordField id="au-proof-password" label={li(TEXT.password, lang)} value={proof} onChange={setProof} autoComplete="current-password" invalid={problem !== null} autoFocus />
          )}
          <SubmitButton busy={busy} label={li(TEXT.continue, lang)} busyLabel={li(TEXT.working, lang)} />
          <button type="button" className="au-link-btn" onClick={() => { setProofKind(proofKind === 'code' ? 'password' : 'code'); setProof(''); setProblem(null); }}>
            {li(proofKind === 'code' ? TEXT.usePasswordProof : TEXT.useCodeProof, lang)}
          </button>
        </form>
      ) : null}

      {phase === 'starting' ? (
        busy || !problem ? (
          <p className="au-lead" role="status">{li(TEXT.working, lang)}</p>
        ) : (
          <div className="au-row">
            <button type="button" className="au-btn au-btn-quiet" onClick={() => void start({})}>{li(TEXT.tryAgain, lang)}</button>
          </div>
        )
      ) : null}

      {phase === 'scan' && secret ? (
        <>
          <div className="au-qr">
            <div className="au-qr-code"><QrCode text={secret.otpauthUrl} label={li(TEXT.qrLabel, lang)} /></div>
            <div className="au-qr-facts">
              <div>
                {li(TEXT.secretLabel, lang)}
                <div className="au-secret" data-testid="enrol-secret">{groupSecret(secret.secret)}</div>
              </div>
              <div>
                {li(TEXT.accountLabel, lang)}
                <div className="au-secret">{secret.issuer}: {secret.account}</div>
              </div>
            </div>
          </div>
          <form className="au-form" onSubmit={(e) => { e.preventDefault(); void confirm(code); }} noValidate>
            <CodeField id="au-confirm" label={li(TEXT.confirmCode, lang)} value={code} onChange={setCode} invalid={problem !== null} onComplete={(v) => void confirm(v)} />
            <SubmitButton busy={busy} label={li(TEXT.confirm, lang)} busyLabel={li(TEXT.working, lang)} />
          </form>
        </>
      ) : null}

      {phase === 'codes' ? (
        <>
          {reenrol ? <Alert kind="info">{li(TEXT.otherSessionsEnded, lang)}</Alert> : null}
          <ul className="au-codes" aria-label={li(TEXT.recoveryTitle, lang)}>
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="au-row">
            <button type="button" className="au-btn au-btn-quiet" onClick={() => void copyCodes()}>{li(TEXT.copyCodes, lang)}</button>
            {copied ? <span className="au-muted" role="status">{li(copied.text, lang)}</span> : null}
          </div>
          <form className="au-form" onSubmit={(e) => { e.preventDefault(); if (saved && me) env.signedIn(me); }}>
            <label className="au-check">
              <input type="checkbox" name="saved" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              {li(TEXT.savedThem, lang)}
            </label>
            <button className="au-btn" type="submit" disabled={!saved} aria-disabled={!saved}>{li(TEXT.continueToApp, lang)}</button>
          </form>
        </>
      ) : null}
    </AuthLayout>
  );
}
