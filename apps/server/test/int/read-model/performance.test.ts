// Performance check of the read model (WP-17): `GET /ui/ms/isms` (93 requirements, 79 evidence, 22 documents, the
// chain, phases and cycle) answers in under one second on the demo template in the test container, and
// `GET /ui/org` and `GET /tasks` stay in the same budget.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { createReadModelApp, sessionFor, type ReadModelApp, type UiClient } from './helpers';

const BUDGET_MS = 1000;

describe('read model performance (WP-17)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let rina: UiClient;

  beforeAll(async () => {
    ctx = await createReadModelApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'ndt');
    // Warm-up: first compilation of the route, the pools and the caches.
    await rina.get('/api/v1/ui/ms/isms');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  for (const url of ['/api/v1/ui/ms/isms', '/api/v1/ui/org', '/api/v1/tasks']) {
    it(`GET ${url} answers in under ${BUDGET_MS} ms`, async () => {
      const times: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await rina.get(url);
        expect(response.status).toBe(200);
        times.push(response.ms);
      }
      expect(Math.max(...times)).toBeLessThan(BUDGET_MS);
    });
  }
});
