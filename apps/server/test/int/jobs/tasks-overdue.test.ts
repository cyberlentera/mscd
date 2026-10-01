// `tasks.overdue` (E.2, BR-10, BR-15, TS 6.7, 6.8) and `audit-prep.generate` (TS 4.9, BR-44) on a copy of the demo
// template (organisation `tst`, `demo.fixed_today` 2026-09-29): effects, tasks, notifications and audit entries,
// idempotency (a second run changes nothing), and tasks closed when their condition clears.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, type AdminClient, type JobsApp } from './helpers';

const TST = '00000000-0000-4000-8000-00000000a004';

describe('tasks.overdue and audit-prep.generate (E.2)', () => {
  const db = useTestDatabase('demo');
  let app: JobsApp;
  let admin: AdminClient;
  const ids: Record<string, string> = {};

  const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await admin.query<T>(text, values)).rows;

  beforeAll(async () => {
    admin = await adminClient(db);
    app = await createJobsApp(db);
    for (const row of await one<{ handle: string; id: string }>(`SELECT handle, id FROM platform.app_user WHERE handle IN ('rina', 'bagus', 'maya')`)) ids[row.handle] = row.id;
    ids.ms = (await one<{ id: string }>(`SELECT id FROM org_tst.management_system WHERE slug = 'isms'`))[0]!.id;
    ids.event = (await one<{ id: string }>(`SELECT id FROM org_tst.audit_event WHERE scheduled_at = '2026-11-12'`))[0]!.id;
    ids.cycle = (await one<{ id: string }>(`SELECT id FROM org_tst.certification_cycle LIMIT 1`))[0]!.id;
    ids.doc = (
      await one<{ id: string }>(
        `INSERT INTO org_tst.document (organization_id, doc_code, title, doc_type, status, owner_user_id, next_review_at, approved_at)
         VALUES ($1, 'WP22-D1', 'Access review procedure', 'procedure', 'approved', $2, '2026-09-01', '2025-09-01') RETURNING id`,
        [TST, ids.bagus],
      )
    )[0]!.id;
    await admin.query(`INSERT INTO org_tst.entity_ms_link (organization_id, entity_type, entity_id, management_system_id, is_primary) VALUES ($1, 'document', $2, $3, true)`, [TST, ids.doc, ids.ms]);
    ids.prep = (
      await one<{ id: string }>(
        `INSERT INTO org_tst.audit_prep_task (organization_id, audit_event_id, management_system_id, title, owner_user_id, due_at, status)
         VALUES ($1, $2, $3, 'Collect access logs', $4, '2026-09-20', 'not_started') RETURNING id`,
        [TST, ids.event, ids.ms, ids.bagus],
      )
    )[0]!.id;
    ids.cycleItem = (
      await one<{ id: string }>(
        `INSERT INTO org_tst.cycle_requirement_status (organization_id, management_system_id, certification_cycle_id, title, owner_user_id, status, due_at)
         VALUES ($1, $2, $3, 'Supplier review', $4, 'in_progress', '2026-09-10') RETURNING id`,
        [TST, ids.ms, ids.cycle, ids.bagus],
      )
    )[0]!.id;
    ids.finding = (
      await one<{ id: string }>(
        `INSERT INTO org_tst.finding (organization_id, management_system_id, code, title, classification, source, status, owner_user_id, raised_at, due_at)
         VALUES ($1, $2, 'WP22-F1', 'Backups not tested', 'minor', 'internal_audit', 'open', $3, '2026-08-01', '2026-09-01') RETURNING id`,
        [TST, ids.ms, ids.bagus],
      )
    )[0]!.id;
    ids.dd = (
      await one<{ id: string }>(
        `INSERT INTO org_tst.due_diligence (organization_id, management_system_id, subject_type, performed_at, valid_until, status)
         VALUES ($1, $2, 'associate', '2025-09-01', '2026-09-01', 'completed') RETURNING id`,
        [TST, ids.ms],
      )
    )[0]!.id;
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const snapshot = async () => ({
    prep: (await one<{ status: string }>(`SELECT status FROM org_tst.audit_prep_task WHERE id = $1`, [ids.prep]))[0]!.status,
    cycle: (await one<{ status: string }>(`SELECT status FROM org_tst.cycle_requirement_status WHERE id = $1`, [ids.cycleItem]))[0]!.status,
    doc: (await one<{ status: string }>(`SELECT status FROM org_tst.document WHERE id = $1`, [ids.doc]))[0]!.status,
    dd: (await one<{ status: string }>(`SELECT status FROM org_tst.due_diligence WHERE id = $1`, [ids.dd]))[0]!.status,
    tasks: await one<{ source_rule: string; entity_code: string; owner: string | null; status: string }>(
      `SELECT source_rule, entity_code, (SELECT handle FROM platform.app_user u WHERE u.id = t.owner_user_id) AS owner, status
         FROM org_tst.task t ORDER BY source_rule, entity_code, status`,
    ),
    notifications: await one<{ kind: string; handle: string; n: string }>(
      `SELECT kind, (SELECT handle FROM platform.app_user u WHERE u.id = recipient_user_id) AS handle, count(*)::text AS n
         FROM org_tst.notification GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
  });

  it('marks overdue items, expires documents and due diligence, opens BR-10 and BR-15 tasks and notifies once', async () => {
    await app.run('tasks.overdue', { orgId: TST, payload: {} });
    expect(app.queue.failed()).toEqual([]);
    const s = await snapshot();
    expect({ prep: s.prep, cycle: s.cycle, doc: s.doc, dd: s.dd }).toEqual({ prep: 'overdue', cycle: 'overdue', doc: 'expired', dd: 'expired' });
    // Every expired document of the system has a BR-10 task (the five seeded ones and WP22-D1); WP22-F1 a BR-15 task.
    expect(s.tasks.filter((t) => t.source_rule === 'BR-10').map((t) => t.entity_code)).toEqual(['PRC-07', 'PRC-11', 'PRC-15', 'REG-03', 'STD-04', 'WP22-D1']);
    expect(s.tasks.filter((t) => t.status === 'open')).toHaveLength(7);
    expect(s.tasks.find((t) => t.entity_code === 'WP22-D1')).toMatchObject({ owner: 'bagus', status: 'open' });
    expect(s.tasks.find((t) => t.source_rule === 'BR-15')).toMatchObject({ entity_code: 'WP22-F1', owner: 'bagus', status: 'open' });
    expect(s.notifications).toEqual([
      { kind: 'document_expired', handle: 'bagus', n: '1' },
      { kind: 'finding_overdue', handle: 'bagus', n: '1' },
      { kind: 'finding_overdue', handle: 'rina', n: '1' },
      { kind: 'task_overdue', handle: 'bagus', n: '2' },
    ]);
    const audit = await one<{ action: string; entity_type: string; actor_kind: string }>(
      `SELECT action, entity_type, actor_kind FROM org_tst.audit_trail WHERE entity_id = ANY($1::uuid[]) ORDER BY action, entity_type`,
      [[ids.prep, ids.cycleItem, ids.doc, ids.dd]],
    );
    expect(audit).toEqual([
      { action: 'cycle_item.updated', entity_type: 'cycle_requirement_status', actor_kind: 'system' },
      { action: 'document.transition', entity_type: 'document', actor_kind: 'system' },
      { action: 'prep_task.updated', entity_type: 'audit_prep_task', actor_kind: 'system' },
      { action: 'register.updated', entity_type: 'due_diligence', actor_kind: 'system' },
    ]);
    // Immediate notifications queue an email dispatch in the same transaction (E.6).
    expect(app.queue.waitingJobs('notifications.dispatch').length).toBe(5);
  });

  it('is idempotent: a second run changes nothing and notifies nobody again', async () => {
    const before = await snapshot();
    await app.run('tasks.overdue', { orgId: TST, payload: {} });
    expect(await snapshot()).toEqual(before);
  });

  it('notifies an item owner once even when the item becomes overdue again', async () => {
    await admin.query(`UPDATE org_tst.audit_prep_task SET status = 'in_progress' WHERE id = $1`, [ids.prep]);
    await app.run('tasks.overdue', { orgId: TST, payload: {} });
    const s = await snapshot();
    expect(s.prep).toBe('overdue');
    expect(s.notifications.find((n) => n.kind === 'task_overdue')).toEqual({ kind: 'task_overdue', handle: 'bagus', n: '2' });
  });

  it('closes BR-10 and BR-15 tasks whose condition cleared (actor system)', async () => {
    await admin.query(`UPDATE org_tst.finding SET status = 'closed', closed_at = '2026-09-28', close_note = 'done' WHERE id = $1`, [ids.finding]);
    await admin.query(`UPDATE org_tst.document SET status = 'approved', next_review_at = '2027-09-01' WHERE id = $1`, [ids.doc]);
    await app.run('tasks.overdue', { orgId: TST, payload: {} });
    const s = await snapshot();
    expect(s.tasks.filter((t) => t.status === 'done').map((t) => `${t.source_rule} ${t.entity_code}`)).toEqual(['BR-10 WP22-D1', 'BR-15 WP22-F1']);
    expect(s.tasks.filter((t) => t.status === 'open')).toHaveLength(5);
    const closed = await one<{ closed_by: string; actor_kind: string }>(
      `SELECT t.closed_by, a.actor_kind FROM org_tst.task t JOIN org_tst.audit_trail a ON a.entity_id = t.id AND a.action = 'task.completed'
        WHERE t.status = 'done' ORDER BY t.entity_code`,
    );
    expect(closed).toEqual([
      { closed_by: '00000000-0000-0000-0000-000000000001', actor_kind: 'system' },
      { closed_by: '00000000-0000-0000-0000-000000000001', actor_kind: 'system' },
    ]);
  });

  it('generates audit preparation tasks when the window of the next event opens, skipping BR-44 tasks on a first audit', async () => {
    // The next ISMS event (2026-11-12) already has its seeded tasks: nothing happens.
    const count = async () => (await one(`SELECT 1 FROM org_tst.audit_prep_task WHERE deleted_at IS NULL`)).length;
    const seeded = await count();
    await app.run('audit-prep.generate', { orgId: TST, payload: {} });
    expect(await count()).toBe(seeded);

    // Without them the window (60 days before 2026-11-12) is open on 2026-09-29.
    await admin.query(`UPDATE org_tst.audit_prep_task SET deleted_at = now() WHERE audit_event_id = $1`, [ids.event]);
    await app.run('audit-prep.generate', { orgId: TST, payload: {} });
    const created = await one<{ template_code: string; due_at: Date; owner: string; status: string }>(
      `SELECT template_code, due_at, (SELECT handle FROM platform.app_user u WHERE u.id = owner_user_id) AS owner, status
         FROM org_tst.audit_prep_task WHERE audit_event_id = $1 AND deleted_at IS NULL ORDER BY position`,
      [ids.event],
    );
    expect(created.map((c) => c.template_code)).toEqual(['PREP-01', 'PREP-02', 'PREP-03', 'PREP-04', 'PREP-05', 'PREP-06', 'PREP-07']);
    expect(created.every((c) => c.owner === 'rina' && c.status === 'not_started')).toBe(true);
    expect(created.map((c) => c.due_at.toISOString().slice(0, 10))).toEqual(['2026-10-10', '2026-10-06', '2026-10-15', '2026-10-20', '2026-10-28', '2026-11-05', '2026-11-09']);
    const notes = await one<{ kind: string; digest: boolean }>(`SELECT kind, digest FROM org_tst.notification WHERE kind = 'prep_task_assigned'`);
    expect(notes).toEqual([{ kind: 'prep_task_assigned', digest: true }]);

    // A second run creates nothing more.
    await app.run('audit-prep.generate', { orgId: TST, payload: {} });
    expect(await one(`SELECT 1 FROM org_tst.audit_prep_task WHERE audit_event_id = $1 AND deleted_at IS NULL`, [ids.event])).toHaveLength(7);

    // A first audit (no earlier event): PREP-04 (finding closure) is skipped (BR-44).
    await admin.query(`UPDATE org_tst.audit_prep_task SET deleted_at = now() WHERE audit_event_id = $1`, [ids.event]);
    await admin.query(`UPDATE org_tst.audit_event SET deleted_at = now() WHERE management_system_id = $1 AND scheduled_at < '2026-11-12'`, [ids.ms]);
    await app.run('audit-prep.generate', { orgId: TST, payload: {} });
    const first = await one<{ template_code: string }>(
      `SELECT template_code FROM org_tst.audit_prep_task WHERE audit_event_id = $1 AND deleted_at IS NULL ORDER BY position`,
      [ids.event],
    );
    expect(first.map((c) => c.template_code)).toEqual(['PREP-01', 'PREP-02', 'PREP-03', 'PREP-05', 'PREP-06', 'PREP-07']);
  });

  it('does nothing for an organisation that is not active', async () => {
    await admin.query(`UPDATE platform.organization SET status = 'suspended' WHERE id = $1`, [TST]);
    try {
      app.moduleRef.get(TenantResolver).invalidateAll();
      const before = await snapshot();
      await app.run('tasks.overdue', { orgId: TST, payload: {} });
      expect(await snapshot()).toEqual(before);
    } finally {
      await admin.query(`UPDATE platform.organization SET status = 'active' WHERE id = $1`, [TST]);
    }
  });
});
