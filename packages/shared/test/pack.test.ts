// Pack and licence formats (E.8, D-15): canonical JSON, semantic versions, licence binding and signing payload, and
// every pack source folder of the repository against the dataset schemas.
import { generateKeyPairSync, createHash, sign, verify } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError, Ed25519Signature, KeyId, LicenceDocument, MAPPING_CSV_HEADER, MAPPING_FILE_RE, MappingRow, PACK_CSV_HEADERS,
  PACK_CSV_ROW_SCHEMAS, PACK_DATASET_FILES, PACK_JSON_SCHEMAS, PackManifest, PackSourceManifest, REQUIRED_LOOKUP_DOMAINS, TRIAL_MAX_DAYS,
  canonicalJson, canonicalJsonWithout, compareSemver, licenceBinding, licenceSigningPayload,
} from '../src/index.js';
import { EXAMPLE_LICENCE } from '../src/examples.js';
import { REPO_ROOT, csvRecords, readRepoFile } from './helpers.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson('é"\n')).toBe(JSON.stringify('é"\n'));
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(-0)).toBe('0');
  });

  it('sorts by UTF-16 code units', () => {
    expect(canonicalJson({ b: 1, B: 2, á: 3, a: 4 })).toBe('{"B":2,"a":4,"b":1,"á":3}');
  });

  it('leaves out undefined members and writes undefined array items as null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('rejects values without a JSON form', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, Symbol('x'), new Date(0), new Map(), { a: { b: Number.NaN } }]) {
      expect(() => canonicalJson(bad), String(typeof bad)).toThrow(CanonicalJsonError);
    }
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/Circular/);
    expect(() => canonicalJson({ a: { b: Number.NaN } })).toThrow(/a\.b/);
  });

  it('accepts a repeated (not circular) reference', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('omits top-level members on request', () => {
    expect(canonicalJsonWithout({ signature: 's', b: 2, a: { signature: 'kept' } }, ['signature'])).toBe('{"a":{"signature":"kept"},"b":2}');
  });
});

describe('compareSemver', () => {
  it('orders versions as semver 2.0.0', () => {
    const ordered = ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0', '2.0.0'];
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        expect(compareSemver(ordered[i] as string, ordered[j] as string), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
  });

  it('rejects text that is not a version', () => {
    expect(() => compareSemver('1.0', '1.0.0')).toThrow();
    expect(() => compareSemver('1.0.0', 'v1.0.0')).toThrow();
  });
});

describe('licence', () => {
  const doc = LicenceDocument.parse(EXAMPLE_LICENCE);

  it('reads the binding (D-15)', () => {
    expect(licenceBinding(doc)).toEqual({ kind: 'organization', id: doc.organization_id });
    const installation = { ...doc, organization_id: undefined, installation_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' };
    expect(licenceBinding(installation)).toEqual({ kind: 'installation', id: installation.installation_id });
    const unbound = { ...doc, organization_id: undefined };
    expect(licenceBinding(unbound)).toEqual({ kind: 'unbound', reason: 'not_trial' });
    expect(licenceBinding({ ...unbound, trial: true, valid_from: '2026-01-01', valid_until: '2026-04-01' })).toEqual({ kind: 'trial' });
    expect(TRIAL_MAX_DAYS).toBe(90);
    expect(licenceBinding({ ...unbound, trial: true, valid_from: '2026-01-01', valid_until: '2026-04-02' })).toEqual({ kind: 'unbound', reason: 'trial_too_long' });
  });

  it('keeps unknown members, which the signature covers', () => {
    const extended = LicenceDocument.parse({ ...EXAMPLE_LICENCE, future_field: { a: 1 } });
    expect(licenceSigningPayload(extended)).toContain('"future_field":{"a":1}');
  });

  it('signs and verifies canonical JSON without the signature with Ed25519', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const keyId = createHash('sha256').update(spki).digest('hex').slice(0, 16);
    expect(KeyId.safeParse(keyId).success).toBe(true);
    const unsigned = { ...EXAMPLE_LICENCE, key_id: keyId };
    const payload = licenceSigningPayload(unsigned);
    expect(payload).not.toContain('"signature"');
    expect(payload).toBe(canonicalJsonWithout(unsigned, ['signature']));
    const signature = `ed25519:${sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')}`;
    expect(Ed25519Signature.safeParse(signature).success).toBe(true);
    const signed = LicenceDocument.parse({ ...unsigned, signature });
    // Member order and the signature itself do not change the payload.
    const reordered = Object.fromEntries(Object.entries(signed).reverse());
    expect(licenceSigningPayload(reordered)).toBe(payload);
    const bytes = Buffer.from(signature.slice('ed25519:'.length), 'base64');
    expect(verify(null, Buffer.from(licenceSigningPayload(reordered), 'utf8'), publicKey, bytes)).toBe(true);
    expect(verify(null, Buffer.from(licenceSigningPayload({ ...signed, max_users: 9999 }), 'utf8'), publicKey, bytes)).toBe(false);
  });
});

describe('pack source folders', () => {
  const root = path.join(REPO_ROOT, 'packs/sources');
  const folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  it('exist', () => {
    expect(folders.length).toBeGreaterThanOrEqual(6);
  });

  for (const folder of folders) {
    describe(folder, () => {
      const rel = (file: string) => `packs/sources/${folder}/${file}`;

      it('has a valid source manifest named like the folder', () => {
        const manifest = PackSourceManifest.parse(JSON.parse(readRepoFile(rel('manifest.json'))));
        expect(manifest.pack_id).toBe(folder);
        const built = PackManifest.safeParse({ ...manifest, datasets: Object.fromEntries(PACK_DATASET_FILES.map((f) => [f, `sha256:${'0'.repeat(64)}`])) });
        expect(built.success).toBe(true);
      });

      it('has every dataset file', () => {
        for (const file of PACK_DATASET_FILES) expect(existsSync(path.join(root, folder, file)), file).toBe(true);
      });

      for (const [file, schema] of Object.entries(PACK_CSV_ROW_SCHEMAS)) {
        it(`${file} has the E.8 header and valid rows`, () => {
          const { header, records } = csvRecords(readRepoFile(rel(file)));
          expect(header).toEqual([...PACK_CSV_HEADERS[file as keyof typeof PACK_CSV_HEADERS]]);
          records.forEach((record, i) => {
            const result = schema.safeParse(record);
            expect(result.success, `${file} row ${i + 2}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
          });
        });
      }

      for (const [file, schema] of Object.entries(PACK_JSON_SCHEMAS)) {
        it(`${file} is valid`, () => {
          const result = schema.safeParse(JSON.parse(readRepoFile(rel(file))));
          expect(result.success, result.success ? '' : JSON.stringify(result.error.issues.slice(0, 5))).toBe(true);
        });
      }

      it('carries the required lookup domains', () => {
        const { records } = csvRecords(readRepoFile(rel('lookups.csv')));
        const domains = new Set(records.map((r) => r.domain));
        for (const d of REQUIRED_LOOKUP_DOMAINS) expect(domains.has(d), d).toBe(true);
        const keys = records.map((r) => `${r.domain}:${r.code}`);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('has valid mapping files when present', () => {
        const dir = path.join(root, folder, 'mappings');
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
          expect(MAPPING_FILE_RE.test(`mappings/${name}`), name).toBe(true);
          const { header, records } = csvRecords(readRepoFile(rel(`mappings/${name}`)));
          expect(header).toEqual([...MAPPING_CSV_HEADER]);
          for (const record of records) expect(MappingRow.safeParse(record).success, JSON.stringify(record)).toBe(true);
        }
      });
    });
  }
});
