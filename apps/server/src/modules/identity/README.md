# identity module

Local sign-in, sessions, CSRF, MFA, passwords, invitations and preferences (build plan F.1 to F.5), and the `SESSION_RESOLVER` of the authorisation guard (F.7). Subfolders `oidc/` (WP-16), `saml/` (WP-19) and `guest/` (WP-26) build on the exported services.

Owner: WP-11; `oidc/` WP-16, `saml/` WP-19, `guest/` WP-26.

| File | Content |
|---|---|
| `session.service.ts` | `SessionService`: create, rotate and revoke sessions (by user, organisation, grant, provider), the cookie, the CSRF token of a request |
| `session-resolver.ts` | `SESSION_RESOLVER`: cookie, session, user, organisation status rule; `verifyRequest` checks `X-CSRF-Token`, or `Origin` (else `Referer`) of public routes, and refuses a request with neither header that a page of another site could send (F.2) |
| `auth.service.ts`, `credentials.ts`, `local-login-policy.ts` | Local sign-in, lockout, `auth.sso_required`, logout, password reset and change |
| `mfa.service.ts`, `totp.ts`, `recovery-codes.ts` | TOTP (RFC 6238), recovery codes, the per-user second-factor lock, enrolment, re-enrolment, factor reset |
| `invitation.service.ts` | Users with invited memberships and invitation links (an active account gets the membership only, unless the operator asks for a link); `POST /auth/invitations/accept` (a new password for an account without one, else the current password, never replaced) |
| `account-mailer.ts`, `mail-templates.ts` | `account` and `security` emails through Nodemailer (E.6) |
| `preferences.service.ts` | `PUT /me/preferences` and `Me.preferences` |
| `guest-otp.ts` | Registry for the resolver of the guest one-time code step (`auth: 'guest_otp'`) |
| `password-policy.ts`, `common-passwords.txt` | The password policy (F.4) with normalised forms (digits and symbols around a common word, character swaps, repeats, runs); the list holds the SecLists `10k-most-common.txt` and the 10,000 most common passwords of 12 or more characters from SecLists `xato-net-10-million-passwords-1000000.txt`. Its header carries the source and the SecLists MIT copyright and permission notice, so the file must ship whole, next to the compiled module |
