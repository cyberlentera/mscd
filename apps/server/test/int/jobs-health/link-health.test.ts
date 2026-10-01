// `link-health.check`, `link-health.plan` and `POST /ms/{ms}/link-health/run` (build plan E.2, E.4, TS 5.5, TS 5.7)
// on a copy of the demo template (organisation ndt, `demo.fixed_today` 2026-09-29) against the storage gateway and
// the mock providers with the demo fixtures (G.8): every fault switch of the mock gives its E.4 status and the
// right notification, throttling leaves statuses alone and reschedules the rest of the batch after Retry-After, the
// validity windows decide the stored integrity, the plan selects due objects by priority, and the on-demand run
// tracks its background task.
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessRuleError } from '../../../src/common/problems';
import { LICENCE_GATE, type LicenceGate } from '../../../src/common/tokens';
import { LINK_CHECK_RETRY_LIMIT, LinkHealthService } from '../../../src/modules/link-health/link-health.service';
import { TenantJobRunner } from '../../../src/modules/jobs/tenant-job';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import {
  NOON,
  ORG_IDS,
  createHealthApp,
  evidenceObject,
  mockAdmin,
  objectState,
  repositoryId,
  rows,
  sessionFor,
  startProviderStack,
  type HealthApp,
  type ProviderStack,
} from './helpers';

const NDT = ORG_IDS.ndt;
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(new Date(NOON).getTime() - hours * HOUR);

