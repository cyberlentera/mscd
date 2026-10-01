// Area `auth`: local sign-in, MFA, passwords and invitations (WP-11), OIDC, providers and identity linking (WP-16),
// SAML (WP-19) and guest auditor access (WP-26). Build plan D.2, D.3 "System, session and identity", F.1 to F.5,
// F.8, F.9, F.14.
import { z } from 'zod';
import { IdentityProviderIcon, IdentityProviderKind } from '../enums.js';
import { NoBody, ProviderSlug, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { Me } from './me.js';
import { EXAMPLE_ME } from '../examples.js';


/** Error codes of `/login?error=<code>` (F.8 step 6, H.6). */
export const LOGIN_ERROR_CODES = ['no_account', 'mfa_required_by_policy', 'idp_error', 'expired', 'invitation_invalid', 'sso_required'] as const;
export const LoginErrorCode = z.enum(LOGIN_ERROR_CODES).meta({ id: 'LoginErrorCode', description: 'Error code of /login?error= (F.8, H.6)' });
export type LoginErrorCode = z.infer<typeof LoginErrorCode>;

/**
 * `messageKey` values of the sign-in problems (F.3 to F.5), for the web's messages. `auth.invalid_credentials` is the
 * one answer of every failed local sign-in; `auth.sso_required` comes only after a correct password and carries the
 * accepted `methods`.
 */
export const AUTH_MESSAGE_KEYS = [
  'auth.invalid_credentials',
  'auth.sso_required',
  'auth.mfa_invalid',
  'auth.proof_required',
  'auth.proof_invalid',
  'auth.password_invalid',
  'auth.reset_invalid',
  'auth.invitation_invalid',
] as const;
export type AuthMessageKey = (typeof AUTH_MESSAGE_KEYS)[number];

const Email = z.email().max(254);
const TotpCode = z.string().regex(/^\d{6}$/);
/** Recovery code `xxxx-xxxx-xx`, lowercase base32 (F.5). */
const RecoveryCode = z.string().regex(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/);
/** New password policy (F.4): 12 to 256 characters; the server also checks the email, handle and common passwords. */
const NewPassword = z.string().min(12).max(256);
/** Single-use token of a link (base64url of 32 random bytes in this build, F.4, F.14). */
const LinkToken = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
/** Relative path inside the application (never a URL or a protocol-relative path, F.8 step 1). */
const ReturnTo = z.string().max(2048).regex(/^\/(?![/\\])[^\s]*$/);

export const AuthProvidersQuery = named(
  'AuthProvidersQuery',
  z.strictObject({ org: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(), email: Email.optional() }),
  'GET /auth/providers query: with tenancy.mode multi the organisation comes from org or from the domain of email (D.2)',
  { valid: [{}, { org: 'ndt' }, { email: 'rina.kusuma@nusantaradigital.co.id' }], invalid: [{ org: 'NDT' }, { email: 'not-an-email' }, { tenant: 'ndt' }] },
);
export type AuthProvidersQuery = z.infer<typeof AuthProvidersQuery>;

export const AuthProvider = named(
  'AuthProvider',
  z.object({ slug: ProviderSlug, kind: IdentityProviderKind, label: z.string(), icon: IdentityProviderIcon }),
  'A sign-in button of the login page (D.2 AuthProviders.providers)',
  { valid: [{ slug: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak', icon: 'generic' }], invalid: [{ slug: 'keycloak', kind: 'ldap', label: 'x', icon: 'generic' }] },
);
export type AuthProvider = z.infer<typeof AuthProvider>;

export const AuthProviders = named(
  'AuthProviders',
  z.object({ local: z.boolean(), providers: z.array(AuthProvider) }),
  'Sign-in methods the login page offers (D.2)',
  {
    valid: [{ local: true, providers: [] }, { local: true, providers: [{ slug: 'entra', kind: 'oidc', label: 'Sign in with Microsoft', icon: 'microsoft' }] }],
    invalid: [{ providers: [] }, { local: true, providers: [{ slug: 'x' }] }],
  },
);
export type AuthProviders = z.infer<typeof AuthProviders>;

export const LoginRequest = named(
  'LoginRequest',
  z.strictObject({ email: Email, password: z.string().min(1).max(256), remember: z.boolean() }),
  'POST /auth/login body (D.2)',
  {
    valid: [{ email: 'rina.kusuma@nusantaradigital.co.id', password: 'correct horse battery staple', remember: false }],
    invalid: [{ email: 'rina', password: 'x', remember: false }, { email: 'rina.kusuma@nusantaradigital.co.id', password: 'x'.repeat(257), remember: true }, { email: 'a@b.co', password: 'x' }],
  },
);
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LOGIN_STATUSES = ['ok', 'mfa_required', 'mfa_enrolment_required'] as const;
export const LoginStatus = z.enum(LOGIN_STATUSES).meta({ id: 'LoginStatus', description: 'Result of a sign-in step (D.2 LoginResponse.status)' });
export type LoginStatus = z.infer<typeof LoginStatus>;

export const LoginResponse = named(
  'LoginResponse',
  z.object({ status: LoginStatus, csrfToken: z.string().min(16), me: Me.optional() })
    .refine((r) => (r.status === 'ok') === (r.me !== undefined), { message: 'me is present exactly when status is ok', path: ['me'] }),
  'Result of a sign-in step: the next step, the CSRF token of the new session (F.2) and Me once the session is active (D.2)',
  {
    valid: [{ status: 'mfa_required', csrfToken: 'b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5' }, { status: 'ok', csrfToken: 'b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5', me: EXAMPLE_ME }],
    invalid: [{ status: 'ok', csrfToken: 'b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5' }, { status: 'denied', csrfToken: 'b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5' }],
  },
);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MfaVerifyRequest = named(
  'MfaVerifyRequest',
  z.union([z.strictObject({ code: TotpCode }), z.strictObject({ recoveryCode: RecoveryCode })]),
  'POST /auth/mfa/verify body: exactly one of a 6-digit code or a recovery code xxxx-xxxx-xx (D.2, F.5)',
  { valid: [{ code: '123456' }, { recoveryCode: 'abcd-efgh-ij' }], invalid: [{ code: '12345' }, { code: '123456', recoveryCode: 'abcd-efgh-ij' }, { recoveryCode: 'ABCD-EFGH-IJ' }, {}] },
);
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>;

export const MfaEnrolStartRequest = named(
  'MfaEnrolStartRequest',
  z.union([z.strictObject({}), z.strictObject({ currentCode: TotpCode }), z.strictObject({ password: z.string().min(1).max(256) })]),
  'POST /auth/mfa/enrol/start body: empty in state mfa_enrolment; from an active session exactly one proof unless one was given in the last 5 minutes (F.5)',
  { valid: [{}, { currentCode: '654321' }, { password: 'correct horse battery staple' }], invalid: [{ currentCode: '654321', password: 'x' }, { currentCode: 'abc' }] },
);
export type MfaEnrolStartRequest = z.infer<typeof MfaEnrolStartRequest>;

export const MfaEnrolStartResponse = named(
  'MfaEnrolStartResponse',
  z.object({ secret: z.string().regex(/^[A-Z2-7]{16,64}$/), otpauthUrl: z.string().startsWith('otpauth://totp/'), issuer: z.string(), account: z.string() }),
  'New TOTP secret, shown once (F.5)',
  {
    valid: [{ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/MSCD:rina.kusuma%40nusantaradigital.co.id?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=MSCD', issuer: 'MSCD', account: 'rina.kusuma@nusantaradigital.co.id' }],
    invalid: [{ secret: 'jbswy3dp', otpauthUrl: 'otpauth://totp/x', issuer: 'MSCD', account: 'x' }, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'https://x', issuer: 'MSCD', account: 'x' }],
  },
);
export type MfaEnrolStartResponse = z.infer<typeof MfaEnrolStartResponse>;

export const MfaEnrolConfirmRequest = named('MfaEnrolConfirmRequest', z.strictObject({ code: TotpCode }), 'POST /auth/mfa/enrol/confirm body', {
  valid: [{ code: '000123' }],
  invalid: [{ code: 123 }, {}],
});
export type MfaEnrolConfirmRequest = z.infer<typeof MfaEnrolConfirmRequest>;

const EXAMPLE_RECOVERY_CODES = ['abcd-efgh-ij', 'bcde-fghi-jk', 'cdef-ghij-kl', 'defg-hijk-lm', 'efgh-ijkl-mn', 'fghi-jklm-no', 'ghij-klmn-op', 'hijk-lmno-pq', 'ijkl-mnop-qr', 'jklm-nopq-rs'];

export const MfaEnrolConfirmResponse = named(
  'MfaEnrolConfirmResponse',
  z.object({ recoveryCodes: z.array(RecoveryCode).length(10), me: Me }),
  'Ten recovery codes, shown once, and the active session (F.5)',
  { valid: [{ recoveryCodes: EXAMPLE_RECOVERY_CODES, me: EXAMPLE_ME }], invalid: [{ recoveryCodes: EXAMPLE_RECOVERY_CODES.slice(0, 9), me: EXAMPLE_ME }] },
);
export type MfaEnrolConfirmResponse = z.infer<typeof MfaEnrolConfirmResponse>;

export const PasswordResetRequest = named('PasswordResetRequest', z.strictObject({ email: Email }), 'POST /auth/password/reset-request body', {
  valid: [{ email: 'rina.kusuma@nusantaradigital.co.id' }],
  invalid: [{ email: 'rina' }, {}],
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

export const PasswordResetConfirm = named('PasswordResetConfirm', z.strictObject({ token: LinkToken, password: NewPassword }), 'POST /auth/password/reset body: the token of the emailed link and the new password (F.4)', {
  valid: [{ token: 'Q2hhbmdlTWUtVG9rZW4tVmFsdWUtMDEyMzQ1Njc4OWFi', password: 'correct horse battery' }],
  invalid: [{ token: 'Q2hhbmdlTWUtVG9rZW4tVmFsdWUtMDEyMzQ1Njc4OWFi', password: 'short' }, { token: 'a b', password: 'correct horse battery' }],
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

export const PasswordChangeRequest = named('PasswordChangeRequest', z.strictObject({ currentPassword: z.string().min(1).max(256), newPassword: NewPassword }), 'POST /auth/password/change body', {
  valid: [{ currentPassword: 'correct horse battery staple', newPassword: 'a much longer passphrase' }],
  invalid: [{ currentPassword: '', newPassword: 'a much longer passphrase' }, { currentPassword: 'x', newPassword: 'short' }],
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequest>;

export const InvitationAcceptRequest = named(
  'InvitationAcceptRequest',
  z.strictObject({ token: LinkToken, password: z.string().min(1).max(256).optional() }),
  'POST /auth/invitations/accept body: the invitation token and the password: a new one (policy checked by the server) for an account without a password, or the current password of an account that has one, which is never replaced (F.4, F.6)',
  {
    valid: [{ token: 'SW52aXRhdGlvbi1Ub2tlbi1WYWx1ZS0wMTIzNDU2Nzg5YWI', password: 'a much longer passphrase' }, { token: 'SW52aXRhdGlvbi1Ub2tlbi1WYWx1ZS0wMTIzNDU2Nzg5YWI' }],
    invalid: [{ password: 'a much longer passphrase' }, { token: 'x' }, { token: 'SW52aXRhdGlvbi1Ub2tlbi1WYWx1ZS0wMTIzNDU2Nzg5YWI', password: '' }],
  },
);
export type InvitationAcceptRequest = z.infer<typeof InvitationAcceptRequest>;

export const ProviderParams = named('ProviderParams', z.strictObject({ slug: ProviderSlug }), 'Path parameter {slug} of an identity provider', {
  valid: [{ slug: 'keycloak' }],
  invalid: [{ slug: 'Keycloak' }],
});
export type ProviderParams = z.infer<typeof ProviderParams>;

export const SsoStartQuery = named('SsoStartQuery', z.strictObject({ returnTo: ReturnTo.optional(), invitation: LinkToken.optional() }), 'OIDC and SAML start query: relative return path and an optional invitation token (F.8 step 1)', {
  valid: [{}, { returnTo: '/controls?ms=isms' }, { invitation: 'SW52aXRhdGlvbi1Ub2tlbi1WYWx1ZS0wMTIzNDU2Nzg5YWI' }],
  invalid: [{ returnTo: 'https://evil.example/' }, { returnTo: '//evil.example/' }, { next: '/' }],
});
export type SsoStartQuery = z.infer<typeof SsoStartQuery>;

export const OidcCallbackQuery = named(
  'OidcCallbackQuery',
  z.looseObject({
    state: z.string().min(1).max(512),
    code: z.string().max(4096).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(2000).optional(),
    iss: z.string().max(2048).optional(),
  }),
  'Authorisation response of the identity provider (F.8 step 2); other members are kept for the OIDC library',
  { valid: [{ state: 'c3RhdGU', code: 'abc', iss: 'https://sso.example.co.id/realms/mscd', session_state: 'x' }, { state: 's', error: 'access_denied' }], invalid: [{ code: 'abc' }, { state: '' }] },
);
export type OidcCallbackQuery = z.infer<typeof OidcCallbackQuery>;

export const SamlAcsBody = named(
  'SamlAcsBody',
  z.strictObject({ SAMLResponse: z.string().min(1).max(1_048_576).regex(/^[A-Za-z0-9+/=\r\n]+$/), RelayState: z.string().max(1024).optional() }),
  'SAML response posted by the identity provider (HTTP-POST binding, F.9)',
  { valid: [{ SAMLResponse: 'PHNhbWxwOlJlc3BvbnNlLz4=', RelayState: 'abc' }], invalid: [{ SAMLResponse: '<xml/>' }, { RelayState: 'abc' }] },
);
export type SamlAcsBody = z.infer<typeof SamlAcsBody>;

export const XmlText = named('XmlText', z.string().startsWith('<'), 'XML document', {
  valid: ['<?xml version="1.0"?><md:EntityDescriptor/>'],
  invalid: ['metadata', ''],
});

export const GuestStartRequest = named('GuestStartRequest', z.strictObject({ token: LinkToken }), 'POST /auth/guest/start body: the token from the URL fragment of the access link (F.14)', {
  valid: [{ token: 'R3Vlc3QtQWNjZXNzLVRva2VuLVZhbHVlLTAxMjM0NTY3ODk' }],
  invalid: [{ token: '' }, {}],
});
export type GuestStartRequest = z.infer<typeof GuestStartRequest>;

export const GuestLoginRequest = named('GuestLoginRequest', z.strictObject({ email: Email }), 'POST /auth/guest/login body of a returning guest (F.14 step 4)', {
  valid: [{ email: 'ext.auditor@mscd.test' }],
  invalid: [{ email: 'auditor' }],
});
export type GuestLoginRequest = z.infer<typeof GuestLoginRequest>;

export const GuestVerifyRequest = named('GuestVerifyRequest', z.strictObject({ code: TotpCode }), 'POST /auth/guest/verify body: the emailed 6-digit code (F.14 step 3)', {
  valid: [{ code: '482913' }],
  invalid: [{ code: '4829' }],
});
export type GuestVerifyRequest = z.infer<typeof GuestVerifyRequest>;

export const GuestStartResponse = named(
  'GuestStartResponse',
  z.object({ status: z.literal('code_sent'), emailHint: z.string() }),
  'Answer of guest start and login: the same either way, with the first letter and domain of the address (F.14)',
  { valid: [{ status: 'code_sent', emailHint: 'e***@mscd.test' }], invalid: [{ status: 'sent', emailHint: 'x' }] },
);
export type GuestStartResponse = z.infer<typeof GuestStartResponse>;

export const IdentityLinkStart = named('IdentityLinkStart', z.object({ redirectUrl: z.string().min(1) }), 'Start of identity linking: the authorisation URL to follow (D.2, F.8)', {
  valid: [{ redirectUrl: 'https://sso.example.co.id/realms/mscd/protocol/openid-connect/auth?client_id=mscd' }],
  invalid: [{}, { redirectUrl: '' }],
});
export type IdentityLinkStart = z.infer<typeof IdentityLinkStart>;

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

export const authProvidersRoute = defineRoute({
  id: 'auth.providers',
  owner: 'WP-16',
  method: 'GET',
  path: '/api/v1/auth/providers',
  summary: 'Sign-in methods for the login page (organisation by org or email domain in multi-tenant mode)',
  auth: 'public',
  query: AuthProvidersQuery,
  response: AuthProviders,
  errors: [],
});

export const authLoginRoute = defineRoute({
  id: 'auth.login',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/login',
  summary: 'Local sign-in with email and password; one generic 401 for every failure',
  auth: 'public',
  body: LoginRequest,
  response: LoginResponse,
  errors: [401, 403, 429],
  readOnlyAllowed: true,
  rateLimits: [{ key: 'ip', max: 30, windowSeconds: 900 }, { key: 'email', max: 10, windowSeconds: 900 }],
});

export const authMfaVerifyRoute = defineRoute({
  id: 'auth.mfa.verify',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/mfa/verify',
  summary: 'Second factor: TOTP code or recovery code',
  auth: 'mfa_pending',
  body: MfaVerifyRequest,
  response: LoginResponse,
  errors: [401, 429],
  readOnlyAllowed: true,
  rateLimits: [{ key: 'session', max: 5, windowSeconds: 300 }],
});

export const authMfaEnrolStartRoute = defineRoute({
  id: 'auth.mfa.enrol.start',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/mfa/enrol/start',
  summary: 'Start TOTP enrolment (re-enrolment from an active session needs a recent proof)',
  auth: 'enrolment',
  body: MfaEnrolStartRequest,
  response: MfaEnrolStartResponse,
  errors: [401, 429],
  readOnlyAllowed: true,
});

export const authMfaEnrolConfirmRoute = defineRoute({
  id: 'auth.mfa.enrol.confirm',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/mfa/enrol/confirm',
  summary: 'Confirm TOTP enrolment; returns the recovery codes once',
  auth: 'enrolment',
  body: MfaEnrolConfirmRequest,
  response: MfaEnrolConfirmResponse,
  errors: [401],
  readOnlyAllowed: true,
});

export const authLogoutRoute = defineRoute({
  id: 'auth.logout',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/logout',
  summary: 'End the session and clear the cookie',
  auth: 'any_session',
  response: NoBody,
  status: 204,
  errors: [],
  readOnlyAllowed: true,
});

export const authPasswordResetRequestRoute = defineRoute({
  id: 'auth.password.reset-request',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/password/reset-request',
  summary: 'Request a password reset email; always 202',
  auth: 'public',
  body: PasswordResetRequest,
  response: NoBody,
  status: 202,
  errors: [403, 429],
  readOnlyAllowed: true,
  rateLimits: [{ key: 'email', max: 5, windowSeconds: 3600 }, { key: 'ip', max: 5, windowSeconds: 3600 }],
});

export const authPasswordResetRoute = defineRoute({
  id: 'auth.password.reset',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/password/reset',
  summary: 'Set a new password with the emailed token; revokes every session of the user',
  auth: 'public',
  body: PasswordResetConfirm,
  response: NoBody,
  status: 204,
  errors: [403],
  readOnlyAllowed: true,
});

export const authPasswordChangeRoute = defineRoute({
  id: 'auth.password.change',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/password/change',
  summary: "Change the session user's password; revokes the user's other sessions",
  auth: 'session',
  body: PasswordChangeRequest,
  response: NoBody,
  status: 204,
  errors: [401],
  readOnlyAllowed: true,
});

export const authInvitationAcceptRoute = defineRoute({
  id: 'auth.invitation.accept',
  owner: 'WP-11',
  method: 'POST',
  path: '/api/v1/auth/invitations/accept',
  summary: 'Redeem an invitation with a new password (or the current one of an existing account), then continue to the second factor',
  auth: 'public',
  body: InvitationAcceptRequest,
  response: LoginResponse,
  errors: [401, 403],
  readOnlyAllowed: true,
});

export const authOidcStartRoute = defineRoute({
  id: 'auth.oidc.start',
  owner: 'WP-16',
  method: 'GET',
  path: '/api/v1/auth/oidc/:slug/start',
  summary: 'Redirect to the OIDC identity provider (authorisation code with PKCE)',
  auth: 'public',
  params: ProviderParams,
  query: SsoStartQuery,
  response: NoBody,
  status: 302,
  errors: [404],
});

export const authOidcCallbackRoute = defineRoute({
  id: 'auth.oidc.callback',
  owner: 'WP-16',
  method: 'GET',
  path: '/api/v1/auth/oidc/:slug/callback',
  summary: 'OIDC callback; redirects to returnTo or to /login?error=<code>',
  auth: 'public',
  params: ProviderParams,
  query: OidcCallbackQuery,
  response: NoBody,
  status: 302,
  errors: [],
});

export const authSamlStartRoute = defineRoute({
  id: 'auth.saml.start',
  owner: 'WP-19',
  method: 'GET',
  path: '/api/v1/auth/saml/:slug/start',
  summary: 'Redirect to the SAML identity provider (HTTP-Redirect binding)',
  auth: 'public',
  params: ProviderParams,
  query: SsoStartQuery,
  response: NoBody,
  status: 302,
  errors: [404],
});

export const authSamlAcsRoute = defineRoute({
  id: 'auth.saml.acs',
  owner: 'WP-19',
  method: 'POST',
  path: '/api/v1/auth/saml/:slug/acs',
  summary: 'SAML assertion consumer service (form post from the identity provider; binding cookie required)',
  auth: 'public',
  params: ProviderParams,
  body: SamlAcsBody,
  requestType: 'application/x-www-form-urlencoded',
  response: NoBody,
  status: 302,
  errors: [],
  csrfExempt: true,
  readOnlyAllowed: true,
});

export const authSamlMetadataRoute = defineRoute({
  id: 'auth.saml.metadata',
  owner: 'WP-19',
  method: 'GET',
  path: '/api/v1/auth/saml/:slug/metadata',
  summary: 'SAML service provider metadata',
  auth: 'public',
  params: ProviderParams,
  response: XmlText,
  responseType: 'application/samlmetadata+xml',
  errors: [404],
});

export const authGuestStartRoute = defineRoute({
  id: 'auth.guest.start',
  owner: 'WP-26',
  method: 'POST',
  path: '/api/v1/auth/guest/start',
  summary: 'Use a guest access link once and email a one-time code',
  auth: 'public',
  body: GuestStartRequest,
  response: GuestStartResponse,
  errors: [401, 403, 429],
  readOnlyAllowed: true,
  rateLimits: [{ key: 'ip', max: 10, windowSeconds: 3600 }, { key: 'grant', max: 5, windowSeconds: 3600 }],
});

export const authGuestLoginRoute = defineRoute({
  id: 'auth.guest.login',
  owner: 'WP-26',
  method: 'POST',
  path: '/api/v1/auth/guest/login',
  summary: 'Returning guest: email a new one-time code when an active grant exists (same answer either way)',
  auth: 'public',
  body: GuestLoginRequest,
  response: GuestStartResponse,
  errors: [403, 429],
  readOnlyAllowed: true,
  rateLimits: [{ key: 'ip', max: 10, windowSeconds: 3600 }, { key: 'grant', max: 5, windowSeconds: 3600 }],
});

export const authGuestVerifyRoute = defineRoute({
  id: 'auth.guest.verify',
  owner: 'WP-26',
  method: 'POST',
  path: '/api/v1/auth/guest/verify',
  summary: 'Check the emailed one-time code; continues to TOTP enrolment or TOTP',
  auth: 'guest_otp',
  body: GuestVerifyRequest,
  response: LoginResponse,
  errors: [401, 429],
  readOnlyAllowed: true,
});

export const meIdentityLinkRoute = defineRoute({
  id: 'me.identity.link',
  owner: 'WP-16',
  method: 'POST',
  path: '/api/v1/me/identities/:slug/link',
  summary: 'Link an identity of a provider to the session user (password or TOTP verified in the last 5 minutes)',
  auth: 'session',
  params: ProviderParams,
  response: IdentityLinkStart,
  errors: [401, 404],
});

export const routes: RouteDef[] = [
  authProvidersRoute, authLoginRoute, authMfaVerifyRoute, authMfaEnrolStartRoute, authMfaEnrolConfirmRoute, authLogoutRoute,
  authPasswordResetRequestRoute, authPasswordResetRoute, authPasswordChangeRoute, authInvitationAcceptRoute,
  authOidcStartRoute, authOidcCallbackRoute, authSamlStartRoute, authSamlAcsRoute, authSamlMetadataRoute,
  authGuestStartRoute, authGuestLoginRoute, authGuestVerifyRoute, meIdentityLinkRoute,
];
