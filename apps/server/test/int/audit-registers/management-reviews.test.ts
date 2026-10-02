// Management reviews and cycle derivation (build plan D.3 "Registers and workflows: audit side", C.13
// `management_review.status`, BR-13, BR-14, E.2 `cycle.derive`, WP-37). The demo packs define no review inputs and
// no derivations (G.7), so this file first proves that `cycle.derive` keeps every seeded cycle status of the demo
// template, then adds fixture rows to the framework content (mandatory review inputs of the ISO 27001 and ISO 9001
// editions, derivations of the ISO 27001 cycle requirements): a joint review of the `ndt` ISMS and QMS cannot close
// while the QMS input is empty (BR-13) or without decisions (BR-14), closing queues `cycle.derive` for both systems,
// and on `tst` the derivation sets `MGMT_REVIEW` done only after a review closed with complete inputs.
import { ManagementReviewItem } from '@mscd/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  addReviewInputs, auditOf, createAuditApp, cycleItemsOf, inOrg, ORG_IDS, REVIEWS, rowsOf, sessionFor, setDerivation, systemOf, TODAY, verifyChain,
  type AuditApp, type Client, type DemoOrg,
} from './helpers';

describe('management reviews and cycle derivation', () => {
  const db = useTestDatabase('demo');
  let ctx: AuditApp;

  beforeAll(async () => {
    ctx = await createAuditApp(db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps the cycle statuses of the demo template (the demo packs carry no derivations)', async () => {
    const orgs: DemoOrg[] = ['ndt', 'bsd', 'rmn', 'tst'];
    const statuses = () => Promise.all(orgs.map((org) => rowsOf<{ id: string; status: string; updated_at: Date }>(db, org, sql`select id, status, updated_at from cycle_requirement_status order by id`)));
    const before = await statuses();
    expect(before.flat().length).toBeGreaterThan(0);
    for (const org of orgs) {
      const result = await ctx.derive(org);
      expect(result).toEqual({ systems: 0, items: [], skipped: [] });
    }
    expect(await statuses()).toEqual(before);
  });

  describe('joint review of the ndt ISMS and QMS', () => {
    let rina: Client;
    let sari: Client;
    let bagus: Client;
    let hendra: Client;
    let reviewId: string;

    beforeAll(async () => {
      rina = await sessionFor(ctx, db, 'rina', 'ndt');
      sari = await sessionFor(ctx, db, 'sari', 'ndt');
      bagus = await sessionFor(ctx, db, 'bagus', 'ndt');
      hendra = await sessionFor(ctx, db, 'hendra', 'ndt');
      const isms = await systemOf(db, 'ndt', 'isms');
      const qms = await systemOf(db, 'ndt', 'qms');
      await addReviewInputs(db, isms.editionId, [
        { code: 'MRI-01', title: 'Status of actions from previous reviews', mandatory: true },
        { code: 'MRI-02', title: 'Results of risk assessment', mandatory: true },
        { code: 'MRI-09', title: 'Opportunities for improvement', mandatory: false },
      ]);
      await addReviewInputs(db, qms.editionId, [{ code: 'MRQ-01', title: 'Customer satisfaction', mandatory: true }]);
    });

    it('plans a joint review with one input row per mandatory input and linked system', async () => {
      const body = { code: 'MR-2026-J', title: 'Joint management review 2026', plannedAt: '2026-10-28', ownerHandle: 'hendra', linkedMs: ['isms', 'qms'] };
      expect((await bagus.post(REVIEWS('isms'), body)).status).toBe(403);
      expect((await rina.post(REVIEWS('isms'), { ...body, linkedMs: ['qms'] })).status).toBe(422);
      expect((await rina.post(REVIEWS('isms'), { ...body, linkedMs: ['isms', 'nope'] })).status).toBe(404);
      const created = await rina.post(REVIEWS('isms'), body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ changed: ['isms', 'qms'], count: 3, ref: { entityType: 'management_review', code: 'MR-2026-J' } });
      reviewId = created.body.ref!.id;
      expect((await rina.post(REVIEWS('isms'), body)).status).toBe(409);

      const list = await hendra.get<ManagementReviewItem[]>(REVIEWS('qms'));
      expect(z.array(ManagementReviewItem).safeParse(list.body).success).toBe(true);
      const review = list.body.find((r) => r.code === 'MR-2026-J')!;
      expect(review).toMatchObject({ status: 'planned', owner: 'hendra', linkedMs: ['isms', 'qms'], decisionsRecorded: false });
      expect(review.inputs.map((i) => [i.ms, i.defCode, i.mandatory, i.complete])).toEqual([
        ['isms', 'MRI-01', true, false],
        ['isms', 'MRI-02', true, false],
        ['qms', 'MRQ-01', true, false],
      ]);
      expect((await auditOf(db, 'ndt', reviewId))[0]).toMatchObject({ action: 'management_review.created', actor: 'rina' });
    });

    it('cannot close while the QMS mandatory input is empty (BR-13) or without decisions (BR-14)', async () => {
      const url = `${REVIEWS('isms')}/${reviewId}`;
      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved' })).status).toBe(409);
      expect((await rina.request('PUT', `${url}/inputs/MRI-01`, { content: 'All actions of 2025 closed' })).status).toBe(200);
      expect((await rina.request('PUT', `${url}/inputs/MRI-02`, { content: 'Two risks above appetite' })).status).toBe(200);
      expect((await rina.request('PUT', `${url}/inputs/MRI-09`, { content: 'Automate the access reviews' })).status).toBe(200);
      expect((await rina.request('PUT', `${url}/inputs/MRQ-01`, { content: 'x' })).status).toBe(404);
      expect((await bagus.request('PUT', `${url}/inputs/MRI-01`, { content: 'x' })).status).toBe(403);
      const held = await rina.post(`${url}/transitions`, { to: 'held', heldAt: '2026-09-28' });
      expect(held.status).toBe(200);

      const missing = await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved for PAM' });
      expect(missing.body).toMatchObject({ status: 422, rule: 'BR-13', affected: ['qms'] });
      // The QMS input is recorded through the QMS path by its MS Manager.
      expect((await sari.request('PUT', `${REVIEWS('qms')}/${reviewId}/inputs/MRQ-01`, { content: 'Satisfaction 4.4 of 5' })).status).toBe(200);
      expect((await rina.post(`${url}/transitions`, { to: 'closed' })).body).toMatchObject({ status: 422, rule: 'BR-14' });
      expect(ctx.queue.waitingJobs('cycle.derive')).toEqual([]);

      const closed = await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved for PAM' });
      expect(closed.status).toBe(200);
      expect(closed.body.changed).toEqual(['isms', 'qms']);
      const [row] = await rowsOf<Record<string, unknown>>(db, 'ndt', sql`select * from management_review where id = ${reviewId}`);
      expect(row).toMatchObject({ status: 'closed', held_at: '2026-09-28', closed_at: TODAY, decisions_recorded: true, decisions_text: 'Budget approved for PAM' });
      // Closing queued cycle.derive for both linked systems.
      const isms = await systemOf(db, 'ndt', 'isms');
      const qms = await systemOf(db, 'ndt', 'qms');
      expect(ctx.queue.waitingJobs('cycle.derive').map((j) => j.env)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ orgId: ORG_IDS.ndt, payload: { msId: isms.id } }),
          expect.objectContaining({ orgId: ORG_IDS.ndt, payload: { msId: qms.id } }),
        ]),
      );
      const review = (await hendra.get<ManagementReviewItem[]>(REVIEWS('isms'))).body.find((r) => r.code === 'MR-2026-J')!;
      expect(review.inputs.every((i) => i.complete)).toBe(true);
      expect(review.inputs.find((i) => i.defCode === 'MRI-09')).toMatchObject({ mandatory: false, content: 'Automate the access reviews' });
      // A closed review's inputs no longer change.
      expect((await rina.request('PUT', `${url}/inputs/MRI-01`, { content: 'Changed' })).status).toBe(409);
      expect((await auditOf(db, 'ndt', reviewId)).map((a) => a.action)).toEqual([
        'management_review.created', 'management_review.input_updated', 'management_review.input_updated', 'management_review.input_updated',
        'management_review.transition', 'management_review.input_updated', 'management_review.transition',
      ]);
      expect(await verifyChain(db, 'ndt')).toMatchObject({ firstBroken: null });
    });
  });

  describe('cycle.derive on the tst ISMS with fixture derivations', () => {
    let rina: Client;
    let editionId: string;
    let msId: string;

    beforeAll(async () => {
      rina = await sessionFor(ctx, db, 'rina', 'tst');
      ({ id: msId, editionId } = await systemOf(db, 'tst', 'isms'));
      // The ISMS edition's inputs were added above; the derivation of the management review requirement is added here.
      await setDerivation(db, editionId, 'MGMT_REVIEW', { kind: 'management_review_closed' });
      // The seeded item starts as not done, so the derivation has something to decide.
      await inOrg(db, 'tst', (trx) =>
        sql`update cycle_requirement_status s set status = 'in_progress' from ref.cycle_requirement_def d
             where d.id = s.cycle_requirement_def_id and d.code = 'MGMT_REVIEW'`.execute(trx),
      );
    });

    const mgmt = async () => (await cycleItemsOf(db, 'tst', 'isms')).find((i) => i.def_code === 'MGMT_REVIEW')!;

    it('sets MGMT_REVIEW done only after a review closed with complete inputs', async () => {
      const item = await mgmt();
      expect(item.status).toBe('in_progress');
      expect(item.cycle_start <= TODAY && TODAY <= item.cycle_end).toBe(true);

      // No review: nothing changes.
      expect((await ctx.derive('tst', msId)).items).toEqual([expect.objectContaining({ kind: 'management_review_closed', met: false, changed: false })]);
      const created = await rina.post(REVIEWS('isms'), { code: 'MR-2026-T', title: 'Management review 2026', plannedAt: TODAY, ownerHandle: 'rina', linkedMs: ['isms'] });
      expect(created.status).toBe(201);
      const url = `${REVIEWS('isms')}/${created.body.ref!.id}`;
      expect((await rina.post(`${url}/transitions`, { to: 'held' })).status).toBe(200);
      expect((await rina.request('PUT', `${url}/inputs/MRI-01`, { content: 'Actions closed' })).status).toBe(200);
      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Keep the plan' })).body).toMatchObject({ status: 422, rule: 'BR-13' });
      expect((await rina.request('PUT', `${url}/inputs/MRI-02`, { content: 'Risk results reviewed' })).status).toBe(200);
      // Held with complete inputs but not closed: still not done.
      expect((await ctx.derive('tst', msId)).items[0]).toMatchObject({ met: false, changed: false });
      expect((await mgmt()).status).toBe('in_progress');

      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Keep the plan' })).status).toBe(200);
      // A mandatory input added to the edition after the closure leaves the review incomplete: not done.
      await addReviewInputs(db, editionId, [{ code: 'MRI-03', title: 'Audit results', mandatory: true }]);
      expect((await ctx.derive('tst', msId)).items[0]).toMatchObject({ met: false, changed: false });
      expect((await mgmt()).status).toBe('in_progress');
      // The fixture input becomes optional again (the pack installer role updates framework content, it never deletes it).
      await sql`update ref.review_input_def set mandatory = false where framework_version_id = ${editionId} and code = 'MRI-03'`.execute(db.packInstaller);

      // Closed with every mandatory input complete: done, by the system.
      const result = await ctx.derive('tst', msId);
      expect(result.items[0]).toMatchObject({ met: true, changed: true });
      const done = await mgmt();
      expect(done.status).toBe('done');
      expect(await auditOf(db, 'tst', done.id)).toEqual([
        expect.objectContaining({ action: 'cycle_item.updated', actor: 'system', before: { status: 'in_progress' }, after: { status: 'done', derivation: 'management_review_closed' } }),
      ]);
      // Idempotent: a second run changes nothing.
      expect((await ctx.derive('tst', msId)).items[0]).toMatchObject({ met: true, changed: false });
      expect(await auditOf(db, 'tst', done.id)).toHaveLength(1);
    });

    it('derives the other kinds from the data and skips unknown kinds', async () => {
      await setDerivation(db, editionId, 'INTERNAL_AUDIT', { kind: 'internal_audit_done' });
      await setDerivation(db, editionId, 'RISK_ASSESSMENT', { kind: 'risk_assessment_current', months: 12 });
      await setDerivation(db, editionId, 'CORRECTIVE_ACTION', { kind: 'corrective_action_magic' });
      const before = await cycleItemsOf(db, 'tst', 'isms');
      const [expected] = await rowsOf<{ internal: boolean; risks_current: boolean }>(
        db,
        'tst',
        sql`select exists (select 1 from finding f join certification_cycle c on c.id = (select certification_cycle_id from cycle_requirement_status where id = ${before[0]!.id})
                            where f.management_system_id = ${msId} and f.deleted_at is null and f.source = 'internal_audit'
                              and f.raised_at between c.cycle_start and c.cycle_end) as internal,
                   (select count(*) > 0 and bool_and(r.assessed_at >= (${TODAY}::date - interval '12 months')::date)
                      from risk r join entity_ms_link l on l.entity_type = 'risk' and l.entity_id = r.id and l.management_system_id = ${msId} and l.deleted_at is null
                     where r.deleted_at is null) as risks_current`,
      );
      const result = await ctx.derive('tst', msId);
      const byCode = new Map(before.map((i) => [i.id, i.def_code]));
      const kinds = Object.fromEntries(result.items.map((i) => [byCode.get(i.itemId), i.met]));
      expect(kinds).toMatchObject({ MGMT_REVIEW: true, INTERNAL_AUDIT: expected!.internal, RISK_ASSESSMENT: expected!.risks_current === true });
      expect(result.skipped).toEqual([expect.objectContaining({ kind: 'corrective_action_magic' })]);
      const after = await cycleItemsOf(db, 'tst', 'isms');
      for (const item of after) {
        const was = before.find((b) => b.id === item.id)!;
        if (item.def_code === 'INTERNAL_AUDIT' && expected!.internal) expect(item.status).toBe('done');
        else if (item.def_code === 'RISK_ASSESSMENT' && expected!.risks_current) expect(item.status).toBe('done');
        else expect(item.status).toBe(was.status);
      }
      expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
    });
  });
});
