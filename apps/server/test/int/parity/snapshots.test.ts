// Snapshot parity (build plan J.4, G.9): `GET /ui/org` and `GET /ui/ms/{ms}` for ndt, bsd and rmn as `rina`
// (persona `manager`) equal the exported sample snapshots under the J.4 normalisation. The known differences are
// listed below with the decision that causes them, and their API values are asserted instead.
import { UiMsSnapshot, UiOrgSnapshot } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';
import { useTestDatabase } from '../../setup/test-db';
import { createReadModelApp, sessionFor, type DemoOrg, type ReadModelApp, type UiClient } from '../read-model/helpers';
import { differences, normaliseMs, normaliseOrg, sampleMsSnapshot, sampleOrgSnapshot } from './compare';

const sample = loadSampleSnapshot();
const ORGS: readonly Exclude<DemoOrg, 'tst'>[] = ['ndt', 'bsd', 'rmn'];

describe('UI snapshot parity with the sample (J.4)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  const clients = new Map<DemoOrg, UiClient>();

  beforeAll(async () => {
    ctx = await createReadModelApp(db);
    for (const org of ORGS) clients.set(org, await sessionFor(ctx, db, 'rina', org));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('the comparison is not vacuous: a changed title, holder, count or status is reported', async () => {
    const response = await clients.get('ndt')!.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    const changes: ((s: UiMsSnapshot) => void)[] = [
      (s) => (s.bundle.reqs[0]!.title += ' (changed)'),
      (s) => (s.bundle.chain.items[0]!.h = 'maya'),
      (s) => (s.bundle.chain.recs.risk = 1),
      (s) => (s.bundle.evs[0]!.fresh = 'critical'),
      (s) => (s.bundle.phases[0]!.acts[0]!.st = 'ns'),
      (s) => s.bundle.gates.pop(),
      (s) => (s.bundle.chain.items[0]!.refKey = 'isms:req:A.5.1'),
    ];
    for (const change of changes) {
      const api = structuredClone(response.body);
      change(api);
      const { api: a, sample: e, wireMismatches } = normaliseMs(api, sampleMsSnapshot(sample.snapshots.ndt!, 'isms'));
      expect(differences(a, e).length + wireMismatches.length).toBeGreaterThan(0);
    }
  });

  for (const org of ORGS) {
    describe(org, () => {
      it('GET /ui/org equals the sample organisation snapshot', async () => {
        const response = await clients.get(org)!.get<UiOrgSnapshot>('/api/v1/ui/org');
        expect(response.status).toBe(200);
        expect(UiOrgSnapshot.safeParse(response.body).success).toBe(true);
        const api = structuredClone(response.body) as unknown as Record<string, unknown>;
        const expected = sampleOrgSnapshot(sample.snapshots[org]!);
        const known = knownOrgDifferences(org, api, expected);
        const { api: a, sample: s } = normaliseOrg(api, expected);
        expect(differences(a, s)).toEqual([]);
        for (const check of known) check();
      });

      for (const ms of sample.snapshots[org]!.orgs.find((o) => o.id === org)!.ms) {
        it(`GET /ui/ms/${ms} equals the sample bundle and system keys`, async () => {
          const response = await clients.get(org)!.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
          expect(response.status).toBe(200);
          const parsed = UiMsSnapshot.safeParse(response.body);
          expect(parsed.success ? [] : parsed.error.issues.slice(0, 5)).toEqual([]);
          const { api, sample: s, wireMismatches } = normaliseMs(response.body, sampleMsSnapshot(sample.snapshots[org]!, ms));
          expect(wireMismatches).toEqual([]);
          expect(differences(api, s)).toEqual([]);
        });
      }
    });
  }
});

/**
 * Differences between the API and the sample that follow from decisions, asserted on the API side and then aligned
 * so the remaining comparison is exact:
 * - The sample organisation snapshot carries the licence card, `TITLES` and `CLAUSE_AT_RISK` of the whole sample for
 *   every organisation (WP-07 deviation 3). The API composes the licence card from the organisation's own licence
 *   (G.3: bound to the organisation, named after it) and its own systems, and lists titles and clauses of its own
 *   systems only (G.5).
 * - `rina` is also a member of the test organisation `tst` (G.3), the last entry of her `orgs`.
 * - The sample lists only the repositories that a system uses; every organisation has a Managed Vault (A-41), so the
 *   API lists rmn's unused vault too (G.5 `REPOS[]`: repositories ordered by position).
 */
function knownOrgDifferences(org: DemoOrg, api: Record<string, unknown>, expected: Record<string, unknown>): (() => void)[] {
  const checks: (() => void)[] = [];
  // G.3: rina is also a member of the test organisation, which the sample does not know.
  const orgs = api.orgs as { id: string }[];
  checks.push(() => expect(orgs.at(-1)).toMatchObject({ id: 'tst', name: 'Test Organisation', ms: ['isms'], sites: 1 }));
  api.orgs = orgs.filter((o) => o.id !== 'tst');
  if (org === 'ndt') return checks;
  const systems = (api.MS as { id: string; code: string }[]).length;
  const licence = api.LICENCE as Record<string, unknown>;
  const name = org === 'bsd' ? 'PT Bank Sentosa Digital' : 'RS Medika Nusantara';
  checks.push(() => expect(licence).toMatchObject({ org: name, fw: `${systems} of 4`, ms: `${systems} of 10`, users: '86 of 150' }));
  expected.LICENCE = { ...(expected.LICENCE as Record<string, unknown>), org: name, fw: `${systems} of 4`, ms: `${systems} of 10` };
  const stages = new Set(Object.values(api.STAGES as Record<string, { id: string }[]>).flat().map((s) => s.id));
  const clauses = expected.CLAUSE_AT_RISK as Record<string, string>;
  checks.push(() => expect(Object.keys(api.CLAUSE_AT_RISK as object).sort()).toEqual(Object.keys(clauses).filter((k) => stages.has(k)).sort()));
  expected.CLAUSE_AT_RISK = Object.fromEntries(Object.entries(clauses).filter(([k]) => stages.has(k)));
  const codes = new Set(Object.values(api.CHAINS as Record<string, { id: string; nodes: [string, string | null][] }[]>).flat().flatMap((c) => [c.id, ...c.nodes.map((n) => n[1])]));
  expected.TITLES = Object.fromEntries(Object.entries(expected.TITLES as Record<string, string>).filter(([k]) => codes.has(k)));
  if (org === 'rmn') {
    const repos = api.REPOS as { id: string; ms: string[] }[];
    checks.push(() => expect(repos.find((r) => r.id === 'vault')).toMatchObject({ ms: [] }));
    api.REPOS = repos.filter((r) => r.id !== 'vault');
  }
  return checks;
}
