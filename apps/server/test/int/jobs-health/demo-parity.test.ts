// The demo template with the demo fixtures (G.8, G.9, J.4 "after every job"): `link-health.plan` with its checks,
// `link-health.repository`, `drift.evaluate`, `integrity.rehash` and the `freshness.recompute` they queue run once for
// every organisation against the storage gateway, the mock providers and a SeaweedFS vault. No storage object changes
// its status, `GET /ui/ms/{ms}` for ndt, bsd and rmn as `rina` still equals the sample and equals the API before the
// jobs (the `DRIFT` rows included: only the seeded stale risk rows, none resolved), and the My Tasks counts stay at 3,
// 31, 1 and 3. `GET /ui/org` changes only where the repository check must: the time of the last check, and the
// OneDrive the fixture refuses (account disabled).
import type { TaskList, UiMsSnapshot, UiOrgSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';
import { useTestDatabase } from '../../setup/test-db';
import { startSeaweed, type Seaweed } from '../gateway/helpers';
import { differences, normaliseMs, sampleMsSnapshot } from '../parity/compare';
import {
  NOON,
  ORG_IDS,
  allStatuses,
  createHealthApp,
  rows,
  sessionFor,
  startProviderStack,
  type Client,
  type DemoOrg,
  type HealthApp,
  type ProviderStack,
} from './helpers';

const sample = loadSampleSnapshot();
const ORGS: readonly Exclude<DemoOrg, 'tst'>[] = ['ndt', 'bsd', 'rmn'];
const ALL_ORGS: readonly DemoOrg[] = ['ndt', 'bsd', 'rmn', 'tst'];
const MY_TASKS: Record<string, number> = { rina: 3, bagus: 31, maya: 1, hendra: 3 };
const JOBS = ['link-health.plan', 'link-health.repository', 'drift.evaluate', 'integrity.rehash'] as const;

/**
 * A snapshot without its clock, without refs (drift rows of live rules add refs the UI never shows, G.5) and without
 * the API-only check time of each evidence file (`evs[].lastCheck`, J.4), which a check moves by design.
 */
function comparable(value: unknown): Record<string, unknown> {
  const copy = structuredClone(value) as Record<string, unknown>;
  delete copy.generatedAt;
  delete copy.refs;
  const evs = (copy.bundle as { evs?: Record<string, unknown>[] } | undefined)?.evs ?? [];
  for (const ev of evs) delete ev.lastCheck;
  return copy;
}

describe('demo template after every link health, integrity and drift job (G.9, J.4)', () => {
  const db = useTestDatabase('demo');
  let seaweed: Seaweed;
  let stack: ProviderStack;
  let ctx: HealthApp;
  const before = new Map<string, unknown>();
  const statusesBefore = new Map<DemoOrg, Record<string, string>>();
  const clients = new Map<string, Client>();
  let driftBefore: unknown[];

  const get = async <T,>(org: DemoOrg, handle: string, url: string): Promise<T> => {
    const key = `${org}:${handle}`;
    if (!clients.has(key)) clients.set(key, await sessionFor(ctx, db, handle, org));
    const response = await clients.get(key)!.get<T>(url);
    expect(response.status).toBe(200);
    return response.body;
  };
  const storedDrift = async () => {
    const all: unknown[] = [];
    for (const org of ALL_ORGS) {
      all.push(
        ...(await rows(
          db,
          org,
          sql`SELECT d.id, d.rule_code, d.entity_code, d.holder_user_id, d.due_at::text AS due_at, d.resolved_at, d.position
              FROM drift_result d JOIN ref.drift_rule_def r ON r.id = d.drift_rule_def_id
              WHERE d.deleted_at IS NULL AND r.source_kind NOT IN ('unverif', 'nohash', 'metric', 'exercise') ORDER BY d.id`,
        )),
      );
    }
    return all;
  };

  beforeAll(async () => {
    seaweed = await startSeaweed();
    stack = await startProviderStack({ vaultEndpoint: seaweed.endpoint });
    ctx = await createHealthApp(db, stack);
    ctx.setNow(NOON);
    for (const org of ORGS) {
      before.set(`${org}:org`, comparable(await get(org, 'rina', '/api/v1/ui/org')));
      for (const ms of sample.snapshots[org]!.orgs.find((o) => o.id === org)!.ms) {
        before.set(`${org}:${ms}`, comparable(await get(org, 'rina', `/api/v1/ui/ms/${ms}`)));
      }
    }
    for (const handle of Object.keys(MY_TASKS)) before.set(`tasks:${handle}`, await get('ndt', handle, '/api/v1/tasks'));
    for (const org of ALL_ORGS) statusesBefore.set(org, await allStatuses(db, org));
    driftBefore = await storedDrift();

    for (const org of ALL_ORGS) {
      for (const name of JOBS) await ctx.queue.send(name, { orgId: ORG_IDS[org], payload: {} }, { singletonKey: `parity:${name}:${org}` });
    }
    await ctx.drain(true);
  }, 240_000);
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
    await seaweed?.stop();
  });

  it('ran every job without a failure', () => {
    expect(ctx.queue.failed()).toEqual([]);
    const ran = new Set(ctx.queue.completed().map((j) => j.name));
    for (const name of [...JOBS, 'link-health.check'] as const) expect(ran.has(name), name).toBe(true);
  });

  it('changed no link status in any organisation', async () => {
    for (const org of ALL_ORGS) expect({ org, statuses: await allStatuses(db, org) }).toEqual({ org, statuses: statusesBefore.get(org) });
    // The due objects were checked (the Google Drive evidence behind implemented controls, last checked 2.5 days ago).
    const [{ n }] = (await rows<{ n: number }>(db, 'ndt', sql`SELECT count(*)::int AS n FROM storage_object WHERE last_verified_at = ${new Date(NOON)}`)) as [{ n: number }];
    expect(n).toBeGreaterThan(0);
  });

  it('kept the stored drift rows: the seeded stale risk rows, none resolved, nothing added to stored-row rules', async () => {
    expect(await storedDrift()).toEqual(driftBefore);
  });

  for (const org of ORGS) {
    it(`${org}: every system snapshot still equals the sample and the API before the jobs`, async () => {
      for (const ms of sample.snapshots[org]!.orgs.find((o) => o.id === org)!.ms) {
        const after = await get<UiMsSnapshot>(org, 'rina', `/api/v1/ui/ms/${ms}`);
        const { api, sample: expected, wireMismatches } = normaliseMs(after, sampleMsSnapshot(sample.snapshots[org]!, ms));
        expect(wireMismatches).toEqual([]);
        expect({ ms, diff: differences(api, expected) }).toEqual({ ms, diff: [] });
        expect({ ms, diff: differences(comparable(after), before.get(`${org}:${ms}`)) }).toEqual({ ms, diff: [] });
        // Checked files show the time of this check.
        for (const ev of after.bundle.evs as { lastCheck?: string }[]) {
          if (ev.lastCheck !== undefined) expect(['29 Sep 2026 12:00', '29 Sep 2026 06:00', '27 Sep 2026 06:00', '-']).toContain(ev.lastCheck);
        }
      }
    });

    it(`${org}: the organisation snapshot changes only in the repository check results`, async () => {
      const after = comparable(await get<UiOrgSnapshot>(org, 'rina', '/api/v1/ui/org'));
      const previous = structuredClone(before.get(`${org}:org`)) as Record<string, unknown>;
      const repos = (snapshot: Record<string, unknown>) => snapshot.REPOS as { id: string; status: string; last: string; msg?: unknown }[];
      for (const repo of repos(after)) expect(repo.last, repo.id).toBe('29 Sep 2026 12:00');
      const od = repos(after).find((r) => r.id === 'od');
      if (od) expect(od.status).toBe('bad');
      const strip = (snapshot: Record<string, unknown>) => {
        snapshot.REPOS = repos(snapshot)
          .filter((r) => r.id !== 'od')
          .map((r) => ({ ...r, last: undefined }));
        return snapshot;
      };
      expect(differences(strip(after), strip(previous))).toEqual([]);
    });
  }

  it('keeps the My Tasks counts of the four personas', async () => {
    for (const [handle, total] of Object.entries(MY_TASKS)) {
      const after = await get<TaskList>('ndt', handle, '/api/v1/tasks');
      expect({ handle, total: after.counts.total }).toEqual({ handle, total });
      expect(differences(after, before.get(`tasks:${handle}`))).toEqual([]);
    }
  });
});
