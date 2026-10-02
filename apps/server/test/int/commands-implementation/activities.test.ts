// Activity and phase commands (build plan D.3, C.13, D-13, A.4 5.4 and 5.12, A-48, WP-20) on the `tst` ISMS:
// success, 409, 412, 422 and 404 paths of `POST /ms/{ms}/activities/{id}/transitions` and
// `POST /ms/{ms}/phases/{n}/verify`, the rules BR-12, BR-39, BR-40, BR-47, VERIFY-SELF and the BR-46 flag, own
// grants, the two audit entries from not started to complete, and the audit chain after the run.
import { randomUUID } from 'node:crypto';
import { CommandResult, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../../../src/modules/implementation/activity.service';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import {
  ACTIVITY_URL, activitiesWithStatus, activityOf, auditOf, createCommandsApp, grantRole, inOrg, ORG_IDS, sessionFor, userId, verifyChain,
  type Client, type CommandsApp,
} from './helpers';

const TODAY = '2026-09-29';

describe('activity and phase commands', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let hendra: Client;
  let maya: Client;
  let rinaNdt: Client;

  /** Sets columns of an activity directly (fixtures). */
  async function setActivity(no: string, values: { status?: string; owner?: string | null; out?: string | null; doc?: string | null; blocker?: string | null }) {
    const [phase, activity] = no.split('.').map(Number);
    const owner = values.owner === undefined ? undefined : values.owner === null ? null : await userId(db, values.owner);
    await inOrg(db, 'tst', async (trx) => {
      const doc = values.doc === undefined ? undefined : values.doc === null ? null
        : (await sql<{ id: string }>`select id from document where doc_code = ${values.doc} and deleted_at is null`.execute(trx)).rows[0]!.id;
      await sql`update implementation_activity_progress set
                  status = coalesce(${values.status ?? null}, status),
                  owner_user_id = case when ${owner !== undefined} then ${owner ?? null}::uuid else owner_user_id end,
                  output_document_code = case when ${values.out !== undefined} then ${values.out ?? null} else output_document_code end,
                  output_document_id = case when ${doc !== undefined} then ${doc ?? null}::uuid else output_document_id end,
                  blocker_gate_item_ref = case when ${values.blocker !== undefined} then ${values.blocker ?? null} else blocker_gate_item_ref end,
                  blocker_reason = case when ${values.blocker !== undefined} then (case when ${values.blocker ?? null}::text is null then null else 'Blocked by gate item ' || ${values.blocker ?? null} end) else blocker_reason end,
                  completed_by_user_id = case when ${values.status !== undefined} then null else completed_by_user_id end,
                  completed_at = case when ${values.status !== undefined} then null else completed_at end,
                  verified_at = case when ${values.status !== undefined} then null else verified_at end,
                  verified_by_user_id = case when ${values.status !== undefined} then null else verified_by_user_id end
                where phase_no = ${phase} and activity_no = ${activity}
                  and management_system_id = (select id from management_system where slug = 'isms')`.execute(trx);
    });
    return activityOf(db, 'tst', 'isms', no);
  }

  beforeAll(async () => {
    ctx = await createCommandsApp(db);
    await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('completes an activity in progress: completer, date, audit entry, ETag and snapshot', async () => {
    const act = await setActivity('9.4', { owner: 'bagus', out: null, doc: null });
    expect(act.status).toBe('in_progress');
    const response = await rina.post(ACTIVITY_URL('isms', act.id), { to: 'complete' });
    expect(response.status).toBe(200);
    expect(CommandResult.safeParse(response.body).success).toBe(true);
    expect(response.body).toMatchObject({ changed: ['isms'], ref: { entityType: 'implementation_activity_progress', id: act.id, code: '9.4' } });
    expect(await activityOf(db, 'tst', 'isms', '9.4')).toMatchObject({ status: 'complete', completedBy: 'rina' });
    const audit = await auditOf(db, 'tst', act.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'activity.transition', actor: 'rina', before: { status: 'in_progress' }, after: expect.objectContaining({ status: 'complete', completed_at: TODAY }) });
    const snapshot = await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    const phase9 = snapshot.body.bundle.phases.find((p) => p.no === 9)!;
    expect(phase9.acts.find((a) => a.no === '9.4')).toMatchObject({ st: 'complete', by: 'rina' });
    expect(snapshot.body.refs['isms:act:9.4']!.etag).toBe(response.body.ref!.etag);
  });

  it('VERIFY-SELF: the completer cannot verify; another verifier can, and the owner cannot (A-48)', async () => {
    const act = await activityOf(db, 'tst', 'isms', '9.4');
    const self = await rina.post(ACTIVITY_URL('isms', act.id), { to: 'verified' });
    expect(self.status).toBe(422);
    expect(self.body).toMatchObject({ rule: 'VERIFY-SELF', messageKey: 'rule.VERIFY-SELF' });
    const ok = await hendra.post(ACTIVITY_URL('isms', act.id), { to: 'verified' });
    expect(ok.status).toBe(200);
    expect(await activityOf(db, 'tst', 'isms', '9.4')).toMatchObject({ status: 'verified' });
    // The MS Manager owns 9.6 and Bagus completes it: the owner may not verify (TS 6.6), the Programme Owner may.
    const owned = await setActivity('9.6', { owner: 'rina', out: null, doc: null });
    await setActivity('9.6', { owner: 'bagus' });
    expect((await bagus.post(ACTIVITY_URL('isms', owned.id), { to: 'complete' })).status).toBe(200);
    await setActivity('9.6', { owner: 'rina' });
    const ownerVerify = await rina.post(ACTIVITY_URL('isms', owned.id), { to: 'verified' });
    expect(ownerVerify.status).toBe(422);
    expect(ownerVerify.body.rule).toBe('VERIFY-SELF');
    expect((await hendra.post(ACTIVITY_URL('isms', owned.id), { to: 'verified' })).status).toBe(200);
  });

  it('rejects a completed activity back to in progress only with a reason', async () => {
    const act = await setActivity('9.5', { status: 'in_progress', owner: 'bagus', out: null, doc: null });
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete' })).status).toBe(200);
    const noReason = await rina.post(ACTIVITY_URL('isms', act.id), { to: 'in_progress' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors).toEqual([{ path: 'body.rejectReason', message: expect.any(String) }]);
    const rejected = await rina.post(ACTIVITY_URL('isms', act.id), { to: 'in_progress', rejectReason: 'Output not approved' });
    expect(rejected.status).toBe(200);
    expect(await activityOf(db, 'tst', 'isms', '9.5')).toMatchObject({ status: 'in_progress', completedBy: null });
    expect((await auditOf(db, 'tst', act.id)).at(-1)).toMatchObject({ after: expect.objectContaining({ reject_reason: 'Output not approved' }) });
    // The owner (own grant) cannot reject: the row needs activity.verify.
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete' })).status).toBe(200);
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'in_progress', rejectReason: 'x' })).status).toBe(403);
  });

  it('BR-40: a controlled-document output is linked before completion (request code, template code or 422)', async () => {
    const act = await setActivity('9.7', { status: 'in_progress', owner: 'bagus', out: 'XX-404', doc: null });
    const missing = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete' });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ rule: 'BR-40', messages: { en: 'Link the output document from the register before marking this complete.' } });
    const unknown = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete', outputDocumentCode: 'NOPE-1' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.rule).toBe('BR-40');
    const linked = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete', outputDocumentCode: 'POL-01' });
    expect(linked.status).toBe(200);
    const after = await activityOf(db, 'tst', 'isms', '9.7');
    expect(after.status).toBe('complete');
    expect(after.outputDocumentId).not.toBeNull();
    // The template code names a register document: it is linked without a request code.
    const auto = await setActivity('9.1', { status: 'in_progress', owner: 'bagus', out: 'POL-01', doc: null });
    expect((await bagus.post(ACTIVITY_URL('isms', auto.id), { to: 'complete' })).status).toBe(200);
    expect((await activityOf(db, 'tst', 'isms', '9.1')).outputDocumentId).toBe(after.outputDocumentId);
  });

  it('BR-12: an activity behind a critical gate that has not passed stays locked; from not started to complete writes two audit entries', async () => {
    // Phase 4 of the ISMS is the critical gate and holds blocked activities.
    const behindGate = await setActivity('9.3', { status: 'not_started', owner: 'bagus', out: null, doc: null });
    const start = await bagus.post(ACTIVITY_URL('isms', behindGate.id), { to: 'in_progress' });
    expect(start.status).toBe(422);
    expect(start.body).toMatchObject({ rule: 'BR-12', messages: { en: expect.stringMatching(/critical gate phase 4/), id: expect.stringMatching(/fase gerbang kritis 4/) } });
    expect((await bagus.post(ACTIVITY_URL('isms', behindGate.id), { to: 'complete' })).body.rule).toBe('BR-12');
    // Phase 2 has no critical gate before it: not started to complete in one command (A.4 5.12).
    const early = await setActivity('2.1', { status: 'not_started', owner: 'bagus', out: null, doc: null });
    const done = await bagus.post(ACTIVITY_URL('isms', early.id), { to: 'complete' });
    expect(done.status).toBe(200);
    const audit = await auditOf(db, 'tst', early.id);
    expect(audit.map((a) => [a.before?.status, a.after?.status])).toEqual([['not_started', 'in_progress'], ['in_progress', 'complete']]);
  });

  it('BR-39: a block names a current gate item; BR-47 warns when the approved output contradicts it; the owner unblocks', async () => {
    const act = await setActivity('9.2', { status: 'in_progress', owner: 'bagus', out: 'POL-01', doc: 'POL-01' });
    const unknown = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'blocked', blockerGateItemRef: 'A.9.99', blockerReason: 'Waiting for the access review' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.rule).toBe('BR-39');
    const incomplete = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'blocked', blockerReason: 'Waiting' });
    expect(incomplete.status).toBe(400);
    const snapshot = await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    const gate = snapshot.body.bundle.gates[0]!.id;
    const blocked = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'blocked', blockerGateItemRef: gate, blockerReason: 'Waiting for the gate item' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.warnings).toEqual([{ rule: 'BR-47', messages: { en: 'Document status and activity status do not match. Check one of them.', id: expect.any(String) } }]);
    expect(await activityOf(db, 'tst', 'isms', '9.2')).toMatchObject({ status: 'blocked', blockerRef: gate });
    const unblocked = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'in_progress' });
    expect(unblocked.status).toBe(200);
    expect(await activityOf(db, 'tst', 'isms', '9.2')).toMatchObject({ status: 'in_progress', blockerRef: null });
  });

  it('BR-12 also holds on the way through blocked: an activity blocked before it started stays locked behind the gate', async () => {
    // 9.3 has no audit history and no completion: it was never started.
    const act = await setActivity('9.3', { status: 'not_started', owner: 'bagus', out: null, doc: null, blocker: null });
    const snapshot = await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    const gate = snapshot.body.bundle.gates[0]!.id;
    const blocked = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'blocked', blockerGateItemRef: gate, blockerReason: 'Waiting for the gate item' });
    expect(blocked.status).toBe(200);
    const unblocked = await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'in_progress' });
    expect(unblocked.status).toBe(422);
    expect(unblocked.body).toMatchObject({ rule: 'BR-12', messages: { en: expect.stringMatching(/critical gate phase 4/) } });
    expect(await activityOf(db, 'tst', 'isms', '9.3')).toMatchObject({ status: 'blocked', blockerRef: gate });
  });

  it('clears the completion when a completed activity is blocked and then taken up again', async () => {
    const act = await setActivity('2.2', { status: 'in_progress', owner: 'bagus', out: null, doc: null, blocker: null });
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete' })).status).toBe(200);
    const snapshot = await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    const gate = snapshot.body.bundle.gates[0]!.id;
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'blocked', blockerGateItemRef: gate, blockerReason: 'Waiting' })).status).toBe(200);
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'in_progress' })).status).toBe(200);
    const row = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ completed_at: string | null; completed_by_user_id: string | null }>`
        select completed_at, completed_by_user_id from implementation_activity_progress where id = ${act.id}`.execute(trx)).rows[0]!,
    );
    expect(row).toEqual({ completed_at: null, completed_by_user_id: null });
  });

  it('answers 409 for pairs C.13 does not list, 403 for someone else\'s activity, 412 for a stale ETag and 404 across systems', async () => {
    const verified = await activityOf(db, 'tst', 'isms', '5.1');
    expect(verified.status).toBe('verified');
    const toBlocked = await rina.post(ACTIVITY_URL('isms', verified.id), { to: 'blocked', blockerGateItemRef: 'A.8.12', blockerReason: 'x' });
    expect(toBlocked.status).toBe(409);
    expect(toBlocked.body.type).toMatch(/transition-not-allowed$/);
    const ns = await setActivity('5.2', { status: 'not_started', owner: 'hendra' });
    expect((await rina.post(ACTIVITY_URL('isms', ns.id), { to: 'verified' })).status).toBe(409);
    // A Domain Owner on an activity owned by someone else (own grant only).
    const others = await setActivity('5.3', { status: 'in_progress', owner: 'hendra', out: null, doc: null });
    expect((await bagus.post(ACTIVITY_URL('isms', others.id), { to: 'complete' })).status).toBe(403);
    expect((await maya.post(ACTIVITY_URL('isms', others.id), { to: 'complete' })).status).toBe(403);
    expect((await rina.post(ACTIVITY_URL('isms', others.id), { to: 'complete' }, { 'if-match': 'W/"42"' })).status).toBe(412);
    expect((await activityOf(db, 'tst', 'isms', '5.3')).status).toBe('in_progress');
    const qms = await activitiesWithStatus(db, 'ndt', 'qms', 'in_progress');
    expect((await rinaNdt.post(ACTIVITY_URL('isms', qms[0]!.id), { to: 'complete' })).status).toBe(404);
    expect((await rina.post(ACTIVITY_URL('isms', randomUUID()), { to: 'complete' })).status).toBe(404);
  });

  it('verifies a phase once (phase.verified), then answers that it is already verified; BR-12 when not all are verified', async () => {
    const phaseEntries = () =>
      inOrg(db, 'tst', async (trx) =>
        (await sql<{ n: number }>`select count(*)::int as n from audit_trail where action = 'phase.verified' and entity_code = '3'`.execute(trx)).rows[0]!.n,
      );
    // D.3: a phase seeded as verified has nothing to confirm (WP-30 fix of WP-27 follow-up 2).
    const seeded = await rina.post('/api/v1/ms/isms/phases/3/verify');
    expect(seeded.status).toBe(200);
    expect(seeded.body).toMatchObject({ ok: true, changed: [], message: ['Phase 3 is already verified', 'Fase 3 sudah terverifikasi'] });
    expect(await phaseEntries()).toBe(0);
    const open = await rina.post('/api/v1/ms/isms/phases/9/verify');
    expect(open.status).toBe(422);
    expect(open.body).toMatchObject({ rule: 'BR-12', messages: { en: 'Phase verification needs all activities Verified', id: 'Verifikasi fase memerlukan semua aktivitas Terverifikasi' } });
    expect((await rina.post('/api/v1/ms/isms/phases/42/verify')).status).toBe(404);
    expect((await bagus.post('/api/v1/ms/isms/phases/3/verify')).status).toBe(403);
    // A change in the phase after the confirmation asks for a new one.
    const act = await setActivity('3.1', { status: 'in_progress', owner: 'bagus', out: null, doc: null });
    expect((await bagus.post(ACTIVITY_URL('isms', act.id), { to: 'complete' })).status).toBe(200);
    expect((await hendra.post(ACTIVITY_URL('isms', act.id), { to: 'verified' })).status).toBe(200);
    const first = await rina.post('/api/v1/ms/isms/phases/3/verify');
    expect(first.body).toMatchObject({ ok: true, changed: [], message: ['Phase 3 verified', 'Fase 3 terverifikasi'] });
    const again = await rina.post('/api/v1/ms/isms/phases/3/verify');
    expect(again.body.message).toEqual(['Phase 3 is already verified', 'Fase 3 sudah terverifikasi']);
    expect(await phaseEntries()).toBe(1);
  });

  it('BR-46: flags a gate phase whose blocked activities do not match the open gate items', async () => {
    const service = ctx.moduleRef.get(ActivityService);
    const scope = ctx.moduleRef.get(TenantScope);
    const org = await ctx.moduleRef.get(TenantResolver).resolve('tst');
    const check = () => scope.withTenant({ orgId: ORG_IDS.tst, schema: 'org_tst', userId: '00000000-0000-0000-0000-000000000001' }, (trx) => service.gateConsistencyIn(trx, org!, 'isms'));
    const before = await check();
    expect(before.gatePhases).toEqual([4]);
    expect(before.blockedActivities).toBe(before.openGateItems);
    expect(before.finding).toBeNull();
    await setActivity('4.5', { status: 'in_progress', blocker: null });
    const after = await check();
    expect(after.blockedActivities).toBe(before.blockedActivities - 1);
    expect(after.finding).toMatchObject({ rule: 'BR-46', severity: 'flag', messages: { en: expect.stringMatching(/blocked activities does not match/) } });
  });

  it('keeps the audit chain intact after the run', async () => {
    expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
  });
});
