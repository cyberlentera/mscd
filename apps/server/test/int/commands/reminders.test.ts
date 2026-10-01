// Reminders (build plan D.3, E.5, K.2 WP-35): a reminder by record key and by ref writes a `reminder` row, an
// in-app notification with the E.5 text and a `notifications.dispatch` job in the same transaction, and an audit
// entry; BR-50 holds a second reminder to the same person about the same item within 72 hours (422 with
// `retryAfter`); a record of another system gives 404; a recipient outside the organisation gives NOT-A-MEMBER;
// bulk reminders count the holders of open chain items and list what BR-50 skipped; and the audit chain verifies.
import { BulkReminderResult, CommandResult, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditOf, createApp, notificationsOf, rowsOf, sessionFor, verifyChain, type Client, type CommandsApp } from './helpers';

describe('reminders', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let rinaNdt: Client;

  beforeAll(async () => {
    ctx = await createApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const snapshot = async (client: Client = rina, ms = 'isms') => (await client.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`)).body;
  const remindersOf = (handle: string, key: string) =>
    rowsOf<{ id: string; notification_id: string | null; sent_by: string }>(db, 'tst', sql`
      select r.id, r.notification_id, s.handle as sent_by from reminder r join platform.app_user u on u.id = r.recipient_user_id
        join platform.app_user s on s.id = r.sent_by_user_id where u.handle = ${handle} and r.record_key = ${key}`);

  it('sends a reminder by record key: reminder row, notification with the E.5 text, dispatch job, audit entry', async () => {
    const dispatched = ctx.queue.waitingJobs('notifications.dispatch').length;
    const response = await rina.post('/api/v1/reminders', { ms: 'isms', recordKey: 'isms:x:R-022', recipient: 'hendra' });
    expect(response.status).toBe(200);
    expect(CommandResult.safeParse(response.body).success).toBe(true);
    expect(response.body).toMatchObject({ changed: [], count: 1, message: ['Reminder sent to Hendra Wijaya, email + in-app', expect.any(String)] });
    const rows = await remindersOf('hendra', 'isms:x:R-022');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_by).toBe('rina');
    const [notification] = await notificationsOf(db, 'tst', 'hendra', 'reminder');
    expect(notification!.id).toBe(rows[0]!.notification_id);
    const item = (await snapshot()).bundle.chain.items.find((i) => i.key === 'isms:x:R-022')!;
    expect(notification!.body_en).toBe(`Reminder: ${item.act[0]} for ${item.title[0]}, due 30 Oct 2026`);
    expect(notification!.digest).toBe(false);
    expect(ctx.queue.waitingJobs('notifications.dispatch').length).toBe(dispatched + 1);
    const ref = (await snapshot()).refs['isms:x:R-022']!;
    expect((await auditOf(db, 'tst', ref.id)).at(-1)).toMatchObject({ action: 'reminder.sent', actor: 'rina', after: { recipient: 'hendra', record_key: 'isms:x:R-022' } });
  });

  it('holds a second reminder to the same person about the same item within 72 hours (BR-50)', async () => {
    const response = await maya.post('/api/v1/reminders', { ms: 'isms', recordKey: 'isms:x:R-022', recipient: 'hendra' });
    expect(response.status).toBe(422);
    expect(response.body.rule).toBe('BR-50');
    expect(response.body.retryAfter).toBeGreaterThan(71 * 3600);
    expect(response.body.retryAfter).toBeLessThanOrEqual(72 * 3600);
    expect(response.body.messages!.en).toMatch(/^The last reminder was sent at \d{2} \w{3} \d{4} \d{2}:\d{2}\. Try again after \d{2} \w{3} \d{4} \d{2}:\d{2}\.$/);
    expect(await remindersOf('hendra', 'isms:x:R-022')).toHaveLength(1);
    // Another recipient, or the same recipient about another item, is not held.
    expect((await maya.post('/api/v1/reminders', { ms: 'isms', recordKey: 'isms:x:R-022', recipient: 'rina' })).status).toBe(200);
  });

  it('sends a reminder by ref, resolved in the system of the body', async () => {
    const s = await snapshot();
    const ref = s.refs['isms:doc:PRC-07']!;
    const response = await rina.post('/api/v1/reminders', { ms: 'isms', ref: { module: ref.module, entityType: 'document', id: ref.id, code: 'PRC-07' }, recipient: 'bagus' });
    expect(response.status).toBe(200);
    expect(await remindersOf('bagus', 'isms:doc:PRC-07')).toHaveLength(1);
    const [notification] = await notificationsOf(db, 'tst', 'bagus', 'reminder');
    expect(notification!.body_en).toMatch(/^Reminder: Start review: .+ for .+, v.+, due \d{2} \w{3} \d{4}$/);
  });

  it('answers 404 for a record of another system or organisation and for an unknown key', async () => {
    const qms = await snapshot(rinaNdt, 'qms');
    const doc = qms.bundle.docs.find((d) => !d.shared)!;
    const ref = qms.refs[`qms:doc:${doc.id}`]!;
    const otherSystem = await rinaNdt.post('/api/v1/reminders', { ms: 'isms', ref: { module: ref.module, entityType: 'document', id: ref.id, code: doc.id }, recipient: 'rina' });
    expect(otherSystem.status).toBe(404);
    expect((await rinaNdt.post('/api/v1/reminders', { ms: 'isms', recordKey: `qms:doc:${doc.id}`, recipient: 'rina' })).status).toBe(404);
    expect((await rina.post('/api/v1/reminders', { ms: 'isms', ref: { module: ref.module, entityType: 'document', id: ref.id, code: doc.id }, recipient: 'rina' })).status).toBe(404);
    expect((await rina.post('/api/v1/reminders', { ms: 'isms', recordKey: 'isms:x:R-999', recipient: 'rina' })).status).toBe(404);
    expect((await rina.post('/api/v1/reminders', { ms: 'qms', recordKey: 'qms:x:R-022', recipient: 'rina' })).status).toBe(404);
  });

  it('answers NOT-A-MEMBER for a recipient outside the organisation and 403 for a Domain Owner', async () => {
    const stranger = await rina.post('/api/v1/reminders', { ms: 'isms', recordKey: 'isms:x:R-027', recipient: 'staff01' });
    expect(stranger.status).toBe(422);
    expect(stranger.body.rule).toBe('NOT-A-MEMBER');
    expect((await bagus.post('/api/v1/reminders', { ms: 'isms', recordKey: 'isms:x:R-027', recipient: 'dewi' })).status).toBe(403);
  });

  it('reminds every holder of an open chain item once, skips what BR-50 holds, and counts holders', async () => {
    const s = await snapshot();
    const holders = new Set(s.bundle.chain.items.map((i) => i.h).filter((h) => h !== 'none'));
    const response = await rina.post('/api/v1/reminders/bulk', { ms: 'isms', scope: 'open_chain_items' });
    expect(response.status).toBe(200);
    expect(BulkReminderResult.safeParse(response.body).success).toBe(true);
    const result = response.body as unknown as BulkReminderResult;
    // Hendra still has other open items; only R-022 and PRC-07 were reminded in the last 72 hours.
    expect(result.count).toBe(holders.size);
    expect(result.message).toEqual([`Reminders sent to ${holders.size} holders`, `Pengingat dikirim ke ${holders.size} pemegang`]);
    expect(result.data.skipped.map((x) => `${x.recipient} ${x.recordKey}`).sort()).toEqual(['bagus isms:doc:PRC-07', 'hendra isms:x:R-022']);
    const notified = await rowsOf<{ n: number }>(db, 'tst', sql`
      select count(distinct recipient_user_id)::int as n from reminder where bulk_id is not null and notification_id is not null`);
    expect(notified[0]!.n).toBe(holders.size);

    const again = await rina.post('/api/v1/reminders/bulk', { ms: 'isms', scope: 'open_chain_items' });
    expect(again.status).toBe(200);
    const second = again.body as unknown as BulkReminderResult;
    expect(second.count).toBe(0);
    expect(second.data.skipped.length).toBe(s.bundle.chain.items.filter((i) => i.h !== 'none' && s.refs[i.key]).length);
    expect((await bagus.post('/api/v1/reminders/bulk', { ms: 'isms', scope: 'open_chain_items' })).status).toBe(403);
  });

  it('leaves a verifiable audit chain', async () => {
    expect((await verifyChain(db, 'tst')).firstBroken).toBeNull();
  });
});
