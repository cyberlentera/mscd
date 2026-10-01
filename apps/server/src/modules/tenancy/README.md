# tenancy module
`TenantScope` (`withTenant`, `withPlatform`, after-commit hooks, F.10), `TenantResolver` (60 second cache, `invalidate`), the C.3 readiness checks (migrations, schema privileges) and the PostgreSQL stores of rate limits (F.3) and idempotency keys (D.1; a claim without a stored response is in progress for a lease of five minutes, then the same request may take it over). Imports `CommonModule` (clock, job queue, notification writer, file responder).
Owner: WP-08.
