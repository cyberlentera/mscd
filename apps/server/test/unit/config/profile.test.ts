import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProfileError, loadProfile, validateProfile, applyOverrides } from '../../../src/config/load-profile';
import { ConfigError, MscdConfig } from '../../../src/config/mscd-config';

const PROFILES = path.resolve(__dirname, '../../../profiles');
const profile = (name: string) => path.join(PROFILES, `${name}.yaml`);
const raw = (name: string) => parseYaml(readFileSync(profile(name), 'utf8')) as Record<string, unknown>;

function issuesOf(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProfileError) return error.issues;
    throw error;
  }
  throw new Error('expected a ProfileError');
}

describe('shipped profiles', () => {
  it.each(['onprem', 'saas', 'demo', 'test'])('%s.yaml is valid in a development build', (name) => {
    const { profile: p, file } = loadProfile({ env: { MSCD_PROFILE_FILE: profile(name) }, flavor: 'dev' });
    expect(file).toBe(profile(name));
    expect(p.kms.provider).toBe('file');
  });

  it.each(['onprem', 'saas'])('%s.yaml is valid in a release build', (name) => {
    expect(() => loadProfile({ env: { MSCD_PROFILE_FILE: profile(name) }, flavor: 'release' })).not.toThrow();
  });

  it.each(['demo', 'test'])('%s.yaml is refused in a release build (I.1, D-20)', (name) => {
    const issues = issuesOf(() => loadProfile({ env: { MSCD_PROFILE_FILE: profile(name) }, flavor: 'release' }));
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['demo.enabled', 'identity.oidc.allow_insecure_http', 'gateway.tls.mode']));
    expect(issues.find((i) => i.path === 'demo.enabled')?.message).toBe('demo mode is refused in a release build (I.1)');
    if (name === 'test') expect(paths).toEqual(expect.arrayContaining(['test.endpoints_enabled', 'test.template_database']));
  });

  it('differ as I.1 says', () => {
    const onprem = loadProfile({ env: { MSCD_PROFILE_FILE: profile('onprem') }, flavor: 'dev' }).profile;
    const saas = loadProfile({ env: { MSCD_PROFILE_FILE: profile('saas') }, flavor: 'dev' }).profile;
    const test = loadProfile({ env: { MSCD_PROFILE_FILE: profile('test') }, flavor: 'dev' }).profile;
    expect(onprem.tenancy).toEqual({ mode: 'single', isolation: 'database' });
    expect(saas.tenancy).toEqual({ mode: 'multi', isolation: 'schema' });
    expect(saas.license.validation).toBe('online');
    expect(saas.packs.channel).toBe('managed');
    expect(onprem.http.trust_proxy).toEqual({ cidrs: ['172.31.250.10/32'] });
    expect(saas.http.trust_proxy).toEqual({ hops: 1 });
    expect(test.jobs.schedules_enabled).toBe(false);
    expect(test.observability.log_level).toBe('warn');
    expect(test.http.trust_proxy).toEqual({ hops: 0 });
    expect(test.demo.fixed_today).toBe('2026-09-29');
    expect(test.security.cookie_secure).toBe(false);
  });
});

describe('validation', () => {
  it('rejects kms.provider values other than file with the D-09 message', () => {
    const issues = issuesOf(() =>
      loadProfile({ env: { MSCD_PROFILE_FILE: profile('onprem'), MSCD__KMS__PROVIDER: 'cloud_kms' }, flavor: 'dev' }),
    );
    expect(issues).toEqual([{ path: 'kms.provider', message: 'kms.provider cloud_kms is not available in this build; use file' }]);
    for (const value of ['vault', 'hsm']) {
      const more = issuesOf(() =>
        loadProfile({ env: { MSCD_PROFILE_FILE: profile('onprem'), MSCD__GATEWAY__KMS__PROVIDER: value }, flavor: 'dev' }),
      );
      expect(more[0]?.message).toBe(`gateway.kms.provider ${value} is not available in this build; use file`);
    }
  });

  it('refuses trusted keys in the profile, from the file or the environment (D-16)', () => {
    const fromFile = { ...raw('onprem'), license: { validation: 'offline', trusted_keys: ['abc'] } };
    expect(issuesOf(() => validateProfile(fromFile, 'dev'))).toEqual([
      { path: 'license.trusted_keys', message: 'trusted keys are compiled into the build (D-16)' },
    ]);
    const fromEnv = issuesOf(() =>
      loadProfile({ env: { MSCD_PROFILE_FILE: profile('onprem'), MSCD__PACKS__TRUSTED_KEYS: '[abc]' }, flavor: 'release' }),
    );
    expect(fromEnv).toEqual([{ path: 'packs.trusted_keys', message: 'trusted keys are compiled into the build (D-16)' }]);
  });

  it('lists unknown keys, missing keys and wrong values together', () => {
    const input = raw('onprem');
    const http = input.http as Record<string, unknown>;
    input.http = { ...http, trust_proxy: true, porrt: 1 };
    delete (input.tenancy as Record<string, unknown>).isolation;
    const issues = issuesOf(() => validateProfile(input, 'dev'));
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'tenancy.isolation', message: 'is required' },
        { path: 'http.porrt', message: 'unknown key' },
        { path: 'http.trust_proxy', message: 'must be {hops: <n>} or {cidrs: [<range>, ...]}; true is not allowed (F.12)' },
      ]),
    );
  });

  it('applies the cross-field rules of demo mode (D-20)', () => {
    const input = raw('test');
    input.demo = { ...(input.demo as object), enabled: false };
    const paths = issuesOf(() => validateProfile(input, 'dev')).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['demo.fixed_today', 'demo.personas', 'identity.oidc.allow_insecure_http', 'gateway.tls.mode']),
    );
    const unacknowledged = raw('demo');
    unacknowledged.demo = { ...(unacknowledged.demo as object), acknowledge_insecure: false };
    expect(issuesOf(() => validateProfile(unacknowledged, 'dev')).map((i) => i.path)).toEqual(['demo.acknowledge_insecure']);
  });

  it('formats every issue on its own line', () => {
    const error = new ProfileError('/x/p.yaml', [
      { path: 'a.b', message: 'is required' },
      { path: 'c', message: 'unknown key' },
    ]);
    expect(error.format()).toBe('Invalid deployment profile /x/p.yaml:\n  - a.b: is required\n  - c: unknown key\n');
  });

  it('needs MSCD_PROFILE_FILE and a readable YAML mapping', () => {
    expect(issuesOf(() => loadProfile({ env: {}, flavor: 'dev' }))[0]?.path).toBe('MSCD_PROFILE_FILE');
    expect(issuesOf(() => loadProfile({ env: { MSCD_PROFILE_FILE: '/nonexistent/p.yaml' }, flavor: 'dev' }))[0]?.message).toMatch(
      /cannot read the file/,
    );
  });
});

