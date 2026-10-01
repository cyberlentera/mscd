// `cleanup.expired` (E.2): every kind of expired row, nothing that is still valid, and the same state after a
// second run (J.8 idempotency).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CleanupExpiredJob } from '../../../src/modules/jobs/cleanup-expired.job';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, type AdminClient, type JobsApp } from './helpers';

const TST = '00000000-0000-4000-8000-00000000a004';
const NDT = '00000000-0000-4000-8000-00000000a001';
const SYSTEM = '00000000-0000-0000-0000-000000000001';

describe('cleanup.expired (E.2)', () => {
  const db = useTestDatabase('demo');
  let app: JobsApp;
  let admin: AdminClient;

  beforeAll(async () => {
    admin = await adminClient(db);
    app = await createJobsApp(db);
    const hash = () => randomBytes(32);
    const old = "now() - interval '1 hour'";
    const later = "now() + interval '1 hour'";
    await admin.query(`INSERT INTO platform.rate_limit_bucket (key, window_start, hits, expires_at) VALUES
      ('t:old', now() - interval '2 hours', 3, ${old}), ('t:new', now(), 1, ${later})`);
    await admin.query(`INSERT INTO platform.idempotency_key (organization_id, user_id, key, route, request_hash, created_at, expires_at) VALUES
      ($1, $3, 'old-tst', 'POST /x', repeat('a', 64), now() - interval '2 days', ${old}),
      ($2, $3, 'old-ndt', 'POST /x', repeat('a', 64), now() - interval '2 days', ${old}),
      ($1, $3, 'new-tst', 'POST /x', repeat('a', 64), now(), ${later})`, [TST, NDT, SYSTEM]);
    await admin.query(`INSERT INTO platform.auth_transaction (kind, organization_id, state_hash, browser_binding_hash, expires_at) VALUES
      ('guest_otp', $1, $2, $3, ${old}), ('guest_otp', $1, $4, $5, ${later})`, [TST, hash(), hash(), hash(), hash()]);
    const idp = await admin.query<{ id: string }>(`INSERT INTO platform.identity_provider (organization_id, slug, kind, display_name, saml_entry_point, saml_idp_certs)
      VALUES ($1, 'wp22-saml', 'saml', 'SAML', 'https://idp.invalid/sso', ARRAY['cert']) RETURNING id`, [TST]);
    await admin.query(`INSERT INTO platform.saml_assertion_seen (identity_provider_id, assertion_id_hash, expires_at) VALUES ($1, $2, ${old}), ($1, $3, ${later})`, [
      idp.rows[0]!.id,
      hash(),
      hash(),
    ]);
    await admin.query(`INSERT INTO platform.job_outbox (queue, payload, created_at, dispatched_at) VALUES
      ('cycle.derive', '{}', now() - interval '9 days', now() - interval '8 days'),
      ('cycle.derive', '{}', now() - interval '2 days', now() - interval '2 days'),
      ('cycle.derive', '{}', now() - interval '9 days', NULL)`);
    await admin.query(`INSERT INTO platform.session (id_hash, user_id, organization_id, state, auth_method, csrf_token_hash, idle_expires_at, absolute_expires_at) VALUES
      ($1, $4, $5, 'active', 'local', $1, ${old}, ${later}),
      ($2, $4, $5, 'active', 'local', $2, ${later}, ${old}),
      ($3, $4, $5, 'active', 'local', $3, ${later}, ${later})`, [hash(), hash(), hash(), SYSTEM, TST]);
    const ms = await admin.query<{ id: string; repo: string }>(`SELECT id, default_storage_repository_id AS repo FROM org_tst.management_system ORDER BY position LIMIT 1`);
    const { id: msId, repo } = ms.rows[0]!;
    await admin.query(`INSERT INTO org_tst.upload_intent (organization_id, management_system_id, object_kind, target_id, storage_repository_id, mode, folder_path,
        stored_name, max_bytes, correlation_code, status, expires_at) VALUES
      ($1, $2, 'evidence', gen_random_uuid(), $3, 'stored', '/x', 'a.pdf', 10, 'wp22-old', 'open', ${old}),
      ($1, $2, 'evidence', gen_random_uuid(), $3, 'stored', '/x', 'b.pdf', 10, 'wp22-new', 'open', ${later}),
      ($1, $2, 'evidence', gen_random_uuid(), $3, 'stored', '/x', 'c.pdf', 10, 'wp22-done', 'completed', ${old})`, [TST, msId, repo]);
    await admin.query(`INSERT INTO org_tst.export_file (organization_id, kind, format, file_name, expires_at) VALUES
      ($1, 'soa', 'xlsx', 'old.xlsx', ${old}), ($1, 'soa', 'xlsx', 'new.xlsx', ${later})`, [TST]);
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const state = async () => {
    const one = async (text: string, values: unknown[] = []) => (await admin.query<{ v: string }>(text, values)).rows.map((r) => r.v);
    return {
      buckets: await one(`SELECT key AS v FROM platform.rate_limit_bucket WHERE key LIKE 't:%' ORDER BY 1`),
      idempotency: await one(`SELECT key AS v FROM platform.idempotency_key ORDER BY 1`),
      authTransactions: await one(`SELECT (expires_at > now())::text AS v FROM platform.auth_transaction ORDER BY 1`),
      saml: await one(`SELECT (expires_at > now())::text AS v FROM platform.saml_assertion_seen ORDER BY 1`),
      outbox: await one(`SELECT (dispatched_at IS NULL)::text || ':' || (created_at < now() - interval '7 days')::text AS v FROM platform.job_outbox ORDER BY 1`),
      sessions: await one(`SELECT coalesce(revoke_reason, 'live') AS v FROM platform.session WHERE user_id = $1 ORDER BY 1`, [SYSTEM]),
      intents: await one(`SELECT correlation_code || ':' || status AS v FROM org_tst.upload_intent WHERE correlation_code LIKE 'wp22-%' ORDER BY 1`),
      exportFiles: await one(`SELECT file_name || ':' || (deleted_at IS NOT NULL)::text AS v FROM org_tst.export_file ORDER BY 1`),
    };
  };

  it('removes or marks every expired row and keeps valid ones', async () => {
    await app.run('cleanup.expired', { orgId: null, payload: {} });
    expect(await state()).toEqual({
      buckets: ['t:new'],
      idempotency: ['new-tst'],
      authTransactions: ['true'],
      saml: ['true'],
      outbox: ['false:false', 'true:true'],
      sessions: ['expired', 'expired', 'live'],
      intents: ['wp22-done:completed', 'wp22-new:open', 'wp22-old:expired'],
      exportFiles: ['new.xlsx:false', 'old.xlsx:true'],
    });
    expect(app.queue.failed('cleanup.expired')).toEqual([]);
  });

  it('is idempotent', async () => {
    const before = await state();
    const result = await app.moduleRef.get(CleanupExpiredJob).cleanup();
    expect(await state()).toEqual(before);
    expect(result).toMatchObject({ idempotencyKeys: 0, authTransactions: 0, samlAssertions: 0, outboxRows: 0, sessionsRevoked: 0, uploadIntentsExpired: 0, exportFilesExpired: 0, failedOrganisations: [] });
  });
});
