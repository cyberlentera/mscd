// Area `ops` (owner from wave 11: WP-34): operations endpoints of the platform operator (D.2 `OpsHealth`, D.3
// "Operations").
import { z } from 'zod';
import { OpsRunnableJob } from '../enums.js';
import { BinaryBody, IsoDate, OrgSlug, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { LicenceState } from './license.js';

export const QueueStats = named(
  'QueueStats',
  z.object({ name: z.string(), waiting: z.int().min(0), active: z.int().min(0), failed: z.int().min(0), oldestAgeSeconds: z.number().min(0) }),
  'Job queue statistics (E.1 JobQueue.stats)',
  { valid: [{ name: 'freshness.recompute', waiting: 2, active: 1, failed: 0, oldestAgeSeconds: 4.2 }], invalid: [{ name: 'x', waiting: -1, active: 0, failed: 0, oldestAgeSeconds: 0 }] },
);
export type QueueStats = z.infer<typeof QueueStats>;

export const OpsHealth = named(
  'OpsHealth',
  z.object({
    components: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'down']), detail: z.string() })),
    migrations: z.array(z.object({ schema: z.string(), latest: z.string().nullable(), expected: z.string().nullable() })),
    queues: z.array(QueueStats),
    licences: z.array(z.object({ org: OrgSlug, state: LicenceState, validUntil: IsoDate })),
  }),
  'Installation health for the platform operator (D.2)',
  {
    valid: [{ components: [{ name: 'database', status: 'ok', detail: 'SELECT 1 in 2 ms' }], migrations: [{ schema: 'platform', latest: '0004_operations', expected: '0004_operations' }], queues: [], licences: [{ org: 'ndt', state: 'valid', validUntil: '2027-03-31' }] }],
    invalid: [{ components: [{ name: 'database', status: 'green', detail: '' }], migrations: [], queues: [], licences: [] }],
  },
);
export type OpsHealth = z.infer<typeof OpsHealth>;

export const JobRunParams = named('JobRunParams', z.strictObject({ name: OpsRunnableJob }), 'Path parameter {name}: a job of the operator allow-list', {
  valid: [{ name: 'drift.evaluate' }],
  invalid: [{ name: 'pack.install' }, { name: 'rm -rf' }],
});
export type JobRunParams = z.infer<typeof JobRunParams>;

export const JobRunRequest = named('JobRunRequest', z.strictObject({ org: OrgSlug.optional() }), 'POST /ops/jobs/{name}/run body: only the organisation, never a free payload', {
  valid: [{}, { org: 'ndt' }],
  invalid: [{ payload: {} }, { org: 'NDT' }],
});
export type JobRunRequest = z.infer<typeof JobRunRequest>;

export const JobRunResponse = named('JobRunResponse', z.object({ jobId: z.string().min(1) }), 'Id of the queued job', {
  valid: [{ jobId: 'ob-42' }],
  invalid: [{}],
});
export type JobRunResponse = z.infer<typeof JobRunResponse>;

const op = { owner: 'WP-34' as const, auth: 'session' as const, scope: 'platform' as const };

export const opsHealthRoute = defineRoute({ ...op, id: 'ops.health', method: 'GET', path: '/api/v1/ops/health', summary: 'Components, migrations, queues and licence states', permission: 'ops.read', response: OpsHealth, errors: [] });
export const opsQueuesRoute = defineRoute({ ...op, id: 'ops.queues', method: 'GET', path: '/api/v1/ops/queues', summary: 'Queue statistics', permission: 'ops.read', response: z.array(QueueStats), errors: [] });
export const opsJobRunRoute = defineRoute({
  ...op, id: 'ops.jobs.run', method: 'POST', path: '/api/v1/ops/jobs/:name/run', summary: 'Run an allow-listed job now (audited ops.job_run)',
  permission: 'ops.jobs.run', params: JobRunParams, body: JobRunRequest, response: JobRunResponse, status: 202, errors: [404, 422],
});
export const opsDiagnosticsRoute = defineRoute({
  ...op, id: 'ops.diagnostics', method: 'POST', path: '/api/v1/ops/diagnostics',
  summary: 'Diagnostics archive (.tar.gz): profile without secrets, versions, migration state, queue stats, redacted log lines, metrics (audited)',
  permission: 'ops.read', response: BinaryBody, responseType: 'application/gzip', file: true, errors: [],
});

export const routes: RouteDef[] = [opsHealthRoute, opsQueuesRoute, opsJobRunRoute, opsDiagnosticsRoute];
