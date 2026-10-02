// Findings and corrective actions (build plan D.3 "Registers and workflows: audit side", C.13 `finding.status` and
// `corrective_action.status`, BR-06, BR-07, BR-08, BR-09, WP-37) on the `tst` ISMS: a major and a minor finding of
// one joint audit event closed by one corrective action; closing without RCA or systemic check (BR-06, BR-07) and
// without a verified corrective action (BR-08) rejected; the step machine with its texts and own grants; a
// verification by the implementer or the owner (BR-09) or on the implementation day (BR-08) rejected at the API and
// at the database; an ineffective verification returning to the action step; OFI closing with a note; reopening;
// lists, permissions, If-Match and the audit chain.
import { CorrectiveActionItem, FindingItem, pageOf, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, CA, CAS, createAuditApp, FINDING, FINDINGS, inOrg, rowsOf, sessionFor, TODAY, verifyChain, type AuditApp, type Client, type Reply,
} from './helpers';

describe('findings and corrective actions', () => {
  const db = useTestDatabase('demo');
  let ctx: AuditApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let hendra: Client;
  let eventId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createAuditApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    const [event] = await rowsOf<{ id: string }>(
      db,
      'tst',
      sql`select e.id from audit_event e join management_system m on m.id = e.management_system_id and m.slug = 'isms'
           where e.scheduled_at < ${TODAY}::date order by e.scheduled_at desc limit 1`,
    );
    eventId = event!.id;
  });
  afterAll(async () => {
    ctx?.setToday(null);
    await ctx?.close();
  });

  const transition = (client: Client, url: string, body: Record<string, unknown>) => client.post(`${url}/transitions`, body);
  const findingRow = async (id: string) =>
    (await rowsOf<Record<string, unknown>>(db, 'tst', sql`select * from finding where id = ${id}`))[0]!;
  const actionRow = async (id: string) =>
    (await rowsOf<Record<string, unknown>>(db, 'tst', sql`select * from corrective_action where id = ${id}`))[0]!;

  it('raises findings of one audit event (finding.raise) and lists them with their event', async () => {
    const major = await rina.post(FINDINGS('isms'), {
      code: 'JA-2026-01', title: 'Privileged access not reviewed', classification: 'major', clauseRef: 'A.5.18', source: 'certification_audit',
      auditEventId: eventId, ownerHandle: 'bagus', dueAt: '2026-11-30',
    });
    expect(major.status).toBe(201);
    expect(major.body).toMatchObject({ ok: true, changed: ['isms'], ref: { module: 'audit', entityType: 'finding', code: 'JA-2026-01' } });
    ids.major = major.body.ref!.id;
    // An Internal Auditor raises findings too.
    const minor = await maya.post(FINDINGS('isms'), {
      code: 'JA-2026-02', title: 'Access review evidence incomplete', classification: 'minor', source: 'certification_audit', auditEventId: eventId, ownerHandle: 'bagus',
    });
    expect(minor.status).toBe(201);
    ids.minor = minor.body.ref!.id;
    const ofi = await rina.post(FINDINGS('isms'), { code: 'JA-2026-03', title: 'Automate the review reminders', classification: 'ofi', source: 'internal_audit', ownerHandle: 'rina' });
    expect(ofi.status).toBe(201);
    ids.ofi = ofi.body.ref!.id;

    expect((await rina.post(FINDINGS('isms'), { code: 'JA-2026-01', title: 'Again', classification: 'minor', source: 'other', ownerHandle: 'bagus' })).status).toBe(409);
    expect((await bagus.post(FINDINGS('isms'), { code: 'JA-2026-09', title: 'Not allowed', classification: 'minor', source: 'other', ownerHandle: 'bagus' })).status).toBe(403);
    expect((await rina.post(FINDINGS('isms'), { code: 'JA-2026-09', title: 'Unknown event', classification: 'minor', source: 'other', ownerHandle: 'bagus', auditEventId: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);
    expect((await rina.post(FINDINGS('isms'), { code: 'JA-2026-09', title: 'Unknown owner', classification: 'minor', source: 'other', ownerHandle: 'sari' })).body).toMatchObject({ status: 422, rule: 'NOT-A-MEMBER' });

    const row = await findingRow(ids.major);
    expect(row).toMatchObject({ status: 'open', raised_at: TODAY, source: 'certification_audit', audit_event_id: eventId });
    expect(await auditOf(db, 'tst', ids.major)).toEqual([expect.objectContaining({ action: 'finding.created', actor: 'rina' })]);

    const page = await hendra.get<Page<FindingItem>>(`${FINDINGS('isms')}?classification=major&q=privileged`);
    expect(page.status).toBe(200);
    expect(pageOf(FindingItem).safeParse(page.body).success).toBe(true);
    expect(page.body.items).toEqual([
      expect.objectContaining({ code: 'JA-2026-01', classification: 'major', owner: 'bagus', status: 'open', auditEvent: expect.objectContaining({ id: eventId }), correctiveActions: [] }),
    ]);
    // A Domain Owner sees only the findings they own.
    const own = await bagus.get<Page<FindingItem>>(FINDINGS('isms'));
    expect(own.body.items.every((f) => f.owner === 'bagus')).toBe(true);
    expect(own.body.items.map((f) => f.code)).toEqual(expect.arrayContaining(['JA-2026-01', 'JA-2026-02']));
  });

  it('rejects closing a major finding without RCA (BR-06), systemic check (BR-07) or a verified corrective action (BR-08)', async () => {
    const url = FINDING('isms', ids.major!);
    expect((await transition(rina, url, { to: 'closed' })).body).toMatchObject({ status: 422, rule: 'BR-06' });
    expect((await rina.patch(url, { rcaText: 'Review task had no owner after the reorganisation' })).status).toBe(200);
    expect((await transition(rina, url, { to: 'closed' })).body).toMatchObject({ status: 422, rule: 'BR-07' });
    const patched = await rina.patch(url, { systemicCheckText: 'All privileged groups of every platform checked' });
    expect(patched.status).toBe(200);
    // A stale If-Match is 412; the current ETag works.
    expect((await rina.patch(url, { title: 'Privileged access not reviewed in Q2' }, { 'if-match': 'W/"1"' })).status).toBe(412);
    expect((await rina.patch(url, { title: 'Privileged access not reviewed in Q2' }, { 'if-match': patched.body.ref!.etag! })).status).toBe(200);
    expect((await transition(rina, url, { to: 'closed' })).body).toMatchObject({ status: 422, rule: 'BR-08' });
    // The minor finding needs a verified corrective action too (BR-08); RCA is not required for it.
    expect((await transition(rina, FINDING('isms', ids.minor!), { to: 'closed' })).body).toMatchObject({ status: 422, rule: 'BR-08' });
    // Only finding.manage moves findings: the Internal Auditor raises but does not manage them.
    expect((await transition(maya, url, { to: 'in_progress' })).status).toBe(403);
    expect((await transition(rina, url, { to: 'in_progress' })).status).toBe(200);
    expect((await transition(rina, url, { to: 'open' })).status).toBe(400);
    // The database refuses a closed major finding without its texts (BR-06 and BR-07 backstop).
    await expect(
      inOrg(db, 'tst', (trx) => sql`update finding set status = 'closed', closed_at = ${TODAY}::date, rca_text = null where id = ${ids.major}`.execute(trx)),
    ).rejects.toThrow(/check constraint/);
  });

  it('creates one corrective action for both findings and walks its steps with texts and own grants', async () => {
    const created = await rina.post(CAS('isms'), { findingIds: [ids.major, ids.minor], code: 'CA-JA-01', title: 'Quarterly privileged access review', ownerHandle: 'bagus', dueAt: '2026-11-15' });
    expect(created.status).toBe(201);
    ids.action = created.body.ref!.id;
    expect(created.body.data).toMatchObject({ findings: [expect.objectContaining({ code: 'JA-2026-01' }), expect.objectContaining({ code: 'JA-2026-02' })] });
    expect((await rina.post(CAS('isms'), { findingIds: ['00000000-0000-4000-8000-000000000999'], code: 'CA-JA-09', title: 'x', ownerHandle: 'bagus' })).status).toBe(404);
    expect((await rina.post(CAS('isms'), { findingIds: [ids.major], code: 'CA-JA-01', title: 'Duplicate', ownerHandle: 'bagus' })).status).toBe(409);
    expect((await bagus.post(CAS('isms'), { findingIds: [ids.major], code: 'CA-JA-09', title: 'x', ownerHandle: 'bagus' })).status).toBe(403);

    const url = CA('isms', ids.action);
    // Each step needs its text; steps cannot be skipped.
    expect((await transition(bagus, url, { to: 'rca' })).status).toBe(400);
    expect((await transition(bagus, url, { to: 'action', text: 'skip' })).status).toBe(409);
    // The owner (Domain Owner, own grant) moves the steps; another Domain Owner cannot.
    const other = await sessionFor(ctx, db, 'mfa.tester', 'tst');
    expect((await transition(other, url, { to: 'rca', text: 'Revoked the stale accounts' })).status).toBe(403);
    expect((await transition(bagus, url, { to: 'rca', text: 'Revoked the stale accounts' })).status).toBe(200);
    expect((await transition(bagus, url, { to: 'systemic_check', text: 'No owner for the review task' })).status).toBe(200);
    expect((await transition(bagus, url, { to: 'action', text: 'Checked every platform with privileged groups' })).status).toBe(200);
    // The MS Manager (corrective_action.manage) implements the action: the implementer is recorded.
    const implemented = await transition(rina, url, { to: 'effectiveness_verification', text: 'Quarterly review task with a named owner' });
    expect(implemented.status).toBe(200);
    expect(await actionRow(ids.action)).toMatchObject({
      status: 'effectiveness_verification', correction_text: 'Revoked the stale accounts', rca_text: 'No owner for the review task',
      systemic_check_text: 'Checked every platform with privileged groups', action_text: 'Quarterly review task with a named owner', implemented_at: TODAY,
    });

    const list = await hendra.get<Page<CorrectiveActionItem>>(CAS('isms'));
    expect(pageOf(CorrectiveActionItem).safeParse(list.body).success).toBe(true);
    expect(list.body.items.find((a) => a.code === 'CA-JA-01')).toMatchObject({ implementedBy: 'rina', owner: 'bagus', findings: [{ code: 'JA-2026-01' }, { code: 'JA-2026-02' }] });
    const findings = await hendra.get<Page<FindingItem>>(FINDINGS('isms'));
    expect(findings.body.items.find((f) => f.code === 'JA-2026-02')?.correctiveActions).toEqual([expect.objectContaining({ code: 'CA-JA-01', status: 'effectiveness_verification' })]);
  });

  it('rejects verification by the implementer or the owner (BR-09) and on the implementation day (BR-08), at the API and the database', async () => {
    const url = CA('isms', ids.action!);
    // The implementer (rina) cannot verify.
    expect((await transition(rina, url, { to: 'closed', effective: true })).body).toMatchObject({ status: 422, rule: 'BR-09' });
    // The verification needs `effective`.
    expect((await transition(maya, url, { to: 'closed' })).status).toBe(400);
    // Maya verifies on the implementation day: BR-08.
    expect((await transition(maya, url, { to: 'closed', effective: true })).body).toMatchObject({ status: 422, rule: 'BR-08' });

    // The owner cannot verify either: a second action owned by maya, implemented by rina.
    const second = await rina.post(CAS('isms'), { findingIds: [ids.minor], code: 'CA-JA-02', title: 'Evidence checklist', ownerHandle: 'maya' });
    ids.second = second.body.ref!.id;
    for (const [to, text] of [['rca', 'c'], ['systemic_check', 'r'], ['action', 's'], ['effectiveness_verification', 'a']] as const) {
      expect((await transition(rina, CA('isms', ids.second), { to, text })).status).toBe(200);
    }
    ctx.setToday('2026-09-30');
    expect((await transition(maya, CA('isms', ids.second), { to: 'closed', effective: true })).body).toMatchObject({ status: 422, rule: 'BR-09' });
    ctx.setToday(null);

    // The database refuses the same day, the implementer and the owner as verifier (BR-08 and BR-09 backstops).
    const [ids2] = await rowsOf<{ rina: string; bagus: string; maya: string }>(
      db,
      'tst',
      sql`select (select id from platform.app_user where handle = 'rina') as rina, (select id from platform.app_user where handle = 'bagus') as bagus,
                 (select id from platform.app_user where handle = 'maya') as maya`,
    );
    const attempt = (set: ReturnType<typeof sql>) =>
      inOrg(db, 'tst', (trx) => sql`update corrective_action set ${set} where id = ${ids.action}`.execute(trx));
    await expect(attempt(sql`verified_by_user_id = ${ids2!.maya}, verified_at = implemented_at`)).rejects.toThrow(/check constraint/);
    await expect(attempt(sql`verified_by_user_id = ${ids2!.rina}, verified_at = implemented_at + 1`)).rejects.toThrow(/check constraint/);
    await expect(attempt(sql`verified_by_user_id = ${ids2!.bagus}, verified_at = implemented_at + 1`)).rejects.toThrow(/check constraint/);
    expect(await actionRow(ids.action!)).toMatchObject({ status: 'effectiveness_verification', verified_by_user_id: null });
  });

  it('returns an ineffective action to the action step and closes it after a verification on another day', async () => {
    const url = CA('isms', ids.action!);
    ctx.setToday('2026-10-01');
    const ineffective = await transition(maya, url, { to: 'closed', effective: false, note: 'Q3 review still missing' });
    expect(ineffective.status).toBe(200);
    expect(ineffective.body.message?.[0]).toMatch(/returns to the action step/);
    expect(await actionRow(ids.action!)).toMatchObject({ status: 'action', verified_by_user_id: null, verification_note: 'Q3 review still missing' });
    // Implemented again on 1 October and verified on 6 October.
    expect((await transition(rina, url, { to: 'effectiveness_verification', text: 'Review task scheduled with a deputy owner' })).status).toBe(200);
    ctx.setToday('2026-10-06');
    const closed = await transition(maya, url, { to: 'closed', effective: true, note: 'Q3 review done on time' });
    expect(closed.status).toBe(200);
    expect(await actionRow(ids.action!)).toMatchObject({ status: 'closed', effective: true, implemented_at: '2026-10-01', verified_at: '2026-10-06', verification_note: 'Q3 review done on time' });
    expect((await auditOf(db, 'tst', ids.action!)).map((a) => a.action)).toEqual([
      'corrective_action.created', 'corrective_action.transition', 'corrective_action.transition', 'corrective_action.transition', 'corrective_action.transition',
      'corrective_action.transition', 'corrective_action.transition', 'corrective_action.transition',
    ]);
    // A closed action keeps its findings.
    expect((await rina.patch(url, { findingIds: [ids.major] })).body).toMatchObject({ status: 422 });
    ctx.setToday(null);
  });

  it('closes both findings of the joint audit with the one corrective action', async () => {
    const major = await transition(rina, FINDING('isms', ids.major!), { to: 'closed' });
    expect(major.status).toBe(200);
    const minor = await transition(rina, FINDING('isms', ids.minor!), { to: 'closed' });
    expect(minor.status).toBe(200);
    expect(await findingRow(ids.major!)).toMatchObject({ status: 'closed', closed_at: TODAY });
    expect(await findingRow(ids.minor!)).toMatchObject({ status: 'closed' });
    const closed = await hendra.get<Page<FindingItem>>(`${FINDINGS('isms')}?status=closed&source=certification_audit`);
    expect(closed.body.items.map((f) => f.code)).toEqual(expect.arrayContaining(['JA-2026-01', 'JA-2026-02']));
    // A closed major finding keeps its RCA and systemic check.
    expect((await rina.patch(FINDING('isms', ids.major!), { rcaText: null })).body).toMatchObject({ status: 422, rule: 'BR-06' });
  });

  it('closes an OFI with a close note only and reopens a finding with a reason', async () => {
    const url = FINDING('isms', ids.ofi!);
    expect((await transition(rina, url, { to: 'closed' })).status).toBe(400);
    expect((await transition(rina, url, { to: 'closed', note: 'Reminders automated in the ticket system' })).status).toBe(200);
    expect(await findingRow(ids.ofi!)).toMatchObject({ status: 'closed', close_note: 'Reminders automated in the ticket system' });
    expect((await transition(rina, url, { to: 'in_progress' })).status).toBe(400);
    const reopened: { status: number; body: Reply } = await transition(rina, url, { to: 'in_progress', note: 'Reminders stopped after the upgrade' });
    expect(reopened.status).toBe(200);
    expect(await findingRow(ids.ofi!)).toMatchObject({ status: 'in_progress', closed_at: null, close_note: null, status_note: 'Reminders stopped after the upgrade' });
    expect((await auditOf(db, 'tst', ids.ofi!)).at(-1)).toMatchObject({ action: 'finding.transition', before: expect.objectContaining({ status: 'closed' }), after: expect.objectContaining({ status: 'in_progress' }) });
  });

  it('answers 404 for findings and actions of another organisation and keeps the audit chain intact', async () => {
    const [ndt] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from finding limit 1`);
    expect((await rina.patch(FINDING('isms', ndt!.id), { title: 'x' })).status).toBe(404);
    expect((await rina.post(CAS('isms'), { findingIds: [ndt!.id], code: 'CA-JA-99', title: 'x', ownerHandle: 'bagus' })).status).toBe(404);
    expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
  });
});
