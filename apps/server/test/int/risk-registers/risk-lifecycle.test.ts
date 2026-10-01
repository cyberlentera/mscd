// Risk lifecycle (build plan D.3 "Registers and workflows: risk side", C.13 `risk_treatment.status`, BR-04, BR-17,
// WP-36) on the `tst` organisation: a risk with two treatments from proposal to closure, residual acceptance by the
// risk's owner only (never the implementer, at the API and at the database), closing without acceptance rejected,
// risks without an owner rejected, the chain records the read model shows at every step, and the audit chain.
import { CommandResult, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, createRiskApp, grantRole, inOrg, msIdOf, REGISTERS_URL, rowOf, sessionFor, userId, verifyChain, type Client, type RiskApp,
} from './helpers';

const TODAY = '2026-09-29';

describe('risk lifecycle', () => {
  const db = useTestDatabase('demo');
  let ctx: RiskApp;
  let rina: Client;
  let bagus: Client;
  let hendra: Client;
  let maya: Client;

  beforeAll(async () => {
    ctx = await createRiskApp(db);
    // Hendra (Top Management) also becomes Risk Owner of the tst ISMS: he owns the risk and implements a treatment.
    await grantRole(db, 'tst', 'isms', 'hendra', 'risk_owner');
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const treatmentUrl = (id: string) => `/api/v1/ms/isms/treatments/${id}`;
  const acceptUrl = (id: string) => `/api/v1/ms/isms/risks/${id}/residual-acceptance`;
  const xOf = (snapshot: UiMsSnapshot, stage: string, code: string) => (snapshot.X[stage] ?? []).find((r) => r.id === code);

  it('rejects a risk without an owner (BR-17) and creates one with an owner', async () => {
    const none = await rina.post(REGISTERS_URL('isms', 'risks'), { code: 'R-900', title: 'Ransomware on file servers', likelihood: 3, consequence: 5 });
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ rule: 'BR-17', messages: { en: 'A risk needs an owner.' } });
    const unassigned = await rina.post(REGISTERS_URL('isms', 'risks'), { code: 'R-900', title: 'Ransomware on file servers', ownerHandle: 'none' });
    expect(unassigned.status).toBe(422);
    expect(unassigned.body.rule).toBe('BR-17');

    const created = await rina.post(REGISTERS_URL('isms', 'risks'), {
      code: 'R-900', title: 'Ransomware on file servers', ownerHandle: 'hendra', likelihood: 3, consequence: 5,
      impactDimensions: { confidentiality: 4, availability: 5 }, treatmentOption: 'modify', assessedAt: TODAY,
    });
    expect(created.status).toBe(201);
    expect(CommandResult.safeParse(created.body).success).toBe(true);
    expect(created.body).toMatchObject({ ok: true, changed: ['isms'], ref: { module: 'audit', entityType: 'risk', code: 'R-900' } });
    const risk = await rowOf(db, 'tst', 'risk', 'R-900');
    expect(risk).toMatchObject({ owner: 'hendra', pending: 'Select a treatment: no treatment linked' });
    expect(risk.row).toMatchObject({ risk_profile_code: 'information_security', likelihood: 3, consequence: 5, treatment_option: 'modify' });
    const audit = await auditOf(db, 'tst', risk.id);
    expect(audit).toEqual([expect.objectContaining({ action: 'register.created', actor: 'rina', after: expect.objectContaining({ register_code: 'R-900', owner: 'hendra' }) })]);

    // The new risk is an open chain record of the ISMS, held by its owner.
    const snapshot = (await rina.snapshot('isms')).body;
    expect(xOf(snapshot, 'risk', 'R-900')).toMatchObject({ t: 'Ransomware on file servers', act: 'Select a treatment: no treatment linked', h: 'hendra' });
  });

  it('checks lookups, scales and the profile of the edition', async () => {
    const base = { title: 'Lookup checks', ownerHandle: 'hendra' };
    expect((await rina.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901', treatmentOption: 'transfer' })).status).toBe(422);
    expect((await rina.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901', likelihood: 6 })).status).toBe(422);
    expect((await rina.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901', impactDimensions: { safety: 2 } })).status).toBe(422);
    expect((await rina.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901', riskProfileCode: 'quality' })).status).toBe(422);
    // A field of another register kind is a validation error.
    const foreign = await rina.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901', unit: '%' });
    expect(foreign.status).toBe(400);
    // Duplicate code.
    expect((await rina.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-900' })).status).toBe(409);
    // Only risk.manage in full creates risks: a Domain Owner and a Risk Owner cannot.
    expect((await bagus.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901', ownerHandle: 'bagus' })).status).toBe(403);
    expect((await hendra.post(REGISTERS_URL('isms', 'risks'), { ...base, code: 'R-901' })).status).toBe(403);
  });

  it('runs two treatments through C.13 to residual acceptance by the risk owner and closure', async () => {
    const risk = await rowOf(db, 'tst', 'risk', 'R-900');
    // A target outside the active edition is rejected.
    const badTarget = await rina.post(`/api/v1/ms/isms/risks/${risk.id}/treatments`, {
      riskCode: 'R-900', code: 'T-901', title: 'Offline backups', ownerHandle: 'bagus', targetType: 'catalogue_item', targetCode: 'A.99.1', targetDate: '2026-12-15',
    });
    expect(badTarget.status).toBe(422);

    const t1 = await rina.post(`/api/v1/ms/isms/risks/${risk.id}/treatments`, {
      riskCode: 'R-900', code: 'T-901', title: 'Offline backups', ownerHandle: 'bagus', targetType: 'catalogue_item', targetCode: 'A.8.13', targetDate: '2026-12-15',
    });
    expect(t1.status).toBe(201);
    const t2 = await rina.post(`/api/v1/ms/isms/risks/${risk.id}/treatments`, {
      riskCode: 'R-900', code: 'T-902', title: 'Endpoint detection rollout', ownerHandle: 'hendra', targetType: 'catalogue_item', targetCode: 'A.8.7', targetDate: '2027-01-31',
    });
    expect(t2.status).toBe(201);
    expect((await rina.post(`/api/v1/ms/isms/risks/${risk.id}/treatments`, {
      riskCode: 'R-900', code: 'T-902', title: 'Twice', ownerHandle: 'hendra', targetType: 'catalogue_item', targetCode: 'A.8.7', targetDate: '2027-01-31',
    })).status).toBe(409);
    // Only risk.manage adds treatments.
    expect((await bagus.post(`/api/v1/ms/isms/risks/${risk.id}/treatments`, {
      riskCode: 'R-900', code: 'T-903', title: 'x', ownerHandle: 'bagus', targetType: 'catalogue_item', targetCode: 'A.8.7', targetDate: '2027-01-31',
    })).status).toBe(403);

    const id1 = t1.body.ref!.id;
    const id2 = t2.body.ref!.id;
    // The risk no longer waits for a treatment; the treatments wait for approval.
    expect((await rowOf(db, 'tst', 'risk', 'R-900')).pending).toBeNull();
    let snapshot = (await rina.snapshot('isms')).body;
    expect(xOf(snapshot, 'risk', 'R-900')).toBeUndefined();
    expect(xOf(snapshot, 'treatment', 'T-901')).toMatchObject({ act: 'Approve the treatment', h: 'bagus', up: ['R-900'], down: ['A.8.13'] });

    // Approval needs risk.manage (the treatment owner cannot approve its own treatment).
    expect((await bagus.post(`${treatmentUrl(id1)}/transitions`, { to: 'approved' })).status).toBe(403);
    // 412 with a stale If-Match, then approval with the current ETag.
    expect((await rina.post(`${treatmentUrl(id1)}/transitions`, { to: 'approved' }, { 'if-match': 'W/"1"' })).status).toBe(412);
    const approved = await rina.post(`${treatmentUrl(id1)}/transitions`, { to: 'approved' }, { 'if-match': t1.body.ref!.etag! });
    expect(approved.status).toBe(200);
    expect((await rina.post(`${treatmentUrl(id2)}/transitions`, { to: 'approved' })).status).toBe(200);
    // A pair C.13 does not list.
    expect((await rina.post(`${treatmentUrl(id1)}/transitions`, { to: 'implemented' })).status).toBe(409);

    // The owner (Domain Owner, own grant) moves the work; someone else's treatment is 403.
    expect((await bagus.post(`${treatmentUrl(id2)}/transitions`, { to: 'in_progress' })).status).toBe(403);
    expect((await bagus.post(`${treatmentUrl(id1)}/transitions`, { to: 'in_progress' })).status).toBe(200);
    expect((await bagus.post(`${treatmentUrl(id1)}/transitions`, { to: 'delayed', note: 'Tape library late' })).status).toBe(200);
    expect((await rowOf(db, 'tst', 'risk_treatment', 'T-901')).pending).toBe('Report implementation progress: the target date has passed');
    expect((await bagus.post(`${treatmentUrl(id1)}/transitions`, { to: 'in_progress' })).status).toBe(200);

    // Residual acceptance before the treatment is implemented is BR-04.
    const early = await hendra.post(acceptUrl(risk.id), { treatmentId: id1, residualLikelihood: 1, residualConsequence: 4, note: 'Too early' });
    expect(early.status).toBe(422);
    expect(early.body.rule).toBe('BR-04');

    const implemented = await bagus.post(`${treatmentUrl(id1)}/transitions`, { to: 'implemented' });
    expect(implemented.status).toBe(200);
    const t1Row = await rowOf(db, 'tst', 'risk_treatment', 'T-901');
    expect(t1Row.row).toMatchObject({ status: 'implemented', implemented_at: TODAY, implemented_by_user_id: await userId(db, 'bagus') });
    expect(t1Row.pending).toBeNull();
    // The risk now waits for its owner's residual acceptance.
    expect(await rowOf(db, 'tst', 'risk', 'R-900')).toMatchObject({ pending: 'Residual risk acceptance by Risk Owner', owner: 'hendra' });
    snapshot = (await rina.snapshot('isms')).body;
    expect(xOf(snapshot, 'risk', 'R-900')).toMatchObject({ act: 'Residual risk acceptance by Risk Owner', h: 'hendra' });
    expect(xOf(snapshot, 'treatment', 'T-901')).toBeUndefined();

    // Closing without residual acceptance is BR-04.
    const closeEarly = await rina.post(`${treatmentUrl(id1)}/transitions`, { to: 'closed' });
    expect(closeEarly.status).toBe(422);
    expect(closeEarly.body).toMatchObject({ rule: 'BR-04', type: expect.stringMatching(/business-rule$/) });
    // residual_accepted is not reachable through the transition route.
    expect((await rina.post(`${treatmentUrl(id1)}/transitions`, { to: 'residual_accepted' })).status).toBe(409);

    // Only the risk's owner accepts: the MS Manager (own grant), the implementer and an auditor cannot.
    expect((await rina.post(acceptUrl(risk.id), { treatmentId: id1, residualLikelihood: 1, residualConsequence: 4, note: 'x' })).status).toBe(403);
    expect((await bagus.post(acceptUrl(risk.id), { treatmentId: id1, residualLikelihood: 1, residualConsequence: 4, note: 'x' })).status).toBe(403);
    expect((await maya.post(acceptUrl(risk.id), { treatmentId: id1, residualLikelihood: 1, residualConsequence: 4, note: 'x' })).status).toBe(403);
    const accepted = await hendra.post(acceptUrl(risk.id), { residualLikelihood: 1, residualConsequence: 4, note: 'Offline backups tested' });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ ref: { entityType: 'risk', id: risk.id }, data: { treatment: { id: id1, code: 'T-901' } } });
    expect((await rowOf(db, 'tst', 'risk_treatment', 'T-901')).row.status).toBe('residual_accepted');
    const afterAcceptance = await rowOf(db, 'tst', 'risk', 'R-900');
    expect(afterAcceptance.row).toMatchObject({ residual_likelihood: 1, residual_consequence: 4, residual_accepted_at: TODAY });
    expect(afterAcceptance.pending).toBeNull();
    const acceptance = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ accepted_by: string; implemented_by: string; residual_score: number; accepted_at: string }>`
        select (select handle from platform.app_user where id = accepted_by_user_id) as accepted_by,
               (select handle from platform.app_user where id = implemented_by_user_id) as implemented_by, residual_score, accepted_at
          from residual_acceptance where risk_treatment_id = ${id1}`.execute(trx)).rows);
    expect(acceptance).toEqual([{ accepted_by: 'hendra', implemented_by: 'bagus', residual_score: 4, accepted_at: TODAY }]);
    expect((await auditOf(db, 'tst', risk.id)).at(-1)).toMatchObject({ action: 'risk.residual_accepted', actor: 'hendra', after: expect.objectContaining({ treatment: 'T-901' }) });

    // Closing after acceptance (risk.manage) clears the treatment's action.
    const closed = await rina.post(`${treatmentUrl(id1)}/transitions`, { to: 'closed' });
    expect(closed.status).toBe(200);
    expect((await rowOf(db, 'tst', 'risk_treatment', 'T-901')).row).toMatchObject({ status: 'closed', closed_at: TODAY, pending_action: null });

    // Second treatment: implemented by the risk owner himself, who therefore cannot accept it (BR-04).
    expect((await hendra.post(`${treatmentUrl(id2)}/transitions`, { to: 'in_progress' })).status).toBe(200);
    expect((await hendra.post(`${treatmentUrl(id2)}/transitions`, { to: 'implemented' })).status).toBe(200);
    const self = await hendra.post(acceptUrl(risk.id), { treatmentId: id2, residualLikelihood: 2, residualConsequence: 3, note: 'My own work' });
    expect(self.status).toBe(422);
    expect(self.body).toMatchObject({ rule: 'BR-04', messages: { en: expect.stringContaining('implementer cannot accept') } });
    expect((await rowOf(db, 'tst', 'risk_treatment', 'T-902')).row.status).toBe('implemented');
    expect(await inOrg(db, 'tst', async (trx) =>
      (await sql<{ n: number }>`select count(*)::int as n from residual_acceptance where risk_treatment_id = ${id2}`.execute(trx)).rows[0]!.n)).toBe(0);

    // The database refuses the same acceptance (CHECK on the implementer snapshot).
    const hendraId = await userId(db, 'hendra');
    await expect(inOrg(db, 'tst', (trx) => sql`
      insert into residual_acceptance (organization_id, risk_id, risk_treatment_id, accepted_by_user_id, implemented_by_user_id, accepted_at)
      values ('00000000-0000-4000-8000-00000000a004', ${risk.id}, ${id2}, ${hendraId}, ${hendraId}, ${TODAY})`.execute(trx))).rejects.toThrow(/check constraint/);

    // The risk passes to the MS Manager, who did not implement T-902 and now accepts it as the risk's owner.
    const riskNow = await rowOf(db, 'tst', 'risk', 'R-900');
    const handOver = await rina.patch(`${REGISTERS_URL('isms', 'risks')}/${risk.id}`, { ownerHandle: 'rina' }, { 'if-match': `W/"${riskNow.updatedAt.getTime()}"` });
    expect(handOver.status).toBe(200);
    const second = await rina.post(acceptUrl(risk.id), { treatmentId: id2, residualLikelihood: 2, residualConsequence: 3, note: 'EDR coverage at 98 percent' });
    expect(second.status).toBe(201);
    expect((await rina.post(`${treatmentUrl(id2)}/transitions`, { to: 'closed' })).status).toBe(200);

    const treatments = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ code: string; status: string; pending_action: string | null }>`
        select code, status, pending_action from risk_treatment where risk_id = ${risk.id} order by code`.execute(trx)).rows);
    expect(treatments).toEqual([
      { code: 'T-901', status: 'closed', pending_action: null },
      { code: 'T-902', status: 'closed', pending_action: null },
    ]);
    const final = await rowOf(db, 'tst', 'risk', 'R-900');
    expect(final.pending).toBeNull();
    expect(final.row).toMatchObject({ residual_likelihood: 2, residual_consequence: 3 });
    snapshot = (await rina.snapshot('isms')).body;
    expect(xOf(snapshot, 'risk', 'R-900')).toBeUndefined();
    expect(xOf(snapshot, 'treatment', 'T-902')).toBeUndefined();
    const transitions = (await auditOf(db, 'tst', id2)).filter((a) => a.action === 'risk.treatment_transition').map((a) => a.after?.status);
    expect(transitions).toEqual(['approved', 'in_progress', 'implemented', 'residual_accepted', 'closed']);
  });

  it('reworks an open treatment and changes it with If-Match', async () => {
    const risk = await rowOf(db, 'tst', 'risk', 'R-900');
    const created = await rina.post(`/api/v1/ms/isms/risks/${risk.id}/treatments`, {
      riskCode: 'R-900', code: 'T-904', title: 'Network segmentation', ownerHandle: 'bagus', targetType: 'requirement', targetCode: '6.1', targetDate: '2027-02-28',
    });
    expect(created.status).toBe(201);
    const id = created.body.ref!.id;
    expect((await rina.post(`${treatmentUrl(id)}/transitions`, { to: 'approved' })).status).toBe(200);
    expect((await rina.post(`${treatmentUrl(id)}/transitions`, { to: 'proposed', note: 'Scope changed' })).status).toBe(200);
    expect((await rowOf(db, 'tst', 'risk_treatment', 'T-904')).pending).toBe('Approve the treatment');

    const current = await rowOf(db, 'tst', 'risk_treatment', 'T-904');
    expect((await rina.patch(treatmentUrl(id), { targetDate: '2027-03-31' }, { 'if-match': 'W/"1"' })).status).toBe(412);
    const patched = await rina.patch(treatmentUrl(id), { targetType: 'catalogue_item', targetCode: 'A.8.22', title: 'Segment the data centre network' }, { 'if-match': `W/"${current.updatedAt.getTime()}"` });
    expect(patched.status).toBe(200);
    expect((await rowOf(db, 'tst', 'risk_treatment', 'T-904')).row).toMatchObject({ target_type: 'catalogue_item', title: 'Segment the data centre network' });
    expect((await rina.patch(treatmentUrl(id), { targetType: 'catalogue_item', targetCode: 'B.1' })).status).toBe(422);
    expect((await bagus.patch(treatmentUrl(id), { title: 'Mine' })).status).toBe(403);
    expect((await auditOf(db, 'tst', id)).at(-1)).toMatchObject({ action: 'register.updated', after: expect.objectContaining({ catalogue_item_id: 'A.8.22' }) });
  });

  it('lets a Risk Owner change only the assessment fields of own risks', async () => {
    const created = await rina.post(REGISTERS_URL('isms', 'risks'), { code: 'R-905', title: 'Insider data theft', ownerHandle: 'hendra', likelihood: 2, consequence: 4 });
    expect(created.status).toBe(201);
    const id = created.body.ref!.id;
    const assessed = await hendra.patch(`${REGISTERS_URL('isms', 'risks')}/${id}`, { likelihood: 3, assessedAt: TODAY, nextReviewAt: '2027-09-29' });
    expect(assessed.status).toBe(200);
    expect((await rowOf(db, 'tst', 'risk', 'R-905')).row).toMatchObject({ likelihood: 3, assessed_at: TODAY, next_review_at: '2027-09-29' });
    expect((await hendra.patch(`${REGISTERS_URL('isms', 'risks')}/${id}`, { title: 'Renamed' })).status).toBe(403);
    // Someone else's risk.
    const other = await rowOf(db, 'tst', 'risk', 'R-900');
    expect((await hendra.patch(`${REGISTERS_URL('isms', 'risks')}/${other.id}`, { likelihood: 1 })).status).toBe(403);
    // BR-17 on patch: the owner cannot be removed.
    const unassign = await rina.patch(`${REGISTERS_URL('isms', 'risks')}/${id}`, { ownerHandle: 'none' });
    expect(unassign.status).toBe(422);
    expect(unassign.body.rule).toBe('BR-17');
    // Residual acceptance date is set only by the acceptance command.
    expect((await rina.patch(`${REGISTERS_URL('isms', 'risks')}/${id}`, { residualAcceptedAt: TODAY })).status).toBe(400);
  });

  it('keeps the tenant audit chain verifiable', async () => {
    const chain = await verifyChain(db, 'tst');
    expect(chain.firstBroken).toBeNull();
    expect(chain.checked).toBeGreaterThan(0);
    expect(await msIdOf(db, 'tst', 'isms')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
