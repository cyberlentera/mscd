# link-health module

Link health planning, checks and repository connection checks (build plan E.2, E.4, TS 5.5, TS 5.7). Owner: WP-23.

| File | Content |
|---|---|
| `link-status.ts` | The E.4 precedence (`decideLinkStatus`) and folder path comparison |
| `link-status-writer.ts` | Stores an observation: status, `link_status_since`, `link_health_result`, audit `link_status.changed`, BR-32 `evidence_anomaly` and `document_new_version` |
| `link-health.service.ts` | Selection of due objects, `link-health.plan`, `link-health.check` (token bucket, rate limit rescheduling, `freshness.recompute` per affected system, background task progress) and `POST /ms/{ms}/link-health/run` |
| `repository-health.service.ts` | `link-health.repository`: connection tests, `connector` alerts, `connector_revoked`, `credential_expiring` at 30 and 7 days |
| `request-pacer.ts` | Per-repository token bucket (m365 4, google_drive 5, managed_vault 50 requests per second) |
| `link-health.jobs.ts`, `link-health.controller.ts` | Job handlers and the route |
