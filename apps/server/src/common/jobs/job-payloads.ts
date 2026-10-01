// Payload of every job of build plan E.2, by job name. Producers and handlers share these types through
// `JobQueue.send` and `@JobHandler`.
import type { JobName } from '@mscd/shared';

/** Jobs whose payload is the empty object. */
type Empty = Record<string, never>;

export interface JobPayloads {
  'scheduler.tick': Empty;
  'freshness.recompute': { msId?: string; evidenceIds?: string[]; entryIds?: string[] };
  'freshness.sweep': Empty;
  'tasks.overdue': Empty;
  'documents.review-alerts': Empty;
  'audit-prep.generate': Empty;
  'license.check': Empty;
  'packs.lifecycle': Empty;
  'edition.withdrawn-alerts': Empty;
  'link-health.plan': Empty;
  'link-health.check': { repositoryId: string; storageObjectIds: string[]; taskId?: string };
  'link-health.repository': Empty;
  'drift.evaluate': { msId?: string };
  'integrity.rehash': Empty;
  'cycle.derive': { msId?: string };
  'notifications.dispatch': { notificationIds?: string[] };
  'notifications.digest': Empty;
  'evidence-pack.build': { packId: string };
  'export.build': { taskId: string };
  'pack.install': { installId: string; objectKey: string; requestedBy: string; orgId?: string };
  'audit.verify-chain': Empty;
  'cleanup.expired': Empty;
}

// Compile-time check: every job name of @mscd/shared has a payload type and nothing else does.
type MissingPayloads = Exclude<JobName, keyof JobPayloads>;
type ExtraPayloads = Exclude<keyof JobPayloads, JobName>;
export type JobPayloadsComplete = [MissingPayloads, ExtraPayloads] extends [never, never] ? true : { missing: MissingPayloads; extra: ExtraPayloads };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const payloadsComplete: JobPayloadsComplete = true;
