# identity/guest

Guest auditor sign-in (build plan F.14, D-27; owner WP-26).

- `POST /auth/guest/start`: the token from the fragment of the emailed access link. The link works once; it starts
  an emailed one-time code check bound to the cookie `mscd_guest_tx` (10 minutes, 5 attempts).
- `POST /auth/guest/login`: a returning guest asks for a new code; the answer is the same whether or not an active
  grant exists for the address.
- `POST /auth/guest/verify`: the right code creates a session pinned to the grant (`auth_method = 'guest'`) in
  `mfa_enrolment` (first use) or `mfa_pending`; the identity module's MFA routes finish the sign-in with TOTP.
- `GuestAccountService`: the guest account of a grant (kind `guest`, never an existing account) and what a revoked
  or expired grant ends at once (sessions, open code transactions, membership).

The access link token carries the organisation id as a 22-character prefix, so the grant is read from one tenant
schema; only the SHA-256 of the token is stored.
