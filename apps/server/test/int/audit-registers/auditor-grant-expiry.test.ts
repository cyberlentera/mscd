// Scheduled closing of expired guest auditor grants (build plan F.14 step 5, E.2 `cleanup.expired`; WP-26 verifier
// finding handled by WP-37): the auditor access module registers a tenant step of the hourly `cleanup.expired`
// job, so a grant past its expiry revokes the guest's sessions, disables the guest membership and ends the role on
// the next run, without anyone listing or creating grants. A grant that is still valid is left alone, and a second
// run changes nothing.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDITOR_GRANTS_EXPIRED_STEP, AuditorAccessModule } from '../../../src/modules/auditor-access/auditor-access.module';
import { CleanupExpiredJob } from '../../../src/modules/jobs/cleanup-expired.job';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, type AdminClient, type JobsApp } from '../jobs/helpers';
import { ORG_IDS } from './helpers';

describe('expired auditor grants are closed by cleanup.expired (F.14 step 5)', () => {
  const db = useTestDatabase('demo');
  let app: JobsApp;
  let admin: AdminClient;
  let grant: { id: string; user_id: string; user_ms_role_id: string };
  let sessionHash: Buffer;

  beforeAll(async () => {
    admin = await adminClient(db);
    app = await createJobsApp(db, { imports: [AuditorAccessModule] });
    // The seeded grant of ext.auditor on the tst ISMS (expires today + 14 days) with a live guest session.
    const found = await admin.query<{ id: string; user_id: string; user_ms_role_id: string }>(
      `SELECT g.id, g.user_id, g.user_ms_role_id FROM org_tst.auditor_access_grant g JOIN platform.app_user u ON u.id = g.user_id
        WHERE u.handle = 'ext.auditor' AND g.revoked_at IS NULL AND g.deleted_at IS NULL`,
    );
    grant = found.rows[0]!;
    sessionHash = randomBytes(32);
    await admin.query(
      `INSERT INTO platform.session (id_hash, user_id, organization_id, auth_org_id, state, auth_method, auth_grant_id, csrf_token_hash, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $3, 'active', 'guest', $4, $5, now() + interval '1 hour', now() + interval '8 hours')`,
      [sessionHash, grant.user_id, ORG_IDS.tst, grant.id, randomBytes(32)],
    );
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const state = async () => {
    const session = await admin.query<{ revoked: boolean; reason: string | null }>(
      `SELECT revoked_at IS NOT NULL AS revoked, revoke_reason AS reason FROM platform.session WHERE id_hash = $1`,
      [sessionHash],
    );
    const membership = await admin.query<{ status: string }>(`SELECT status FROM platform.org_membership WHERE user_id = $1 AND organization_id = $2`, [grant.user_id, ORG_IDS.tst]);
    const role = await admin.query<{ ended: boolean }>(`SELECT valid_until <= now() AS ended FROM org_tst.user_ms_role WHERE id = $1`, [grant.user_ms_role_id]);
    const audit = await admin.query<{ after_data: Record<string, unknown> }>(
      `SELECT after_data FROM org_tst.audit_trail WHERE action = 'auditor_access.revoked' AND entity_id = $1 ORDER BY seq`,
      [grant.id],
    );
    return { session: session.rows[0], membership: membership.rows[0]?.status, roleEnded: role.rows[0]?.ended, revocations: audit.rows.map((r) => r.after_data) };
  };

  it('leaves a valid grant alone', async () => {
    const result = await app.moduleRef.get(CleanupExpiredJob).cleanup();
    expect(result.tenantSteps).toEqual({ [AUDITOR_GRANTS_EXPIRED_STEP]: 0 });
    expect(await state()).toEqual({ session: { revoked: false, reason: null }, membership: 'active', roleEnded: false, revocations: [] });
  });

  it('ends the expired grant on the next hourly run: sessions revoked, membership disabled, role ended, audited', async () => {
    await admin.query(`UPDATE org_tst.auditor_access_grant SET expires_at = now() - interval '1 minute' WHERE id = $1`, [grant.id]);
    // The job itself, as the worker runs it (registered handler on the queue).
    await app.run('cleanup.expired', { orgId: null, payload: {} });
    expect(app.queue.failed('cleanup.expired')).toEqual([]);
    const after = await state();
    expect(after).toMatchObject({ session: { revoked: true, reason: 'grant_revoked' }, membership: 'disabled', roleEnded: true });
    expect(after.revocations).toEqual([expect.objectContaining({ reason: 'expired', sessionsRevoked: 1 })]);

    // A second run finds nothing more to end.
    const again = await app.moduleRef.get(CleanupExpiredJob).cleanup();
    expect(again.tenantSteps).toEqual({ [AUDITOR_GRANTS_EXPIRED_STEP]: 0 });
    expect((await state()).revocations).toHaveLength(1);
  });
});