describe('link health check (E.4)', () => {
  const db = useTestDatabase('demo');
  let stack: ProviderStack;
  let ctx: HealthApp;
  /** Intact SharePoint evidence of the ISMS, one per test that changes a file. */
  let spare: { code: string; owner: string; version: string }[] = [];
  const take = () => spare.shift()!;

  const check = async (ids: string[], repository = 'sp', options: { delayed?: boolean; taskId?: string } = {}) => {
    await ctx.run(
      'link-health.check',
      { orgId: NDT, payload: { repositoryId: await repositoryId(db, 'ndt', repository), storageObjectIds: ids, ...(options.taskId ? { taskId: options.taskId } : {}) } },
      { delayed: options.delayed },
    );
  };
  const notificationsFor = (kind: string, entityId: string) =>
    rows<{ recipient_user_id: string; digest: boolean; title_en: string }>(
      db,
      'ndt',
      sql`SELECT recipient_user_id, digest, title_en FROM notification WHERE kind = ${kind} AND entity_ref->>'id' = ${entityId}`,
    );
  const results = (objectId: string) =>
    rows<{ outcome: string; status_before: string; status_after: string; job_id: string | null }>(
      db,
      'ndt',
      sql`SELECT outcome, status_before, status_after, job_id FROM link_health_result WHERE storage_object_id = ${objectId}::uuid ORDER BY checked_at, id`,
    );
  const integrity = async (evidenceId: string) =>
    (await rows<{ integrity_status: string | null }>(db, 'ndt', sql`SELECT integrity_status FROM evidence WHERE id = ${evidenceId}::uuid`))[0]!.integrity_status;

  beforeAll(async () => {
    stack = await startProviderStack();
    ctx = await createHealthApp(db, stack);
    spare = await rows<{ code: string; owner: string; version: string }>(
      db,
      'ndt',
      sql`SELECT e.evidence_code AS code, e.owner_user_id AS owner, o.external_version_id AS version
          FROM evidence e JOIN storage_object o ON o.id = e.storage_object_id JOIN storage_repository r ON r.id = o.storage_repository_id
          WHERE r.slug = 'sp' AND o.link_status = 'intact' AND e.owner_user_id IS NOT NULL AND e.deleted_at IS NULL
            AND o.external_version_id <> '1.0'
          ORDER BY e.evidence_code LIMIT 20`,
    );
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });
  beforeEach(async () => {
    await mockAdmin(stack.mock, '/_admin/reset');
    ctx.gateway.script = null;
    ctx.setNow(NOON);
  });

  it('keeps intact files intact, records the check time and reads folders written with spaces as the same folder', async () => {
    const before = await evidenceObject(db, 'ndt', 'EV-0100');
    expect(before.folder_path).toBe('Compliance / ISMS / Evidence / 2026 / Q3');
    await check([before.id]);
    const after = await objectState(db, 'ndt', before.id);
    expect(after).toMatchObject({ link_status: 'intact', folder_path: before.folder_path, link_status_since: before.link_status_since });
    expect(after.last_verified_at?.toISOString()).toBe(new Date(NOON).toISOString());
    expect(after.last_good_check_at?.toISOString()).toBe(new Date(NOON).toISOString());
    expect(await results(before.id)).toEqual([]);
    expect(ctx.queue.failed()).toEqual([]);
  });

  it('a file moved in the provider becomes moved, follows the folder and stays moved', async () => {
    const { code } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, `/_admin/items/${object.external_item_id}/move`);
    await check([object.id]);
    const after = await objectState(db, 'ndt', object.id);
    expect(after.link_status).toBe('moved');
    expect(after.folder_path).toBe('Compliance/ISMS/Evidence/2026/Q3/Moved');
    expect(after.link_status_since.toISOString()).toBe(new Date(NOON).toISOString());
    expect(await results(object.id)).toEqual([{ outcome: 'found', status_before: 'intact', status_after: 'moved', job_id: expect.any(String) }]);
    const audit = await rows<{ action: string; actor_kind: string; after_data: { linkStatus: string } }>(
      db,
      'ndt',
      sql`SELECT action, actor_kind, after_data FROM audit_trail WHERE entity_id = ${object.id}::uuid`,
    );
    expect(audit).toEqual([expect.objectContaining({ action: 'link_status.changed', actor_kind: 'system', after_data: expect.objectContaining({ linkStatus: 'moved' }) })]);
    ctx.setNow(new Date(new Date(NOON).getTime() + 2 * HOUR));
    await check([object.id]);
    expect((await objectState(db, 'ndt', object.id)).link_status).toBe('moved');
    expect(await results(object.id)).toHaveLength(1);
  });

  it('a deleted file becomes missing and its evidence is no longer valid', async () => {
    const { code } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, `/_admin/items/${object.external_item_id}/delete`);
    await check([object.id]);
    expect(await objectState(db, 'ndt', object.id)).toMatchObject({ link_status: 'missing', last_good_check_at: object.last_good_check_at });
    // The check queued freshness.recompute for the system, which stored the broken integrity.
    expect(ctx.queue.completed('freshness.recompute').length).toBeGreaterThan(0);
    expect(await integrity(object.evidence_id)).toBe('broken');
  });

  it('a newer provider version gives version_changed and a BR-32 evidence_anomaly to the evidence owner (digest)', async () => {
    const { code, owner } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, `/_admin/items/${object.external_item_id}/new-version`, { content: 'a newer version', versionId: '9.0' });
    await check([object.id]);
    expect((await objectState(db, 'ndt', object.id)).link_status).toBe('version_changed');
    expect(await notificationsFor('evidence_anomaly', object.evidence_id)).toEqual([
      { recipient_user_id: owner, digest: true, title_en: `New file version for evidence ${code}` },
    ]);
    // Still valid: no downgrade (BR-32 anomaly only).
    expect(await integrity(object.evidence_id)).toBe('degraded');
    // A second check changes nothing and notifies nobody again.
    await check([object.id]);
    expect(await notificationsFor('evidence_anomaly', object.evidence_id)).toHaveLength(1);
  });

  it('a newer version of a document file notifies the document owner (PRD 11.4, digest)', async () => {
    const [doc] = await rows<{ object_id: string; item: string; document_id: string; owner: string; doc_code: string }>(
      db,
      'ndt',
      sql`SELECT o.id AS object_id, o.external_item_id AS item, d.id AS document_id, d.owner_user_id AS owner, d.doc_code
          FROM document_version v JOIN document d ON d.id = v.document_id JOIN storage_object o ON o.id = v.storage_object_id
          JOIN storage_repository r ON r.id = o.storage_repository_id
          WHERE r.slug = 'sp' AND o.link_status = 'intact' AND d.owner_user_id IS NOT NULL AND v.deleted_at IS NULL AND d.deleted_at IS NULL
          ORDER BY d.doc_code LIMIT 1`,
    );
    expect(doc).toBeDefined();
    await mockAdmin(stack.mock, `/_admin/items/${doc!.item}/new-version`, { content: 'a revised document', versionId: '9.0' });
    await check([doc!.object_id]);
    expect((await objectState(db, 'ndt', doc!.object_id)).link_status).toBe('version_changed');
    expect(await notificationsFor('document_new_version', doc!.document_id)).toEqual([
      { recipient_user_id: doc!.owner, digest: true, title_en: `New version available for ${doc!.doc_code}` },
    ]);
  });

  it('a purged pinned version gives pinned_version_lost', async () => {
    const { code, version } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, `/_admin/items/${object.external_item_id}/new-version`, { content: 'replacement', versionId: '9.0' });
    await mockAdmin(stack.mock, `/_admin/items/${object.external_item_id}/purge-version`, { versionId: version });
    await check([object.id]);
    expect((await objectState(db, 'ndt', object.id)).link_status).toBe('pinned_version_lost');
  });

  it('changed content under the same version gives hash_mismatch', async () => {
    const { code } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, `/_admin/items/${object.external_item_id}/corrupt-hash`);
    await check([object.id]);
    expect((await objectState(db, 'ndt', object.id)).link_status).toBe('hash_mismatch');
  });

  it('a forbidden drive gives access_denied', async () => {
    const { code } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, '/_admin/drives/drive-sp-compliance/forbid');
    await check([object.id]);
    expect(await objectState(db, 'ndt', object.id)).toMatchObject({ link_status: 'access_denied', link_status_reason: null });
    expect(await integrity(object.evidence_id)).toBe('degraded');
  });

  it('a revoked credential gives verification_pending with credential_invalid (valid for 72 hours only)', async () => {
    const { code } = take();
    const object = await evidenceObject(db, 'ndt', code);
    await mockAdmin(stack.mock, '/_admin/tokens/revoke');
    await check([object.id]);
    expect(await objectState(db, 'ndt', object.id)).toMatchObject({ link_status: 'verification_pending', link_status_reason: 'credential_invalid' });
    expect(await integrity(object.evidence_id)).toBe('degraded');
    // 73 hours after the token failed the same answer keeps the status, and the stored integrity is broken (TS 5.7,
    // C.12). With demo.fixed_today the windows are measured on the fixed date, so the start of the state moves back.
    await rows(db, 'ndt', sql`UPDATE storage_object SET link_status_since = ${ago(73)} WHERE id = ${object.id}::uuid`);
    await check([object.id]);
    expect(await objectState(db, 'ndt', object.id)).toMatchObject({ link_status: 'verification_pending', link_status_reason: 'credential_invalid' });
    await ctx.run('freshness.recompute', { orgId: NDT, payload: { evidenceIds: [object.evidence_id] } });
    expect(await integrity(object.evidence_id)).toBe('broken');
  });

  it('the demo repositories keep their seeded states: od is forbidden, gd has an expired delegated token', async () => {
    const od = await evidenceObject(db, 'ndt', 'EV-0271');
    await check([od.id], 'od');
    expect(await objectState(db, 'ndt', od.id)).toMatchObject({ link_status: 'access_denied', link_status_since: od.link_status_since });
    const gd = await evidenceObject(db, 'ndt', 'EB-0103');
    await check([gd.id], 'gd');
    expect(await objectState(db, 'ndt', gd.id)).toMatchObject({
      link_status: 'verification_pending',
      link_status_reason: 'credential_invalid',
      link_status_since: gd.link_status_since,
    });
    expect(await results(od.id)).toEqual([]);
    expect(await results(gd.id)).toEqual([]);
  });

  it('throttling leaves every status unchanged and reschedules the rest of the batch after Retry-After', async () => {
    const codes = [take(), take(), take()].map((s) => s.code);
    const objects = await Promise.all(codes.map((c) => evidenceObject(db, 'ndt', c)));
    // The second object changes once it is checked.
    await mockAdmin(stack.mock, `/_admin/items/${objects[1]!.external_item_id}/delete`);
    // One provider request answers 429 with a Retry-After the adapter does not wait for.
    await check([objects[0]!.id], 'sp');
    await mockAdmin(stack.mock, '/_admin/throttle', { count: 1, retryAfterSeconds: 120 });
    const ids = objects.map((o) => o.id);
    await check(ids, 'sp', { delayed: false });
    for (const o of objects) expect((await objectState(db, 'ndt', o.id)).link_status).toBe('intact');
    const waiting = ctx.queue.waitingJobs('link-health.check');
    expect(waiting).toHaveLength(1);
    expect((waiting[0]!.env.payload as { storageObjectIds: string[] }).storageObjectIds).toEqual(ids);
    expect(await results(objects[0]!.id)).toEqual([expect.objectContaining({ outcome: 'rate_limited', status_before: 'intact', status_after: 'intact' })]);
    // After the wait the rest runs: the deleted file is found missing, the others stay intact.
    await ctx.drain(true);
    expect(ctx.queue.waitingJobs('link-health.check')).toHaveLength(0);
    expect((await objectState(db, 'ndt', objects[1]!.id)).link_status).toBe('missing');
    expect((await objectState(db, 'ndt', objects[2]!.id)).link_status).toBe('intact');
  });

  describe('validity windows with an unreachable provider', () => {
    const unreachableFor = (externalItemId: string) => (pathName: string, body: unknown) =>
      pathName === '/v1/stat' && (body as { object: { externalItemId: string } }).object.externalItemId === externalItemId
        ? { outcome: 'unreachable', pinnedVersionAvailable: false }
        : undefined;

    for (const [hours, expected, integ] of [
      [71, 'verification_pending', 'degraded'],
      [73, 'access_denied', 'broken'],
    ] as const) {
      it(`access_denied for ${hours} hours stays ${expected === 'access_denied' ? 'access_denied (no longer valid)' : 'valid and becomes verification_pending'}`, async () => {
        const { code } = take();
        const object = await evidenceObject(db, 'ndt', code);
        await rows(db, 'ndt', sql`UPDATE storage_object SET link_status = 'access_denied', link_status_since = ${ago(hours)} WHERE id = ${object.id}::uuid`);
        ctx.gateway.script = unreachableFor(object.external_item_id);
        await check([object.id]);
        await ctx.run('freshness.recompute', { orgId: NDT, payload: { evidenceIds: [object.evidence_id] } });
        expect((await objectState(db, 'ndt', object.id)).link_status).toBe(expected);
        expect(await integrity(object.evidence_id)).toBe(integ);
      });
    }

    for (const [hours, integ] of [
      [6 * 24, 'degraded'],
      [8 * 24, 'broken'],
    ] as const) {
      it(`verification_pending (unreachable) for ${hours / 24} days is ${integ}`, async () => {
        const { code } = take();
        const object = await evidenceObject(db, 'ndt', code);
        await rows(
          db,
          'ndt',
          sql`UPDATE storage_object SET link_status = 'verification_pending', link_status_reason = 'unreachable', link_status_since = ${ago(hours)} WHERE id = ${object.id}::uuid`,
        );
        ctx.gateway.script = unreachableFor(object.external_item_id);
        await check([object.id]);
        await ctx.run('freshness.recompute', { orgId: NDT, payload: { evidenceIds: [object.evidence_id] } });
        expect(await objectState(db, 'ndt', object.id)).toMatchObject({ link_status: 'verification_pending', link_status_reason: 'unreachable' });
        expect(await integrity(object.evidence_id)).toBe(integ);
      });
    }
  });

  describe('plan (TS 5.5)', () => {
    const due = async () => {
      const org = (await ctx.moduleRef.get(TenantResolver).resolveById(NDT))!;
      const service = ctx.moduleRef.get(LinkHealthService);
      return ctx.moduleRef.get(TenantJobRunner).run(org, (trx) => service.dueObjects(trx, new Date(NOON)));
    };

    it('selects implemented evidence after 24 hours and other evidence and documents after 7 days, by priority', async () => {
      const [implemented] = await rows<{ id: string }>(
        db,
        'ndt',
        sql`SELECT o.id FROM storage_object o JOIN evidence e ON e.storage_object_id = o.id
            JOIN evidence_target t ON t.evidence_id = e.id JOIN applicability_entry a ON a.id = t.applicability_entry_id
            WHERE a.implementation_status = 'implemented' AND o.link_status = 'intact' AND o.deleted_at IS NULL LIMIT 1`,
      );
      const [document] = await rows<{ id: string }>(
        db,
        'ndt',
        sql`SELECT o.id FROM storage_object o JOIN document_version v ON v.storage_object_id = o.id
            WHERE o.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.storage_object_id = o.id) LIMIT 1`,
      );
      const set = (id: string, at: Date) => rows(db, 'ndt', sql`UPDATE storage_object SET last_verified_at = ${at} WHERE id = ${id}::uuid`);
      await set(implemented!.id, ago(23));
      await set(document!.id, ago(6 * 24));
      let list = await due();
      expect(list.map((r) => r.id)).not.toContain(implemented!.id);
      expect(list.map((r) => r.id)).not.toContain(document!.id);
      await set(implemented!.id, ago(25));
      await set(document!.id, ago(8 * 24));
      list = await due();
      const byId = new Map(list.map((r) => [r.id, r.priority]));
      expect(byId.get(implemented!.id)).toBe(1);
      expect(byId.get(document!.id)).toBe(3);
      expect(list.map((r) => r.priority)).toEqual([...list.map((r) => r.priority)].sort());
    });

    it('queues checks in batches of at most 50 per repository and does nothing without the link_health_monitor feature', async () => {
      await rows(db, 'ndt', sql`UPDATE storage_object SET last_verified_at = ${ago(30 * 24)} WHERE deleted_at IS NULL`);
      const expected = (await due()).length;
      expect(expected).toBeGreaterThan(50);
      // Feature off: nothing is queued.
      const gate = ctx.moduleRef.get<LicenceGate>(LICENCE_GATE);
      const original = gate.assertFeature.bind(gate);
      gate.assertFeature = async () => {
        throw new BusinessRuleError('LIC-FEATURE', { en: 'No', id: 'Tidak' });
      };
      const before = ctx.queue.completed('link-health.check').length;
      await ctx.run('link-health.plan', { orgId: NDT, payload: {} }, { delayed: false });
      expect(ctx.queue.completed('link-health.check').length).toBe(before);
      gate.assertFeature = original;
      // Feature on: every due object is checked once, in batches of at most 50 of one repository.
      ctx.gateway.calls.length = 0;
      await ctx.run('link-health.plan', { orgId: NDT, payload: {} });
      const checks = ctx.queue.completed('link-health.check').slice(before);
      expect(checks.reduce((n, j) => n + (j.env.payload as { storageObjectIds: string[] }).storageObjectIds.length, 0)).toBe(expected);
      for (const job of checks) expect((job.env.payload as { storageObjectIds: string[] }).storageObjectIds.length).toBeLessThanOrEqual(50);
      expect(ctx.gateway.calls.filter((c) => c.path === '/v1/stat')).toHaveLength(expected);
      expect(ctx.queue.failed()).toEqual([]);
      // Nothing is due any more except the seeded vault objects, whose demo item ids the gateway refuses (an error
      // that keeps the status and leaves them due).
      const vault = await repositoryId(db, 'ndt', 'vault');
      const left = await due();
      expect(left.every((r) => r.storage_repository_id === vault)).toBe(true);
    });
  });

  describe('POST /ms/{ms}/link-health/run', () => {
    it('checks every file reference of the system as one background task', async () => {
      const rina = await sessionFor(ctx, db, 'rina', 'ndt');
      const [{ n }] = (await rows<{ n: number }>(
        db,
        'ndt',
        sql`SELECT count(DISTINCT o.id)::int AS n FROM storage_object o
            WHERE o.deleted_at IS NULL AND (
              o.id IN (SELECT e.storage_object_id FROM evidence e JOIN evidence_target t ON t.evidence_id = e.id AND t.deleted_at IS NULL
                       JOIN management_system m ON m.id = t.management_system_id WHERE m.slug = 'bcms' AND e.deleted_at IS NULL)
              OR o.id IN (SELECT v.storage_object_id FROM document_version v JOIN document d ON d.id = v.document_id
                          WHERE v.deleted_at IS NULL AND d.deleted_at IS NULL AND (d.is_org_wide OR d.id IN (
                            SELECT l.entity_id FROM entity_ms_link l JOIN management_system m ON m.id = l.management_system_id
                            WHERE l.entity_type = 'document' AND l.deleted_at IS NULL AND m.slug = 'bcms'))))`,
      )) as [{ n: number }];
      const reply = await rina.post('/api/v1/ms/bcms/link-health/run');
      expect(reply.status).toBe(202);
      expect(reply.body).toMatchObject({ ok: true, changed: [], count: n, taskId: expect.any(String) });
      const task = async () =>
        (await rows<{ kind: string; status: string; progress: number; result: { checked: number }; params: { total: number }; created_by: string }>(
          db,
          'ndt',
          sql`SELECT kind, status, progress, result, params, created_by FROM background_task WHERE id = ${reply.body.taskId!}::uuid`,
        ))[0]!;
      expect(await task()).toMatchObject({ kind: 'link_health_run', status: 'queued', params: { total: n } });
      await ctx.drain(true);
      expect(await task()).toMatchObject({ status: 'succeeded', progress: 100, result: { checked: n } });
      expect(ctx.queue.failed()).toEqual([]);
    });

    const taskRow = async (id: string) =>
      (await rows<{ status: string; progress: number; result: { checked: number; changed: number } }>(
        db,
        'ndt',
        sql`SELECT status, progress, result FROM background_task WHERE id = ${id}::uuid`,
      ))[0]!;

    it('a second run of the same system before the first is done gets its own checks and also succeeds', async () => {
      const rina = await sessionFor(ctx, db, 'rina', 'ndt');
      const first = await rina.post('/api/v1/ms/bcms/link-health/run');
      const second = await rina.post('/api/v1/ms/bcms/link-health/run');
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const n = first.body.count!;
      expect(n).toBeGreaterThan(0);
      expect(second.body.taskId).not.toBe(first.body.taskId);
      await ctx.drain(true);
      for (const reply of [first, second]) {
        expect(await taskRow(reply.body.taskId!)).toMatchObject({ status: 'succeeded', progress: 100, result: { checked: n } });
      }
      expect(ctx.queue.failed()).toEqual([]);
    });

    it('a retried check batch counts its objects once', async () => {
      const objects = await Promise.all([take(), take(), take()].map((s) => evidenceObject(db, 'ndt', s.code)));
      const [{ id: taskId }] = (await rows<{ id: string }>(
        db,
        'ndt',
        sql`INSERT INTO background_task (kind, status, params, result) VALUES ('link_health_run', 'queued', ${JSON.stringify({ total: 4 })}::jsonb,
            ${JSON.stringify({ checked: 0, changed: 0 })}::jsonb) RETURNING id`,
      )) as [{ id: string }];
      // The second stat call of the first attempt fails in transport; the job is retried from its first object.
      let stats = 0;
      ctx.gateway.script = (pathName) => {
        if (pathName !== '/v1/stat') return undefined;
        stats += 1;
        return stats === 2 ? new Error('connection reset') : undefined;
      };
      await ctx.run(
        'link-health.check',
        { orgId: NDT, payload: { repositoryId: await repositoryId(db, 'ndt', 'sp'), storageObjectIds: objects.map((o) => o.id), taskId } },
        { retryLimit: LINK_CHECK_RETRY_LIMIT },
      );
      expect(stats).toBe(5);
      expect(await taskRow(taskId)).toMatchObject({ status: 'running', result: { checked: 3 } });
      ctx.gateway.script = null;
      await check([(await evidenceObject(db, 'ndt', take().code)).id], 'sp', { taskId });
      expect(await taskRow(taskId)).toMatchObject({ status: 'succeeded', progress: 100, result: { checked: 4 } });
      expect(ctx.queue.failed()).toEqual([]);
    });

    it('needs link_health.run on the system and answers 404 for an unknown system', async () => {
      const bagus = await sessionFor(ctx, db, 'bagus', 'ndt');
      expect((await bagus.post('/api/v1/ms/isms/link-health/run')).status).toBe(403);
      const rina = await sessionFor(ctx, db, 'rina', 'ndt');
      expect([403, 404]).toContain((await rina.post('/api/v1/ms/nope/link-health/run')).status);
    });
  });
});
