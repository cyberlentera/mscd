# platform module
HTTP bootstrap on Fastify (cookies, F.12 headers, multipart, raw upload streams, request ids and the request context), pino logging with F.12 redaction, readiness checks (checks with `after` run once their prerequisite passes), the metrics registry and listener, `GET /healthz`, `GET /readyz`; in run mode `api` also the problem details filter (D.1), the rate limit plugin and service (F.3) and `GET /api/v1/system/profile` on the shared route.
Owner: WP-08 (skeleton by WP-03).