describe('environment overrides', () => {
  it('parse values as YAML and create missing levels', () => {
    const result = applyOverrides(
      { http: { port: 3000 } },
      {
        MSCD__HTTP__PORT: '3100',
        MSCD__DEMO__ENABLED: 'true',
        MSCD__OBSERVABILITY__METRICS_PORT: 'null',
        MSCD__STORAGE__ADAPTERS__ENABLED: '[managed_vault]',
        MSCD__KMS__PROVIDER: 'cloud_kms',
        OTHER: 'x',
      },
    );
    expect(result).toEqual({
      http: { port: 3100 },
      demo: { enabled: true },
      observability: { metrics_port: null },
      storage: { adapters: { enabled: ['managed_vault'] } },
      kms: { provider: 'cloud_kms' },
    });
  });

  it('reject malformed names', () => {
    expect(issuesOf(() => applyOverrides({}, { MSCD__HTTP____PORT: '1' }))[0]?.message).toMatch(/not a valid override name/);
  });

  it('change a loaded profile', () => {
    const { profile: p } = loadProfile({
      env: { MSCD_PROFILE_FILE: profile('test'), MSCD__HTTP__PORT: '3174', MSCD__TEST__ENDPOINTS_ENABLED: 'true' },
      flavor: 'dev',
    });
    expect(p.http.port).toBe(3174);
    expect(p.test?.endpoints_enabled).toBe(true);
  });
});

describe('paths and secrets', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-config-'));
    await writeFile(path.join(dir, 'db.url'), 'postgres://mscd_app:from-file@db/mscd\n');
    await writeFile(path.join(dir, 'empty.url'), '\n');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('resolves relative paths against the folder of the profile', () => {
    const { profile: p } = loadProfile({ env: { MSCD_PROFILE_FILE: profile('test') }, flavor: 'dev' });
    expect(p.database.url_file).toBe(path.resolve(PROFILES, '../test/fixtures/secrets/db-app.url'));
    expect(p.gateway.token_files).toEqual([path.resolve(PROFILES, '../test/fixtures/secrets/gateway.token')]);
    expect(p.packs.dir).toBe(path.resolve(PROFILES, '../../../packs/dist'));
    const onprem = loadProfile({ env: { MSCD_PROFILE_FILE: profile('onprem') }, flavor: 'dev' }).profile;
    expect(onprem.database.url_file).toBe('/run/secrets/db-app.url');
  });

  it('reads database URLs from the shorthand variables first, then the profile files (I.1)', () => {
    const load = (env: Record<string, string>) =>
      MscdConfig.load({ runMode: 'api', flavor: 'dev', env: { MSCD_PROFILE_FILE: profile('test'), ...env } });
    expect(load({}).databaseUrl('app')).toBe('postgres://mscd_app:app-dev@localhost:55432/mscd');
    expect(load({ MSCD_DATABASE_URL: 'postgres://mscd_app:x@h/d' }).databaseUrl('app')).toBe('postgres://mscd_app:x@h/d');
    expect(load({ MSCD_DATABASE_URL_FILE: path.join(dir, 'db.url') }).databaseUrl('app')).toBe('postgres://mscd_app:from-file@db/mscd');
    expect(() => load({ MSCD_DATABASE_URL: 'a', MSCD_DATABASE_URL_FILE: 'b' }).databaseUrl('app')).toThrow(ConfigError);
    expect(() => load({ MSCD_DATABASE_URL_FILE: path.join(dir, 'empty.url') }).databaseUrl('app')).toThrow(/is empty/);
    expect(load({}).databaseUrl('admin')).toBe('postgres://postgres:postgres-dev@localhost:55432/mscd');
    const onprem = MscdConfig.load({ runMode: 'api', flavor: 'dev', env: { MSCD_PROFILE_FILE: profile('onprem') } });
    expect(() => onprem.databaseUrl('admin')).toThrow(/MSCD_DATABASE_ADMIN_URL/);
    expect(() => onprem.databaseUrl('app')).toThrow(/Cannot read the database.url_file file \/run\/secrets\/db-app.url/);
  });

  it('labels the deployment from the licence validation mode', () => {
    const load = (name: string) => MscdConfig.load({ runMode: 'api', flavor: 'dev', env: { MSCD_PROFILE_FILE: profile(name) } });
    expect(load('onprem').deploy).toBe('onprem');
    expect(load('saas').deploy).toBe('saas');
  });
});
