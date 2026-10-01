// Audit event, preparation task and cycle item commands (build plan D.3, C.13, A-23, A-26, K.2 WP-35): planning an
// event, moving its date (BR-42: After audit flags recomputed, preparation tasks flagged instead of rejected,
// affected holders notified, `count` of holders), preparation tasks (BR-43 on create, patch and the trigger,
// C.13 statuses, own grants), cycle items, the 403, 404, 409 and 412 paths, and the audit chain after the run.
import { CommandResult, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditOf, createApp, notificationsOf, rowsOf, sessionFor, verifyChain, type Client, type CommandsApp } from './helpers';

describe('audit event commands', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;

  beforeAll(async () => {
    ctx = await createApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const snapshot = async () => (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
  const eventOf = async (label: string) => {
    const [row] = await rowsOf<{ id: string; updated_at: Date }>(db, 'tst', sql`select id, updated_at from audit_event where short_label = ${label}`);
    return row!;
  };
  const refByCode = (s: UiMsSnapshot, kind: string, code: string) => {
    const key = Object.keys(s.refs).find((k) => k.startsWith(`isms:${kind}:`) && s.refs[k]!.code === code);
    if (!key) throw new Error(`No ${kind} ref ${code}`);
    return s.refs[key]!;
  };

  describe('audit events', () => {
    it('plans an event (201) that the timeline shows; 403 for a Domain Owner', async () => {
      const body = { eventType: 'special', nameEn: 'Special audit', nameId: 'Audit khusus', shortLabel: 'Special 2027', scheduledAt: '2027-03-15', auditDays: 1 };
      const response = await rina.post('/api/v1/ms/isms/audit-events', body);
      expect(response.status).toBe(201);
      expect(CommandResult.safeParse(response.body).success).toBe(true);
      expect(response.body.ref).toMatchObject({ entityType: 'audit_event', code: 'Special 2027' });
      expect((await snapshot()).EVENTS.some((e) => e.d === '2027-03-15')).toBe(true);
      expect((await auditOf(db, 'tst', response.body.ref!.id))[0]).toMatchObject({ action: 'audit_event.created', actor: 'rina' });
      expect((await bagus.post('/api/v1/ms/isms/audit-events', body)).status).toBe(403);
    });

    it('moving the next audit earlier flags preparation tasks, recomputes After audit and notifies the affected holders (BR-42)', async () => {
      const event = await eventOf('Surveillance 1');
      const before = await snapshot();
      expect(before.bundle.chain.items.find((i) => i.key === 'isms:x:R-022')).toMatchObject({ due: '2026-10-30', after: false, h: 'hendra' });
      const response = await rina.patch(`/api/v1/ms/isms/audit-events/${event.id}`, { scheduledAt: '2026-10-25' }, { 'if-match': `W/"${new Date(event.updated_at).getTime()}"` });
      expect(response.status).toBe(200);
      expect(response.body.count).toBeGreaterThan(0);

      const after = await snapshot();
      expect(after.bundle.chain.items.find((i) => i.key === 'isms:x:R-022')).toMatchObject({ after: true });
      const flagged = await rowsOf<{ title: string }>(db, 'tst', sql`select title from audit_prep_task where audit_event_id = ${event.id} and violates_br43 order by title`);
      expect(flagged.map((f) => f.title)).toEqual(['Brief auditees on expected sampling focus', 'Compile evidence pack: manifest in SharePoint', 'Management review 2026 held and recorded']);

      const hendra = await notificationsOf(db, 'tst', 'hendra', 'audit_date_changed');
      expect(hendra).toHaveLength(1);
      expect(hendra[0]!.body_en).toMatch(/^The audit date has changed\. \d+ of your items are now due after the audit\.$/);
      expect(hendra[0]!.body_id).toMatch(/^Tanggal audit berubah\. \d+ item Anda kini jatuh tempo setelah audit\.$/);
      const recipients = await rowsOf<{ n: number }>(db, 'tst', sql`select count(distinct recipient_user_id)::int as n from notification where kind = 'audit_date_changed'`);
      expect(recipients[0]!.n).toBe(response.body.count);
      expect(ctx.queue.waitingJobs('notifications.dispatch').length).toBeGreaterThan(0);
      expect((await auditOf(db, 'tst', event.id)).at(-1)).toMatchObject({
        action: 'audit_event.updated',
        before: expect.objectContaining({ scheduled_at: '2026-11-12' }),
        after: expect.objectContaining({ scheduled_at: '2026-10-25', holders_notified: response.body.count }),
      });

      // Moving it back clears the flags and notifies nobody new.
      const back = await rina.patch(`/api/v1/ms/isms/audit-events/${event.id}`, { scheduledAt: '2026-11-12' });
      expect(back.status).toBe(200);
      expect(back.body.count).toBe(0);
      expect(await rowsOf(db, 'tst', sql`select id from audit_prep_task where audit_event_id = ${event.id} and violates_br43`)).toEqual([]);
    });

    it('records the outcome; 412 for a stale If-Match, 404 for an unknown event, 400 for an empty patch', async () => {
      const event = await eventOf('Stage 2, certification');
      const ok = await rina.patch(`/api/v1/ms/isms/audit-events/${event.id}`, { outcome: 'recommended', outcomeSummary: 'Certified, 1 OFI' });
      expect(ok.status).toBe(200);
      expect(ok.body.count).toBe(0);
      expect((await rina.patch(`/api/v1/ms/isms/audit-events/${event.id}`, { outcomeSummary: 'x' }, { 'if-match': 'W/"1"' })).status).toBe(412);
      expect((await rina.patch('/api/v1/ms/isms/audit-events/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', { outcomeSummary: 'x' })).status).toBe(404);
      expect((await rina.patch(`/api/v1/ms/isms/audit-events/${event.id}`, {})).status).toBe(400);
    });
  });

  describe('preparation tasks', () => {
    it('adds a task before the audit (201) and refuses one on or after it (BR-43)', async () => {
      const event = await eventOf('Surveillance 1');
      const late = await rina.post(`/api/v1/ms/isms/audit-events/${event.id}/prep-tasks`, { title: 'Book the meeting room', ownerHandle: 'rina', dueAt: '2026-11-12' });
      expect(late.status).toBe(422);
      expect(late.body.rule).toBe('BR-43');
      const blockedWithoutNote = await rina.post(`/api/v1/ms/isms/audit-events/${event.id}/prep-tasks`, { title: 'Book the meeting room', ownerHandle: 'bagus', dueAt: '2026-11-02', status: 'blocked' });
      expect(blockedWithoutNote.status).toBe(400);
      const ok = await rina.post(`/api/v1/ms/isms/audit-events/${event.id}/prep-tasks`, { title: 'Book the meeting room', ownerHandle: 'bagus', dueAt: '2026-11-02' });
      expect(ok.status).toBe(201);
      expect((await snapshot()).PREP.at(-1)).toEqual(['Book the meeting room', 'bagus', '2026-11-02', 'open']);
      expect((await notificationsOf(db, 'tst', 'bagus', 'prep_task_assigned'))[0]).toMatchObject({ title_en: 'Preparation task assigned: Book the meeting room', digest: true });
      expect((await maya.post(`/api/v1/ms/isms/audit-events/${event.id}/prep-tasks`, { title: 'x', ownerHandle: 'maya', dueAt: '2026-11-02' })).status).toBe(403);
    });

    it('moves a task through C.13 by its owner (own grant), with a note for blocked; 409 for other pairs', async () => {
      const s = await snapshot();
      const own = refByCode(s, 'prep', 'Close NC-2025-02 with effectiveness verification');
      const blocked = await bagus.patch(`/api/v1/ms/isms/prep-tasks/${own.id}`, { status: 'blocked' });
      expect(blocked.status).toBe(400);
      const withNote = await bagus.patch(`/api/v1/ms/isms/prep-tasks/${own.id}`, { status: 'blocked', note: 'Waiting for the verifier' }, { 'if-match': own.etag! });
      expect(withNote.status).toBe(200);
      expect((await bagus.patch(`/api/v1/ms/isms/prep-tasks/${own.id}`, { status: 'done' })).status).toBe(409);
      expect((await bagus.patch(`/api/v1/ms/isms/prep-tasks/${own.id}`, { status: 'in_progress' })).status).toBe(200);
      expect((await bagus.patch(`/api/v1/ms/isms/prep-tasks/${own.id}`, { status: 'done' })).status).toBe(200);
      expect((await snapshot()).PREP.find((p) => p[0] === 'Close NC-2025-02 with effectiveness verification')![3]).toBe('done');
      const audit = await auditOf(db, 'tst', own.id);
      expect(audit.map((a) => a.after?.status).filter(Boolean)).toEqual(['blocked', 'in_progress', 'done']);

      const others = refByCode(s, 'prep', 'Approve SoA v3.0');
      expect((await bagus.patch(`/api/v1/ms/isms/prep-tasks/${others.id}`, { status: 'in_progress' })).status).toBe(403);
      expect((await bagus.patch(`/api/v1/ms/isms/prep-tasks/${others.id}`, { note: 'x' })).status).toBe(403);
      expect((await rina.patch(`/api/v1/ms/isms/prep-tasks/${others.id}`, { status: 'done' })).status).toBe(409);
      expect((await rina.patch(`/api/v1/ms/isms/prep-tasks/${others.id}`, { status: 'overdue' })).status).toBe(409);
    });

    it('checks BR-43 on a new due date, reassigns with a notification, and answers 412 and 404', async () => {
      const s = await snapshot();
      const task = refByCode(s, 'prep', 'Management review 2026 held and recorded');
      const late = await rina.patch(`/api/v1/ms/isms/prep-tasks/${task.id}`, { dueAt: '2026-11-20' });
      expect(late.status).toBe(422);
      expect(late.body.rule).toBe('BR-43');
      const ok = await rina.patch(`/api/v1/ms/isms/prep-tasks/${task.id}`, { dueAt: '2026-11-03', ownerHandle: 'maya' }, { 'if-match': task.etag! });
      expect(ok.status).toBe(200);
      expect((await snapshot()).PREP.find((p) => p[0] === 'Management review 2026 held and recorded')!.slice(1, 3)).toEqual(['maya', '2026-11-03']);
      expect(await notificationsOf(db, 'tst', 'maya', 'prep_task_assigned')).toHaveLength(1);
      expect((await rina.patch(`/api/v1/ms/isms/prep-tasks/${task.id}`, { dueAt: '2026-11-04' }, { 'if-match': task.etag! })).status).toBe(412);
      expect((await rina.patch('/api/v1/ms/isms/prep-tasks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', { dueAt: '2026-11-04' })).status).toBe(404);
    });
  });

  describe('cycle items', () => {
    it('updates status, note, owner and due date per C.13; own grants for Domain Owners and Internal Auditors', async () => {
      const s = await snapshot();
      const own = refByCode(s, 'cycle', '10.2');
      const blocked = await bagus.patch(`/api/v1/ms/isms/cycle-items/${own.id}`, { status: 'blocked', note: 'Verifier on leave' });
      expect(blocked.status).toBe(200);
      expect((await snapshot()).CYCLE_ITEMS.find((c) => c[0] === '10.2')!.slice(4)).toEqual(['open', 'Verifier on leave']);
      const audit = (await auditOf(db, 'tst', own.id)).at(-1);
      expect(audit).toMatchObject({ action: 'cycle_item.updated', actor: 'bagus', after: { status: 'blocked', condition_note: 'Verifier on leave' } });

      const ia = refByCode(s, 'cycle', '9.2');
      expect((await maya.patch(`/api/v1/ms/isms/cycle-items/${ia.id}`, { status: 'done' })).status).toBe(200);
      expect((await snapshot()).CYCLE_ITEMS.find((c) => c[0] === '9.2')![4]).toBe('done');

      const others = refByCode(s, 'cycle', '9.3');
      expect((await bagus.patch(`/api/v1/ms/isms/cycle-items/${others.id}`, { status: 'in_progress' })).status).toBe(403);
      expect((await rina.patch(`/api/v1/ms/isms/cycle-items/${others.id}`, { status: 'done' })).status).toBe(409);
      const moved = await rina.patch(`/api/v1/ms/isms/cycle-items/${others.id}`, { ownerHandle: 'rina', dueAt: '2026-10-29', note: '5 of 7 inputs prepared' });
      expect(moved.status).toBe(200);
      expect((await snapshot()).CYCLE_ITEMS.find((c) => c[0] === '9.3')).toEqual(['9.3', 'Management review with all mandatory inputs', 'rina', '2026-10-29', 'open', '5 of 7 inputs prepared']);
    });
  });

  it('leaves a verifiable audit chain', async () => {
    const chain = await verifyChain(db, 'tst');
    expect(chain.firstBroken).toBeNull();
  });
});
