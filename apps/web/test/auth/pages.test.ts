// The sign-in and account pages rendered with react-dom/server (no DOM library in this workspace): fields, labels,
// placeholders, the error code messages, notices, languages and themes of each page (H.6).
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthRouter } from '../../src/auth/AuthRouter';
import type { AuthRouterProps } from '../../src/auth/AuthRouter';
import { EnrolPage } from '../../src/auth/EnrolPage';
import { ForgotPasswordPage } from '../../src/auth/ForgotPasswordPage';
import { GuestPage } from '../../src/auth/GuestPage';
import { LOGIN_ERROR_MESSAGES, TEXT, li } from '../../src/auth/i18n';
import { InvitePage } from '../../src/auth/InvitePage';
import { LoginPage } from '../../src/auth/LoginPage';
import { MfaPage } from '../../src/auth/MfaPage';
import { ResetPasswordPage } from '../../src/auth/ResetPasswordPage';
import type { AuthPage } from '../../src/auth/routes';
import { BrandPanel, brandFacts } from '../../src/auth/ui';
import { LOGIN_ERROR_CODES } from '../../../../packages/shared/src/api/auth';
import { PROFILE, fakeEnv, makeApi } from './helpers';

const TOKEN = 'Q2hhbmdlTWUtVG9rZW4tVmFsdWUtMDEyMzQ1Njc4OWFi';
const FORBIDDEN = /[\u2014\u00b7]/;

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
    expect(text).toContain('Please wait');
    expect(html).not.toContain('<form');
  });

  it('asks for the current code (or the password) first from an active session', () => {
    const html = render(EnrolPage, { env: envFor(), mode: 'reenrol' });
    const text = textOf(html);
    expect(text).toContain('Replace your authenticator');
    expect(text).toContain(li(TEXT.reenrolLead, 'en'));
    expect(html).toContain('id="au-proof-code"');
    expect(text).toContain('Use my password instead');
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
    expect(html).not.toContain(TOKEN);
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
