// Enrolment page `/login/enrol` (BUILD-PLAN H.6, F.5). During sign-in (session in `mfa_enrolment`) it starts at
// once; from an active session (re-enrolment) it first asks for the current code or the password. When the account
// got a confirmed factor in another sign-in meanwhile, a start or confirmation during sign-in answers 401
// `auth.proof_required` (WP-11): the page then asks for the current code only (the server refuses a password there)
// and offers to sign in again. Then: the QR code (rendered to SVG with `qrcode`), the secret in groups of four, the
// confirmation code, and the ten recovery codes with Copy and "I saved them" before the application opens. Once
// the page has asked for the current code during sign-in, the step kept for this tab says so (`replacing`), so a
// reload still shows the replacement title and, on the recovery codes, that the other sessions were signed out.
import React, { useEffect, useRef, useState } from 'react';
import type { Me, MfaEnrolStartRequest, MfaEnrolStartResponse } from '@mscd/shared';
import { useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, li } from './i18n';
import type { Pair } from './i18n';
import type { ApiError } from '../data/api/ApiClient';
import { QrCode, groupSecret } from './QrCode';
import { markStepReplacing, storeStep } from './routes';
import { Alert, AuthLayout, CodeField, NoticeView, PageHead, PasswordField, SubmitButton } from './ui';
import type { Notice } from './ui';

export type EnrolMode = 'enrol' | 'reenrol';
export type EnrolPhase = 'proof' | 'starting' | 'scan' | 'codes';

export interface EnrolPageProps {
  env: AuthEnv;
  /** `enrol` during sign-in; `reenrol` from an active session (asks for a proof first). */
  mode: EnrolMode;
  /**
   * Begin at the proof form: always so for `reenrol`. During sign-in the page switches to its current-code form by
   * itself when the server answers 401 `auth.proof_required`; this prop renders that state at once.
   */
  startWithProof?: boolean;
  /**
   * During sign-in: this enrolment replaces a confirmed factor, as the step kept for this tab says after a reload
   * (`PendingStep.replacing`). Unlike `startWithProof` the page still starts without a proof: within 5 minutes of
   * the current-code proof the server accepts that (WP-11), and otherwise it asks for the code again.
   */
  replacing?: boolean;
  /** Copies text; default `navigator.clipboard.writeText`. */
  copy?: (text: string) => Promise<void>;
}

/** What the page does after a refused start or confirmation. */
export type EnrolRefusal =
  /** The sign-in step ended (a 401 that is not about a code or a proof): sign in again, with the message. */
  | { next: 'sign-in'; text: Pair }
  /** During sign-in the account has a confirmed factor now (WP-11): only its current code replaces it. */
  | { next: 'current-code' }
  /** The page stays where it is and shows the message. */
  | { next: 'stay'; text: Pair };

const PROOF_KEYS = new Set(['auth.proof_invalid', 'auth.proof_required']);

/**
 * The page's reading of a refused `POST /auth/mfa/enrol/start` or `/confirm` (F.5, WP-11). During sign-in, 401
 * `auth.proof_required` means the account got a confirmed factor in another session (or the proof of its current code
 * is older than 5 minutes), so the current-code form follows; a password is never offered there. The page sends
 * only codes during sign-in, so `auth.proof_invalid` there is about the current code.
 */
export function enrolRefusal(error: ApiError, mode: EnrolMode): EnrolRefusal {
  if (mode === 'enrol' && error.messageKey === 'auth.proof_required') return { next: 'current-code' };
  if (mode === 'enrol' && error.messageKey === 'auth.proof_invalid') return { next: 'stay', text: TEXT.currentCodeWrong };
  if (error.status === 401 && error.messageKey !== 'auth.mfa_invalid' && !(error.messageKey && PROOF_KEYS.has(error.messageKey))) {
    return { next: 'sign-in', text: errorMessage(error, { stepExpired: true }) };
  }
  return { next: 'stay', text: errorMessage(error) };
}

/**
 * Title and lead of a phase, and whether the recovery codes say that the other sessions were signed out: the server
 * revokes them when a factor is replaced, from an active session (`reenrol`) or during sign-in (`replacing`).
 */
export function enrolTexts(phase: EnrolPhase, mode: EnrolMode, replacing: boolean): { title: Pair; lead: Pair; otherSessionsEnded: boolean } {
  const reenrol = mode === 'reenrol';
  const replaces = reenrol || (mode === 'enrol' && replacing);
  // During sign-in the proof form is the current-code form of an account that has a factor (WP-11).
  const codeOnly = !reenrol && phase === 'proof';
  return {
    title: phase === 'codes' ? TEXT.recoveryTitle : replaces ? TEXT.reenrolTitle : TEXT.enrolTitle,
    lead: phase === 'codes' ? TEXT.recoveryLead : codeOnly ? TEXT.enrolFactorLead : phase === 'proof' ? TEXT.reenrolLead : TEXT.enrolLead,
    otherSessionsEnded: phase === 'codes' && replaces,
  };
}

function defaultCopy(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard not available'));
}

export function EnrolPage({ env, mode, startWithProof = false, replacing: replacingAtStart = false, copy = defaultCopy }: EnrolPageProps) {
  const { api, lang } = env;
  const mounted = useMountedRef();
  const [phase, setPhase] = useState<EnrolPhase>(mode === 'reenrol' || startWithProof ? 'proof' : 'starting');
  /** During sign-in: the account has a confirmed factor (WP-11), so this enrolment replaces it. */
  const [replacing, setReplacing] = useState(mode === 'enrol' && (startWithProof || replacingAtStart));
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

  /** Back to the sign-in page; the step kept for this tab is forgotten. */
  function signInAgain(notice: Notice | null = null) {
    storeStep(env.store, null);
    env.navigate('login', { replace: true, notice });
  }

  /** Follows `enrolRefusal`: sign in again, the current-code form (a new secret follows it), or a message. */
  function refused(error: ApiError) {
    const next = enrolRefusal(error, mode);
    if (next.next === 'sign-in') {
      signInAgain({ kind: 'error', text: next.text });
      return;
    }
    setProof('');
    setCode('');
    if (next.next === 'current-code') {
      // Kept with the step for this tab, so a reload still knows (cleared with the step).
      markStepReplacing(env.store);
      setSecret(null);
      setProofKind('code');
      setProblem(null);
      setReplacing(true);
      setPhase('proof');
      return;
    }
    setProblem({ kind: 'error', text: next.text });
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
    refused(result.error);
  }

  useEffect(() => {
    if (mode !== 'enrol' || phase !== 'starting' || started.current) return;
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
    refused(result.error);
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
  /** During sign-in the proof form is the current-code form of an account that has a factor (WP-11). */
  const codeOnly = !reenrol && phase === 'proof';
  const { title, lead, otherSessionsEnded } = enrolTexts(phase, mode, replacing);

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
          {codeOnly ? null : (
            <button type="button" className="au-link-btn" onClick={() => { setProofKind(proofKind === 'code' ? 'password' : 'code'); setProof(''); setProblem(null); }}>
              {li(proofKind === 'code' ? TEXT.usePasswordProof : TEXT.useCodeProof, lang)}
            </button>
          )}
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

      {!reenrol && (phase === 'proof' || (phase === 'starting' && !busy && problem)) ? (
        <div className="au-actions">
          <button type="button" className="au-link-btn" onClick={() => signInAgain()}>{li(TEXT.signInAgain, lang)}</button>
        </div>
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
          {otherSessionsEnded ? <Alert kind="info">{li(TEXT.otherSessionsEnded, lang)}</Alert> : null}
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
