// Register rows of the risk side (build plan D.3, A-29, BR-22, F.6, WP-36): lists filtered by `ScopePolicy`, create
// and change of context issues, interested parties, assets and metrics, a Domain Owner who changes only own rows,
// shared rows with BR-22 confirmation and their system links (`ndt`, which has four systems), metric values,
// entity links with the primary rule, operating criteria, and the soft delete of WP-35's route for every kind.
import { CommandResult, pageOf, RegisterItem } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LicenceService } from '../../../src/modules/license/licence.service';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, createRiskApp, inOrg, linksOf, msIdOf, REGISTERS_URL, rowOf, sessionFor, verifyChain, type Client, type RegisterPage, type RiskApp,
} from './helpers';
import { entriesWithStatus } from '../commands-implementation/helpers';

const KINDS = [
  { register: 'context-issues', table: 'context_issue', body: { issueType: 'external', description: 'New sector regulation', lastReviewedAt: '2026-09-01' } },
  { register: 'interested-parties', table: 'interested_party', body: { requirements: 'Quarterly service reports', lastReviewedAt: '2026-08-15' } },
  { register: 'assets', table: 'asset', body: { assetType: 'infrastructure', classification: 'confidential' } },
  { register: 'risks', table: 'risk', body: { likelihood: 2, consequence: 3 } },
  { register: 'metrics', table: 'metric', body: { unit: '%', targetValue: 95, frequencyCode: 'monthly' } },
] as const;

