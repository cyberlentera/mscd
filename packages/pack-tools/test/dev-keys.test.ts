// The development keys (R-11, D-16): three Ed25519 pairs, the <kind>-dev.pub copies that gen-build-info.mjs reads,
// and dev-key-ids.json listing their ids.
import { createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_KEY_IDS, keyId, loadPublicKey, loadSigningKey } from '../src/index.js';
import { DEV_KEYS_DIR } from './helpers.js';

const read = (name: string) => readFileSync(path.join(DEV_KEYS_DIR, name), 'utf8');

describe('dev-keys', () => {
  it('holds exactly the three pairs, their -dev.pub copies, the id list and the README', () => {
    expect(readdirSync(DEV_KEYS_DIR).sort()).toEqual([
      'README.md', 'anchor-dev.pub', 'anchor-signing.key', 'anchor-signing.pub', 'dev-key-ids.json', 'licence-dev.pub', 'licence-signing.key',
      'licence-signing.pub', 'pack-dev.pub', 'pack-signing.key', 'pack-signing.pub',
    ]);
  });

  for (const kind of ['pack', 'licence', 'anchor']) {
    it(`${kind}-signing is an Ed25519 pair whose public key is also ${kind}-dev.pub`, () => {
      const key = loadSigningKey(read(`${kind}-signing.key`));
      const pub = loadPublicKey(read(`${kind}-signing.pub`));
      expect(keyId(pub)).toBe(key.keyId);
      expect(read(`${kind}-dev.pub`)).toBe(read(`${kind}-signing.pub`));
      const message = Buffer.from(`mscd ${kind}`);
      expect(verify(null, message, pub, sign(null, message, key.privateKey))).toBe(true);
      expect(DEV_KEY_IDS).toContain(key.keyId);
    });
  }

  it('lists the three key ids in dev-key-ids.json, which DEV_KEY_IDS reads', () => {
    const ids = JSON.parse(read('dev-key-ids.json')) as string[];
    expect(ids).toEqual(['pack', 'licence', 'anchor'].map((kind) => keyId(createPublicKey(read(`${kind}-signing.pub`)))));
    expect([...DEV_KEY_IDS]).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it('names every public key in the <kind>-*.pub form of gen-build-info.mjs', () => {
    const pubs = readdirSync(DEV_KEYS_DIR).filter((f) => f.endsWith('.pub'));
    for (const file of pubs) expect(file).toMatch(/^(licence|pack|anchor)-[A-Za-z0-9._-]+\.pub$/);
  });
});
