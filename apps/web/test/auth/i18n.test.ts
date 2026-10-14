// Language rule, texts and the mapping of api errors and `/login?error=` codes (H.6).
import { describe, expect, it } from 'vitest';
import {
  LOGIN_ERROR_MESSAGES, MESSAGE_KEYS, TEXT, UNKNOWN_LOGIN_ERROR, detectLang, errorMessage, fill, li, loginErrorMessage, methodsText,
  passwordProblemMessage, retryMessage,
} from '../../src/auth/i18n';
import { CONNECTION_LOST } from '../../src/data/api/ApiClient';
import { AUTH_MESSAGE_KEYS, LOGIN_ERROR_CODES } from '../../../../packages/shared/src/api/auth';

// Writing rules: no en or em dash, centre dot, curly quote or arrow character.
const FORBIDDEN = /[\u2013\u2014\u00b7\u2018\u2019\u201c\u201d\u2190\u2192]/;

describe('language', () => {
  it('follows ?lang= first, then the browser language', () => {
    expect(detectLang('?lang=id', ['en-US'])).toBe('id');
    expect(detectLang('?lang=en', ['id-ID'])).toBe('en');
    expect(detectLang('?lang=fr', ['id-ID'])).toBe('id');
    expect(detectLang('', ['id'])).toBe('id');
    expect(detectLang('', ['in-ID'])).toBe('id');
    expect(detectLang('', ['en-GB', 'id'])).toBe('en');
    expect(detectLang('', ['nl-NL'])).toBe('en');
    expect(detectLang('', [])).toBe('en');
  });

  it('picks and fills pairs', () => {
    expect(li(['Hello', 'Halo'], 'id')).toBe('Halo');
    expect(li(['Hello', 'Halo'], 'en')).toBe('Hello');
    expect(fill(['{a} and {b} {c}', '{a} dan {b}'], { a: 1, b: 'x' })).toEqual(['1 and x {c}', '1 dan x']);
  });
});

describe('texts', () => {
  const pairs = [...Object.values(TEXT), ...Object.values(LOGIN_ERROR_MESSAGES), ...Object.values(MESSAGE_KEYS)];

  it('have both languages, without the characters the writing rules forbid', () => {
    for (const [en, id] of pairs) {
      expect(en.length).toBeGreaterThan(0);
      expect(id.length).toBeGreaterThan(0);
      expect(FORBIDDEN.test(en) || FORBIDDEN.test(id)).toBe(false);
    }
  });

  it('are translated (the Indonesian text differs) except names and codes', () => {
    const same = Object.entries(TEXT).filter(([, [en, id]]) => en === id).map(([k]) => k);
    expect(same.sort()).toEqual(['deployOnprem', 'deploySaas', 'emailPlaceholder', 'factFrameworks', 'passwordPlaceholder', 'tls'].sort());
  });
});

describe('/login?error= codes', () => {
  it('has a message for every code of the shared contract and nothing else', () => {
    expect(Object.keys(LOGIN_ERROR_MESSAGES).sort()).toEqual([...LOGIN_ERROR_CODES].sort());
    for (const code of LOGIN_ERROR_CODES) expect(loginErrorMessage(code)).toBe(LOGIN_ERROR_MESSAGES[code]);
  });

  it('gives a generic text for an unknown code', () => {
    expect(loginErrorMessage('constructor')).toBe(UNKNOWN_LOGIN_ERROR);
    expect(loginErrorMessage('<script>')).toBe(UNKNOWN_LOGIN_ERROR);
  });
});

