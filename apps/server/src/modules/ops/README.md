# ops module

Platform operator endpoints and diagnostics (D.3 Operations), and the metrics of ARCHITECTURE 12 that are read from the job queue and the database.
Owner: WP-34 (skeleton by WP-03, build plan B.4).

| Route | Permission | Notes |
|---|---|---|
| `GET /api/v1/ops/health` | `ops.read` | Readiness checks, job queue, job outbox (degraded when rows are stuck or parked), telemetry; newest applied migration of `platform` and `ref`; queue statistics; licence state per active organisation |
| `GET /api/v1/ops/queues` | `ops.read` | `JobQueue.stats()` |
| `POST /api/v1/ops/jobs/{name}/run` | `ops.jobs.run` | Allow-list of D.3 (`OPS_RUNNABLE_JOBS`), body `{org?}` only, empty payload. Tenant jobs need `org` of an active organisation (422 otherwise, 404 for an unknown slug); installation-wide jobs refuse `org` (422); a job without a handler in the build is 422. Singleton key `ops:<job>:<org id or all>`; 409 when the driver reports a run already waiting. The job and the `ops.job_run` entry (platform chain, actor kind `operator`) commit in one transaction |
| `POST /api/v1/ops/diagnostics` | `ops.read` | `.tar.gz` with `README.txt`, `profile.json`, `versions.json`, `migrations.json`, `queues.json`, `health.json`, `logs.ndjson` (ring buffer, at most 1,000 lines) and `metrics.txt`; every file scrubbed by `SecretScrubber`; audited `ops.diagnostics_exported` before the bytes are sent |

`OpsMetricsCollector` keeps one snapshot of the collected metrics for 15 seconds, so scrapes of the api and the worker cost one round of queries per interval; a section that fails keeps its last values and is logged once.
