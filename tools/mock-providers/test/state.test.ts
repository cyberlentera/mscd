import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFixtures, parseFixtureDocument } from '../src/fixtures.js';
import { MockState, type UploadSession } from '../src/state.js';

describe('state housekeeping', () => {
  it('drops expired upload sessions and authorization codes at most once a minute', () => {
    const state = new MockState();
    const session = (id: string, expiresAt: number): UploadSession => ({
      id,
      provider: 'm365',
      driveId: 'd',
      parentId: 'p',
      name: 'n',
      targetItemId: null,
      conflictBehavior: 'fail',
      mimeType: null,
      description: null,
      createdBy: { displayName: 'x' },
      chunks: [Buffer.alloc(1024)],
      received: 1024,
      total: 2048,
      expiresAt,
      fields: null,
    });
    const now = Date.now();
    state.uploadSessions.set('old', session('old', now - 1));
    state.uploadSessions.set('live', session('live', now + 60_000));
    state.purgeExpired(now);
    expect([...state.uploadSessions.keys()]).toEqual(['live']);
    state.uploadSessions.set('old2', session('old2', now - 1));
    state.purgeExpired(now + 1000);
    expect(state.uploadSessions.has('old2')).toBe(true);
    state.purgeExpired(now + 61_000);
    expect(state.uploadSessions.has('old2')).toBe(false);
  });
});

describe('fixtures/example.json', () => {
  it('is a valid fixture document', () => {
    const document = parseFixtureDocument(JSON.parse(readFileSync(new URL('../fixtures/example.json', import.meta.url), 'utf8')));
    const summary = applyFixtures(new MockState(), document);
    expect(summary).toMatchObject({ drives: 3, items: 5 });
  });
});
