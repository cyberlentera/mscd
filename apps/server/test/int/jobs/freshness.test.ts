// `freshness.recompute` and `freshness.sweep` (E.3, TS 6.1, BR-11, BR-31) on a copy of the demo template
// (organisation `tst`, `demo.fixed_today` 2026-09-29): stored freshness and integrity, the automatic downgrade with
// its task, notification and audit entry, the 72 hour window of an invalid credential, no promotion back, tasks
// closed when the evidence is in date again, `evidence_aging` once per production, and idempotency.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FreshnessModule } from '../../../src/modules/freshness/freshness.module';
import { FreshnessService } from '../../../src/modules/freshness/freshness.service';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import type { TenantInfo } from '../../../src/common/tokens';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, type AdminClient, type JobsApp } from './helpers';

const TST = '00000000-0000-4000-8000-00000000a004';
/** 2026-09-29 12:00 in Jakarta: the instant the windows are measured at (fixed today, real time of day is replaced). */
const NOON = '2026-09-29T05:00:00Z';

describe('freshness jobs (E.3)', () => {
  const db = useTestDatabase('demo');
  let app: JobsApp;
  let admin: AdminClient;
  let org: TenantInfo;
  const ids: Record<string, string> = {};
  let n = 0;
  const used = new Set<string>();

  const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await admin.query<T>(text, values)).rows;

  /** An implemented entry of the ISMS whose only evidence is the given record (its seeded evidence is detached). */
  async function entryWith(evidence: { producedAt: string; link?: { status: string; since: string; reason?: string | null } | null }[]): Promise<{ entry: string; evidence: string[] }> {
    const entry = (
      await one<{ id: string }>(
        `SELECT e.id FROM org_tst.applicability_entry e WHERE e.management_system_id = $1 AND e.implementation_status = 'implemented'
            AND e.deleted_at IS NULL AND NOT e.id = ANY($2::uuid[]) ORDER BY e.position LIMIT 1`,
        [ids.ms, [...used]],
      )
    )[0]!.id;
    used.add(entry);
    n += 1;
    await admin.query(`UPDATE org_tst.applicability_entry SET owner_user_id = $2 WHERE id = $1`, [entry, ids.rina]);
    await admin.query(`UPDATE org_tst.evidence_target SET deleted_at = now() WHERE applicability_entry_id = $1`, [entry]);
    const created: string[] = [];
    for (const e of evidence) {
      let objectId: string | null = null;
      if (e.link) {
        objectId = (
          await one<{ id: string }>(
            `INSERT INTO org_tst.storage_object (organization_id, storage_repository_id, external_item_id, hash_algorithm, hash_value, hash_source,
               link_status, link_status_since, link_status_reason)
             VALUES ($1, $2, $3, 'sha256', repeat('a', 64), 'computed', $4, $5, $6) RETURNING id`,
            [TST, ids.repo, `wp22-${n}-${created.length}`, e.link.status, e.link.since, e.link.reason ?? null],
          )
        )[0]!.id;
      }
      const code = `WP22-E${n}${created.length}`;
      const ev = (
        await one<{ id: string }>(
          `INSERT INTO org_tst.evidence (organization_id, evidence_code, title, owner_user_id, produced_at, storage_object_id, external_ref, frequency_code)
           VALUES ($1, $2, 'Firewall rule review', $3, $4, $5, $6, $7) RETURNING id`,
          [TST, code, ids.bagus, e.producedAt, objectId, objectId ? null : 'system:siem', ids.freq],
        )
      )[0]!.id;
      const target = (await one<{ target_type: string; catalogue_item_id: string | null; requirement_id: string | null }>(
        `SELECT target_type, catalogue_item_id, requirement_id FROM org_tst.applicability_entry WHERE id = $1`,
        [entry],
      ))[0]!;
      await admin.query(
        `INSERT INTO org_tst.evidence_target (organization_id, evidence_id, management_system_id, applicability_entry_id, target_type, catalogue_item_id, requirement_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [TST, ev, ids.ms, entry, target.target_type, target.catalogue_item_id, target.requirement_id],
      );
      created.push(ev);
    }
    return { entry, evidence: created };
  }

  const entryState = async (id: string) =>
    (await one<{ implementation_status: string; freshness_status: string | null; integrity_status: string | null; last_evidence_at: Date | null }>(
      `SELECT implementation_status, freshness_status, integrity_status, last_evidence_at FROM org_tst.applicability_entry WHERE id = $1`,
      [id],
    ))[0]!;
  const tasksOf = async (evidenceIds: string[]) =>
    one<{ source_rule: string; status: string; owner: string }>(
      `SELECT source_rule, status, (SELECT handle FROM platform.app_user u WHERE u.id = owner_user_id) AS owner FROM org_tst.task
        WHERE entity_type = 'evidence' AND entity_id = ANY($1::uuid[]) ORDER BY created_at`,
      [evidenceIds],
    );

  beforeAll(async () => {
    admin = await adminClient(db);
    app = await createJobsApp(db, { imports: [FreshnessModule] });
    app.setNow(NOON);
    org = (await app.moduleRef.get(TenantResolver).resolveById(TST))!;
    for (const row of await one<{ handle: string; id: string }>(`SELECT handle, id FROM platform.app_user WHERE handle IN ('rina', 'bagus')`)) ids[row.handle] = row.id;
    const ms = (await one<{ id: string; repo: string; fv: string }>(
      `SELECT id, default_storage_repository_id AS repo, framework_version_id AS fv FROM org_tst.management_system WHERE slug = 'isms'`,
    ))[0]!;
    ids.ms = ms.id;
    ids.repo = ms.repo;
    // A monthly-like frequency: the shortest period above 20 days.
    ids.freq = (await one<{ code: string }>(
      `SELECT code FROM ref.evidence_frequency_rule WHERE framework_version_id = $1 AND period_days > 20 ORDER BY period_days LIMIT 1`,
      [ms.fv],
    ))[0]!.code;
    ids.period = String((await one<{ p: number }>(`SELECT period_days AS p FROM ref.evidence_frequency_rule WHERE framework_version_id = $1 AND code = $2`, [ms.fv, ids.freq]))[0]!.p);
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('stores freshness and integrity on the whole organisation and changes nothing on a second sweep (demo data keeps its statuses)', async () => {
    const statuses = async () => one(`SELECT implementation_status, count(*)::int AS n FROM org_tst.applicability_entry GROUP BY 1 ORDER BY 1`);
    const before = await statuses();
    await app.run('freshness.sweep', { orgId: TST, payload: {} });
    expect(app.queue.failed()).toEqual([]);
    expect(await statuses()).toEqual(before);
    expect(await one(`SELECT 1 FROM org_tst.evidence WHERE deleted_at IS NULL AND (freshness_status IS NULL OR integrity_status IS NULL)`)).toEqual([]);
    const aging = await one<{ n: number }>(`SELECT count(*)::int AS n FROM org_tst.notification WHERE kind = 'evidence_aging' AND digest`);
    expect(aging[0]!.n).toBeGreaterThan(0);
    const snapshot = async () => ({
      evidence: await one(`SELECT id, freshness_status, integrity_status, derived_at FROM org_tst.evidence ORDER BY id`),
      entries: await one(`SELECT id, implementation_status, freshness_status, integrity_status, last_evidence_at, derived_at FROM org_tst.applicability_entry ORDER BY id`),
      notifications: await one(`SELECT count(*)::int AS n FROM org_tst.notification`),
      tasks: await one(`SELECT count(*)::int AS n FROM org_tst.task`),
    });
    const first = await snapshot();
    await app.run('freshness.sweep', { orgId: TST, payload: {} }, { singletonKey: 'fs:again' });
    expect(await snapshot()).toEqual(first);
  });

  it('downgrades an implemented entry whose evidence expired (BR-11), with its task, notification and audit entry', async () => {
    const period = Number(ids.period);
    const produced = new Date(Date.UTC(2026, 8, 29) - (period * 2 + 3) * 86_400_000).toISOString().slice(0, 10);
    const { entry, evidence } = await entryWith([{ producedAt: produced }]);
    await app.run('freshness.recompute', { orgId: TST, payload: { evidenceIds: evidence } }, { singletonKey: `fr:${TST}:all`, startAfterSeconds: 5 });
    expect(await entryState(entry)).toMatchObject({ implementation_status: 'partially_implemented', freshness_status: 'critical', integrity_status: 'ok' });
    expect(await tasksOf(evidence)).toEqual([{ source_rule: 'BR-11', status: 'open', owner: 'bagus' }]);
    const notes = await one<{ kind: string; handle: string; title_en: string }>(
      `SELECT kind, (SELECT handle FROM platform.app_user u WHERE u.id = recipient_user_id) AS handle, title_en FROM org_tst.notification
        WHERE kind = 'freshness_downgrade' AND entity_ref->>'id' = $1`,
      [entry],
    );
    expect(notes).toEqual([{ kind: 'freshness_downgrade', handle: 'rina', title_en: expect.stringMatching(/downgraded to partially implemented$/) }]);
    const audit = await one<{ actor_kind: string; before_data: unknown; after_data: unknown }>(
      `SELECT actor_kind, before_data, after_data FROM org_tst.audit_trail WHERE action = 'freshness.downgrade' AND entity_id = $1`,
      [entry],
    );
    expect(audit).toEqual([{ actor_kind: 'system', before_data: { implementation_status: 'implemented' }, after_data: { implementation_status: 'partially_implemented', rule: 'BR-11' } }]);

    // Running again changes nothing; fresh evidence closes the task but never promotes the entry back.
    await app.run('freshness.recompute', { orgId: TST, payload: { entryIds: [entry] } });
    expect(await tasksOf(evidence)).toEqual([{ source_rule: 'BR-11', status: 'open', owner: 'bagus' }]);
    await admin.query(`UPDATE org_tst.evidence SET produced_at = '2026-09-28' WHERE id = $1`, [evidence[0]]);
    await app.run('freshness.recompute', { orgId: TST, payload: { evidenceIds: evidence } });
    expect(await tasksOf(evidence)).toEqual([{ source_rule: 'BR-11', status: 'done', owner: 'bagus' }]);
    expect(await entryState(entry)).toMatchObject({ implementation_status: 'partially_implemented', freshness_status: 'fresh' });
  });

  it('downgrades for an unverifiable file (BR-31), and an invalid credential keeps the link valid for 72 hours only', async () => {
    // Missing file: BR-31.
    const missing = await entryWith([{ producedAt: '2026-09-20', link: { status: 'missing', since: '2026-09-28T00:00:00Z' } }]);
    // Credential invalid 71 hours before noon on 2026-09-29: still valid, no downgrade.
    const pending = await entryWith([{ producedAt: '2026-09-20', link: { status: 'verification_pending', since: '2026-09-26T06:00:00Z', reason: 'credential_invalid' } }]);
    await app.run('freshness.recompute', { orgId: TST, payload: { entryIds: [missing.entry, pending.entry] } });
    expect(await entryState(missing.entry)).toMatchObject({ implementation_status: 'partially_implemented', integrity_status: 'broken' });
    expect(await tasksOf(missing.evidence)).toEqual([{ source_rule: 'BR-31', status: 'open', owner: 'bagus' }]);
    expect(await entryState(pending.entry)).toMatchObject({ implementation_status: 'implemented', integrity_status: 'degraded' });
    expect(await tasksOf(pending.evidence)).toEqual([]);

    // Two hours later (73 hours): the window has passed.
    app.setNow('2026-09-29T07:00:00Z');
    try {
      await app.run('freshness.recompute', { orgId: TST, payload: { entryIds: [pending.entry] } });
    } finally {
      app.setNow(NOON);
    }
    expect(await entryState(pending.entry)).toMatchObject({ implementation_status: 'partially_implemented', integrity_status: 'broken' });
    expect(await tasksOf(pending.evidence)).toEqual([{ source_rule: 'BR-31', status: 'open', owner: 'bagus' }]);

    // The file is found again: the task closes.
    await admin.query(`UPDATE org_tst.storage_object SET link_status = 'intact', link_status_reason = NULL WHERE id = (SELECT storage_object_id FROM org_tst.evidence WHERE id = $1)`, [pending.evidence[0]]);
    await app.run('freshness.recompute', { orgId: TST, payload: { evidenceIds: pending.evidence } });
    expect(await tasksOf(pending.evidence)).toEqual([{ source_rule: 'BR-31', status: 'done', owner: 'bagus' }]);
  });

  it('keeps an entry implemented while an older valid record remains, even when a newer one breaks', async () => {
    const both = await entryWith([
      { producedAt: '2026-09-15', link: { status: 'intact', since: '2026-09-15T00:00:00Z' } },
      { producedAt: '2026-09-27', link: { status: 'hash_mismatch', since: '2026-09-28T00:00:00Z' } },
    ]);
    const result = await app.moduleRef.get(FreshnessService).recompute(org, { entryIds: [both.entry] });
    expect(result.downgraded).toEqual([]);
    expect(await entryState(both.entry)).toMatchObject({ implementation_status: 'implemented', freshness_status: 'fresh', integrity_status: 'ok' });
    expect((await entryState(both.entry)).last_evidence_at?.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('notifies evidence_aging once per production date (digest)', async () => {
    const period = Number(ids.period);
    const produced = new Date(Date.UTC(2026, 8, 29) - (period + 3) * 86_400_000).toISOString().slice(0, 10);
    const aging = await entryWith([{ producedAt: produced }]);
    const count = async () =>
      (await one<{ n: number }>(`SELECT count(*)::int AS n FROM org_tst.notification WHERE kind = 'evidence_aging' AND entity_ref->>'id' = $1`, [aging.evidence[0]]))[0]!.n;
    const svc = app.moduleRef.get(FreshnessService);
    await svc.sweep(org);
    expect(await count()).toBe(1);
    await svc.sweep(org);
    expect(await count()).toBe(1);
    expect(await entryState(aging.entry)).toMatchObject({ implementation_status: 'implemented', freshness_status: 'aging' });
  });
});