describe('errorMessage', () => {
  it('has a message for every message key of the identity routes', () => {
    expect(Object.keys(MESSAGE_KEYS).sort()).toEqual([...AUTH_MESSAGE_KEYS].sort());
  });

  it('maps the identity message keys', () => {
    expect(errorMessage({ status: 401, slug: 'unauthenticated', message: ['x', 'x'], messageKey: 'auth.invalid_credentials' })[0]).toMatch(/email or password is not correct/);
    expect(errorMessage({ status: 401, message: ['x', 'x'], messageKey: 'auth.mfa_invalid' })).toEqual(['The code is not correct. Try again.', 'Kode tidak benar. Coba lagi.']);
    expect(errorMessage({ status: 401, message: ['x', 'x'], messageKey: 'auth.sso_required' })).toBe(LOGIN_ERROR_MESSAGES.sso_required);
    expect(errorMessage({ status: 400, message: ['x', 'x'], messageKey: 'auth.reset_invalid' })).toBe(TEXT.resetInvalid);
    expect(errorMessage({ status: 400, message: ['x', 'x'], messageKey: 'auth.invitation_invalid' })).toBe(LOGIN_ERROR_MESSAGES.invitation_invalid);
    expect(errorMessage({ status: 401, message: ['x', 'x'], messageKey: 'auth.proof_required' })[0]).toMatch(/current code or your password/);
  });

  it('says when to try again after a 429', () => {
    expect(errorMessage({ status: 429, slug: 'rate-limited', message: ['x', 'x'], retryAfter: 900 })).toEqual([
      'Too many attempts. Try again in 15 minutes.', 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.',
    ]);
    expect(retryMessage(20)[0]).toBe('Too many attempts. Try again in 1 minute.');
    expect(retryMessage(61)[0]).toBe('Too many attempts. Try again in 2 minutes.');
    expect(retryMessage(undefined)[0]).toMatch(/Wait a moment/);
  });

  it('maps CSRF, inactive organisations, an ended sign-in step and the network failure', () => {
    expect(errorMessage({ status: 403, slug: 'csrf', message: ['x', 'x'] })[0]).toMatch(/Reload the page/);
    expect(errorMessage({ status: 403, slug: 'organisation-inactive', message: ['x', 'x'] })[0]).toMatch(/organisation cannot be used/);
    expect(errorMessage({ status: 401, slug: 'unauthenticated', message: ['x', 'x'] }, { stepExpired: true })[0]).toMatch(/sign-in has expired/);
    expect(errorMessage({ status: 401, slug: 'unauthenticated', message: ['x', 'x'] })[0]).toMatch(/email or password/);
    expect(errorMessage({ status: 0, message: CONNECTION_LOST })).toBe(CONNECTION_LOST);
    expect(errorMessage({ status: 422, rule: 'BR-01', message: ['No valid evidence', 'Tidak ada bukti valid'] })).toEqual(['No valid evidence', 'Tidak ada bukti valid']);
  });

  it('translates the password policy errors of F.4', () => {
    const err = (message: string) => errorMessage({ status: 400, slug: 'validation', message: ['x', 'x'], errors: [{ path: 'body.password', message }] });
    expect(err('Use at least 12 characters')).toBe(TEXT.passwordTooShort);
    expect(err('Use at most 256 characters')).toBe(TEXT.passwordTooLong);
    expect(err('This password is too common; choose another one')).toBe(TEXT.passwordCommon);
    expect(err('The password must not be your email address or user name')).toBe(TEXT.passwordPersonal);
    expect(err('Choose a password to accept the invitation')).toBe(TEXT.choosePassword);
    expect(err('Enter the password of your account to accept the invitation')).toBe(TEXT.inviteEnterPassword);
    expect(passwordProblemMessage('Something new')).toEqual(['Something new', 'Something new']);
  });
});

describe('methodsText', () => {
  it('lists the accepted methods of reauth-required', () => {
    expect(methodsText({ local: true, providers: [{ label: 'Sign in with Keycloak' }] }, 'en')).toBe('email and password, Sign in with Keycloak');
    expect(methodsText({ local: true, providers: [] }, 'id')).toBe('email dan kata sandi');
    expect(methodsText({ local: false, providers: [] }, 'en')).toBe('none is available to your account');
  });
});
