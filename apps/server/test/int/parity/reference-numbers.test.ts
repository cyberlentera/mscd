// Reference numbers of the sample (build plan J.4, UI 4.7): per system of ndt the requirements, evidence, documents,
// chain items, items that are not pending, gate items and critical evidence, read through `GET /ui/ms/{ms}` as
// `rina`; and the My Tasks counts of the four personas through `GET /tasks`.
import type { TaskList, UiMsSnapshot } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portfolioCounts } from '../../../src/modules/read-model/derive/portfolio';
import { useTestDatabase } from '../../setup/test-db';
import { createReadModelApp, sessionFor, type ReadModelApp } from '../read-model/helpers';

const REFERENCE: Record<string, { requirements: number; evidence: number; documents: number; chainItems: number; notPending: number; gateItems: number; criticalEvidence: number }> = {
  isms: { requirements: 93, evidence: 79, documents: 22, chainItems: 63, notPending: 24, gateItems: 4, criticalEvidence: 3 },
  qms: { requirements: 28, evidence: 27, documents: 10, chainItems: 18, notPending: 5, gateItems: 0, criticalEvidence: 0 },
  bcms: { requirements: 27, evidence: 11, documents: 8, chainItems: 25, notPending: 2, gateItems: 3, criticalEvidence: 0 },
  abms: { requirements: 32, evidence: 2, documents: 5, chainItems: 35, notPending: 3, gateItems: 1, criticalEvidence: 0 },
};

/** UI 2.8 card statistics of the sample (gate, findings open and major, expired documents, critical and unverifiable evidence, after audit). */
const CARDS: Record<string, { gate: number; docExp: number; evCrit: number; evBad: number; af: number }> = {
  isms: { gate: 4, docExp: 5, evCrit: 3, evBad: 3, af: 16 },
  qms: { gate: 0, docExp: 1, evCrit: 0, evBad: 0, af: 4 },
  bcms: { gate: 3, docExp: 0, evCrit: 0, evBad: 0, af: 0 },
  abms: { gate: 1, docExp: 0, evCrit: 0, evBad: 0, af: 0 },
};

const MY_TASKS: Record<string, number> = { rina: 3, bagus: 31, maya: 1, hendra: 3 };

describe('UI 4.7 reference numbers through the API', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;

  beforeAll(async () => {
    ctx = await createReadModelApp(db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('counts requirements, evidence, documents, chain items, not pending, gate items and critical evidence per system', async () => {
    const rina = await sessionFor(ctx, db, 'rina', 'ndt');
    for (const [ms, expected] of Object.entries(REFERENCE)) {
      const response = await rina.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
      expect(response.status).toBe(200);
      const counts = portfolioCounts(response.body.bundle);
      expect({ ms, ...pick(counts, Object.keys(expected)) }).toEqual({ ms, ...expected });
      const card = CARDS[ms]!;
      expect({ ms, gate: counts.gateItems, docExp: counts.expiredDocuments, evCrit: counts.criticalEvidence, evBad: counts.unverifiableEvidence, af: counts.afterAudit }).toEqual({ ms, ...card });
    }
  });

  it('gives the My Tasks counts of the four personas (rina 3, bagus 31, maya 1, hendra 3)', async () => {
    for (const [handle, total] of Object.entries(MY_TASKS)) {
      const client = await sessionFor(ctx, db, handle, 'ndt');
      const response = await client.get<TaskList>('/api/v1/tasks');
      expect(response.status).toBe(200);
      expect({ handle, total: response.body.counts.total, items: response.body.items.length }).toEqual({ handle, total, items: total });
      const { overdue, week, later } = response.body.counts;
      expect(overdue + week + later).toBe(total);
      expect(response.body.items.every((i) => i.kind !== 'task')).toBe(true);
    }
  });
});

function pick<T extends object>(value: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (value as Record<string, unknown>)[k]]));
}
