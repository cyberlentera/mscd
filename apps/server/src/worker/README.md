# worker runtime
Run mode `worker` (D.4): `WorkerRuntime.start({queues})` starts a worker on the job queue for every `@JobHandler`
provider (or the `--queues` subset), registers the E.2 cron schedules when `jobs.schedules_enabled`, and wraps every
run with its request id, log lines (`jobId`, `orgId`, `attempt`) and the metrics `mscd_job_runs_total` and
`mscd_job_duration_seconds`. Health, readiness (`job-queue` check) and metrics are served on the metrics port.
Owner: WP-22.
