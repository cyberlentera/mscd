// Generic record commands (build plan D.3, K.2 WP-35): assignment for every kind of the WP-35 table (a SoA gate
// item changes only the justification holder), the kind and entity type check, BR-41 and BR-17 warnings, BR-43 on
// preparation tasks, If-Match, NOT-A-MEMBER, 404 across systems; complete-action with the own grant of a Domain
// Owner; soft delete (hidden from the read model and the per-screen lists, `record.deleted` with the reason, BR-22
// confirmation for a shared record, 422 with open dependants); task completion; the BR-46 flag of the
// implementation summary; and the audit chain after the run.
import { CommandResult, ImplementationSummary, type Page, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, createApp, grantRole, msIdOf, notificationsOf, RECORD_URL, rowsOf, sessionFor, TODAY, userId, verifyChain, type Client,
  type CommandsApp,
} from './helpers';

describe('record commands', () => {
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

  const snapshot = async (client: Client = rina, ms = 'isms') => {
    const r = await client.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
    expect(r.status).toBe(200);
    return r.body;
  };
  const refOf = async (key: string, client: Client = rina) => {
    const ref = (await snapshot(client, key.split(':')[0])).refs[key];
    if (!ref) throw new Error(`No ref ${key}`);
    return ref;
  };
  const item = (s: UiMsSnapshot, key: string) => s.bundle.chain.items.find((i) => i.key === key);

  describe('assignment', () => {
    it('reassigns an explicit chain record (x): holder and due date, audit entry, new ETag, snapshot', async () => {
      const ref = await refOf('isms:x:R-027');
      const response = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'assignment'), { kind: 'x', holder: 'bagus', dueAt: '2026-10-20' }, { 'if-match': ref.etag! });
      expect(response.status).toBe(200);
      expect(CommandResult.safeParse(response.body).success).toBe(true);
      expect(response.body.changed).toEqual(['isms']);
      expect(response.body.warnings).toBeUndefined();
      expect(response.body.ref).toMatchObject({ entityType: 'risk', id: ref.id, code: 'R-027' });
      expect(response.body.ref!.etag).not.toBe(ref.etag);
      const s = await snapshot();
      expect(item(s, 'isms:x:R-027')).toMatchObject({ h: 'bagus', due: '2026-10-20', st: 'pending', after: false });
      expect(s.refs['isms:x:R-027']!.etag).toBe(response.body.ref!.etag);
      const audit = await auditOf(db, 'tst', ref.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'record.assigned',
        actor: 'rina',
        before: expect.objectContaining({ holder: 'dewi', due_at: '2026-11-30' }),
        after: expect.objectContaining({ holder: 'bagus', due_at: '2026-10-20' }),
      });
    });

    it('answers 412 for a stale If-Match and 404 for a record of another system or organisation', async () => {
      const ref = await refOf('isms:x:R-014');
      const stale = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'assignment'), { kind: 'x', holder: 'bagus', dueAt: null }, { 'if-match': 'W/"1"' });
      expect(stale.status).toBe(412);
      const ndtRef = await refOf('qms:doc:' + (await snapshot(rinaNdt, 'qms')).bundle.docs[0]!.id, rinaNdt);
      const other = await rinaNdt.post(RECORD_URL('isms', 'document', ndtRef.id, 'assignment'), { kind: 'doc', holder: 'rina', dueAt: null });
      expect([404]).toContain(other.status);
      const otherOrg = await rina.post(RECORD_URL('isms', 'risk', (await refOf('isms:x:R-014', rinaNdt)).id, 'assignment'), { kind: 'x', holder: 'rina', dueAt: null });
      expect(otherOrg.status).toBe(404);
      const unknownType = await rina.post(RECORD_URL('isms', 'app_user', ref.id, 'assignment'), { kind: 'x', holder: 'rina', dueAt: null });
      expect(unknownType.status).toBe(400);
    });

    it('answers 422 when the kind does not fit the entity type, and NOT-A-MEMBER for an unknown holder', async () => {
      const ref = await refOf('isms:x:R-014');
      const mismatch = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'assignment'), { kind: 'req', holder: 'bagus', dueAt: null });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.messageKey).toBe('records.kind_mismatch');
      const stranger = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'assignment'), { kind: 'x', holder: 'staff01', dueAt: null });
      expect(stranger.status).toBe(422);
      expect(stranger.body.rule).toBe('NOT-A-MEMBER');
    });

    it('warns with BR-41 for a due date after the next audit and BR-17 for a risk set to Unassigned', async () => {
      const ref = await refOf('isms:x:R-035');
      const response = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'assignment'), { kind: 'x', holder: 'none', dueAt: '2026-12-01' });
      expect(response.status).toBe(200);
      const rules = response.body.warnings!.map((w) => w.rule).sort();
      expect(rules).toEqual(['BR-17', 'BR-41']);
      const br41 = response.body.warnings!.find((w) => w.rule === 'BR-41')!;
      expect(br41.messages.en).toBe('This due date falls after the audit on 12 Nov 2026. Bring the due date forward or prepare an explanation.');
      expect(item(await snapshot(), 'isms:x:R-035')).toMatchObject({ h: 'none', due: '2026-12-01', after: true });
    });

    it('reassigns a requirement (owner and action due date) and a SoA gate item (justification holder only)', async () => {
      const s = await snapshot();
      const gate = s.bundle.reqs.find((r) => r.gate)!;
      const ref = s.refs[`isms:soa:${gate.id}`]!;
      const ownerBefore = gate.owner;
      const soa = await rina.post(RECORD_URL('isms', 'applicability_entry', ref.id, 'assignment'), { kind: 'soa', holder: 'maya', dueAt: '2026-10-21' });
      expect(soa.status).toBe(200);
      const after = await snapshot();
      expect(after.bundle.reqs.find((r) => r.id === gate.id)!.owner).toBe(ownerBefore);
      expect(item(after, `isms:soa:${gate.id}`)).toMatchObject({ h: 'maya', due: '2026-10-21' });
      const [row] = await rowsOf<{ owner: string | null; holder: string | null; due: string | null }>(db, 'tst', sql`
        select o.handle as owner, h.handle as holder, e.justification_due_at as due from applicability_entry e
          left join platform.app_user o on o.id = e.owner_user_id left join platform.app_user h on h.id = e.justification_holder_user_id
         where e.id = ${ref.id}`);
      expect(row).toEqual({ owner: ownerBefore ?? null, holder: 'maya', due: '2026-10-21' });

      const req = after.bundle.reqs.find((r) => r.st === 'partial' && !r.gate)!;
      const reqRef = after.refs[`isms:req:${req.id}`]!;
      const reassigned = await rina.post(RECORD_URL('isms', 'applicability_entry', reqRef.id, 'assignment'), { kind: 'req', holder: 'yusuf', dueAt: '2026-10-25' });
      expect(reassigned.status).toBe(200);
      const final = await snapshot();
      expect(final.bundle.reqs.find((r) => r.id === req.id)!.owner).toBe('yusuf');
      expect(item(final, `isms:req:${req.id}`)).toMatchObject({ h: 'yusuf', due: '2026-10-25' });
    });

    it('reassigns a document review, an evidence item and an activity', async () => {
      const s = await snapshot();
      const docRef = s.refs['isms:doc:PRC-11']!;
      expect((await rina.post(RECORD_URL('isms', 'document', docRef.id, 'assignment'), { kind: 'doc', holder: 'andi', dueAt: '2026-10-09' })).status).toBe(200);
      const ev = s.bundle.chain.items.find((i) => i.kind === 'ev')!;
      const evRef = s.refs[ev.key]!;
      const evResult = await rina.post(RECORD_URL('isms', 'evidence', evRef.id, 'assignment'), { kind: 'ev', holder: 'fajar', dueAt: '2026-10-11' });
      expect(evResult.status).toBe(200);
      const jobs = ctx.queue.waitingJobs('freshness.recompute');
      expect(jobs.some((j) => (j.env.payload as { evidenceIds?: string[] }).evidenceIds?.includes(evRef.id))).toBe(true);
      const act = s.bundle.phases.flatMap((p) => p.acts).find((a) => a.st === 'progress')!;
      const actRef = s.refs[`isms:act:${act.no}`]!;
      expect((await rina.post(RECORD_URL('isms', 'implementation_activity_progress', actRef.id, 'assignment'), { kind: 'act', holder: 'dewi', dueAt: '2026-10-13' })).status).toBe(200);
      const after = await snapshot();
      expect(item(after, 'isms:doc:PRC-11')).toMatchObject({ h: 'andi', due: '2026-10-09' });
      expect(after.bundle.docs.find((d) => d.id === 'PRC-11')!.owner).toBe('bagus');
      expect(item(after, ev.key)).toMatchObject({ h: 'fajar', due: '2026-10-11' });
      expect(after.bundle.evs.find((e) => `isms:ev:${e.code}` === ev.key)).toMatchObject({ owner: 'fajar', next: '2026-10-11' });
      expect(after.bundle.phases.flatMap((p) => p.acts).find((a) => a.no === act.no)).toMatchObject({ owner: 'dewi', date: '2026-10-13' });
    });

    it('reassigns preparation tasks (BR-43), cycle items and drift rows', async () => {
      const s = await snapshot();
      const prepKey = Object.keys(s.refs).find((k) => k.startsWith('isms:prep:') && s.refs[k]!.code === 'Approve SoA v3.0')!;
      const prepRef = s.refs[prepKey]!;
      const late = await rina.post(RECORD_URL('isms', 'audit_prep_task', prepRef.id, 'assignment'), { kind: 'prep', holder: 'rina', dueAt: '2026-11-12' });
      expect(late.status).toBe(422);
      expect(late.body.rule).toBe('BR-43');
      expect(late.body.messages!.en).toBe('Preparation tasks must be finished before the audit starts.');
      const noDue = await rina.post(RECORD_URL('isms', 'audit_prep_task', prepRef.id, 'assignment'), { kind: 'prep', holder: 'rina', dueAt: null });
      expect(noDue.status).toBe(400);
      const ok = await rina.post(RECORD_URL('isms', 'audit_prep_task', prepRef.id, 'assignment'), { kind: 'prep', holder: 'bagus', dueAt: '2026-11-01' });
      expect(ok.status).toBe(200);
      const prep = (await snapshot()).PREP.find((p) => p[0] === 'Approve SoA v3.0')!;
      expect(prep.slice(1, 3)).toEqual(['bagus', '2026-11-01']);
      expect((await notificationsOf(db, 'tst', 'bagus', 'prep_task_assigned'))[0]).toMatchObject({ digest: true, title_en: 'Preparation task assigned: Approve SoA v3.0' });

      const cycleKey = Object.keys(s.refs).find((k) => k.startsWith('isms:cycle:') && s.refs[k]!.code === '9.1')!;
      const cycle = await rina.post(RECORD_URL('isms', 'cycle_requirement_status', s.refs[cycleKey]!.id, 'assignment'), { kind: 'cycle', holder: 'maya', dueAt: '2026-10-16' });
      expect(cycle.status).toBe(200);
      expect((await snapshot()).CYCLE_ITEMS.find((c) => c[0] === '9.1')!.slice(2, 4)).toEqual(['maya', '2026-10-16']);

      const driftKey = Object.keys(s.refs).find((k) => k.startsWith('isms:drift:') && s.refs[k]!.code === 'R-009')!;
      const drift = await rina.post(RECORD_URL('isms', 'drift_result', s.refs[driftKey]!.id, 'assignment'), { kind: 'drift', holder: 'andi', dueAt: '2026-10-18' });
      expect(drift.status).toBe(200);
      const [row] = await rowsOf<{ holder: string; due_at: string }>(db, 'tst', sql`
        select u.handle as holder, d.due_at from drift_result d join platform.app_user u on u.id = d.holder_user_id where d.id = ${s.refs[driftKey]!.id}`);
      expect(row).toEqual({ holder: 'andi', due_at: '2026-10-18' });
    });

    it('is refused to a Domain Owner (403)', async () => {
      const ref = await refOf('isms:x:R-014');
      const response = await bagus.post(RECORD_URL('isms', 'risk', ref.id, 'assignment'), { kind: 'x', holder: 'bagus', dueAt: null });
      expect(response.status).toBe(403);
    });
  });

  describe('complete-action', () => {
    it('completes the open action of a record held by the Domain Owner, then 409', async () => {
      const ref = await refOf('isms:x:R-014', bagus);
      const response = await bagus.post(RECORD_URL('isms', 'risk', ref.id, 'complete-action'), { note: 'Reassessed with the asset owner' });
      expect(response.status).toBe(200);
      expect(response.body.changed).toEqual(['isms']);
      const s = await snapshot();
      expect(item(s, 'isms:x:R-014')).toBeUndefined();
      expect(s.refs['isms:x:R-014']).toBeUndefined();
      const audit = await auditOf(db, 'tst', ref.id);
      expect(audit.at(-1)).toMatchObject({ action: 'record.action_completed', actor: 'bagus', after: expect.objectContaining({ pending_action: null, note: 'Reassessed with the asset owner' }) });
      const again = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'complete-action'), {});
      expect(again.status).toBe(409);
    });

    it('is refused to a Domain Owner on a record held by someone else (403) and to an Internal Auditor', async () => {
      const ref = await refOf('isms:x:R-022');
      expect((await bagus.post(RECORD_URL('isms', 'risk', ref.id, 'complete-action'), {})).status).toBe(403);
      expect((await maya.post(RECORD_URL('isms', 'risk', ref.id, 'complete-action'), {})).status).toBe(403);
    });

    it('answers 409 for a record type without a pending action and resolves a drift row', async () => {
      const s = await snapshot();
      expect((await rina.post(RECORD_URL('isms', 'document', s.refs['isms:doc:PRC-07']!.id, 'complete-action'), {})).status).toBe(409);
      const driftKey = Object.keys(s.refs).find((k) => k.startsWith('isms:drift:') && s.refs[k]!.code === 'R-011')!;
      const resolved = await rina.post(RECORD_URL('isms', 'drift_result', s.refs[driftKey]!.id, 'complete-action'), {});
      expect(resolved.status).toBe(200);
      expect((await rina.post(RECORD_URL('isms', 'drift_result', s.refs[driftKey]!.id, 'complete-action'), {})).status).toBe(409);
    });
  });

  describe('soft delete', () => {
    it('hides the record from the read model and the per-screen lists and writes record.deleted with the reason', async () => {
      const s = await snapshot();
      const docRef = s.refs['isms:doc:PRC-16']!;
      const response = await rina.post(RECORD_URL('isms', 'document', docRef.id, 'delete'), { reason: 'Superseded by PRC-17, merged' });
      expect(response.status).toBe(200);
      const after = await snapshot();
      expect(after.bundle.docs.some((d) => d.id === 'PRC-16')).toBe(false);
      expect(after.refs['isms:doc:PRC-16']).toBeUndefined();
      const list = await rina.get<Page<{ id: string }>>('/api/v1/ms/isms/documents?q=PRC-16');
      expect(list.status).toBe(200);
      expect(list.body.items.some((d) => d.id === 'PRC-16')).toBe(false);
      const [row] = await rowsOf<{ deleted: boolean }>(db, 'tst', sql`select deleted_at is not null as deleted from document where id = ${docRef.id}`);
      expect(row!.deleted).toBe(true);
      expect((await auditOf(db, 'tst', docRef.id)).at(-1)).toMatchObject({ action: 'record.deleted', after: expect.objectContaining({ reason: 'Superseded by PRC-17, merged' }) });
      expect((await rina.post(RECORD_URL('isms', 'document', docRef.id, 'delete'), { reason: 'Superseded by PRC-17, merged' })).status).toBe(404);
    });

    it('rejects a risk with open treatments (422) and a short reason (400), and is refused to a Domain Owner', async () => {
      const ref = await refOf('isms:x:R-022');
      const response = await rina.post(RECORD_URL('isms', 'risk', ref.id, 'delete'), { reason: 'Risk retired with the old platform' });
      expect(response.status).toBe(422);
      expect(response.body.messageKey).toBe('records.open_dependants');
      expect(response.body.affected!.length).toBeGreaterThan(0);
      expect((await rina.post(RECORD_URL('isms', 'risk', ref.id, 'delete'), { reason: 'short' })).status).toBe(400);
      expect((await bagus.post(RECORD_URL('isms', 'risk', ref.id, 'delete'), { reason: 'Risk retired with the old platform' })).status).toBe(403);
    });

    it('asks for confirmation before deleting a shared record (BR-22) and deletes it with confirm', async () => {
      const [risk] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from risk where code = 'R-005'`);
      const qms = await msIdOf(db, 'ndt', 'qms');
      await rowsOf(db, 'ndt', sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary) values ('risk', ${risk!.id}, ${qms}, false)`);
      const url = RECORD_URL('isms', 'risk', risk!.id, 'delete');
      const first = await rinaNdt.post(url, { reason: 'Duplicate of R-011, merged' });
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({ rule: 'BR-22', affected: ['qms'], type: expect.stringMatching(/confirmation-required$/) });
      expect(first.body.messages!.en).toBe('This change also applies to: QMS. Continue?');
      const confirmed = await rinaNdt.post(url, { reason: 'Duplicate of R-011, merged', confirm: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.changed).toEqual(['isms', 'qms']);
      const s = await snapshot(rinaNdt);
      expect(Object.values(s.refs).some((r) => r.id === risk!.id)).toBe(false);
    });
  });

  describe('task completion', () => {
    it('lets the owner complete an open task once; others get 404', async () => {
      const rinaId = await userId(db, 'rina');
      const msId = await msIdOf(db, 'tst', 'isms');
      const [task] = await rowsOf<{ id: string }>(db, 'tst', sql`
        insert into task (management_system_id, source_rule, entity_type, entity_id, entity_code, title_en, title_id, owner_user_id, due_at)
        values (${msId}, 'manual', 'document', gen_random_uuid(), 'PRC-07', 'Review PRC-07', 'Tinjau PRC-07', ${rinaId}, ${TODAY}) returning id`);
      expect((await bagus.post(`/api/v1/tasks/${task!.id}/complete`, {})).status).toBe(404);
      const done = await rina.post(`/api/v1/tasks/${task!.id}/complete`, { note: 'Reviewed' });
      expect(done.status).toBe(200);
      expect(done.body.changed).toEqual(['isms']);
      const [row] = await rowsOf<{ status: string; closed: boolean }>(db, 'tst', sql`select status, closed_at is not null as closed from task where id = ${task!.id}`);
      expect(row).toEqual({ status: 'done', closed: true });
      expect((await auditOf(db, 'tst', task!.id)).at(-1)).toMatchObject({ action: 'task.completed', actor: 'rina' });
      expect((await rina.post(`/api/v1/tasks/${task!.id}/complete`, {})).status).toBe(409);
      expect((await rina.post('/api/v1/tasks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b/complete', {})).status).toBe(404);
    });
  });

  describe('implementation summary (BR-46)', () => {
    it('carries the gate consistency flag for the MS Manager and not for a Domain Owner', async () => {
      await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
      const manager = await rina.get<ImplementationSummary>('/api/v1/ms/isms/implementation/summary');
      expect(manager.status).toBe(200);
      expect(ImplementationSummary.safeParse(manager.body).success).toBe(true);
      expect(manager.body.gateConsistency).toMatchObject({ gatePhases: [4], flagged: expect.any(Boolean) });
      expect(manager.body.gateConsistency!.flagged).toBe(manager.body.gateConsistency!.blockedActivities !== manager.body.gateConsistency!.openGateItems);
      const owner = await bagus.get<ImplementationSummary>('/api/v1/ms/isms/implementation/summary');
      expect(owner.status).toBe(200);
      expect(owner.body.gateConsistency).toBeUndefined();
    });
  });

  it('leaves verifiable audit chains', async () => {
    for (const org of ['tst', 'ndt'] as const) {
      const chain = await verifyChain(db, org);
      expect(chain.checked).toBeGreaterThan(0);
      expect(chain.firstBroken).toBeNull();
    }
  });
});
