// The sign-in and account pages rendered with react-dom/server (no DOM library in this workspace): fields, labels,
// placeholders, the error code messages, notices, languages and themes of each page (H.6).
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthRouter } from '../../src/auth/AuthRouter';
import type { AuthRouterProps } from '../../src/auth/AuthRouter';
import { EnrolPage, enrolRefusal, enrolTexts } from '../../src/auth/EnrolPage';
import { ForgotPasswordPage } from '../../src/auth/ForgotPasswordPage';
import { GuestPage } from '../../src/auth/GuestPage';
import { LOGIN_ERROR_MESSAGES, MESSAGE_KEYS, TEXT, li } from '../../src/auth/i18n';
import { InvitePage, inviteOutcome } from '../../src/auth/InvitePage';
import type { ApiError } from '../../src/data/api/ApiClient';
import { LoginPage } from '../../src/auth/LoginPage';
import { MfaPage } from '../../src/auth/MfaPage';
import { ResetPasswordPage } from '../../src/auth/ResetPasswordPage';
import type { AuthPage } from '../../src/auth/routes';
import { BrandPanel, brandFacts } from '../../src/auth/ui';
import { LOGIN_ERROR_CODES } from '../../../../packages/shared/src/api/auth';
import { PROFILE, fakeEnv, makeApi } from './helpers';

