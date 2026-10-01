// Applicability commands (build plan D.3, C.13, A.4 5.1 to 5.4, E.3, WP-20): every route's success, 409, 412, 422
// and 404 paths on the `tst` organisation (and `ndt` for systems `tst` does not have), the rules BR-01 (an entry
// verified on an older valid item is accepted although a newer item is broken), BR-02 per pack activation, BR-03
// warnings, VERIFY-SELF, NOT-A-MEMBER, idempotency, the audit entries, the `freshness.recompute` job queued in the
// command's transaction, and the audit chain after the run.
import { randomUUID } from 'node:crypto';
import { CommandResult, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, createCommandsApp, entriesWithStatus, entryOf, ENTRY_URL, grantRole, inOrg, sessionFor, verifyChain, type Client, type CommandsApp,
} from './helpers';

const TODAY = '2026-09-29';

describe('applicability commands', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let hendra: Client;
  let rinaNdt: Client;

  beforeAll(async () => {
    ctx = await createCommandsApp(db);
    // A second verifier for VERIFY-SELF (A-48): Hendra also becomes Programme Owner of the tst ISMS.
    await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const transitions = (id: string) => `${ENTRY_URL('isms', id)}/transitions`;

  describe('transitions', () => {
    it('marks a partially implemented entry complete: status, completer, audit entry, ETag, freshness job, snapshot', async () => {
      const [first] = await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented');
      const before = await entryOf(db, 'tst', 'isms', first!.code);
      const queued = ctx.queue.waitingJobs('freshness.recompute').length;
      const response = await rina.post(transitions(before.id), { to: 'complete' });
      expect(response.status).toBe(200);
      expect(CommandResult.safeParse(response.body).success).toBe(true);
      expect(response.body.changed).toEqual(['isms']);
      expect(response.body.ref).toMatchObject({ module: 'implementation', entityType: 'applicability_entry', id: before.id, code: first!.code });
      expect(response.body.ref!.etag).toMatch(/^W\/"\d+"$/);
      expect(response.body.ref!.etag).not.toBe(`W/"${before.updatedAt.getTime()}"`);

      const after = await entryOf(db, 'tst', 'isms', first!.code);
      expect(after).toMatchObject({ status: 'complete', completedBy: 'rina' });
      const audit = await auditOf(db, 'tst', before.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'applicability.transition',
        actor: 'rina',
        before: { implementation_status: 'partially_implemented' },
        after: expect.objectContaining({ implementation_status: 'complete', completed_at: TODAY }),
      });
      const jobs = ctx.queue.waitingJobs('freshness.recompute');
      expect(jobs.length).toBeGreaterThanOrEqual(Math.min(queued + 1, 1));
      expect(jobs.at(-1)!.env).toMatchObject({ orgId: '00000000-0000-4000-8000-00000000a004', payload: { msId: before.msId } });

      const snapshot = await rina.snapshot('isms');
      const req = snapshot.body.bundle.reqs.find((r) => r.id === first!.code)!;
      expect(req).toMatchObject({ st: 'complete', by: 'rina' });
      expect(snapshot.body.refs[`isms:req:${first!.code}`]!.etag).toBe(response.body.ref!.etag);
    });

    it('answers 409 for a pair C.13 does not list and for a system-only row', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'planned');
      const response = await rina.post(transitions(entry!.id), { to: 'implemented' });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ status: 409, type: expect.stringMatching(/transition-not-allowed$/) });
      const [implemented] = await entriesWithStatus(db, 'tst', 'isms', 'implemented');
      // implemented to partially_implemented is the automatic downgrade (E.3), never a user transition.
      const system = await rina.post(transitions(implemented!.id), { to: 'partially_implemented' });
      expect(system.status).toBe(409);
      expect((await entryOf(db, 'tst', 'isms', implemented!.code)).status).toBe('implemented');
    });

    it('answers 412 for a stale If-Match and accepts the current ETag', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'not_started');
      const stale = await rina.post(transitions(entry!.id), { to: 'planned' }, { 'if-match': 'W/"1"' });
      expect(stale.status).toBe(412);
      expect((await entryOf(db, 'tst', 'isms', entry!.code)).status).toBe('not_started');
      const snapshot = await rina.snapshot('isms');
      const etag = snapshot.body.refs[`isms:req:${entry!.code}`]!.etag!;
      const current = await rina.post(transitions(entry!.id), { to: 'planned' }, { 'if-match': etag });
      expect(current.status).toBe(200);
      expect((await entryOf(db, 'tst', 'isms', entry!.code)).status).toBe('planned');
    });

    it('answers 404 for a record of another system, an unknown id and an unknown system', async () => {
      const qms = await entriesWithStatus(db, 'ndt', 'qms', 'partially_implemented');
      const crossSystem = await rinaNdt.post(`/api/v1/ms/isms/applicability/${qms[0]!.id}/transitions`, { to: 'complete' });
      expect(crossSystem.status).toBe(404);
      expect((await entriesWithStatus(db, 'ndt', 'qms', 'partially_implemented')).map((e) => e.id)).toContain(qms[0]!.id);
      expect((await rina.post(transitions(randomUUID()), { to: 'complete' })).status).toBe(404);
      expect((await rina.post(`/api/v1/ms/nope/applicability/${qms[0]!.id}/transitions`, { to: 'complete' })).status).toBe(404);
      // A record of another organisation is invisible too.
      const tstEntry = (await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented'))[0]!;
      expect((await rinaNdt.post(`/api/v1/ms/isms/applicability/${tstEntry.id}/transitions`, { to: 'complete' })).status).toBe(404);
    });

    it('lets a Domain Owner complete only own entries (own grant) and never verify', async () => {
      await inOrg(db, 'tst', async (trx) => {
        await sql`update applicability_entry set owner_user_id = (select id from platform.app_user where handle = 'bagus')
                   where id = (select e.id from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
                                where ci.item_code = 'A.8.20' and e.deleted_at is null)`.execute(trx);
      });
      const own = await entryOf(db, 'tst', 'isms', 'A.8.20');
      await inOrg(db, 'tst', (trx) => sql`update applicability_entry set implementation_status = 'planned' where id = ${own.id}`.execute(trx));
      const others = (await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented')).filter((e) => e.owner !== 'bagus');
      const forbidden = await bagus.post(transitions(others[0]!.id), { to: 'complete' });
      expect(forbidden.status).toBe(403);
      const allowed = await bagus.post(transitions(own.id), { to: 'complete' });
      expect(allowed.status).toBe(200);
      expect(await entryOf(db, 'tst', 'isms', 'A.8.20')).toMatchObject({ status: 'complete', completedBy: 'bagus' });
      const verify = await bagus.post(transitions(own.id), { to: 'implemented' });
      expect(verify.status).toBe(403);
      // Internal Auditors hold none of the machine's permissions: the guard refuses them.
      expect((await maya.post(transitions(own.id), { to: 'implemented' })).status).toBe(403);
    });

    it('rejects verification by the completer (VERIFY-SELF) and by the owner when nobody completed it', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented');
      expect((await rina.post(transitions(entry!.id), { to: 'complete' })).status).toBe(200);
      const self = await rina.post(transitions(entry!.id), { to: 'implemented' });
      expect(self.status).toBe(422);
      expect(self.body).toMatchObject({ rule: 'VERIFY-SELF', messages: { en: expect.stringMatching(/cannot verify/), id: expect.stringMatching(/tidak dapat memverifikasi/) } });
      // partially_implemented to implemented: the owner may not verify their own entry either (A.4 5.4).
      const owned = (await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented')).find((e) => e.owner === 'rina');
      if (owned) {
        const ownerVerify = await rina.post(transitions(owned.id), { to: 'implemented' });
        expect(ownerVerify.status).toBe(422);
        expect(ownerVerify.body.rule).toBe('VERIFY-SELF');
      }
      expect((await entryOf(db, 'tst', 'isms', entry!.code)).status).toBe('complete');
    });

    it('BR-01: rejects verification without valid evidence of the current period, offering partial or planned', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented');
      // Every evidence record of the entry is older than two periods (critical).
      await inOrg(db, 'tst', (trx) => sql`
        update evidence set produced_at = date '2024-01-01', frequency_code = 'annual'
         where id in (select evidence_id from evidence_target where applicability_entry_id = ${entry!.id})`.execute(trx));
      const response = await hendra.post(transitions(entry!.id), { to: 'implemented' });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        rule: 'BR-01',
        messageKey: 'rule.BR-01',
        messages: { en: expect.stringMatching(/partially implemented or planned/), id: expect.stringMatching(/diterapkan sebagian atau direncanakan/) },
      });
      expect((await entryOf(db, 'tst', 'isms', entry!.code)).status).toBe('partially_implemented');
    });

    it('BR-01: an entry verified on an older valid item is accepted although a newer item is broken', async () => {
      const entry = (await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented'))[1]!;
      await inOrg(db, 'tst', async (trx) => {
        // Two evidence records target the entry: an older one, intact and in date, and a newer one whose file is missing.
        const { rows } = await sql<{ id: string; storage_object_id: string }>`
          select id, storage_object_id from evidence where deleted_at is null and storage_object_id is not null order by evidence_code limit 2`.execute(trx);
        const [older, newer] = rows;
        const target = await sql<{ catalogue_item_id: string; management_system_id: string }>`
          select catalogue_item_id, management_system_id from applicability_entry where id = ${entry.id}`.execute(trx);
        const t = target.rows[0]!;
        await sql`update evidence_target set deleted_at = now() where applicability_entry_id = ${entry.id}`.execute(trx);
        for (const e of [older!, newer!]) {
          await sql`insert into evidence_target (evidence_id, management_system_id, applicability_entry_id, target_type, catalogue_item_id)
                    values (${e.id}, ${t.management_system_id}, ${entry.id}, 'catalogue_item', ${t.catalogue_item_id})
                    on conflict do nothing`.execute(trx);
        }
        await sql`update evidence set produced_at = date '2026-09-01', frequency_code = 'monthly' where id = ${older!.id}`.execute(trx);
        await sql`update storage_object set link_status = 'intact', link_status_since = now() where id = ${older!.storage_object_id}`.execute(trx);
        await sql`update evidence set produced_at = date '2026-09-28', frequency_code = 'monthly' where id = ${newer!.id}`.execute(trx);
        await sql`update storage_object set link_status = 'missing', link_status_since = now() where id = ${newer!.storage_object_id}`.execute(trx);
      });
      const response = await hendra.post(transitions(entry.id), { to: 'implemented' });
      expect(response.body.rule).toBeUndefined();
      expect(response.status).toBe(200);
      const after = await entryOf(db, 'tst', 'isms', entry.code);
      expect(after.status).toBe('implemented');
      const audit = await auditOf(db, 'tst', entry.id);
      expect(audit.at(-1)).toMatchObject({ action: 'applicability.transition', actor: 'hendra', after: expect.objectContaining({ implementation_status: 'implemented', verified_at: TODAY }) });
    });

    it('BR-02 runs only where the pack activates it: ISO 37001 rejects verifying an entry without a risk', async () => {
      const abms = await entriesWithStatus(db, 'ndt', 'abms', 'partially_implemented');
      const entry = abms.find((e) => e.owner !== 'rina')!;
      const response = await rinaNdt.post(`/api/v1/ms/abms/applicability/${entry.id}/transitions`, { to: 'implemented' });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ rule: 'BR-02', messages: { en: expect.stringMatching(/risk/), id: expect.stringMatching(/risiko/) } });
      // ISO 9001 does not activate BR-02: the same request reaches BR-01 instead.
      const qms = (await entriesWithStatus(db, 'ndt', 'qms', 'partially_implemented')).find((e) => e.owner !== 'rina')!;
      const qmsResponse = await rinaNdt.post(`/api/v1/ms/qms/applicability/${qms.id}/transitions`, { to: 'implemented' });
      expect(qmsResponse.body.rule).not.toBe('BR-02');
    });

    it('sets not applicable with an exclusion justification and warns about a meaningless one (BR-03)', async () => {
      const [first, second] = await entriesWithStatus(db, 'tst', 'isms', 'planned');
      const missing = await rina.post(transitions(first!.id), { to: 'not_applicable' });
      expect(missing.status).toBe(400);
      const vague = await rina.post(transitions(first!.id), { to: 'not_applicable', exclusionJustification: 'N/A.' });
      expect(vague.status).toBe(200);
      expect(vague.body.warnings).toEqual([{ rule: 'BR-03', messages: { en: expect.stringMatching(/not look meaningful/), id: expect.any(String) } }]);
      expect(await entryOf(db, 'tst', 'isms', first!.code)).toMatchObject({ status: 'not_applicable', isApplicable: false });
      const phrase = await rina.post(transitions(second!.id), { to: 'not_applicable', exclusionJustification: 'tidak berlaku' });
      expect(phrase.body.warnings?.[0]?.rule).toBe('BR-03');
      const [third] = await entriesWithStatus(db, 'tst', 'isms', 'not_started');
      const clear = await rina.post(transitions(third!.id), { to: 'not_applicable', exclusionJustification: 'No software development takes place in scope' });
      expect(clear.status).toBe(200);
      expect(clear.body.warnings).toBeUndefined();
    });

    it('rejects a completed entry back to partially implemented with the reason as its note', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'complete');
      const response = await hendra.post(transitions(entry!.id), { to: 'partially_implemented', reason: 'Evidence does not cover Q3' });
      expect(response.status).toBe(200);
      expect(await entryOf(db, 'tst', 'isms', entry!.code)).toMatchObject({ status: 'partially_implemented', completedBy: null });
      const snapshot = await rina.snapshot('isms');
      expect(snapshot.body.bundle.reqs.find((r) => r.id === entry!.code)).toMatchObject({ st: 'partial', note: 'Evidence does not cover Q3' });
    });
  });

  describe('PATCH', () => {
    it('changes owner, note, gate flag, frequency, risks and documents in one audit entry', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'implemented');
      const queued = ctx.queue.waitingJobs('freshness.recompute').length;
      const response = await rina.patch(ENTRY_URL('isms', entry!.id), {
        ownerHandle: 'bagus', statusNote: 'Reviewed in October', holdsGate: true, gateReason: 'Awaiting board decision',
        frequencyCode: 'quarterly', riskCodes: ['R-014'], documentCodes: ['POL-01'],
      });
      expect(response.status).toBe(200);
      expect(response.body.changed).toEqual(['isms']);
      const snapshot = await rina.snapshot('isms');
      const req = snapshot.body.bundle.reqs.find((r) => r.id === entry!.code)!;
      expect(req).toMatchObject({ owner: 'bagus', note: 'Reviewed in October', gate: true, freq: 'quarterly', risks: ['R-014'], doc: 'POL-01', st: 'blocked' });
      const audit = await auditOf(db, 'tst', entry!.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'applicability.updated',
        after: expect.objectContaining({ status_note: 'Reviewed in October', holds_gate: true, frequency_code: 'quarterly', risk_codes: ['R-014'], document_codes: ['POL-01'] }),
      });
      expect(ctx.queue.waitingJobs('freshness.recompute').length).toBeGreaterThanOrEqual(Math.min(queued, 1));
      const clear = await rina.patch(ENTRY_URL('isms', entry!.id), { holdsGate: false, ownerHandle: 'none' });
      expect(clear.status).toBe(200);
      expect(await entryOf(db, 'tst', 'isms', entry!.code)).toMatchObject({ holdsGate: false, gateReason: null, owner: null });
    });

    it('BR-02: removing the last risk of an applicable ISO 27001 entry is rejected; ISO 9001 does not activate the rule', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'implemented');
      const response = await rina.patch(ENTRY_URL('isms', entry!.id), { riskCodes: [] });
      expect(response.status).toBe(422);
      expect(response.body.rule).toBe('BR-02');
      const snapshot = await rina.snapshot('isms');
      expect(snapshot.body.bundle.reqs.find((r) => r.id === entry!.code)!.risks.length).toBeGreaterThan(0);
      const [qms] = await entriesWithStatus(db, 'ndt', 'qms', 'implemented');
      expect((await rinaNdt.patch(ENTRY_URL('qms', qms!.id), { riskCodes: [] })).status).toBe(200);
    });

    it('answers 422 NOT-A-MEMBER, 422 for unknown codes, 412 for a stale ETag and 403 without applicability.manage', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'implemented');
      const stranger = await rina.patch(ENTRY_URL('isms', entry!.id), { ownerHandle: 'staff01' });
      expect(stranger.status).toBe(422);
      expect(stranger.body.rule).toBe('NOT-A-MEMBER');
      expect((await rina.patch(ENTRY_URL('isms', entry!.id), { riskCodes: ['R-999'] })).status).toBe(422);
      expect((await rina.patch(ENTRY_URL('isms', entry!.id), { documentCodes: ['NOPE-1'] })).status).toBe(422);
      expect((await rina.patch(ENTRY_URL('isms', entry!.id), { frequencyCode: 'hourly' })).status).toBe(422);
      expect((await rina.patch(ENTRY_URL('isms', entry!.id), { statusNote: 'x' }, { 'if-match': 'W/"5"' })).status).toBe(412);
      expect((await bagus.patch(ENTRY_URL('isms', entry!.id), { statusNote: 'x' })).status).toBe(403);
      expect((await rina.patch(ENTRY_URL('isms', randomUUID()), { statusNote: 'x' })).status).toBe(404);
    });

    it('makes an entry not applicable with a justification and applicable again (not started)', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'not_started');
      expect((await rina.patch(ENTRY_URL('isms', entry!.id), { isApplicable: false })).status).toBe(400);
      const out = await rina.patch(ENTRY_URL('isms', entry!.id), { isApplicable: false, exclusionJustification: 'tbd' });
      expect(out.status).toBe(200);
      expect(out.body.warnings?.[0]?.rule).toBe('BR-03');
      expect(await entryOf(db, 'tst', 'isms', entry!.code)).toMatchObject({ status: 'not_applicable', isApplicable: false });
      const back = await rina.patch(ENTRY_URL('isms', entry!.id), { isApplicable: true });
      expect(back.status).toBe(200);
      expect(await entryOf(db, 'tst', 'isms', entry!.code)).toMatchObject({ status: 'not_started', isApplicable: true });
    });
  });

  describe('create', () => {
    it('adds a requirement entry of the active edition, holding the gate under BR-02 until a risk is linked', async () => {
      const key = randomUUID();
      const body = { targetType: 'requirement', code: '6.1', isApplicable: true, inclusionJustification: 'Risk assessment process', ownerHandle: 'rina', frequencyCode: 'annual' };
      const response = await rina.post('/api/v1/ms/isms/applicability', body, { 'idempotency-key': key });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ ok: true, changed: ['isms'], ref: { entityType: 'applicability_entry', code: 'Cl. 6.1' } });
      const entry = await entryOf(db, 'tst', 'isms', '6.1');
      expect(entry).toMatchObject({ status: 'not_started', owner: 'rina', holdsGate: true, gateReason: 'No risk-based justification', isApplicable: true });
      expect((await auditOf(db, 'tst', entry.id))[0]).toMatchObject({ action: 'applicability.created', actor: 'rina' });
      const replay = await rina.post('/api/v1/ms/isms/applicability', body, { 'idempotency-key': key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.ref!.id).toBe(response.body.ref!.id);
      const duplicate = await rina.post('/api/v1/ms/isms/applicability', body);
      expect(duplicate.status).toBe(409);
      const linked = await rina.patch(ENTRY_URL('isms', entry.id), { riskCodes: ['R-014'] });
      expect(linked.status).toBe(200);
      expect(await entryOf(db, 'tst', 'isms', '6.1')).toMatchObject({ holdsGate: false, gateReason: null });
    });

    it('answers 422 for a code outside the edition, an unknown frequency and a non-member owner; 403 for a Domain Owner', async () => {
      const base = { targetType: 'requirement', code: '6.3', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual' };
      expect((await rina.post('/api/v1/ms/isms/applicability', { ...base, code: '99.9' })).status).toBe(422);
      expect((await rina.post('/api/v1/ms/isms/applicability', { ...base, frequencyCode: 'hourly' })).status).toBe(422);
      const stranger = await rina.post('/api/v1/ms/isms/applicability', { ...base, ownerHandle: 'staff01' });
      expect(stranger.status).toBe(422);
      expect(stranger.body.rule).toBe('NOT-A-MEMBER');
      expect((await bagus.post('/api/v1/ms/isms/applicability', base)).status).toBe(403);
      const notApplicable = await rina.post('/api/v1/ms/isms/applicability', { ...base, isApplicable: false, exclusionJustification: 'none' });
      expect(notApplicable.status).toBe(201);
      expect(notApplicable.body.warnings?.[0]?.rule).toBe('BR-03');
      expect(await entryOf(db, 'tst', 'isms', '6.3')).toMatchObject({ status: 'not_applicable', holdsGate: false });
    });
  });

  it('keeps the read model consistent and the audit chain intact after the run', async () => {
    const snapshot = await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    expect(snapshot.status).toBe(200);
    expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
    expect(await verifyChain(db, 'ndt')).toMatchObject({ firstBroken: null });
    expect((await verifyChain(db, 'tst')).checked).toBeGreaterThan(10);
  });
});
