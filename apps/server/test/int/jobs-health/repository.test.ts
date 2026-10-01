// `link-health.repository` (build plan E.2, TS 5.7) on a copy of the demo template (organisation ndt) against the
// storage gateway and the mock providers with the demo fixtures: connection status, time and messages, the
// `connector` alerts and `connector_revoked` of a revoked credential (raised once, resolved when the connection works
// again), and `credential_expiring` to Tenant and Storage Admins 30 and 7 days before the credential expires.
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { NOON, ORG_IDS, createHealthApp, mockAdmin, rows, startProviderStack, type HealthApp, type ProviderStack } from './helpers';

const NDT = ORG_IDS.ndt;
const DAY = 24 * 3_600_000;

interface RepoRow {
  slug: string;
  connection_status: string;
  connection_message_en: string | null;
  connection_status_since: Date;
  last_checked_at: Date | null;
}

describe('repository connection checks (TS 5.7)', () => {
  const db = useTestDatabase('demo');
  let stack: ProviderStack;
  let ctx: HealthApp;

  const repositories = async () =>
    Object.fromEntries(
      (
        await rows<RepoRow>(
          db,
          'ndt',
          sql`SELECT slug, connection_status, connection_message_en, connection_status_since, last_checked_at FROM storage_repository WHERE deleted_at IS NULL`,
        )
      ).map((r) => [r.slug, r]),
    );
  const openAlerts = () =>
    rows<{ slug: string; tone: string; repository: string | null }>(
      db,
      'ndt',
      sql`SELECT m.slug, a.tone, a.source_ref->>'repository' AS repository FROM ms_alert a JOIN management_system m ON m.id = a.management_system_id
          WHERE a.kind = 'connector' AND a.resolved_at IS NULL AND a.deleted_at IS NULL ORDER BY m.position`,
    );
  const notifications = (kind: string) =>
    rows<{ recipient_user_id: string; code: string; digest: boolean }>(
      db,
      'ndt',
      sql`SELECT recipient_user_id, entity_ref->>'code' AS code, digest FROM notification WHERE kind = ${kind} ORDER BY created_at, recipient_user_id`,
    );
  const admins = async (roles: string[]) =>
    (
      await rows<{ user_id: string }>(
        db,
        'ndt',
        sql`SELECT m.user_id FROM platform.org_membership m JOIN platform.app_user u ON u.id = m.user_id
            WHERE m.organization_id = ${NDT}::uuid AND m.status = 'active' AND m.deleted_at IS NULL AND u.status = 'active'
              AND m.admin_roles && ${roles}::text[] ORDER BY m.user_id`,
      )
    ).map((r) => r.user_id);
  const runJob = () => ctx.run('link-health.repository', { orgId: NDT, payload: {} });

  beforeAll(async () => {
    stack = await startProviderStack();
    ctx = await createHealthApp(db, stack);
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });
  beforeEach(async () => {
    await mockAdmin(stack.mock, '/_admin/reset');
    ctx.setNow(NOON);
  });

  it('tests every repository: sp stays ok, gd stays revoked with its alert and message, od is refused by the provider', async () => {
    const before = await repositories();
    expect(before.gd!.connection_status).toBe('revoked');
    expect(await openAlerts()).toEqual([{ slug: 'bcms', tone: 'bad', repository: 'gd' }]);
    await runJob();
    expect(ctx.queue.failed()).toEqual([]);
    const after = await repositories();
    for (const slug of ['sp', 'gd', 'od', 'vault']) expect(after[slug]!.last_checked_at?.toISOString(), slug).toBe(new Date(NOON).toISOString());
    expect(after.sp).toMatchObject({ connection_status: 'ok', connection_message_en: null, connection_status_since: before.sp!.connection_status_since });
    // Same state: the seeded message and the time the state began are kept.
    expect(after.gd).toMatchObject({
      connection_status: 'revoked',
      connection_message_en: before.gd!.connection_message_en,
      connection_status_since: before.gd!.connection_status_since,
    });
    // The fixture's OneDrive answers 403 to every request (account disabled, G.8).
    expect(after.od).toMatchObject({ connection_status: 'failed', connection_message_en: expect.any(String) });
    expect(after.od!.connection_status_since.toISOString()).toBe(new Date(NOON).toISOString());
    // The gd alert is not raised twice and nobody is told again: the state did not change.
    expect(await openAlerts()).toEqual([{ slug: 'bcms', tone: 'bad', repository: 'gd' }]);
    expect(await notifications('connector_revoked')).toEqual([]);
    const audit = await rows<{ entity_code: string; after_data: Record<string, unknown> }>(
      db,
      'ndt',
      sql`SELECT entity_code, after_data FROM audit_trail WHERE action = 'storage.repository.updated' AND actor_kind = 'system' ORDER BY seq`,
    );
    // The vault of this stack has no object store behind it (a closed port), so its test fails too.
    expect(after.vault!.connection_status).toBe('failed');
    expect(audit.map((a) => a.entity_code).sort()).toEqual(['od', 'vault']);
    expect(audit.every((a) => a.after_data.connectionStatus === 'failed' && a.after_data.source === 'link-health.repository')).toBe(true);
  });

  it('a revoked credential raises connector alerts on the systems the repository serves and tells the Tenant Admins once; recovery resolves them', async () => {
    await mockAdmin(stack.mock, '/_admin/tokens/revoke', { clientId: '2f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f' });
    await runJob();
    expect((await repositories()).sp!.connection_status).toBe('revoked');
    const alerts = await openAlerts();
    expect(alerts.filter((a) => a.repository === 'sp').map((a) => a.slug)).toEqual(['isms', 'qms', 'bcms', 'abms']);
    const tenantAdmins = await admins(['tenant_admin']);
    expect(tenantAdmins.length).toBeGreaterThan(0);
    // The OneDrive repository uses the same app registration, so it is revoked too (one notice per repository).
    const revoked = await notifications('connector_revoked');
    expect(revoked.filter((n) => n.code === 'sp').map((n) => n.recipient_user_id).sort()).toEqual(tenantAdmins);
    expect(revoked.filter((n) => n.code === 'od').map((n) => n.recipient_user_id).sort()).toEqual(tenantAdmins);
    // A second run while still revoked adds nothing.
    await runJob();
    expect(await openAlerts()).toEqual(alerts);
    expect(await notifications('connector_revoked')).toHaveLength(revoked.length);
    // The credential works again: sp is ok and its alerts are resolved; the gd alert stays.
    await mockAdmin(stack.mock, '/_admin/reset');
    await runJob();
    expect((await repositories()).sp!.connection_status).toBe('ok');
    const remaining = await openAlerts();
    expect(remaining.filter((a) => a.repository === 'sp')).toEqual([]);
    expect(remaining).toContainEqual({ slug: 'bcms', tone: 'bad', repository: 'gd' });
  });

  it('warns Tenant and Storage Admins 30 and 7 days before the credential expires, once per step', async () => {
    const recipients = await admins(['tenant_admin', 'storage_admin']);
    expect(recipients.length).toBeGreaterThan(0);
    const setExpiry = (at: Date) =>
      rows(
        db,
        'ndt',
        sql`UPDATE storage_credential SET expires_at = ${at} WHERE storage_repository_id = (SELECT id FROM storage_repository WHERE slug = 'gd')
              AND revoked_at IS NULL AND deleted_at IS NULL`,
      );
    await setExpiry(new Date(new Date(NOON).getTime() + 31 * DAY));
    await runJob();
    expect(await notifications('credential_expiring')).toEqual([]);
    await setExpiry(new Date(new Date(NOON).getTime() + 30 * DAY));
    await runJob();
    let sent = await notifications('credential_expiring');
    expect(sent.map((n) => n.recipient_user_id).sort()).toEqual(recipients);
    expect(sent.every((n) => n.code === 'gd 30d' && n.digest === false)).toBe(true);
    await runJob();
    expect(await notifications('credential_expiring')).toHaveLength(recipients.length);
    await setExpiry(new Date(new Date(NOON).getTime() + 7 * DAY));
    await runJob();
    await runJob();
    sent = await notifications('credential_expiring');
    expect(sent).toHaveLength(2 * recipients.length);
    expect(sent.filter((n) => n.code === 'gd 7d').map((n) => n.recipient_user_id).sort()).toEqual(recipients);
    // The email goes out right away (not a digest notification).
    expect(ctx.queue.waitingJobs('notifications.dispatch').length).toBeGreaterThanOrEqual(2 * recipients.length);
  });
});
