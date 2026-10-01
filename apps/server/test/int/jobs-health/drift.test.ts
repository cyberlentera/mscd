// `drift.evaluate` (build plan E.2, TS 9.6, BR-48, BR-49) on a copy of the demo template (organisation ndt,
// `demo.fixed_today` 2026-09-29): on the demo data it finds exactly the seeded stale risk rows and resolves none;
// detection and resolution for `stale_risk`, `metric` and `exercise` with holder, due date and `drift_detected`;
// `manual` rules keep their stored rows; a run for one system leaves the others alone; a second run changes nothing.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { NOON, ORG_IDS, createHealthApp, rows, startProviderStack, type HealthApp, type ProviderStack } from './helpers';

const NDT = ORG_IDS.ndt;
const DUE = '2026-10-29';

interface DriftRow {
  id: string;
  ms: string;
  rule_code: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_code: string;
  holder_user_id: string | null;
  due_at: string | null;
  resolved_at: Date | null;
}

describe('drift.evaluate (BR-48, BR-49)', () => {
  const db = useTestDatabase('demo');
  let stack: ProviderStack;
  let ctx: HealthApp;
  let seeded: DriftRow[];

  const drift = () =>
    rows<DriftRow>(
      db,
      'ndt',
      sql`SELECT d.id, m.slug AS ms, d.rule_code, d.entity_type, d.entity_id, d.entity_code, d.holder_user_id, d.due_at::text AS due_at, d.resolved_at
          FROM drift_result d JOIN management_system m ON m.id = d.management_system_id WHERE d.deleted_at IS NULL ORDER BY m.position, d.rule_code, d.position`,
    );
  const open = async (ms: string, rule: string) => (await drift()).filter((r) => r.ms === ms && r.rule_code === rule && r.resolved_at === null);
  const evaluate = (msSlug?: string) =>
    msSlug
      ? rows<{ id: string }>(db, 'ndt', sql`SELECT id FROM management_system WHERE slug = ${msSlug}`).then(([m]) =>
          ctx.run('drift.evaluate', { orgId: NDT, payload: { msId: m!.id } }),
        )
      : ctx.run('drift.evaluate', { orgId: NDT, payload: {} });
  const notified = (driftId: string) =>
    rows<{ recipient_user_id: string; digest: boolean }>(
      db,
      'ndt',
      sql`SELECT recipient_user_id, digest FROM notification WHERE kind = 'drift_detected' AND entity_ref->>'id' = ${driftId}`,
    );

  beforeAll(async () => {
    stack = await startProviderStack();
    ctx = await createHealthApp(db, stack);
    seeded = await drift();
    await evaluate();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('finds exactly the seeded stale risk rows on the demo data and resolves none', async () => {
    expect(ctx.queue.failed()).toEqual([]);
    const after = await drift();
    for (const row of seeded) expect(after.find((r) => r.id === row.id), row.entity_code).toEqual(row);
    const added = after.filter((r) => !seeded.some((s) => s.id === r.id));
    // No stored-row rule (stale_risk, dd_expired) got a new row.
    expect(added.filter((r) => ['risk12', 'dd'].includes(r.rule_code))).toEqual([]);
    expect(seeded.filter((r) => r.rule_code === 'risk12').map((r) => `${r.ms}:${r.entity_code}`)).toEqual([
      'isms:R-005', 'isms:R-009', 'isms:R-011', 'isms:R-017', 'isms:R-020', 'isms:R-029', 'qms:RO-03', 'qms:RO-05',
    ]);
    // Live rules (shown from their source lists, G.5) get stored rows too: the three unverifiable ISMS files.
    expect(added.filter((r) => r.ms === 'isms' && r.rule_code === 'unverif').map((r) => r.entity_code).sort()).toEqual(['EV-0124', 'EV-0271', 'EV-0313']);
    for (const row of added) expect(row).toMatchObject({ due_at: DUE, resolved_at: null });
  });

  it('a second run changes nothing', async () => {
    const before = await drift();
    const notifications = await rows(db, 'ndt', sql`SELECT id FROM notification WHERE kind = 'drift_detected'`);
    await evaluate();
    expect(await drift()).toEqual(before);
    expect(await rows(db, 'ndt', sql`SELECT id FROM notification WHERE kind = 'drift_detected'`)).toHaveLength(notifications.length);
  });

  it('stale_risk: a risk not reassessed for 12 months gets a row for its owner; reassessed, its row is resolved', async () => {
    const [risk] = await rows<{ id: string; code: string; owner_user_id: string }>(
      db,
      'ndt',
      sql`SELECT r.id, r.code, r.owner_user_id FROM risk r JOIN entity_ms_link l ON l.entity_id = r.id AND l.entity_type = 'risk'
          JOIN management_system m ON m.id = l.management_system_id
          WHERE m.slug = 'isms' AND r.deleted_at IS NULL AND r.owner_user_id IS NOT NULL AND r.code NOT IN ('R-005', 'R-009', 'R-011', 'R-017', 'R-020', 'R-029')
          ORDER BY r.code LIMIT 1`,
    );
    await rows(db, 'ndt', sql`UPDATE risk SET assessed_at = '2025-09-28' WHERE id = ${risk!.id}::uuid`);
    await evaluate('isms');
    const [row] = (await open('isms', 'risk12')).filter((r) => r.entity_id === risk!.id);
    expect(row).toMatchObject({ entity_type: 'risk', entity_code: risk!.code, holder_user_id: risk!.owner_user_id, due_at: DUE });
    expect(await notified(row!.id)).toEqual([{ recipient_user_id: risk!.owner_user_id, digest: true }]);
    // Exactly 12 months ago is still current.
    await rows(db, 'ndt', sql`UPDATE risk SET assessed_at = '2025-09-29' WHERE id = ${risk!.id}::uuid`);
    await evaluate('isms');
    expect((await open('isms', 'risk12')).some((r) => r.entity_id === risk!.id)).toBe(false);
    // A seeded row is resolved the same way once its risk is reassessed (BR-49).
    const r005 = seeded.find((r) => r.entity_code === 'R-005' && r.ms === 'isms')!;
    await rows(db, 'ndt', sql`UPDATE risk SET assessed_at = '2026-09-01' WHERE id = ${r005.entity_id}::uuid`);
    await evaluate('isms');
    const resolved = (await drift()).find((r) => r.id === r005.id)!;
    expect(resolved.resolved_at?.toISOString()).toBe(new Date(NOON).toISOString());
    const audit = await rows<{ action: string; actor_kind: string }>(
      db,
      'ndt',
      sql`SELECT action, actor_kind FROM audit_trail WHERE entity_type = 'drift_result' AND entity_id = ${r005.id}::uuid`,
    );
    expect(audit).toEqual([{ action: 'register.updated', actor_kind: 'system' }]);
  });

  it('metric: a metric not measured within its period gets a row; measured again, the row is resolved', async () => {
    // The demo metrics have no frequency (never stale); this one is measured monthly from now on.
    const [metric] = await rows<{ id: string; code: string; owner_user_id: string | null }>(
      db,
      'ndt',
      sql`UPDATE metric SET frequency_code = 'monthly' WHERE id = (
            SELECT x.id FROM metric x JOIN entity_ms_link l ON l.entity_id = x.id AND l.entity_type = 'metric' AND l.deleted_at IS NULL
            JOIN management_system m ON m.id = l.management_system_id WHERE m.slug = 'isms' AND x.deleted_at IS NULL ORDER BY x.code LIMIT 1)
          RETURNING id, code, owner_user_id`,
    );
    expect(metric).toBeDefined();
    await rows(db, 'ndt', sql`UPDATE metric SET last_measured_at = '2026-09-28' WHERE id = ${metric!.id}::uuid`);
    await evaluate('isms');
    expect((await open('isms', 'metric')).some((r) => r.entity_id === metric!.id)).toBe(false);
    await rows(db, 'ndt', sql`UPDATE metric SET last_measured_at = '2025-01-01' WHERE id = ${metric!.id}::uuid`);
    await evaluate('isms');
    const [row] = (await open('isms', 'metric')).filter((r) => r.entity_id === metric!.id);
    expect(row).toMatchObject({ entity_type: 'metric', entity_code: metric!.code, holder_user_id: metric!.owner_user_id, due_at: DUE });
    await rows(db, 'ndt', sql`UPDATE metric SET last_measured_at = '2026-09-29' WHERE id = ${metric!.id}::uuid`);
    await evaluate('isms');
    expect((await drift()).find((r) => r.id === row!.id)!.resolved_at).not.toBeNull();
  });

  it('exercise: a business continuity plan without a scheduled exercise gets a row; once one is planned, it is resolved', async () => {
    // The demo BCMS has no plan records; one is added with an exercise performed more than a year ago.
    const [plan] = await rows<{ id: string; code: string; owner_user_id: string | null }>(
      db,
      'ndt',
      sql`INSERT INTO bc_plan (organization_id, management_system_id, code, title, owner_user_id, status)
          SELECT ${NDT}::uuid, m.id, 'BCP-WP23', 'Data centre recovery plan', (SELECT user_id FROM user_ms_role WHERE management_system_id = m.id LIMIT 1), 'approved'
          FROM management_system m WHERE m.slug = 'bcms' RETURNING id, code, owner_user_id`,
    );
    await rows(
      db,
      'ndt',
      sql`INSERT INTO exercise (organization_id, management_system_id, code, title, bc_plan_id, planned_at, performed_at)
          SELECT ${NDT}::uuid, management_system_id, 'EX-WP23A', 'Old tabletop', id, '2025-06-01', '2025-06-01' FROM bc_plan WHERE id = ${plan!.id}::uuid`,
    );
    await evaluate('bcms');
    const [row] = (await open('bcms', 'exercise')).filter((r) => r.entity_id === plan!.id);
    expect(row).toMatchObject({ entity_type: 'bc_plan', entity_code: plan!.code, holder_user_id: plan!.owner_user_id, due_at: DUE });
    await rows(
      db,
      'ndt',
      sql`INSERT INTO exercise (organization_id, management_system_id, code, title, bc_plan_id, planned_at)
          SELECT ${NDT}::uuid, management_system_id, 'EX-WP23B', 'Tabletop exercise', id, '2026-11-15' FROM bc_plan WHERE id = ${plan!.id}::uuid`,
    );
    await evaluate('bcms');
    expect((await drift()).find((r) => r.id === row!.id)!.resolved_at).not.toBeNull();
  });

  it('manual rules keep their stored rows, and a run for one system leaves the others alone', async () => {
    const manual = seeded.filter((r) => ['mr', 'csat'].includes(r.rule_code));
    expect(manual.length).toBeGreaterThan(0);
    await evaluate();
    const after = await drift();
    for (const row of manual) expect(after.find((r) => r.id === row.id)).toEqual(row);
    // A qms risk made stale is not picked up by a run for the ISMS only.
    const [risk] = await rows<{ id: string }>(
      db,
      'ndt',
      sql`SELECT r.id FROM risk r JOIN entity_ms_link l ON l.entity_id = r.id AND l.entity_type = 'risk' JOIN management_system m ON m.id = l.management_system_id
          WHERE m.slug = 'qms' AND r.code NOT IN ('RO-03', 'RO-05') AND NOT EXISTS (
            SELECT 1 FROM entity_ms_link o JOIN management_system om ON om.id = o.management_system_id
            WHERE o.entity_id = r.id AND o.entity_type = 'risk' AND om.slug = 'isms') ORDER BY r.code LIMIT 1`,
    );
    await rows(db, 'ndt', sql`UPDATE risk SET assessed_at = '2024-01-01' WHERE id = ${risk!.id}::uuid`);
    await evaluate('isms');
    expect((await open('qms', 'risk12')).some((r) => r.entity_id === risk!.id)).toBe(false);
    await evaluate('qms');
    expect((await open('qms', 'risk12')).some((r) => r.entity_id === risk!.id)).toBe(true);
    expect(ctx.queue.failed()).toEqual([]);
  });
});
