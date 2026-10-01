// Evidence records and targets (build plan D.3, E.3, BR-22, BR-23, WP-36): a new evidence record with targets is
// visible in `GET /ui/ms/{ms}` and gets its stored freshness from `freshness.recompute`; changes ask for BR-22
// confirmation once the evidence serves several systems; a target reached through a mapping marked not reusable
// returns the BR-23 warning; the last target cannot be removed; a Domain Owner manages only own evidence.
import { CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { auditOf, createRiskApp, inOrg, linksOf, msIdOf, rowOf, sessionFor, verifyChain, type Client, type RiskApp } from './helpers';

describe('evidence records and targets', () => {
  const db = useTestDatabase('demo');
  let ctx: RiskApp;
  let rina: Client;
  let bagus: Client;
  let rinaNdt: Client;

  beforeAll(async () => {
    ctx = await createRiskApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('creates evidence with targets that the read model shows and freshness derives', async () => {
    const queued = ctx.queue.waitingJobs('freshness.recompute').length;
    const created = await rina.post('/api/v1/ms/isms/evidence', {
      code: 'EV-9000', title: 'Quarterly backup restore test', ownerHandle: 'rina', frequencyCode: 'quarterly', classification: 'internal',
      targets: [{ targetType: 'catalogue_item', code: 'A.8.13' }, { targetType: 'catalogue_item', code: 'A.8.14' }],
    });
    expect(created.status).toBe(201);
    expect(CommandResult.safeParse(created.body).success).toBe(true);
    expect(created.body).toMatchObject({ changed: ['isms'], ref: { module: 'surveillance', entityType: 'evidence', code: 'EV-9000' } });
    const id = created.body.ref!.id;
    const msId = await msIdOf(db, 'tst', 'isms');
    expect(await linksOf(db, 'tst', 'evidence', id)).toEqual([expect.objectContaining({ slug: 'isms', primary: true })]);
    const jobs = ctx.queue.waitingJobs('freshness.recompute');
    expect(jobs.length).toBeGreaterThanOrEqual(Math.min(queued + 1, 1));
    expect(jobs.at(-1)!.env).toMatchObject({ payload: { msId, evidenceIds: [id] } });

    // The bundle lists it for both targets' system; nothing was ever produced, so it is critical (E.3).
    let snapshot = (await rina.snapshot('isms')).body;
    const ev = snapshot.bundle.evs.find((e) => e.code === 'EV-9000');
    expect(ev).toMatchObject({ title: 'Quarterly backup restore test', owner: 'rina', freq: 'quarterly', fresh: 'critical' });
    expect(snapshot.refs['isms:ev:EV-9000']).toMatchObject({ id });

    // The freshness job stores the derived state.
    expect((await rowOf(db, 'tst', 'evidence', 'EV-9000')).row.freshness_status).toBeNull();
    await ctx.recompute('tst', { msId, evidenceIds: [id] });
    expect((await rowOf(db, 'tst', 'evidence', 'EV-9000')).row).toMatchObject({ freshness_status: 'critical', integrity_status: 'ok' });
    // A production date of today makes it fresh after the next recompute.
    await inOrg(db, 'tst', (trx) => sql`update evidence set produced_at = '2026-09-29', external_ref = 'https://example.test/restore-test' where id = ${id}`.execute(trx));
    await ctx.recompute('tst', { msId, evidenceIds: [id] });
    expect((await rowOf(db, 'tst', 'evidence', 'EV-9000')).row.freshness_status).toBe('fresh');
    snapshot = (await rina.snapshot('isms')).body;
    expect(snapshot.bundle.evs.find((e) => e.code === 'EV-9000')).toMatchObject({ fresh: 'fresh', prod: '2026-09-29' });
    expect((await auditOf(db, 'tst', id))[0]).toMatchObject({ action: 'evidence.created', actor: 'rina' });
  });

  it('rejects unknown targets, duplicate codes, unknown frequencies and foreign owners', async () => {
    const base = { title: 'x', ownerHandle: 'rina', frequencyCode: 'monthly', classification: 'internal' };
    expect((await rina.post('/api/v1/ms/isms/evidence', { ...base, code: 'EV-9001', targets: [{ targetType: 'catalogue_item', code: 'A.99.9' }] })).status).toBe(422);
    expect((await rina.post('/api/v1/ms/isms/evidence', { ...base, code: 'EV-9001', targets: [{ targetType: 'requirement', code: '7.5' }] })).status).toBe(422);
    expect((await rina.post('/api/v1/ms/isms/evidence', { ...base, code: 'EV-9000', targets: [{ targetType: 'catalogue_item', code: 'A.8.13' }] })).status).toBe(409);
    expect((await rina.post('/api/v1/ms/isms/evidence', { ...base, code: 'EV-9001', frequencyCode: 'hourly', targets: [{ targetType: 'catalogue_item', code: 'A.8.13' }] })).status).toBe(422);
    // A Domain Owner adds evidence only as its owner.
    expect((await bagus.post('/api/v1/ms/isms/evidence', { ...base, code: 'EV-9001', targets: [{ targetType: 'catalogue_item', code: 'A.8.13' }] })).status).toBe(403);
    const own = await bagus.post('/api/v1/ms/isms/evidence', { ...base, ownerHandle: 'bagus', code: 'EV-9001', targets: [{ targetType: 'catalogue_item', code: 'A.8.13' }] });
    expect(own.status).toBe(201);
    // ... and changes only own evidence.
    const others = await rowOf(db, 'tst', 'evidence', 'EV-9000');
    expect((await bagus.patch(`/api/v1/ms/isms/evidence/${others.id}`, { title: 'Mine' })).status).toBe(403);
    expect((await bagus.patch(`/api/v1/ms/isms/evidence/${own.body.ref!.id}`, { title: 'Firewall review' })).status).toBe(200);
  });

  it('changes evidence with If-Match and queues the recompute', async () => {
    const row = await rowOf(db, 'tst', 'evidence', 'EV-9000');
    expect((await rina.patch(`/api/v1/ms/isms/evidence/${row.id}`, { frequencyCode: 'monthly' }, { 'if-match': 'W/"1"' })).status).toBe(412);
    const queued = ctx.queue.waitingJobs('freshness.recompute').length;
    const changed = await rina.patch(`/api/v1/ms/isms/evidence/${row.id}`, { frequencyCode: 'monthly', nextDueOverride: '2026-10-31' }, { 'if-match': `W/"${row.updatedAt.getTime()}"` });
    expect(changed.status).toBe(200);
    expect((await rowOf(db, 'tst', 'evidence', 'EV-9000')).row).toMatchObject({ frequency_code: 'monthly', next_due_override: '2026-10-31' });
    expect(ctx.queue.waitingJobs('freshness.recompute').length).toBeGreaterThanOrEqual(Math.min(queued + 1, 1));
    expect((await auditOf(db, 'tst', row.id)).at(-1)).toMatchObject({ action: 'evidence.updated', after: { frequency_code: 'monthly', next_due_override: '2026-10-31' } });
  });

  it('adds targets in other systems with the BR-23 warning for a non-reusable mapping, then asks for BR-22 confirmation', async () => {
    // Mappings between the QMS clause 7.5 and the clauses 7.5 of the BCMS (not reusable) and the ABMS (reusable).
    const mappings = await inOrg(db, 'ndt', async (trx) => {
      const { rows } = await sql<{ slug: string; requirement_id: string }>`
        select m.slug, r.id as requirement_id from management_system m
          join ref.requirement r on r.framework_version_id = m.framework_version_id and r.requirement_code = '7.5'
         where m.slug in ('qms', 'bcms', 'abms') and m.deleted_at is null`.execute(trx);
      return Object.fromEntries(rows.map((r) => [r.slug, r.requirement_id]));
    });
    expect(Object.keys(mappings).sort()).toEqual(['abms', 'bcms', 'qms']);
    await inScope(db.migrator, { platformScope: true }, async (trx) => {
      await sql`insert into ref.requirement_mapping (source_requirement_id, target_requirement_id, mapping_type, evidence_reusable)
                values (${mappings.qms}, ${mappings.bcms}, 'partial', false), (${mappings.abms}, ${mappings.qms}, 'equivalent', true)`.execute(trx);
    });

    const created = await rinaNdt.post('/api/v1/ms/qms/evidence', {
      code: 'EV-9100', title: 'Document control register extract', ownerHandle: 'rina', frequencyCode: 'quarterly', classification: 'internal',
      targets: [{ targetType: 'requirement', code: '7.5' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.ref!.id;
    const url = `/api/v1/ms/qms/evidence/${id}/targets`;

    // A reusable mapping: no warning; the evidence joins the ABMS.
    const reusable = await rinaNdt.post(url, { ms: 'abms', targetType: 'requirement', code: '7.5', mappingNote: 'Same document control process' });
    expect(reusable.status).toBe(201);
    expect(reusable.body.warnings).toBeUndefined();
    expect(reusable.body.changed).toEqual(['abms', 'qms']);
    expect((await linksOf(db, 'ndt', 'evidence', id)).map((l) => [l.slug, l.primary])).toEqual([['qms', true], ['abms', false]]);
    expect((await rinaNdt.post(url, { ms: 'abms', targetType: 'requirement', code: '7.5' })).status).toBe(409);
    expect((await rinaNdt.post(url, { ms: 'abms', targetType: 'requirement', code: '99.9' })).status).toBe(422);
    expect((await rinaNdt.post(url, { ms: 'nope', targetType: 'requirement', code: '7.5' })).status).toBe(404);

    // A mapping marked not reusable: BR-23 warning, the target is still added.
    const warned = await rinaNdt.post(url, { ms: 'bcms', targetType: 'requirement', code: '7.5' });
    expect(warned.status).toBe(201);
    expect(warned.body.warnings).toEqual([{ rule: 'BR-23', messages: expect.objectContaining({ en: expect.stringContaining('similar but not identical') }) }]);
    const targetId = (warned.body.data as { targetId: string }).targetId;
    expect((await auditOf(db, 'ndt', id)).at(-1)).toMatchObject({ action: 'evidence.target_added', after: expect.objectContaining({ target: 'bcms:7.5' }) });

    // Visible in the BCMS bundle now.
    const bcms = (await rinaNdt.snapshot('bcms')).body;
    expect(bcms.bundle.evs.some((e) => e.code === 'EV-9100')).toBe(true);

    // Shared evidence: a change needs confirmation (BR-22).
    const unconfirmed = await rinaNdt.patch(`/api/v1/ms/qms/evidence/${id}`, { title: 'Document control register (extract)' });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({ rule: 'BR-22', affected: ['abms', 'bcms'] });
    const confirmed = await rinaNdt.patch(`/api/v1/ms/qms/evidence/${id}`, { title: 'Document control register (extract)', confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.changed).toEqual(['abms', 'bcms', 'qms']);

    // Removing targets: the BCMS one (its link goes too), never the last one.
    const removed = await rinaNdt.post(`${url}/${targetId}/remove`, { reason: 'Mapping not reusable' });
    expect(removed.status).toBe(200);
    expect((await linksOf(db, 'ndt', 'evidence', id)).map((l) => l.slug)).toEqual(['qms', 'abms']);
    const abmsTarget = await inOrg(db, 'ndt', async (trx) =>
      (await sql<{ id: string; slug: string }>`select t.id, m.slug from evidence_target t join management_system m on m.id = t.management_system_id
        where t.evidence_id = ${id} and t.deleted_at is null order by t.position`.execute(trx)).rows);
    expect(abmsTarget.map((t) => t.slug)).toEqual(['qms', 'abms']);
    expect((await rinaNdt.post(`${url}/${abmsTarget[1]!.id}/remove`, { reason: 'Not needed' })).status).toBe(200);
    const last = await rinaNdt.post(`${url}/${abmsTarget[0]!.id}/remove`, { reason: 'Not needed' });
    expect(last.status).toBe(422);
    expect((await rinaNdt.post(`${url}/${targetId}/remove`, { reason: 'Again' })).status).toBe(404);
  });

  it('keeps the audit chains verifiable', async () => {
    for (const org of ['tst', 'ndt'] as const) expect((await verifyChain(db, org)).firstBroken).toBeNull();
  });
});
