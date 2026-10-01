// Without dev-keys/dev-key-ids.json (as in a build context that left it out), `--reject-dev-keys` cannot know the
// development key ids, so the CLI refuses to run instead of signing or verifying without the check.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/commands.js';
import { DEV_KEYS_DIR, SOURCES_DIR, tempDir } from './helpers.js';

vi.mock('../src/dev-key-ids.js', () => ({ DEV_KEY_IDS: Object.freeze([]) }));

describe('mscd-pack --reject-dev-keys without the development key list', () => {
  it('fails closed', () => {
    let err = '';
    const code = runCli(
      ['build', path.join(SOURCES_DIR, 'ISO27001-2022'), '--sign-key-file', path.join(DEV_KEYS_DIR, 'pack-signing.key'), '--out', tempDir(), '--reject-dev-keys'],
      { stdout: () => {}, stderr: (t) => { err += t; } },
    );
    expect(code).toBe(1);
    expect(err).toMatch(/dev-key-ids\.json, which is missing/);
  });
});
