# test-support module

Test-only routes of build plan D.3 "Test support" (WP-27), used by the API end-to-end suite (J.6):

- `POST /api/v1/test/reset`: holds new requests and waits for running ones (`request-gate.ts`), closes the pack
  installer pool, drops the api's database and creates it again from `test.template_database` through the
  administrator URL of `test.admin_database_url_file` (`database-reset.ts`, grants of the template included), checks
  the app pool, resets the mock providers (`POST /_admin/reset`) and clears the organisation, OIDC discovery and
  licence caches.
- `POST /api/v1/test/session {handle, org?}`: an active session (`auth_method = 'test'`, no second factor) for an
  active person, in the given organisation or the user's default one; answers `Me` and sets the session cookie.

Both answer 404 unless the profile has `demo.enabled: true` and `test.endpoints_enabled: true`; the release flavour
refuses every `test.*` key at start-up. Every call is logged at `warn` by the authorisation guard.
