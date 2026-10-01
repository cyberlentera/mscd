import { describe, expect, it } from 'vitest';
import { buildMockProviders, startMockProviders } from '../src/index.js';

describe('mock providers skeleton', () => {
  it('answers the admin health and reset routes', async () => {
    const app = buildMockProviders();
    try {
      const health = await app.inject({ method: 'GET', url: '/_admin/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
      const reset = await app.inject({ method: 'POST', url: '/_admin/reset' });
      expect(reset.json()).toEqual({ ok: true, fixtures: 'none' });
    } finally {
      await app.close();
    }
  });

  it('listens on a free port when asked for port 0', async () => {
    const running = await startMockProviders({ port: 0 });
    try {
      const response = await fetch(`${running.url}/_admin/health`);
      expect(response.status).toBe(200);
    } finally {
      await running.close();
    }
  });
});
