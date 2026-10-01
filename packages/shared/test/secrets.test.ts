// No development credential or development key id of the repository (R-11) appears in the contract sources or the
// OpenAPI document. The compiled package ships in the release server image (I.2), where R-13 forbids development
// secrets and key ids, and the release artefact check of WP-33 hashes whole files, so it cannot find a secret copied
// into a schema example.
import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const src = resolve(here, '../src');

/** Values shorter than this are too generic to search for (for example the Keycloak admin user name). */
const MIN_LENGTH = 6;

function read(path: string): string | undefined {
  const full = join(repo, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

/** String values of the given keys anywhere in a JSON document. */
function jsonValues(text: string | undefined, keys: readonly string[]): string[] {
  if (text === undefined) return [];
  const out: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
    else if (typeof value === 'string' && key !== undefined && keys.includes(key)) out.push(value);
  };
  visit(JSON.parse(text));
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/**
 * The secret values of one key or secret file: a PEM private key gives its base64 body and the raw key in base64,
 * base64url and hex (the forms a key is pasted in); any other file gives its trimmed text.
 */
function fileSecrets(path: string): string[] {
  const text = readFileSync(path, 'utf8').trim();
  const pem = /^-----BEGIN ([A-Z ]+)-----\s+([\s\S]+?)\s+-----END \1-----$/.exec(text);
  if (!pem) return [text];
  const out = [(pem[2] as string).replace(/\s+/g, '')];
  if (pem[1] === 'PRIVATE KEY') {
    const jwk = createPrivateKey(text).export({ format: 'jwk' });
    if (typeof jwk.d === 'string') {
      const raw = Buffer.from(jwk.d, 'base64url');
      out.push(jwk.d, raw.toString('base64'), raw.toString('hex'));
    }
  }
  return out;
}

/** Secret values of every file of a folder except notes (`.md`), public keys (`.pub`) and lists (`.json`). */
function folderSecrets(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return files(dir).filter((f) => !/\.(md|pub|json)$/.test(f)).flatMap(fileSecrets);
}

/** Development key ids of R-11 (`packages/pack-tools/dev-keys/dev-key-ids.json`), which R-13 keeps out of releases. */
function developmentKeyIds(): string[] {
  const text = read('packages/pack-tools/dev-keys/dev-key-ids.json');
  return text === undefined ? [] : (JSON.parse(text) as unknown[]).filter((v): v is string => typeof v === 'string');
}

/** Development secrets and key ids of the folders R-11 names that exist in this checkout. */
function developmentSecrets(): string[] {
  const values: string[] = [...developmentKeyIds()];
  values.push(...folderSecrets(join(repo, 'packages/pack-tools/dev-keys')));
  values.push(...folderSecrets(join(repo, 'apps/server/test/fixtures/secrets')));
  values.push(...folderSecrets(join(repo, 'deploy/compose/config/demo-secrets')));
  const realm = read('deploy/compose/dev/keycloak/realm-mscd.json');
  values.push(...jsonValues(realm, ['secret']));
  if (realm !== undefined) {
    const credentials = (JSON.parse(realm) as { users?: { credentials?: { value?: string }[] }[] }).users ?? [];
    for (const user of credentials) for (const c of user.credentials ?? []) if (c.value) values.push(c.value);
  }
  values.push(...jsonValues(read('deploy/compose/dev/seaweedfs/s3.json'), ['accessKey', 'secretKey']));
  for (const m of (read('deploy/compose/dev/.env.example') ?? '').matchAll(/^[A-Z0-9_]*PASSWORD=(.+)$/gm)) values.push((m[1] as string).trim());
  const init = join(repo, 'deploy/compose/dev/postgres/init');
  if (existsSync(init)) for (const f of files(init)) for (const m of readFileSync(f, 'utf8').matchAll(/PASSWORD '([^']+)'/g)) values.push(m[1] as string);
  return [...new Set(values.filter((v) => v.length >= MIN_LENGTH))];
}

describe('development secrets', () => {
  const secrets = developmentSecrets();

  it('are found in the development folders of this checkout', () => {
    if (existsSync(join(repo, 'deploy/compose/dev/keycloak/realm-mscd.json'))) {
      expect(secrets.length).toBeGreaterThanOrEqual(3);
    }
    for (const id of developmentKeyIds()) expect(secrets, 'development key id').toContain(id);
    const devKeys = join(repo, 'packages/pack-tools/dev-keys');
    if (existsSync(devKeys)) {
      for (const f of files(devKeys).filter((x) => x.endsWith('.key'))) {
        expect(fileSecrets(f).length, `${relative(repo, f)} gives its body and raw key`).toBe(4);
        for (const value of fileSecrets(f)) expect(secrets).toContain(value);
      }
    }
  });

  it('do not appear in the contract sources', () => {
    const hits: string[] = [];
    for (const file of files(src)) {
      const text = readFileSync(file, 'utf8');
      for (const secret of secrets) if (text.includes(secret)) hits.push(`${relative(repo, file)} contains a development secret of length ${secret.length}`);
    }
    expect(hits).toEqual([]);
  });

  it('do not appear in the OpenAPI document', () => {
    const text = JSON.stringify(buildOpenApiDocument());
    expect(secrets.filter((secret) => text.includes(secret)).map((s) => `length ${s.length}`)).toEqual([]);
  });
});
