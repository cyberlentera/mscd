// Building and verifying packs: deterministic archives, manifest checksums, signatures, trusted and rejected keys,
// and the dataset validation with the shared schemas.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PACK_DATASET_FILES } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import {
  DEV_KEY_IDS, PackError, buildAllPacks, buildPack, formatSignatureFile, generateSigningKeyPair, keyId, parseSignatureFile, readPack,
  readTar, verifyPack, type GeneratedKeyPair,
} from '../src/index.js';
import { DEV_KEYS_DIR, SOURCES_DIR, archiveOf, tempDir, testPack } from './helpers.js';

function packError(fn: () => unknown): PackError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PackError);
    return error as PackError;
  }
  throw new Error('expected a PackError');
}

/** Copy of a repository pack source folder that a test may change. */
function sourceCopy(packId = 'ISO27001-2022'): string {
  const dir = path.join(tempDir(), packId);
  cpSync(path.join(SOURCES_DIR, packId), dir, { recursive: true });
  return dir;
}

/** Archive of the files with a manifest whose checksums match them, signed with the key. */
function resigned(files: Map<string, Buffer>, key: GeneratedKeyPair, edit: (manifest: Record<string, unknown>) => void = () => {}): Buffer {
  const manifest = JSON.parse((files.get('manifest.json') as Buffer).toString()) as Record<string, unknown>;
  const datasets: Record<string, string> = {};
  for (const [name, data] of files) {
    if (name !== 'manifest.json' && name !== 'signature') datasets[name] = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  }
  manifest.datasets = datasets;
  edit(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = Buffer.from(formatSignatureFile(sign(null, manifestBytes, key.privateKey), key.keyId));
  const out = new Map(files);
  out.set('manifest.json', manifestBytes);
  out.set('signature', signature);
  return archiveOf(out);
}

describe('buildPack', () => {
  it('builds a deterministic archive: sorted entries, then signature, fixed metadata, gzip level 9', () => {
    const { key, pack } = testPack();
    const again = buildPack(path.join(SOURCES_DIR, 'ISO27001-2022'), key.privateKey);
    expect(again.bytes.equals(pack.bytes)).toBe(true);
    expect(again.sha256).toBe(pack.sha256);
    expect(pack.fileName).toBe('ISO27001-2022-1.2.0.pack');
    expect(pack.bytes[8]).toBe(2); // gzip XFL: maximum compression
    const names = readTar(gunzipSync(pack.bytes), { maxEntries: 100 }).map((e) => e.path);
    const sorted = names.slice(0, -1);
    expect(sorted).toEqual([...sorted].sort());
    expect(names.at(-1)).toBe('signature');
    expect(new Set(names)).toEqual(new Set(['manifest.json', 'signature', ...PACK_DATASET_FILES]));
  });

  it('writes the checksum of every source dataset into the manifest and signs its exact bytes', () => {
    const { key, pack, files } = testPack();
    for (const name of PACK_DATASET_FILES) {
      const source = readFileSync(path.join(SOURCES_DIR, 'ISO27001-2022', name));
      expect(pack.manifest.datasets[name]).toBe(`sha256:${createHash('sha256').update(source).digest('hex')}`);
      expect(files.get(name)?.equals(source)).toBe(true);
    }
    const signature = parseSignatureFile(files.get('signature') as Buffer);
    expect(signature.keyId).toBe(key.keyId);
    const manifestText = (files.get('manifest.json') as Buffer).toString();
    expect(Object.keys(JSON.parse(manifestText))).toEqual([
      'pack_id', 'pack_version', 'framework_code', 'framework_name', 'edition', 'status', 'pre_release', 'engine_min_version', 'modules',
      'applicability_target', 'catalogue', 'datasets',
    ]);
  });

  it('gives a different archive for another signing key, and both verify with their own key only', () => {
    const { key, pack } = testPack();
    const other = generateSigningKeyPair();
    const otherPack = buildPack(path.join(SOURCES_DIR, 'ISO27001-2022'), other.privateKeyPem);
    expect(otherPack.bytes.equals(pack.bytes)).toBe(false);
    expect(verifyPack(otherPack.bytes, [other.publicKeyPem]).keyId).toBe(other.keyId);
    expect(packError(() => verifyPack(otherPack.bytes, [key.publicKey])).code).toBe('untrusted_key');
  });

  it('validates every dataset row with the shared schemas and names file and line', () => {
    const dir = sourceCopy();
    const file = path.join(dir, 'requirements.csv');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[3] = lines[3]?.replace(',true,', ',yes,') ?? '';
    writeFileSync(file, lines.join('\n'));
    const error = packError(() => buildPack(dir, testPack().key.privateKey));
    expect(error.code).toBe('dataset');
    expect(error.issues.some((i) => i.startsWith('requirements.csv:4: is_hs_common'))).toBe(true);
  });

  it('rejects a wrong header, a missing dataset, encoding faults and broken references', () => {
    const key = testPack().key.privateKey;
    const cases: [string, (dir: string) => void, RegExp][] = [
      ['header', (d) => writeFileSync(path.join(d, 'frequencies.csv'), 'code,label\nx,y\n'), /^frequencies\.csv: header is/],
      ['missing', (d) => rmSync(path.join(d, 'rules.json')), /^rules\.json: is missing/],
      ['bom', (d) => writeFileSync(path.join(d, 'lookups.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path.join(d, 'lookups.csv'))])), /^lookups\.csv: starts with a byte order mark/],
      ['crlf', (d) => writeFileSync(path.join(d, 'chain.csv'), readFileSync(path.join(d, 'chain.csv'), 'utf8').replaceAll('\n', '\r\n')), /^chain\.csv: has carriage returns/],
      ['utf8', (d) => writeFileSync(path.join(d, 'prep_tasks.csv'), Buffer.concat([readFileSync(path.join(d, 'prep_tasks.csv')), Buffer.from([0xc3, 0x28, 0x0a])])), /^prep_tasks\.csv: is not valid UTF-8/],
      ['quote', (d) => writeFileSync(path.join(d, 'review_inputs.csv'), 'code,title,mandatory,sort_order\nMRI-1,"open,true,1\n'), /^review_inputs\.csv: is not valid CSV/],
      ['fields', (d) => writeFileSync(path.join(d, 'review_inputs.csv'), 'code,title,mandatory,sort_order\nMRI-1,x,true\n'), /^review_inputs\.csv:2: has 3 fields, expected 4/],
      ['empty line', (d) => writeFileSync(path.join(d, 'review_inputs.csv'), 'code,title,mandatory,sort_order\n\nMRI-1,x,true,1\n'), /^review_inputs\.csv:2: has 1 fields/],
      ['json', (d) => writeFileSync(path.join(d, 'drift_rules.json'), '[{"code": 1}]'), /^drift_rules\.json: 0\.code/],
      ['catalogue ref', (d) => writeFileSync(path.join(d, 'catalogue.csv'), readFileSync(path.join(d, 'catalogue.csv'), 'utf8').replace('A.5.1,A.5,Policies for information security,,', 'A.5.1,A.5,Policies for information security,99.9,')), /requirement_code 99\.9 is not in requirements\.csv/],
      ['duplicate', (d) => writeFileSync(path.join(d, 'frequencies.csv'), `${readFileSync(path.join(d, 'frequencies.csv'), 'utf8')}daily,Daily,Harian,1,99\n`), /duplicate code: daily/],
      ['lookup domain', (d) => writeFileSync(path.join(d, 'lookups.csv'), 'domain,code,label_en,label_id,sort_order\ndoc_type,policy,Policy,Kebijakan,1\n'), /domain treatment_option is missing/],
      ['labels', (d) => writeFileSync(path.join(d, 'labels.id.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(d, 'labels.id.json'), 'utf8')), 'extra.key': 'x' })), /keys differ from labels\.en\.json/],
      ['catalogue flag', (d) => writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8')), catalogue: false })), /catalogue is false but catalogue\.csv has 93 rows/],
    ];
    for (const [label, change, pattern] of cases) {
      const dir = sourceCopy();
      change(dir);
      const error = packError(() => buildPack(dir, key));
      expect(error.code, label).toBe('dataset');
      expect(error.issues.some((i) => pattern.test(i)), `${label}: ${error.issues.join(' | ')}`).toBe(true);
    }
  });

  it('builds mapping datasets and checks their references', () => {
    const key = testPack().key;
    const dir = sourceCopy();
    mkdirSync(path.join(dir, 'mappings'));
    writeFileSync(path.join(dir, 'mappings/ISO9001-2015.csv'), 'source_code,target_pack_id,target_code,mapping_type,evidence_reusable,note\n6.1,ISO9001-2015,6.1,equivalent,true,\n');
    const pack = buildPack(dir, key.privateKey);
    expect(pack.manifest.datasets['mappings/ISO9001-2015.csv']).toMatch(/^sha256:/);
    expect(verifyPack(pack.bytes, [key.publicKey]).datasets.mappings['mappings/ISO9001-2015.csv']).toHaveLength(1);
    writeFileSync(path.join(dir, 'mappings/ISO9001-2015.csv'), 'source_code,target_pack_id,target_code,mapping_type,evidence_reusable,note\n77.7,ISO9001-2015,6.1,equivalent,true,\n');
    expect(packError(() => buildPack(dir, key.privateKey)).issues.join('\n')).toMatch(/source_code 77\.7 is not a requirement/);
  });

  it('refuses source folders with links, extra files, nested folders, a signature or a bad manifest', () => {
    const key = testPack().key.privateKey;
    const cases: [string, (dir: string) => void, string, RegExp][] = [
      ['symlink', (d) => { rmSync(path.join(d, 'rules.json')); symlinkSync('/etc/passwd', path.join(d, 'rules.json')); }, 'source', /rules\.json: is a symbolic link/],
      ['nested', (d) => mkdirSync(path.join(d, 'extra')), 'source', /extra: folders other than mappings\/ are not allowed/],
      ['deep mapping', (d) => mkdirSync(path.join(d, 'mappings/deep'), { recursive: true }), 'source', /mappings\/deep: folders other than mappings/],
      ['signature', (d) => writeFileSync(path.join(d, 'signature'), 'x'), 'source', /signature: a source folder has no signature file/],
      ['unknown file', (d) => writeFileSync(path.join(d, 'notes.txt'), 'x'), 'dataset', /notes\.txt: is not a pack dataset/],
      ['no manifest', (d) => rmSync(path.join(d, 'manifest.json')), 'manifest', /has no manifest\.json/],
      ['manifest json', (d) => writeFileSync(path.join(d, 'manifest.json'), '{'), 'manifest', /not valid UTF-8 JSON/],
      ['manifest datasets', (d) => writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8')), datasets: {} })), 'manifest', /not a valid source manifest/],
      ['manifest id', (d) => writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8')), pack_id: 'ISO27001-2013' })), 'manifest', /pack_id must equal/],
    ];
    for (const [label, change, code, pattern] of cases) {
      const dir = sourceCopy();
      change(dir);
      const error = packError(() => buildPack(dir, key));
      expect(error.code, label).toBe(code);
      expect(error.message, label).toMatch(pattern);
    }
    expect(packError(() => buildPack(path.join(tempDir(), 'none'), key)).code).toBe('source');
  });

  it('refuses a signing key that is not Ed25519, a public key, or a rejected key id', () => {
    const dir = path.join(SOURCES_DIR, 'ISO27001-2022');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(packError(() => buildPack(dir, rsa)).code).toBe('signing_key');
    expect(packError(() => buildPack(dir, testPack().key.publicKeyPem)).code).toBe('signing_key');
    expect(packError(() => buildPack(dir, 'not a key')).code).toBe('signing_key');
    const devKey = readFileSync(path.join(DEV_KEYS_DIR, 'pack-signing.key'));
    const error = packError(() => buildPack(dir, devKey, { rejectKeyIds: DEV_KEY_IDS }));
    expect(error.code).toBe('signing_key');
    expect(error.message).toMatch(/development key/);
  });
});

describe('verifyPack', () => {
  it('returns the manifest, the datasets and the signing key id', () => {
    const { key, pack } = testPack();
    const verified = verifyPack(pack.bytes, [key.publicKey]);
    expect(verified.keyId).toBe(key.keyId);
    expect(verified.sha256).toBe(pack.sha256);
    expect(verified.manifest.pack_version).toBe('1.2.0');
    expect(verified.datasets.catalogue).toHaveLength(93);
    expect(verified.datasets.activities).toHaveLength(69);
    expect(verified.datasets.chain).toHaveLength(8);
    expect(verified.datasets.auditActivities).toHaveLength(6);
    expect(verified.datasets.catalogue[0]).toMatchObject({ item_code: 'A.5.1', theme_code: 'A.5', requirement_code: null, sort_order: 1 });
    expect(verified.files.size).toBe(17);
  });

  it('accepts the trusted keys of a server build, using only pack keys', () => {
    const { key, pack } = testPack();
    expect(verifyPack(pack.bytes, [{ kind: 'pack', keyId: key.keyId, publicKeyPem: key.publicKeyPem }]).keyId).toBe(key.keyId);
    expect(packError(() => verifyPack(pack.bytes, [{ kind: 'licence', keyId: key.keyId, publicKeyPem: key.publicKeyPem }])).code).toBe('untrusted_key');
    expect(() => verifyPack(pack.bytes, [{ kind: 'pack', keyId: '0000000000000000', publicKeyPem: key.publicKeyPem }])).toThrow(/states key id/);
    expect(packError(() => verifyPack(pack.bytes, [])).code).toBe('untrusted_key');
  });

  it('rejects a manifest changed after signing', () => {
    const { key, files } = testPack();
    const manifest = (files.get('manifest.json') as Buffer).toString().replace('"pack_version": "1.2.0"', '"pack_version": "1.2.1"');
    const tampered = new Map(files).set('manifest.json', Buffer.from(manifest));
    const error = packError(() => verifyPack(archiveOf(tampered), [key.publicKey]));
    expect(error.code).toBe('signature');
  });

  it('rejects a malformed signature file and a signature by another key under the same key id', () => {
    const { key, files } = testPack();
    for (const text of ['', 'ed25519:abc\nkey:0000000000000000\n', `rsa:${'A'.repeat(86)}==\nkey:${key.keyId}\n`, `ed25519:${'A'.repeat(86)}==\n`]) {
      expect(packError(() => verifyPack(archiveOf(new Map(files).set('signature', Buffer.from(text))), [key.publicKey])).code).toBe('signature');
    }
    const other = generateSigningKeyPair();
    const forged = formatSignatureFile(sign(null, files.get('manifest.json') as Buffer, other.privateKey), key.keyId);
    expect(packError(() => verifyPack(archiveOf(new Map(files).set('signature', Buffer.from(forged))), [key.publicKey])).code).toBe('signature');
  });

  it('rejects a dataset that does not match its checksum', () => {
    const { key, files } = testPack();
    const lookups = Buffer.from(`${(files.get('lookups.csv') as Buffer).toString()}doc_type,manual,Manual,Panduan,99\n`);
    const error = packError(() => verifyPack(archiveOf(new Map(files).set('lookups.csv', lookups)), [key.publicKey]));
    expect(error.code).toBe('checksum');
    expect(error.issues).toEqual(['lookups.csv']);
  });

  it('rejects signed packs whose manifest or datasets break the schemas', () => {
    const { key, files } = testPack();
    expect(packError(() => verifyPack(resigned(files, key, (m) => { m.status = 'beta'; }), [key.publicKey])).code).toBe('manifest');
    expect(packError(() => verifyPack(resigned(files, key, (m) => { m.pack_id = 'ISO27001-2013'; }), [key.publicKey])).code).toBe('manifest');
    const badRows = new Map(files).set('chain.csv', Buffer.from('stage_key,position\nrisk,1\n'));
    const error = packError(() => verifyPack(resigned(badRows, key), [key.publicKey]));
    expect(error.code).toBe('dataset');
    expect(error.issues[0]).toMatch(/^chain\.csv: header is/);
    const missing = new Map(files);
    missing.delete('rules.json');
    expect(packError(() => verifyPack(resigned(missing, key), [key.publicKey])).issues).toContain('rules.json: is missing');
    expect(verifyPack(resigned(files, key), [key.publicKey]).manifest.pack_id).toBe('ISO27001-2022');
  });

  it('refuses development keys with rejectKeyIds, even when they are trusted', () => {
    const devKey = readFileSync(path.join(DEV_KEYS_DIR, 'pack-signing.key'));
    const devPub = readFileSync(path.join(DEV_KEYS_DIR, 'pack-signing.pub'), 'utf8');
    const pack = buildPack(path.join(SOURCES_DIR, 'ISO22301-2019'), devKey);
    expect(DEV_KEY_IDS).toContain(pack.keyId);
    expect(verifyPack(pack.bytes, [devPub]).keyId).toBe(keyId(devPub));
    const error = packError(() => verifyPack(pack.bytes, [devPub], { rejectKeyIds: DEV_KEY_IDS }));
    expect(error.code).toBe('rejected_key');
    expect(error.message).toMatch(/development key/);
    // A pack signed with another key still verifies when development keys are refused.
    const { key, pack: testBuilt } = testPack();
    expect(verifyPack(testBuilt.bytes, [key.publicKey, devPub], { rejectKeyIds: DEV_KEY_IDS }).keyId).toBe(key.keyId);
  });

  it('reads a pack with the archive limits the caller passes', () => {
    const { key, pack } = testPack();
    expect(packError(() => verifyPack(pack.bytes, [key.publicKey], { limits: { maxEntries: 5 } })).code).toBe('archive');
    expect(readPack(pack.bytes, { maxEntries: 19 }).files.size).toBe(19);
  });
});

describe('buildAllPacks', () => {
  it('builds the six packs of the repository sources and removes stale packs from the output folder', () => {
    const { key } = testPack();
    const out = tempDir();
    writeFileSync(path.join(out, 'ISO27001-2022-1.1.0.pack'), 'stale');
    writeFileSync(path.join(out, 'README.txt'), 'kept');
    const result = buildAllPacks(SOURCES_DIR, key.privateKey, out);
    const expected = [
      'ISO22301-2019-1.0.0.pack', 'ISO27001-2022-1.2.0.pack', 'ISO37001-2016-1.0.0.pack', 'ISO37001-2025-0.6.0.pack', 'ISO9001-2015-1.4.2.pack',
      'ISO9001-2026-0.9.0.pack',
    ];
    expect(result.packs.map((p) => p.fileName)).toEqual(expected);
    expect(result.removed).toEqual([path.join(out, 'ISO27001-2022-1.1.0.pack')]);
    expect(readdirSync(out).sort()).toEqual(['README.txt', ...expected].sort());
    for (const file of expected) {
      const verified = verifyPack(readFileSync(path.join(out, file)), [key.publicKey]);
      expect(file).toBe(`${verified.manifest.pack_id}-${verified.manifest.pack_version}.pack`);
    }
    const byId = new Map(result.packs.map((p) => [p.manifest.pack_id, p.manifest]));
    expect(byId.get('ISO9001-2026')?.supersedes).toEqual({ edition: '2015', transition_ends: '2029-09-15' });
    expect(byId.get('ISO37001-2025')?.pre_release).toBe(true);
    expect(byId.get('ISO37001-2016')?.status).toBe('withdrawn');
  });

  it('requires folder names equal to the pack ids and writes nothing when a pack fails', () => {
    const { key } = testPack();
    const sources = tempDir();
    cpSync(path.join(SOURCES_DIR, 'ISO22301-2019'), path.join(sources, 'ISO22301-2019'), { recursive: true });
    cpSync(path.join(SOURCES_DIR, 'ISO27001-2022'), path.join(sources, 'renamed'), { recursive: true });
    const out = path.join(tempDir(), 'dist');
    expect(packError(() => buildAllPacks(sources, key.privateKey, out)).message).toMatch(/folder name must equal the pack_id/);
    expect(existsSync(out)).toBe(false);
    expect(packError(() => buildAllPacks(tempDir(), key.privateKey, out)).message).toMatch(/holds no pack source folders/);
  });
});
