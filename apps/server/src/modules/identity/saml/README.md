# identity/saml

SAML 2.0 sign-in through `@node-saml/node-saml` 5.1.0 (build plan F.9, F.8 step 4, F.5, D-25, D-26). SP-initiated only: the AuthnRequest goes out through the HTTP-Redirect binding, the response comes back through the HTTP-POST binding to the assertion consumer service (ACS).

Owner: WP-19.

| File | Content |
|---|---|
| `saml.module.ts` | `SamlModule`: the controller and `SamlSignInService`; imports `OidcModule` for `IdentityLinkRegistry` |
| `saml.controller.ts` | `GET /auth/saml/{slug}/start`, `POST /auth/saml/{slug}/acs`, `GET /auth/saml/{slug}/metadata` |
| `saml-sign-in.service.ts` | Start, ACS, identity paths (link, invitation, link transaction), MFA, session, failure audit, SP metadata, the SAML starter of identity linking |
| `saml-rules.ts` | Rules without a database: facts of a signature-checked assertion, persistent NameID, issuer, bearer confirmation (`InResponseTo`, `Recipient`, validity), replay cache expiry, MFA from `AuthnContextClassRef` |

## Flow

1. Start: the provider must exist, be enabled, be of kind `saml`, be offered by the profile (`identity.providers`) and belong to an organisation that is not archived, else 404. An `?invitation=` token must name an unused, unrevoked, unexpired invitation of the provider's organisation, else the browser goes to `/login?error=invitation_invalid`. A transaction `saml_login` stores the SHA-256 of a random state (sent as `RelayState`) and of a browser binding value, the AuthnRequest id (`saml_request_id`), the relative return path and the invitation id, for 10 minutes. The binding value goes to cookie `mscd_saml_tx` (`HttpOnly`, `Path=/api/v1/auth/saml/`, 10 minutes, `Secure; SameSite=None` with `security.cookie_secure`, otherwise `SameSite=Lax`). The AuthnRequest is unsigned, asks for the persistent NameID with `AllowCreate`, names the ACS URL `<http.public_url>/api/v1/auth/saml/<slug>/acs`, has no requested authentication context, and carries `ForceAuthn="true"` for links and invitations.
2. ACS: the transaction is deleted by the hash of `RelayState` (`DELETE ... RETURNING`, single use); the binding cookie must match (constant time), the transaction must not be expired, the slug must be the transaction's provider and the provider still usable. The library checks the XML signature of the assertion against `saml_idp_certs` (signed assertions required, the outer response may be unsigned), the `Conditions` timestamps with 60 seconds of skew and the audience (the SP entity id: `saml_sp_entity_id`, else the metadata URL). The rules then check the issuer (`saml_idp_issuer` when set), record the assertion id in `platform.saml_assertion_seen` until the latest `NotOnOrAfter` plus the skew (its own committed transaction; a second use fails even when the first use failed later), require a bearer confirmation whose `InResponseTo` is the transaction's request id (and the outer response's `InResponseTo`, when present, too), whose `Recipient` is this ACS when given and which is still valid, and take the persistent NameID as subject (any other format is `idp_error`). The binding cookie is always cleared.
3. Account, first match wins: an existing `user_identity (provider, NameID)`; for a `saml_link` transaction the transaction's user; an invitation of the transaction (link `invitation`, membership active after `LicenceGate.assertCanAddUser`, invitation used). No JIT and no email match: SAML assertions never prove `email_verified` (F.9), so `email_at_link` stays null. Otherwise `no_account`. The account must be an active person with an active membership in the provider's organisation.
4. MFA (F.5): with `require_mfa_claim`, an `AuthnContextClassRef` in `saml_mfa_authn_contexts` proves MFA (session `active`, `amr = ['mfa']`, `auth.login` with `secondFactor: 'idp_mfa'` and the contexts). Without a proof, `mfa_fallback = 'reject'` gives `mfa_required_by_policy`; `local_totp` continues to `mfa_pending` (`/login/mfa#csrf=<token>`) or `mfa_enrolment` (`/login/enrol#csrf=<token>`). The session has `auth_method = 'saml'`, `identity_provider_id`, and `organization_id` and `auth_org_id` set to the provider's organisation (D-26).
5. Failures redirect to `/login?error=<code>`: `expired` (transaction unknown, used, expired, binding cookie missing or wrong, another provider's ACS, `InResponseTo` of another request, a replayed assertion), `idp_error` (signature, audience, issuer, timestamps, NameID format, recipient, provider disabled meanwhile, a NameID linked to another account when linking), `no_account`, `invitation_invalid`, `mfa_required_by_policy`. Refusals of a known transaction audit `auth.login_failed` with `{method: 'saml', flow, error, reason}`.

## Identity linking

`POST /me/identities/{slug}/link` is served by the OIDC controller (WP-16), which checks the provider, the user's membership and the recent proof, then calls the starter registered for the provider's kind. `SamlSignInService` registers the SAML starter in `onModuleInit`: a `saml_link` transaction with the session user, the binding cookie, and the HTTP-Redirect URL as `redirectUrl`. The ACS is a cross-site form post that never carries the `SameSite=Lax` session cookie, so the browser is identified by the binding cookie set on the signed-in link request; the transaction's user must still be an active person and member. The link redirects to `/`.

## Mounting

The api loads `SamlModule` next to `OidcModule` (see the WP-19 handoff note for the one import that mounts it).
