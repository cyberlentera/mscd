# identity/oidc

OIDC sign-in, identity linking and the sign-in buttons of the login page (build plan F.8, F.5, D-25, D-26, D.3 "System, session and identity").

Owner: WP-16. Loaded through `admin-idp` (`AdminIdpModule` imports `OidcModule`).

| File | Content |
|---|---|
| `oidc.module.ts` | Module; exports `OidcDiscovery` (used by the provider administration) and `IdentityLinkRegistry` |
| `oidc.controller.ts` | `GET /auth/providers`, `GET /auth/oidc/{slug}/start`, `GET /auth/oidc/{slug}/callback`, `POST /me/identities/{slug}/link` |
| `oidc-sign-in.service.ts` | Start (transaction with hashed state, nonce, sealed PKCE verifier, return path, invitation; binding cookie `mscd_auth_tx`, 10 minutes), callback (single-use transaction, binding and expiry, code exchange through `openid-client`), the four identity paths of F.8 step 4 (existing link, link from a signed-in session, invitation of the provider's organisation, JIT under verified domains; never by email), MFA from `amr` or the local TOTP step, a session pinned to the provider's organisation; every failure redirects to `/login?error=<code>` |
| `discovery.ts` | `openid-client` discovery cached for one hour per provider and settings; plain-HTTP issuers only with `identity.oidc.allow_insecure_http`; failure reasons safe to show |
| `oidc-rules.ts` | Subject (`sub`, or `<tid>:<oid>` for Entra ID), verified email, `amr` MFA proof, the MFA decision, return paths |
| `auth-providers.service.ts` | `AuthProviders` of D.2: one organisation by `?org=` or verified email domain in multi-tenant mode, else every enabled provider |
| `identity-link.registry.ts` | Link starters per provider kind; the SAML module (WP-19) registers its own |
| `provider-lookup.ts` | Provider rows by slug and the usability rule |

After a callback that continues with the local TOTP step, the browser goes to `/login/mfa#csrf=<token>` (a confirmed factor exists) or `/login/enrol#csrf=<token>` (none yet), as the web's sign-in pages expect (WP-38).
