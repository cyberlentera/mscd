// Notifications (build plan E.6, D.3, E.2; WP-24) on the demo template with a Mailpit container:
// - the in-app routes: the recipient's rows only, newest first, the unread filter, marking read (404 for others);
// - `notifications.dispatch`: one email per notification with subject `[MSCD] <title>`, the recipient's language and
//   a link into the app; failures counted until `failed` after five attempts; non-members skipped; the sweep;
// - `notifications.digest`: one email per user with the previous day's digest rows;
// - `documents.review-alerts`: the 60, 30, 14 and 7 day tiers with a mocked clock, once per tier.
import { randomUUID } from 'node:crypto';
import type { Notification, Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/common/dates';
import { MAX_EMAIL_ATTEMPTS } from '../../../src/modules/notifications/notification-delivery.service';
import { inScope } from '../db/helpers';
import { inOrg, signIn, userId, type FilesClient } from '../files/helpers';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { useTestDatabase } from '../../setup/test-db';
import { createWp24App, ORG_IDS, type Wp24App } from './helpers';

const PUBLIC_URL = 'http://localhost:4174';

describe('notifications (E.6)', () => {
  const db = useTestDatabase('demo');
  let mail: Mailpit;
  let ctx: Wp24App;
  let rina: FilesClient;
  let bagus: FilesClient;
  let ids: Record<string, string>;
  let emails: Record<string, string>;

  const pairs = (en: string, id: string) => ({ en, id });

  beforeAll(async () => {
    mail = await startMailpit();
    ctx = await createWp24App(db, { mail });
    rina = await signIn(ctx, db, 'rina', 'tst');
    bagus = await signIn(ctx, db, 'bagus', 'tst');
    ids = {};
    emails = {};
    for (const handle of ['rina', 'bagus', 'maya', 'hendra']) {
      ids[handle] = await userId(db, handle);
      const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.selectFrom('platform.app_user').select('email').where('handle', '=', handle).executeTakeFirstOrThrow(),
      );
      emails[handle] = row.email;
    }
    // Bagus reads MSCD in Indonesian (E.6: the recipient's language preference).
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.user_preference').values({ user_id: ids.bagus!, key: 'lang', value: JSON.stringify('id') }).execute(),
    );
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
    await mail?.stop();
  });

  it('lists the session user\'s notifications only, newest first, with the unread filter, and marks them read', async () => {
    const isms = await inOrg(db, 'tst', (trx) => trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow());
    const first = await ctx.notify('tst', {
      recipientUserId: ids.rina!,
      kind: 'task_overdue',
      msId: isms.id,
      title: pairs('Task overdue: first', 'Tugas terlambat: pertama'),
      body: pairs('First body', 'Isi pertama'),
      ref: { module: 'audit', entityType: 'audit_prep_task', id: randomUUID(), code: 'PREP-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await ctx.notify('tst', { recipientUserId: ids.rina!, kind: 'reminder', title: pairs('Reminder: second', 'Pengingat: kedua'), body: pairs('Second', 'Kedua') });
    const other = await ctx.notify('tst', { recipientUserId: ids.bagus!, kind: 'reminder', title: pairs('For Bagus', 'Untuk Bagus'), body: pairs('B', 'B') });
    expect(first && second && other).toBeTruthy();

    const listed = await rina.get<Page<Notification>>('/api/v1/notifications');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((n) => n.id)).toEqual([second, first]);
    expect(listed.body.total).toBe(2);
    const firstItem = listed.body.items[1]!;
    expect(firstItem).toMatchObject({ kind: 'task_overdue', title: ['Task overdue: first', 'Tugas terlambat: pertama'], ms: 'isms', readAt: null });
    expect(firstItem.ref).toMatchObject({ entityType: 'audit_prep_task', code: 'PREP-1' });
    expect(listed.body.items[0]!.ms).toBeUndefined();

    const paged = await rina.get<Page<Notification>>('/api/v1/notifications?pageSize=1&page=2');
    expect(paged.body.items.map((n) => n.id)).toEqual([first]);
    expect(paged.body.total).toBe(2);

    // Another user's notification is not found; the recipient marks hers read (twice is fine, the time stays).
    expect((await rina.post(`/api/v1/notifications/${other}/read`, {})).status).toBe(404);
    expect((await rina.post(`/api/v1/notifications/${randomUUID()}/read`, {})).status).toBe(404);
    expect((await rina.post(`/api/v1/notifications/${first}/read`, {})).status).toBe(204);
    const readAt = (await rina.get<Page<Notification>>('/api/v1/notifications')).body.items.find((n) => n.id === first)!.readAt;
    expect(readAt).toBeTruthy();
    expect((await rina.post(`/api/v1/notifications/${first}/read`, {})).status).toBe(204);
    expect((await rina.get<Page<Notification>>('/api/v1/notifications')).body.items.find((n) => n.id === first)!.readAt).toBe(readAt);

    const unread = await rina.get<Page<Notification>>('/api/v1/notifications?unread=true');
    expect(unread.body.items.map((n) => n.id)).toEqual([second]);
    expect((await bagus.get<Page<Notification>>('/api/v1/notifications')).body.items.map((n) => n.id)).toEqual([other]);
    expect((await rina.get('/api/v1/notifications?unread=yes')).status).toBe(400);
  });

  it('dispatch sends one email per notification: subject, the recipient\'s language and a link into the app', async () => {
    await mail.clear();
    const forRina = await ctx.notify('tst', {
      recipientUserId: ids.rina!,
      kind: 'document_expired',
      title: pairs('Document expired: PRC-07 Access Control Procedure', 'Dokumen kedaluwarsa: PRC-07 Prosedur Kontrol Akses'),
      body: pairs('The review date has passed.', 'Tanggal tinjauan telah lewat.'),
    });
    const forBagus = await ctx.notify('tst', {
      recipientUserId: ids.bagus!,
      kind: 'task_overdue',
      title: pairs('Task overdue: Backup restore test', 'Tugas terlambat: Uji pemulihan cadangan'),
      body: pairs('The task is past its due date.', 'Tugas telah melewati tanggal jatuh tempo.'),
    });
    const digestOnly = await ctx.notify('tst', { recipientUserId: ids.rina!, kind: 'drift_detected', digest: true, title: pairs('Drift found', 'Drift ditemukan'), body: pairs('d', 'd') });

    // The writer queued one dispatch per non-digest notification; the job sends exactly the named rows.
    await ctx.dispatchJob.handle({ id: 'job-1', name: 'notifications.dispatch', attempt: 1, env: { orgId: ORG_IDS.tst, payload: { notificationIds: [forRina!, forBagus!, digestOnly!] } } });

    const toRina = await mail.waitFor(emails.rina!, (m) => m.subject.includes('PRC-07'));
    expect(toRina.subject).toBe('[MSCD] Document expired: PRC-07 Access Control Procedure');
    expect(toRina.text).toContain('The review date has passed.');
    expect(toRina.text).toContain(`Open MSCD: ${PUBLIC_URL}/`);
    expect(toRina.mailKind).toBe('notification:document_expired');

    const toBagus = await mail.waitFor(emails.bagus!, (m) => m.subject.includes('Uji pemulihan'));
    expect(toBagus.subject).toBe('[MSCD] Tugas terlambat: Uji pemulihan cadangan');
    expect(toBagus.text).toContain('Tugas telah melewati tanggal jatuh tempo.');
    expect(toBagus.text).toContain(`Buka MSCD: ${PUBLIC_URL}/`);

    const rows = await inOrg(db, 'tst', (trx) =>
      trx.selectFrom('notification').select(['id', 'email_status', 'email_attempts', 'email_sent_at']).where('id', 'in', [forRina!, forBagus!, digestOnly!]).execute(),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(forRina!)).toMatchObject({ email_status: 'sent', email_attempts: 1 });
    expect(byId.get(forBagus!)!.email_status).toBe('sent');
    expect(byId.get(digestOnly!)).toMatchObject({ email_status: 'pending', email_attempts: 0 });

    // A second run finds nothing to send.
    const again = await ctx.delivery.dispatch(ORG_IDS.tst, [forRina!, forBagus!]);
    expect(again.sent).toBe(0);
    expect((await mail.messages(emails.rina!)).filter((m) => m.subject.includes('PRC-07'))).toHaveLength(1);
  });

  it('the export link of export_ready points at the download', async () => {
    await mail.clear();
    const taskId = randomUUID();
    const id = await ctx.notify('tst', {
      recipientUserId: ids.rina!,
      kind: 'export_ready',
      title: pairs('Export ready: Readiness report', 'Ekspor siap: Laporan kesiapan'),
      body: pairs('ISMS-readiness-report.pdf is ready.', 'ISMS-readiness-report.pdf siap.'),
      ref: { module: 'admin', entityType: 'background_task', id: taskId, code: 'ISMS-readiness-report.pdf' },
    });
    await ctx.delivery.dispatch(ORG_IDS.tst, [id!]);
    const message = await mail.waitFor(emails.rina!, (m) => m.subject.includes('Export ready'));
    expect(message.text).toContain(`${PUBLIC_URL}/api/v1/exports/${taskId}/download`);
  });

  it('the sweep without an organisation sends what is pending in every organisation; non-members are skipped', async () => {
    await mail.clear();
    const inNdt = await ctx.notify('ndt', { recipientUserId: ids.maya!, kind: 'reminder', title: pairs('Reminder: ndt sweep', 'Pengingat: ndt'), body: pairs('x', 'x') });
    const inTst = await ctx.notify('tst', { recipientUserId: ids.hendra!, kind: 'reminder', title: pairs('Reminder: tst sweep', 'Pengingat: tst'), body: pairs('x', 'x') });
    // Hendra leaves tst before the email goes out: the row is skipped, not sent.
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.org_membership').set({ status: 'disabled' }).where('user_id', '=', ids.hendra!).where('organization_id', '=', ORG_IDS.tst).execute(),
    );
    await ctx.dispatchJob.handle({ id: 'job-sweep', name: 'notifications.dispatch', attempt: 1, env: { orgId: null, payload: {} } });
    await mail.waitFor(emails.maya!, (m) => m.subject === '[MSCD] Reminder: ndt sweep');
    const ndtRow = await inOrg(db, 'ndt', (trx) => trx.selectFrom('notification').select('email_status').where('id', '=', inNdt!).executeTakeFirstOrThrow());
    expect(ndtRow.email_status).toBe('sent');
    const tstRow = await inOrg(db, 'tst', (trx) => trx.selectFrom('notification').select('email_status').where('id', '=', inTst!).executeTakeFirstOrThrow());
    expect(tstRow.email_status).toBe('skipped');
    expect((await mail.messages(emails.hendra!)).filter((m) => m.subject.includes('tst sweep'))).toHaveLength(0);
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.org_membership').set({ status: 'active' }).where('user_id', '=', ids.hendra!).where('organization_id', '=', ORG_IDS.tst).execute(),
    );
  });

  it('a failed send counts attempts, the job retries, and the fifth failure gives up', async () => {
    const offline = await createWp24App(db);
    try {
      const id = await offline.notify('tst', { recipientUserId: ids.rina!, kind: 'reminder', title: pairs('Reminder: offline', 'Pengingat: offline'), body: pairs('x', 'x') });
      const job = { id: 'job-fail', name: 'notifications.dispatch' as const, attempt: 1, env: { orgId: ORG_IDS.tst, payload: { notificationIds: [id!] } } };
      await expect(offline.dispatchJob.handle(job)).rejects.toThrow(/could not be sent/);
      let row = await inOrg(db, 'tst', (trx) => trx.selectFrom('notification').select(['email_status', 'email_attempts', 'last_error']).where('id', '=', id!).executeTakeFirstOrThrow());
      expect(row).toMatchObject({ email_status: 'pending', email_attempts: 1 });
      expect(row.last_error).toBeTruthy();
      for (let attempt = 2; attempt < MAX_EMAIL_ATTEMPTS; attempt += 1) await expect(offline.dispatchJob.handle({ ...job, attempt })).rejects.toThrow();
      // The fifth failure is final: the row is failed and the job no longer asks for a retry.
      await offline.dispatchJob.handle({ ...job, attempt: MAX_EMAIL_ATTEMPTS });
      row = await inOrg(db, 'tst', (trx) => trx.selectFrom('notification').select(['email_status', 'email_attempts', 'last_error']).where('id', '=', id!).executeTakeFirstOrThrow());
      expect(row).toMatchObject({ email_status: 'failed', email_attempts: MAX_EMAIL_ATTEMPTS });
      // Failed rows are not picked up again, not even by the sweep of a working mailer.
      expect((await ctx.delivery.dispatch(ORG_IDS.tst, [id!])).sent).toBe(0);
    } finally {
      await offline.close();
    }
  });

  it('notifications.digest sends one email per user with the previous day\'s digest rows', async () => {
    await mail.clear();
    const a = await ctx.notify('tst', { recipientUserId: ids.maya!, kind: 'evidence_aging', digest: true, title: pairs('Evidence ageing: EV-0101', 'Bukti menua: EV-0101'), body: pairs('Ageing one', 'Menua satu') });
    const b = await ctx.notify('tst', { recipientUserId: ids.maya!, kind: 'drift_detected', digest: true, title: pairs('Drift: stale risk R-014', 'Drift: risiko R-014'), body: pairs('Drift body', 'Isi drift') });
    const c = await ctx.notify('tst', { recipientUserId: ids.bagus!, kind: 'evidence_aging', digest: true, title: pairs('Evidence ageing: EV-0202', 'Bukti menua: EV-0202'), body: pairs('Ageing two', 'Menua dua') });

    // Rows created today wait for tomorrow's digest.
    ctx.clock.setNow(new Date());
    const today = await ctx.digestJob.handle({ id: 'job-dg-0', name: 'notifications.digest', attempt: 1, env: { orgId: ORG_IDS.tst, payload: {} } });
    expect(today).toBeUndefined();
    expect(await mail.messages(emails.maya!)).toHaveLength(0);

    ctx.clock.setNow(new Date(Date.now() + 86_400_000));
    await ctx.digestJob.handle({ id: 'job-dg-1', name: 'notifications.digest', attempt: 1, env: { orgId: ORG_IDS.tst, payload: {} } });
    const toMaya = await mail.waitFor(emails.maya!, (m) => m.subject.startsWith('[MSCD] Daily digest'));
    expect(toMaya.subject).toBe('[MSCD] Daily digest: 2 notifications');
    expect(toMaya.text).toContain('Evidence ageing: EV-0101');
    expect(toMaya.text).toContain('Drift: stale risk R-014');
    expect(toMaya.mailKind).toBe('notification:digest');
    const toBagus = await mail.waitFor(emails.bagus!, (m) => m.subject.startsWith('[MSCD] Ringkasan'));
    expect(toBagus.subject).toBe('[MSCD] Ringkasan harian: 1 notifikasi');
    expect(toBagus.text).toContain('Menua dua');

    const rows = await inOrg(db, 'tst', (trx) => trx.selectFrom('notification').select(['id', 'email_status']).where('id', 'in', [a!, b!, c!]).execute());
    expect(rows.every((r) => r.email_status === 'sent')).toBe(true);
    // A second run sends nothing more.
    await ctx.digestJob.handle({ id: 'job-dg-2', name: 'notifications.digest', attempt: 1, env: { orgId: ORG_IDS.tst, payload: {} } });
    expect((await mail.messages(emails.maya!)).filter((m) => m.subject.startsWith('[MSCD] Daily digest'))).toHaveLength(1);
    ctx.clock.setNow(new Date());
  });

  it('documents.review-alerts raises the 60, 30, 14 and 7 day tiers once each, with a mocked clock', async () => {
    await mail.clear();
    const today = '2027-03-01';
    ctx.clock.setToday(today);
    const docs = await inOrg(db, 'tst', (trx) =>
      trx.selectFrom('document').select(['id', 'doc_code']).where('deleted_at', 'is', null).orderBy('doc_code').limit(6).execute(),
    );
    const [d60, d30, d14, d7, d10, dOther] = docs;
    const due: [typeof d60, number][] = [
      [d60, 60],
      [d30, 30],
      [d14, 14],
      [d7, 7],
      [d10, 10],
    ];
    await inOrg(db, 'tst', async (trx) => {
      // Every other document is far from any tier.
      await trx.updateTable('document').set({ next_review_at: '2031-01-01' }).where('deleted_at', 'is', null).execute();
      for (const [doc, days] of due) {
        await trx.updateTable('document').set({ status: 'approved', next_review_at: addDays(today, days), owner_user_id: ids.bagus! }).where('id', '=', doc!.id).execute();
      }
      // A draft due in 7 days gets no alert.
      await trx.updateTable('document').set({ status: 'draft', next_review_at: addDays(today, 7), owner_user_id: ids.bagus! }).where('id', '=', dOther!.id).execute();
    });

    await ctx.alertsJob.handle({ id: 'job-dra-1', name: 'documents.review-alerts', attempt: 1, env: { orgId: ORG_IDS.tst, payload: {} } });
    let rows = await inOrg(db, 'tst', async (trx) => (await sql<{ code: string; title_en: string; digest: boolean; recipient_user_id: string; id: string }>`
      select entity_ref->>'code' as code, title_en, digest, recipient_user_id, id from notification where kind = 'document_review_due' order by title_en`.execute(trx)).rows);
    expect(rows).toHaveLength(4);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get(d60!.doc_code)).toMatchObject({ digest: true, recipient_user_id: ids.bagus });
    expect(byCode.get(d60!.doc_code)!.title_en).toBe(`Review of ${d60!.doc_code} due in 60 days (30 Apr 2027)`);
    expect(byCode.get(d30!.doc_code)!.digest).toBe(true);
    expect(byCode.get(d14!.doc_code)!.digest).toBe(false);
    expect(byCode.get(d7!.doc_code)!.digest).toBe(false);
    expect(byCode.has(d10!.doc_code)).toBe(false);
    expect(byCode.has(dOther!.doc_code)).toBe(false);

    // The same day again (a retry): nothing new.
    await ctx.alertsJob.handle({ id: 'job-dra-2', name: 'documents.review-alerts', attempt: 2, env: { orgId: ORG_IDS.tst, payload: {} } });
    rows = await inOrg(db, 'tst', async (trx) => (await sql<{ code: string; title_en: string; digest: boolean; recipient_user_id: string; id: string }>`
      select entity_ref->>'code' as code, title_en, digest, recipient_user_id, id from notification where kind = 'document_review_due' order by title_en`.execute(trx)).rows);
    expect(rows).toHaveLength(4);

    // 23 days later the 30 day document is 7 days away: its 7 day alert is raised, the others wait.
    ctx.clock.setToday(addDays(today, 23));
    await ctx.alertsJob.handle({ id: 'job-dra-3', name: 'documents.review-alerts', attempt: 1, env: { orgId: ORG_IDS.tst, payload: {} } });
    rows = await inOrg(db, 'tst', async (trx) => (await sql<{ code: string; title_en: string; digest: boolean; recipient_user_id: string; id: string }>`
      select entity_ref->>'code' as code, title_en, digest, recipient_user_id, id from notification where kind = 'document_review_due' order by title_en`.execute(trx)).rows);
    expect(rows).toHaveLength(5);
    const second = rows.filter((r) => r.code === d30!.doc_code).map((r) => r.title_en).sort();
    expect(second).toEqual([`Review of ${d30!.doc_code} due in 30 days (31 Mar 2027)`, `Review of ${d30!.doc_code} due in 7 days (31 Mar 2027)`]);

    // The 14 and 7 day tiers are emailed at once; the 60 and 30 day ones wait for the digest.
    const immediate = rows.filter((r) => !r.digest).map((r) => r.id);
    expect(immediate).toHaveLength(3);
    await ctx.delivery.dispatch(ORG_IDS.tst, immediate);
    const message = await mail.waitFor(emails.bagus!, (m) => m.subject.includes(d14!.doc_code));
    // Bagus reads Indonesian.
    expect(message.subject).toBe(`[MSCD] Tinjauan ${d14!.doc_code} jatuh tempo dalam 14 hari (15 Mar 2027)`);
    expect(message.text).toContain(`${PUBLIC_URL}/`);
    ctx.clock.setToday('2026-09-29');
  });
});