describe('risk-side registers', () => {
  const db = useTestDatabase('demo');
  let ctx: RiskApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let rinaNdt: Client;
  let bagusNdt: Client;

  beforeAll(async () => {
    ctx = await createRiskApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
    bagusNdt = await sessionFor(ctx, db, 'bagus', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('create, list and change', () => {
    it('creates a row of every kind with its fields and lists it', async () => {
      for (const [index, kind] of KINDS.entries()) {
        const code = `WP36-${index}`;
        const response = await rina.post(REGISTERS_URL('isms', kind.register), { code, title: `Row of ${kind.register}`, ownerHandle: 'rina', ...kind.body });
        expect(response.status, `${kind.register}: ${JSON.stringify(response.body)}`).toBe(201);
        expect(CommandResult.safeParse(response.body).success).toBe(true);
        expect(response.body.ref).toMatchObject({ entityType: kind.table, code });
        const row = await rowOf(db, 'tst', kind.table, code);
        expect(await linksOf(db, 'tst', kind.table, row.id)).toEqual([expect.objectContaining({ slug: 'isms', primary: true })]);

        const list = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', kind.register)}?q=${code}`);
        expect(list.status).toBe(200);
        expect(pageOf(RegisterItem).safeParse(list.body).success).toBe(true);
        expect(list.body.items).toEqual([expect.objectContaining({ code, owner: 'rina', shared: false, ms: ['isms'], ref: expect.objectContaining({ id: row.id }) })]);
        const item = list.body.items[0]! as Record<string, unknown>;
        for (const [key, value] of Object.entries(kind.body)) expect(item[key], `${kind.register}.${key}`).toEqual(value);
      }
      // Chain kinds carry a status from their pending action (a new risk waits for a treatment, a metric for its first value).
      const risks = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', 'risks')}?q=WP36-3`);
      expect(risks.body.items[0]).toMatchObject({ status: 'open', riskProfileCode: 'information_security' });
      const ready = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', 'context-issues')}?status=ready&q=WP36`);
      expect(ready.body.items.map((i) => i.code)).toEqual(['WP36-0']);
    });

    it('validates lookups and register fields', async () => {
      expect((await rina.post(REGISTERS_URL('isms', 'metrics'), { code: 'WP36-M9', title: 'Bad frequency', ownerHandle: 'rina', frequencyCode: 'hourly' })).status).toBe(422);
      expect((await rina.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-A9', title: 'Bad field', ownerHandle: 'rina', likelihood: 3 })).status).toBe(400);
      expect((await rina.post(REGISTERS_URL('isms', 'metrics'), { code: 'WP36-M9', title: 'Read only', ownerHandle: 'rina', lastMeasuredAt: '2026-09-01' })).status).toBe(400);
      expect((await rina.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-0', title: 'Taken code', ownerHandle: 'rina' })).status).toBe(201);
      expect((await rina.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-0', title: 'Taken code', ownerHandle: 'rina' })).status).toBe(409);
      expect((await rina.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-A8', title: 'Stranger', ownerHandle: 'sari' })).status).toBe(422);
      // The path system must be one of the linked systems; an unknown system is 404.
      expect((await rina.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-A7', title: 'Elsewhere', ownerHandle: 'rina', linkedMs: ['qms'] })).status).toBe(422);
      expect((await rinaNdt.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-A7', title: 'Elsewhere', ownerHandle: 'rina', linkedMs: ['isms', 'nope'] })).status).toBe(404);
    });

    it('lets a Domain Owner create and change only own rows, and lists only own rows for them', async () => {
      // Own grant of register.manage: the new row's owner must be the caller (the default when no owner is named).
      expect((await bagus.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-B1', title: 'Somebody else', ownerHandle: 'rina' })).status).toBe(403);
      const own = await bagus.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-B1', title: 'Backup appliance', assetType: 'infrastructure' });
      expect(own.status).toBe(201);
      expect((await rowOf(db, 'tst', 'asset', 'WP36-B1')).owner).toBe('bagus');
      const changed = await bagus.patch(`${REGISTERS_URL('isms', 'assets')}/${own.body.ref!.id}`, { classification: 'restricted' }, { 'if-match': own.body.ref!.etag! });
      expect(changed.status).toBe(200);
      expect(changed.body.ref!.etag).not.toBe(own.body.ref!.etag);
      expect((await rowOf(db, 'tst', 'asset', 'WP36-B1')).row.classification).toBe('restricted');
      // Someone else's row, and handing the own row to someone else, are 403.
      const others = await rowOf(db, 'tst', 'asset', 'WP36-2');
      expect((await bagus.patch(`${REGISTERS_URL('isms', 'assets')}/${others.id}`, { title: 'Mine now' })).status).toBe(403);
      expect((await bagus.patch(`${REGISTERS_URL('isms', 'assets')}/${own.body.ref!.id}`, { ownerHandle: 'rina' })).status).toBe(403);
      // The Internal Auditor has no register.manage.
      expect((await maya.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-B2', title: 'x' })).status).toBe(403);
      // Lists: owner scoping keeps the Domain Owner's rows only; the MS Manager sees all.
      const mine = await bagus.get<RegisterPage>(REGISTERS_URL('isms', 'assets'));
      expect(mine.body.items.length).toBeGreaterThan(0);
      expect(mine.body.items.every((i) => i.owner === 'bagus')).toBe(true);
      const all = await rina.get<RegisterPage>(REGISTERS_URL('isms', 'assets'));
      expect(all.body.total).toBeGreaterThan(mine.body.total);
      const byOwner = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', 'assets')}?owner=bagus`);
      expect(byOwner.body.items.map((i) => i.code)).toEqual(mine.body.items.map((i) => i.code));
      // 412 with a stale If-Match, and a row of another organisation is 404.
      expect((await bagus.patch(`${REGISTERS_URL('isms', 'assets')}/${own.body.ref!.id}`, { title: 'x' }, { 'if-match': 'W/"1"' })).status).toBe(412);
      expect((await rinaNdt.patch(`${REGISTERS_URL('isms', 'assets')}/${own.body.ref!.id}`, { title: 'x' })).status).toBe(404);
      // An audit entry with the changed field only.
      expect((await auditOf(db, 'tst', own.body.ref!.id)).at(-1)).toMatchObject({
        action: 'register.updated', actor: 'bagus', before: { classification: null }, after: { classification: 'restricted' },
      });
    });

    it('pages the list', async () => {
      const first = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', 'risks')}?pageSize=2&page=1`);
      const second = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', 'risks')}?pageSize=2&page=2`);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.total).toBe(second.body.total);
      expect(second.body.items[0]!.code).not.toBe(first.body.items[0]!.code);
    });
  });

  describe('shared rows (BR-22, A-29)', () => {
    it('links a new row to several systems and asks for confirmation before changing it', async () => {
      const created = await rinaNdt.post(REGISTERS_URL('isms', 'context-issues'), {
        code: 'WP36-S1', title: 'Shared supplier concentration', ownerHandle: 'rina', issueType: 'external', linkedMs: ['isms', 'qms'],
      });
      expect(created.status).toBe(201);
      expect(created.body.changed).toEqual(['isms', 'qms']);
      const id = created.body.ref!.id;
      expect(await linksOf(db, 'ndt', 'context_issue', id)).toEqual([
        expect.objectContaining({ slug: 'isms', primary: true }), expect.objectContaining({ slug: 'qms', primary: false }),
      ]);
      // Visible from both systems, marked shared.
      const fromQms = await rinaNdt.get<RegisterPage>(`${REGISTERS_URL('qms', 'context-issues')}?q=WP36-S1`);
      expect(fromQms.body.items[0]).toMatchObject({ shared: true, ms: ['isms', 'qms'] });

      const unconfirmed = await rinaNdt.patch(`${REGISTERS_URL('isms', 'context-issues')}/${id}`, { title: 'Supplier concentration risk' });
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body).toMatchObject({ rule: 'BR-22', affected: ['qms'], type: expect.stringMatching(/confirmation-required$/) });
      expect(unconfirmed.body.messages!.en).toContain('QMS');
      expect((await rowOf(db, 'ndt', 'context_issue', 'WP36-S1')).row.title).toBe('Shared supplier concentration');
      const confirmed = await rinaNdt.patch(`${REGISTERS_URL('isms', 'context-issues')}/${id}`, { title: 'Supplier concentration risk', confirm: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.changed).toEqual(['isms', 'qms']);

      // Relinking: qms becomes primary, bcms joins, isms stays.
      const relinked = await rinaNdt.patch(`${REGISTERS_URL('isms', 'context-issues')}/${id}`, { linkedMs: ['qms', 'isms', 'bcms'], confirm: true });
      expect(relinked.status).toBe(200);
      expect(relinked.body.changed).toEqual(['bcms', 'isms', 'qms']);
      expect((await linksOf(db, 'ndt', 'context_issue', id)).map((l) => [l.slug, l.primary])).toEqual([['qms', true], ['bcms', false], ['isms', false]]);
      // The path system cannot be dropped through its own route.
      expect((await rinaNdt.patch(`${REGISTERS_URL('isms', 'context-issues')}/${id}`, { linkedMs: ['qms'], confirm: true })).status).toBe(422);
      // A row linked to one system needs no confirmation.
      const single = await rinaNdt.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-S2', title: 'Single', ownerHandle: 'rina' });
      expect((await rinaNdt.patch(`${REGISTERS_URL('isms', 'assets')}/${single.body.ref!.id}`, { title: 'Single asset' })).status).toBe(200);
    });

    it('needs the integrated_mode feature for a second system (LIC-FEATURE)', async () => {
      const licences = ctx.moduleRef.get(LicenceService);
      const original = licences.featureLicensed.bind(licences);
      const spy = vi.spyOn(licences, 'featureLicensed').mockImplementation((evaluated, feature) => feature !== 'integrated_mode' && original(evaluated, feature));
      try {
        const shared = await rinaNdt.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-L1', title: 'Shared asset', ownerHandle: 'rina', linkedMs: ['isms', 'qms'] });
        expect(shared.status).toBe(422);
        expect(shared.body.rule).toBe('LIC-FEATURE');
        expect((await rinaNdt.post('/api/v1/ms/bcms/entity-links', { entityType: 'risk', entityCode: 'R-022' })).body.rule).toBe('LIC-FEATURE');
        // One system needs no feature.
        expect((await rinaNdt.post(REGISTERS_URL('isms', 'assets'), { code: 'WP36-L1', title: 'Single asset', ownerHandle: 'rina' })).status).toBe(201);
      } finally {
        spy.mockRestore();
      }
    });

    it('links, re-primaries and unlinks a record through the entity link routes', async () => {
      const risk = await rowOf(db, 'ndt', 'risk', 'R-014');
      const before = await linksOf(db, 'ndt', 'risk', risk.id);
      expect(before.map((l) => l.slug)).toEqual(['isms']);
      // Only the MS Manager (entity_link.manage).
      expect((await bagusNdt.post('/api/v1/ms/bcms/entity-links', { entityType: 'risk', entityCode: 'R-014' })).status).toBe(403);
      const linked = await rinaNdt.post('/api/v1/ms/bcms/entity-links', { entityType: 'risk', entityCode: 'R-014', relevanceNote: 'Also a continuity risk' });
      expect(linked.status).toBe(201);
      expect(linked.body.changed).toEqual(['bcms', 'isms']);
      expect((await rinaNdt.post('/api/v1/ms/bcms/entity-links', { entityType: 'risk', entityCode: 'R-014' })).status).toBe(409);
      expect((await rinaNdt.post('/api/v1/ms/bcms/entity-links', { entityType: 'risk', entityCode: 'R-999' })).status).toBe(404);
      const linkId = (linked.body.data as { linkId: string }).linkId;
      // The risk is now visible from the BCMS register.
      const bcms = await rinaNdt.get<RegisterPage>(`${REGISTERS_URL('bcms', 'risks')}?q=R-014`);
      expect(bcms.body.items[0]).toMatchObject({ code: 'R-014', shared: true, ms: ['isms', 'bcms'] });

      // The primary link cannot be removed; after moving the primary, the old one can.
      const isms = before[0]!;
      expect((await rinaNdt.post(`/api/v1/ms/isms/entity-links/${isms.id}/remove`, { reason: 'Moving to BCMS' })).status).toBe(422);
      const primary = await rinaNdt.post(`/api/v1/ms/isms/entity-links/${linkId}/make-primary`, { reason: 'Continuity owns it' });
      expect(primary.status).toBe(200);
      expect((await linksOf(db, 'ndt', 'risk', risk.id)).map((l) => [l.slug, l.primary])).toEqual([['bcms', true], ['isms', false]]);
      const again = await rinaNdt.post(`/api/v1/ms/isms/entity-links/${linkId}/make-primary`, {});
      expect(again.status).toBe(200);
      expect(again.body.message![0]).toContain('already the primary');
      const removed = await rinaNdt.post(`/api/v1/ms/bcms/entity-links/${isms.id}/remove`, { reason: 'Moved to BCMS' });
      expect(removed.status).toBe(200);
      expect((await linksOf(db, 'ndt', 'risk', risk.id)).map((l) => l.slug)).toEqual(['bcms']);
      expect((await auditOf(db, 'ndt', risk.id)).map((a) => a.action)).toEqual(expect.arrayContaining(['entity_link.created', 'register.updated', 'entity_link.removed']));
      // The link of a record not linked to the path system is 404.
      expect((await rinaNdt.post(`/api/v1/ms/qms/entity-links/${linkId}/make-primary`, {})).status).toBe(404);
    });
  });

  describe('metric values', () => {
    it('records values, refuses overlapping periods and completes the metric action', async () => {
      const created = await rina.post(REGISTERS_URL('isms', 'metrics'), { code: 'WP36-M1', title: 'Patch SLA (%)', ownerHandle: 'bagus', unit: '%', targetValue: 95, frequencyCode: 'monthly' });
      expect(created.status).toBe(201);
      const id = created.body.ref!.id;
      expect((await rowOf(db, 'tst', 'metric', 'WP36-M1')).pending).toBe('Enter the first value');
      const recorded = await bagus.post(`/api/v1/ms/isms/metrics/${id}/values`, { periodStart: '2026-08-01', periodEnd: '2026-08-31', value: 93.5 });
      expect(recorded.status).toBe(201);
      const metric = await rowOf(db, 'tst', 'metric', 'WP36-M1');
      expect(metric.row).toMatchObject({ last_measured_at: '2026-08-31', pending_action: null });
      const overlap = await bagus.post(`/api/v1/ms/isms/metrics/${id}/values`, { periodStart: '2026-08-15', periodEnd: '2026-09-15', value: 90 });
      expect(overlap.status).toBe(422);
      expect((await bagus.post(`/api/v1/ms/isms/metrics/${id}/values`, { periodStart: '2026-09-01', periodEnd: '2026-09-30', value: 96 })).status).toBe(201);
      // An older period keeps the latest measurement date.
      expect((await bagus.post(`/api/v1/ms/isms/metrics/${id}/values`, { periodStart: '2026-07-01', periodEnd: '2026-07-31', value: 91 })).status).toBe(201);
      expect((await rowOf(db, 'tst', 'metric', 'WP36-M1')).row.last_measured_at).toBe('2026-09-30');
      // Someone else's metric (own grant) and no metric.record at all.
      const others = await rowOf(db, 'tst', 'metric', 'WP36-4');
      expect((await bagus.post(`/api/v1/ms/isms/metrics/${others.id}/values`, { periodStart: '2026-09-01', periodEnd: '2026-09-30', value: 1 })).status).toBe(403);
      expect((await maya.post(`/api/v1/ms/isms/metrics/${id}/values`, { periodStart: '2026-10-01', periodEnd: '2026-10-31', value: 1 })).status).toBe(403);
      expect((await auditOf(db, 'tst', id)).filter((a) => a.action === 'metric.value_recorded')).toHaveLength(3);
    });
  });

  describe('operating criteria', () => {
    it('sets the frequency of an entry and queues freshness.recompute', async () => {
      const [entry] = await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented');
      const url = `/api/v1/ms/isms/applicability/${entry!.id}/operating-criteria`;
      const queued = ctx.queue.waitingJobs('freshness.recompute').length;
      const response = await rina.request('PUT', url, { frequencyCode: 'weekly', description: 'Every Monday' });
      expect(response.status).toBe(200);
      expect(response.body.ref).toMatchObject({ entityType: 'applicability_entry', id: entry!.id, code: entry!.code });
      const criteria = await inOrg(db, 'tst', (trx) =>
        trx.selectFrom('operating_criteria').select(['frequency_code', 'description']).where('applicability_entry_id', '=', entry!.id).where('deleted_at', 'is', null).execute());
      expect(criteria).toEqual([{ frequency_code: 'weekly', description: 'Every Monday' }]);
      const jobs = ctx.queue.waitingJobs('freshness.recompute');
      expect(jobs.length).toBeGreaterThanOrEqual(Math.min(queued + 1, 1));
      expect(jobs.at(-1)!.env).toMatchObject({ payload: { msId: await msIdOf(db, 'tst', 'isms') } });
      expect((await auditOf(db, 'tst', entry!.id)).at(-1)).toMatchObject({ action: 'applicability.updated', after: { frequency_code: 'weekly', description: 'Every Monday' } });
      // The snapshot shows the new frequency.
      const snapshot = await rina.snapshot('isms');
      expect(snapshot.body.bundle.reqs.find((r) => r.id === entry!.code)).toMatchObject({ freq: 'weekly' });
      // Same values again change nothing.
      const same = await rina.request('PUT', url, { frequencyCode: 'weekly' });
      expect(same.status).toBe(200);
      expect(same.body.changed).toEqual([]);
      expect((await rina.request('PUT', url, { frequencyCode: 'hourly' })).status).toBe(422);
      expect((await bagus.request('PUT', url, { frequencyCode: 'monthly' })).status).toBe(403);
      expect((await rinaNdt.request('PUT', url, { frequencyCode: 'monthly' })).status).toBe(404);
    });
  });

  describe('soft delete through the record route (WP-35)', () => {
    it('deletes a row of every register kind and hides it from the lists', async () => {
      for (const [index, kind] of KINDS.entries()) {
        const code = `WP36-D${index}`;
        const created = await rina.post(REGISTERS_URL('isms', kind.register), { code, title: `To delete ${kind.register}`, ownerHandle: 'rina', ...kind.body });
        expect(created.status).toBe(201);
        const id = created.body.ref!.id;
        const deleted = await rina.post(`/api/v1/ms/isms/records/${kind.table}/${id}/delete`, { reason: 'Created by mistake during the test' });
        expect(deleted.status, `${kind.register}: ${JSON.stringify(deleted.body)}`).toBe(200);
        const list = await rina.get<RegisterPage>(`${REGISTERS_URL('isms', kind.register)}?q=${code}`);
        expect(list.body.items).toEqual([]);
        expect((await rina.patch(`${REGISTERS_URL('isms', kind.register)}/${id}`, { title: 'Gone' })).status).toBe(404);
        expect((await auditOf(db, 'tst', id)).at(-1)).toMatchObject({ action: 'record.deleted' });
      }
      // A risk with an open treatment keeps it (open dependants).
      const risk = await rina.post(REGISTERS_URL('isms', 'risks'), { code: 'WP36-D9', title: 'Has a treatment', ownerHandle: 'rina' });
      expect((await rina.post(`/api/v1/ms/isms/risks/${risk.body.ref!.id}/treatments`, {
        riskCode: 'WP36-D9', code: 'WP36-T9', title: 'Open treatment', ownerHandle: 'rina', targetType: 'catalogue_item', targetCode: 'A.5.1', targetDate: '2026-12-31',
      })).status).toBe(201);
      expect((await rina.post(`/api/v1/ms/isms/records/risk/${risk.body.ref!.id}/delete`, { reason: 'Should not be possible yet' })).status).toBe(422);
    });
  });

  it('keeps the audit chains verifiable', async () => {
    for (const org of ['tst', 'ndt'] as const) expect((await verifyChain(db, org)).firstBroken).toBeNull();
  });
});