const TOKEN = 'Q2hhbmdlTWUtVG9rZW4tVmFsdWUtMDEyMzQ1Njc4OWFi';
// Writing rules: no en or em dash, centre dot, curly quote or arrow character.
const FORBIDDEN = /[\u2013\u2014\u00b7\u2018\u2019\u201c\u201d\u2190\u2192]/;

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}
function envFor(lang: 'en' | 'id' = 'en', theme: 'light' | 'dark' = 'light') {
  const { api } = makeApi({});
  return fakeEnv(api, { lang, theme, facts: brandFacts(PROFILE, lang) }).env;
}
/** The text content of the markup: tags removed, entities of the renderer decoded. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

describe('brand panel', () => {
  it('shows the design structure: logo, chain, headline, three facts and the footer facts', () => {
    for (const lang of ['en', 'id'] as const) {
      const html = render(BrandPanel, { lang, facts: brandFacts(PROFILE, lang) });
      expect(html).toContain('src="/assets/cyberlentera-logo.png"');
      expect(html).toContain('alt="CyberLentera"');
      expect(html).toContain('>MSCD<');
      expect((html.match(/<circle /g) ?? []).length).toBe(6);
      for (const key of ['chainIssue', 'chainRisk', 'chainControl', 'chainDocument', 'chainEvidence', 'chainFinding', 'headline', 'factFrameworks', 'factChain', 'factFiles'] as const) {
        expect(textOf(html)).toContain(li(TEXT[key], lang));
      }
    }
  });

  it('lists the version, deployment label with region, TLS 1.3 and MFA enforced (H.6)', () => {
    expect(brandFacts(PROFILE, 'en')).toEqual(['v1.0.0', 'SaaS, region Jakarta', 'TLS 1.3', 'MFA enforced']);
    expect(brandFacts(PROFILE, 'id')).toEqual(['v1.0.0', 'SaaS, wilayah Jakarta', 'TLS 1.3', 'MFA diwajibkan']);
    const onprem = { ...PROFILE, deploy: 'onprem' as const, login: { mfaEnforced: false } };
    expect(brandFacts(onprem, 'en')).toEqual(['v1.0.0', 'On-Premise', 'TLS 1.3']);
    expect(brandFacts(PROFILE, 'en', 'onprem')[1]).toBe('On-Premise, region Jakarta');
    expect(brandFacts(null, 'en')).toEqual([]);
  });
});

describe('sign-in page /login', () => {
  it('has the email and password fields of the design, Keep me signed in (unchecked), Continue and the notes', () => {
    const env = envFor();
    const html = render(LoginPage, { env });
    expect(html).toMatch(/<input id="au-email" name="email" class="au-input" type="email" autoComplete="username"[^>]*placeholder="rina.kusuma@nusantaradigital.co.id"[^>]*value=""/);
    expect(html).toMatch(/<input id="au-password" name="password" class="au-input" type="password" autoComplete="current-password" placeholder="•{12}" value=""/);
    expect(html).toMatch(/<input type="checkbox" name="remember"\/>/);
    const text = textOf(html);
    for (const key of ['signInEyebrow', 'signInTitle', 'signInLead', 'workEmail', 'password', 'forgot', 'remember', 'continue', 'secondFactorNote', 'guestQuestion', 'guestLink'] as const) {
      expect(text).toContain(li(TEXT[key], 'en'));
    }
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain('href="/guest"');
    expect(html).not.toContain('au-alert');
    // no providers yet: no SSO buttons and no "or with email" divider
    expect(html).not.toContain('au-sso');
    expect(text).not.toContain(li(TEXT.orWithEmail, 'en'));
  });

  it('shows the message of every /login?error= code in a red note above the form, in both languages', () => {
    for (const lang of ['en', 'id'] as const) {
      for (const code of LOGIN_ERROR_CODES) {
        const html = render(LoginPage, { env: envFor(lang), errorCode: code });
        expect(html).toContain('class="au-alert au-alert-error" role="alert"');
        expect(html).toContain(escapeHtml(li(LOGIN_ERROR_MESSAGES[code], lang)));
        expect(html.indexOf('au-alert')).toBeLessThan(html.indexOf('<form'));
      }
    }
    expect(render(LoginPage, { env: envFor(), errorCode: 'something_else' })).toContain('The sign-in did not complete. Try again.');
  });

  it('shows a notice on arrival (session ended, signed out)', () => {
    const ended = render(LoginPage, { env: envFor(), notice: { kind: 'info', text: TEXT.sessionEnded } });
    expect(textOf(ended)).toContain('Your session has ended. Sign in again.');
    const out = render(LoginPage, { env: envFor('id'), notice: { kind: 'ok', text: TEXT.signedOut } });
    expect(textOf(out)).toContain('Anda telah keluar.');
  });

  it('lists the accepted methods of reauth-required with provider buttons and the divider', () => {
    const reauth = {
      methods: { local: true, providers: [{ slug: 'entra', kind: 'oidc' as const, label: 'Microsoft Entra ID', icon: 'microsoft' as const }, { slug: 'adfs', kind: 'saml' as const, label: 'AD FS' }] },
      org: 'bsd',
    };
    const html = render(LoginPage, { env: { ...envFor(), returnTo: '/?theme=dark' }, reauth, onCancelReauth: () => undefined });
    const text = textOf(html);
    expect(text).toContain('This organisation asks you to sign in again with one of these methods: email and password, Microsoft Entra ID, AD FS.');
    expect(html).toContain('href="/api/v1/auth/oidc/entra/start?returnTo=%2F%3Ftheme%3Ddark"');
    expect(html).toContain('href="/api/v1/auth/saml/adfs/start?returnTo=%2F%3Ftheme%3Ddark"');
    expect(html).toContain('#f25022'); // the Microsoft icon of the design
    expect(text).toContain('or with email');
    expect(text).toContain('Stay in the current organisation');
    expect(html).toContain('<form');
  });

  it('hides the password form when the switch accepts single sign-on only', () => {
    const reauth = { methods: { local: false, providers: [{ slug: 'kc', kind: 'oidc' as const, label: 'Keycloak' }] } };
    const html = render(LoginPage, { env: envFor(), reauth });
    expect(html).not.toContain('<form');
    expect(textOf(html)).toContain(li(TEXT.ssoOnly, 'en'));
  });

  it('renders in Indonesian and in the dark theme', () => {
    const html = render(LoginPage, { env: envFor('id', 'dark') });
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('lang="id"');
    expect(textOf(html)).toContain('Selamat datang kembali');
    expect(textOf(html)).toContain('Tetap masuk di perangkat ini selama 12 jam');
  });
});

describe('second factor /login/mfa', () => {
  it('has a 6-digit one-time-code field that submits itself, Verify and the recovery code switch', () => {
    const html = render(MfaPage, { env: envFor() });
    expect(html).toMatch(/<input id="au-code" name="code" class="au-input au-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\[0-9\]\{6\}" maxLength="6"/);
    const text = textOf(html);
    for (const key of ['mfaEyebrow', 'mfaTitle', 'mfaLead', 'codeLabel', 'verify', 'useRecovery', 'otherAccount'] as const) expect(text).toContain(li(TEXT[key], 'en'));
    expect(textOf(render(MfaPage, { env: envFor('id') }))).toContain('Gunakan kode pemulihan');
  });
});

describe('enrolment /login/enrol', () => {
  it('starts at once during sign-in', () => {
    const html = render(EnrolPage, { env: envFor(), mode: 'enrol' });
    const text = textOf(html);
    expect(text).toContain('Add an authenticator');
    expect(html).toContain('<p class="au-lead" role="status">Please wait</p>');
    expect(text.split('Please wait').length).toBe(2);
    expect(html).not.toContain('<form');
  });

  it('asks for the current code (or the password) first from an active session', () => {
    const html = render(EnrolPage, { env: envFor(), mode: 'reenrol' });
    const text = textOf(html);
    expect(text).toContain('Replace your authenticator');
    expect(text).toContain(li(TEXT.reenrolLead, 'en'));
    expect(html).toContain('id="au-proof-code"');
    expect(text).toContain('Use my password instead');
    expect(text).not.toContain(li(TEXT.signInAgain, 'en'));
  });

  it('asks only for the current code during sign-in when the account has a factor, and offers to sign in again', () => {
    for (const lang of ['en', 'id'] as const) {
      const html = render(EnrolPage, { env: envFor(lang), mode: 'enrol', startWithProof: true });
      const text = textOf(html);
      expect(text).toContain(li(TEXT.reenrolTitle, lang));
      expect(text).toContain(li(TEXT.enrolFactorLead, lang));
      expect(html).toMatch(/id="au-proof-code" name="code"[^>]*autoComplete="one-time-code"/);
      expect(html).not.toContain('au-proof-password');
      expect(html).not.toContain('type="password"');
      for (const key of ['usePasswordProof', 'reenrolLead', 'enrolLead'] as const) expect(text).not.toContain(li(TEXT[key], lang));
      // A password is not accepted in this state (WP-11), so the page does not mention one.
      expect(text).not.toMatch(/password|kata sandi/i);
      expect(html).toContain(`<button type="button" class="au-link-btn">${li(TEXT.signInAgain, lang)}</button>`);
      expect(html).not.toContain('Please wait');
      expect(FORBIDDEN.test(text)).toBe(false);
    }
  });

  it('after a reload of a sign-in step that replaces a factor, starts without a proof under the replacement title', () => {
    for (const lang of ['en', 'id'] as const) {
      // The boot reads the flag of the stored step (session.test.ts) and the router hands it to the page.
      const html = renderToStaticMarkup(createElement(AuthRouter, { page: 'enrol', env: envFor(lang), enrolMode: 'enrol', enrolReplacing: true }));
      const text = textOf(html);
      expect(text).toContain(li(TEXT.reenrolTitle, lang));
      expect(text).not.toContain(li(TEXT.enrolTitle, lang));
      expect(html).toContain(`<p class="au-lead" role="status">${li(TEXT.working, lang)}</p>`);
      expect(html).not.toContain('<form');
      // Without the flag it is a first enrolment; in re-enrolment the flag changes nothing.
      expect(textOf(renderToStaticMarkup(createElement(AuthRouter, { page: 'enrol', env: envFor(lang), enrolMode: 'enrol' })))).toContain(li(TEXT.enrolTitle, lang));
      const reenrol = renderToStaticMarkup(createElement(AuthRouter, { page: 'enrol', env: envFor(lang), enrolMode: 'reenrol', enrolReplacing: true }));
      expect(reenrol).toContain('id="au-proof-code"');
    }
  });

  it('says on the recovery codes that the other sessions were signed out whenever a factor was replaced', () => {
    // During sign-in, also after a reload (the flag of the stored step), and from an active session.
    expect(enrolTexts('codes', 'enrol', true)).toEqual({ title: TEXT.recoveryTitle, lead: TEXT.recoveryLead, otherSessionsEnded: true });
    expect(enrolTexts('codes', 'reenrol', false).otherSessionsEnded).toBe(true);
    // A first enrolment signs no session out.
    expect(enrolTexts('codes', 'enrol', false).otherSessionsEnded).toBe(false);
    for (const phase of ['proof', 'starting', 'scan'] as const) {
      expect(enrolTexts(phase, 'enrol', true).otherSessionsEnded).toBe(false);
      expect(enrolTexts(phase, 'enrol', true).title).toEqual(TEXT.reenrolTitle);
      expect(enrolTexts(phase, 'reenrol', false).title).toEqual(TEXT.reenrolTitle);
    }
    expect(enrolTexts('starting', 'enrol', false).title).toEqual(TEXT.enrolTitle);
    expect(enrolTexts('scan', 'enrol', false)).toEqual({ title: TEXT.enrolTitle, lead: TEXT.enrolLead, otherSessionsEnded: false });
    expect(enrolTexts('proof', 'enrol', true).lead).toEqual(TEXT.enrolFactorLead);
    expect(enrolTexts('proof', 'reenrol', false).lead).toEqual(TEXT.reenrolLead);
    expect(li(TEXT.otherSessionsEnded, 'en')).toBe('Your other sessions were signed out.');
  });

  it('reads a refused start or confirmation: current code during sign-in, sign in again, or a message', () => {
    const key = (messageKey: string, status = 401): ApiError => ({ status, slug: 'unauthenticated', message: ['x', 'x'], messageKey });
    // Sign-in step, account with a factor confirmed in another session (WP-11): the current-code form, at start or confirmation.
    expect(enrolRefusal(key('auth.proof_required'), 'enrol')).toEqual({ next: 'current-code' });
    // The page sends only codes during sign-in: a wrong proof is a wrong current code, without a word about a password.
    expect(enrolRefusal(key('auth.proof_invalid'), 'enrol')).toEqual({ next: 'stay', text: TEXT.currentCodeWrong });
    expect(TEXT.currentCodeWrong.join(' ')).not.toMatch(/password|kata sandi/i);
    expect(TEXT.enrolFactorLead.join(' ')).not.toMatch(/password|kata sandi/i);
    // Re-enrolment keeps the messages about the code or the password.
    expect(enrolRefusal(key('auth.proof_required'), 'reenrol')).toEqual({ next: 'stay', text: MESSAGE_KEYS['auth.proof_required'] });
    expect(enrolRefusal(key('auth.proof_invalid'), 'reenrol')).toEqual({ next: 'stay', text: MESSAGE_KEYS['auth.proof_invalid'] });
    for (const mode of ['enrol', 'reenrol'] as const) {
      expect(enrolRefusal(key('auth.mfa_invalid'), mode)).toEqual({ next: 'stay', text: MESSAGE_KEYS['auth.mfa_invalid'] });
      // Any other 401: the step ended (for example revoked as mfa_enrolled by a first enrolment elsewhere).
      const ended = enrolRefusal({ status: 401, slug: 'unauthenticated', message: ['x', 'x'] }, mode);
      expect(ended.next).toBe('sign-in');
      expect(ended.next === 'sign-in' && ended.text[0]).toBe('Your sign-in has expired. Sign in again.');
      expect(enrolRefusal({ status: 429, slug: 'rate-limited', message: ['x', 'x'], retryAfter: 300 }, mode))
        .toEqual({ next: 'stay', text: ['Too many attempts. Try again in 5 minutes.', 'Terlalu banyak percobaan. Coba lagi dalam 5 menit.'] });
      expect(enrolRefusal({ status: 0, message: ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'] }, mode))
        .toEqual({ next: 'stay', text: ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'] });
    }
  });
});

describe('forgotten password /forgot-password', () => {
  it('asks for the work email', () => {
    const html = render(ForgotPasswordPage, { env: envFor() });
    expect(html).toContain('id="au-email"');
    const text = textOf(html);
    for (const key of ['forgotTitle', 'forgotLead', 'sendLink', 'backToSignIn'] as const) expect(text).toContain(li(TEXT[key], 'en'));
  });
});

describe('password reset /reset-password#token=', () => {
  it('asks for the new password twice with the policy as the hint', () => {
    const html = render(ResetPasswordPage, { env: envFor(), token: TOKEN });
    expect(html).toMatch(/id="au-new-password"[^>]*type="password" autoComplete="new-password"/);
    expect(html).toMatch(/id="au-repeat-password"[^>]*type="password" autoComplete="new-password"/);
    const text = textOf(html);
    for (const key of ['resetTitle', 'newPassword', 'repeatPassword', 'passwordRules', 'setPassword'] as const) expect(text).toContain(li(TEXT[key], 'en'));
    expect(html).not.toContain(TOKEN);
  });

  it('says the link is incomplete without a token', () => {
    const html = render(ResetPasswordPage, { env: envFor('id'), token: null });
    expect(textOf(html)).toContain(li(TEXT.linkIncomplete, 'id'));
    expect(html).not.toContain('<form');
    expect(html).toContain('href="/forgot-password"');
  });
});

describe('invitation /invite#token=', () => {
  it('offers a new password and the sign-in of the organisation', () => {
    const html = render(InvitePage, { env: envFor(), token: TOKEN });
    const text = textOf(html);
    for (const key of ['inviteEyebrow', 'inviteTitle', 'inviteLead', 'newPassword', 'repeatPassword', 'inviteSubmit', 'haveAccount', 'orContinueWith', 'findSignIn'] as const) {
      expect(text).toContain(li(TEXT[key], 'en'));
    }
    expect(html).toMatch(/id="au-new-password"[^>]*type="password" autoComplete="new-password"/);
    expect(html).not.toContain('au-current-password');
    expect(html).not.toContain(TOKEN);
  });

  it('asks an account that has a password for its current password only (WP-11: checked, never replaced)', () => {
    for (const lang of ['en', 'id'] as const) {
      const html = render(InvitePage, { env: envFor(lang), token: TOKEN, initialMode: 'existing' });
      expect(html).toMatch(/id="au-current-password" name="password"[^>]*type="password" autoComplete="current-password"/);
      expect((html.match(/type="password"/g) ?? []).length).toBe(1);
      expect(html).not.toContain('au-new-password');
      expect(html).not.toContain('au-repeat-password');
      expect(html).toContain('href="/forgot-password"');
      const text = textOf(html);
      for (const key of ['inviteExistingLead', 'accountPassword', 'inviteAccept', 'noPasswordYet', 'forgot', 'orContinueWith', 'findSignIn'] as const) {
        expect(text).toContain(li(TEXT[key], lang));
      }
      for (const key of ['inviteLead', 'passwordRules', 'repeatPassword', 'haveAccount'] as const) expect(text).not.toContain(li(TEXT[key], lang));
      // The request cannot say which form sent the value: an account without a password takes it as its new password.
      expect(text).not.toMatch(/stays the same|tidak berubah/);
      expect(li(TEXT.inviteExistingLead, lang)).toMatch(lang === 'en' ? /new password/ : /kata sandi barunya/);
      expect(html).not.toContain(TOKEN);
    }
  });

  it('reads the refusals of the acceptance into a message and the form to show next', () => {
    const validation = (message: string): ApiError => ({ status: 400, slug: 'validation', message: ['x', 'x'], errors: [{ path: 'body.password', message }] });
    const wrong: ApiError = { status: 401, slug: 'unauthenticated', message: ['x', 'x'], messageKey: 'auth.invalid_credentials' };
    // A new password for an account that has one: the server checked it as the current password.
    expect(inviteOutcome(wrong, 'new')).toEqual({ text: TEXT.inviteHasPassword, mode: 'existing', invalidLink: false });
    expect(inviteOutcome(wrong, 'existing')).toEqual({ text: TEXT.inviteWrongPassword, mode: 'existing', invalidLink: false });
    expect(inviteOutcome({ status: 401, message: ['x', 'x'] }, 'existing').text).toBe(TEXT.inviteWrongPassword);
    const enter = validation('Enter the password of your account to accept the invitation');
    expect(inviteOutcome(enter, 'new')).toEqual({ text: TEXT.inviteEnterPassword, mode: 'existing', invalidLink: false });
    expect(inviteOutcome(enter, 'existing')).toEqual({ text: TEXT.inviteEnterPassword, mode: 'existing', invalidLink: false });
    // A current password for an account without one: the server checked it as a new password.
    expect(inviteOutcome(validation('Use at least 12 characters'), 'existing')).toEqual({ text: TEXT.inviteNoPassword, mode: 'new', invalidLink: false });
    expect(inviteOutcome(validation('This password is too common; choose another one'), 'existing').mode).toBe('new');
    expect(inviteOutcome(validation('Use at least 12 characters'), 'new')).toEqual({ text: TEXT.passwordTooShort, mode: 'new', invalidLink: false });
    expect(inviteOutcome(validation('Choose a password to accept the invitation'), 'new').text).toBe(TEXT.choosePassword);
    // The link itself, single sign-on and the rate limit.
    for (const mode of ['new', 'existing'] as const) {
      expect(inviteOutcome({ status: 400, slug: 'validation', message: ['x', 'x'], messageKey: 'auth.invitation_invalid' }, mode))
        .toEqual({ text: LOGIN_ERROR_MESSAGES.invitation_invalid, mode, invalidLink: true });
      expect(inviteOutcome({ status: 400, slug: 'validation', message: ['x', 'x'], errors: [{ path: 'body.token', message: 'Invalid' }] }, mode).invalidLink).toBe(true);
      expect(inviteOutcome({ status: 401, message: ['x', 'x'], messageKey: 'auth.sso_required' }, mode))
        .toEqual({ text: LOGIN_ERROR_MESSAGES.sso_required, mode, invalidLink: false });
      expect(inviteOutcome({ status: 429, slug: 'rate-limited', message: ['x', 'x'], retryAfter: 120 }, mode).text[0]).toBe('Too many attempts. Try again in 2 minutes.');
    }
  });

  it('says the link is incomplete without a token', () => {
    expect(textOf(render(InvitePage, { env: envFor(), token: null }))).toContain(li(TEXT.linkIncomplete, 'en'));
  });
});

describe('guest access /guest', () => {
  it('checks the access link while the start answer is pending', () => {
    const html = render(GuestPage, { env: envFor(), start: new Promise<null>(() => undefined) });
    expect(textOf(html)).toContain('Checking your access link');
    expect(html).not.toContain('<form');
  });

  it('offers "Send me a code" to returning guests', () => {
    const html = render(GuestPage, { env: envFor('id') });
    const text = textOf(html);
    expect(text).toContain('AKSES TAMU AUDITOR');
    expect(text).toContain(li(TEXT.guestReturningLead, 'id'));
    expect(text).toContain('Kirim kode kepada saya');
    expect(html).toContain('id="au-guest-email"');
  });
});

describe('router', () => {
  it('renders the page of each path, every page without em dash or centre dot', () => {
    const titles: Record<AuthPage, string> = {
      login: 'Welcome back', mfa: 'Enter your code', enrol: 'Add an authenticator', forgot: 'Reset your password',
      reset: 'Choose a new password', invite: 'Join MSCD', guest: 'Guest access',
    };
    for (const lang of ['en', 'id'] as const) {
      for (const [page, title] of Object.entries(titles) as [AuthPage, string][]) {
        const props: AuthRouterProps = { page, env: envFor(lang), linkToken: TOKEN };
        const html = render(AuthRouter, props);
        if (lang === 'en') expect(textOf(html)).toContain(title);
        expect(FORBIDDEN.test(textOf(html))).toBe(false);
        expect(html).toContain('class="au-root"');
      }
    }
  });
});
