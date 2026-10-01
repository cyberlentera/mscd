import { describe, expect, it } from 'vitest';
import { runSelfTest, startMockProviders } from '../src/index.js';
import { standardFixtures } from './helpers.js';

describe('self-test', () => {
  it('passes against an empty server and against one with fixtures, over real HTTP', async () => {
    for (const fixtures of [undefined, standardFixtures()]) {
      const running = await startMockProviders({ port: 0, fixtures });
      try {
        const lines: string[] = [];
        await runSelfTest(running.url, (line) => lines.push(line));
        expect(lines).toContain('self-test: graph upload ok');
        expect(lines).toContain('self-test: drive list after upload ok');
      } finally {
        await running.close();
      }
    }
  });

  it('fails when a provider misbehaves', async () => {
    const running = await startMockProviders({ port: 0 });
    try {
      await fetch(`${running.url}/_admin/throttle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 100, apis: ['identity'] }) });
      await expect(runSelfTest(running.url)).rejects.toThrow('Microsoft token request failed');
    } finally {
      await running.close();
    }
  });
});
