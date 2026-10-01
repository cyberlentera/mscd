# admin-idp module

Administration of the OIDC and SAML identity providers of the session's organisation (build plan D.3 "Administration", F.8, F.9, D-25).

Owner: WP-16 (skeleton by WP-03).

| File | Content |
|---|---|
| `admin-idp.module.ts` | Module; imports `identity/oidc` (`OidcModule`), which also mounts the OIDC sign-in routes |
| `admin-idp.controller.ts` | `GET /admin/identity-providers`, `POST /admin/identity-providers`, `PATCH /admin/identity-providers/{id}`, `POST /admin/identity-providers/{id}/test` (`idp.manage`) |
| `identity-providers.service.ts` | Everything runs in the session organisation's tenant transaction (forced RLS of `platform.identity_provider`). OIDC providers are saved only after discovery succeeds (422 `idp.discovery_failed`); the client secret is sealed with `platform.key` (AAD `idp:<providerId>`) and never returned; JIT only when every allowed domain is in `platform.verified_domain` for the organisation (422 `idp.jit_domain_unverified`); SAML certificates are stored as PEM; disabling a provider revokes its sessions (F.1); `idp.created` and `idp.updated` are audited without secrets |
| `provider-view.ts` | `IdentityProviderView` (secrets omitted) and the audited settings |
