# jobs module
Job queue drivers and core jobs (build plan E.1, E.2). Owner: WP-22; interface and in-memory driver WP-08.

- `job-queue-factory.ts`: `createJobQueue(config)`, used by the `JOB_QUEUE` provider of `CommonModule`. pg-boss by
  default, BullMQ on Valkey with `jobs.driver: bullmq`, in memory with the test profile unless
  `MSCD_TEST_JOBS_DRIVER=profile`.
- `pgboss-job-queue.ts`: transactional send through the caller's Kysely transaction, `exclusive` queues (one waiting
  or active job per singleton key), lazy start. `pgboss-schema.ts`: C.3 step 3 of `migrate`.
- `bullmq-job-queue.ts` and `outbox-relay.ts`: transactional send through `platform.job_outbox`, relayed every
  500 ms (and after each commit) with job id `ob-<id>`; singleton keys through BullMQ deduplication.
- `schedules.ts`: the E.2 cron schedules and daily local-time jobs; `scheduler-tick.job.ts` dispatches them.
- Jobs: `scheduler.tick`, `cleanup.expired`, `audit.verify-chain` (installation), `tasks.overdue`,
  `audit-prep.generate` (tenant). `rule-tasks.ts` opens and closes BR-10, BR-11, BR-15 and BR-31 tasks.
