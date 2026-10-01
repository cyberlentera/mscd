// TenantProvisioner (C.8), the gateway data key issuer (D.5 `POST /v1/keys/data-key`) and the `tenant create` and
// `tenant verify-domain` commands (D-01, D-25).
import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tenantCreate, tenantVerifyDomain } from '../../../src/cli/tenant';
import type { MscdConfig } from '../../../src/config/mscd-config';
import { MIGRATIONS_ROOT } from '../../../src/db/migrator';
import {
  GatewayDataKeyIssuer,
  gatewayDataKeyIssuer,
  normaliseDomain,
  TenantProvisioner,
  TenantProvisioningError,
  type DataKeyIssuer,
} from '../../../src/db/tenant-provisioner';
import { buildProgram } from '../../../src/program';
import { createTenant, TEST_STORAGE_KEY_FILE, TestDataKeyIssuer } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from './helpers';

const GATEWAY_TOKEN = readFileSync(path.resolve(__dirname, '../../fixtures/secrets/gateway.token'), 'utf8').trim();

/** A stand-in for the storage gateway's data key endpoint, issuing real wrapped keys with the test KEK. */
async function startFakeGateway(): Promise<{ url: string; calls: { orgId: string; auth: string | undefined }[]; respond: { status?: number; body?: string }; close(): Promise<void> }> {
  const issuer = new TestDataKeyIssuer();
  const calls: { orgId: string; auth: string | undefined }[] = [];
  const respond: { status?: number; body?: string } = {};
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        if (req.method !== 'POST' || req.url !== '/v1/keys/data-key') {
          res.writeHead(404, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ title: 'Not found' }));
          return;
        }
        const { orgId } = JSON.parse(body) as { orgId: string };
        calls.push({ orgId, auth: req.headers.authorization });
        if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ title: 'Unauthorized', detail: 'bad token' }));
          return;
        }
        if (respond.status !== undefined) {
          res.writeHead(respond.status, { 'content-type': 'application/json' }).end(respond.body ?? '');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await issuer.issue(orgId)));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, respond, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A local port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('tenant provisioning (C.8)', () => {
  const db = useTestDatabase('empty');
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;
  let tmp: string | undefined;

  beforeAll(async () => {
    gateway = await startFakeGateway();
  });

  afterAll(async () => {
    await gateway?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function orgCount(slug: string): Promise<{ orgs: number; schemas: number; keys: number; audits: number }> {
    const { rows } = await sql<{ orgs: number; schemas: number; keys: number; audits: number }>`
      select (select count(*)::int from platform.organization where slug = ${slug}) as orgs,
             (select count(*)::int from pg_namespace where nspname = ${`org_${slug}`}) as schemas,
             (select count(*)::int from platform.tenant_key k join platform.organization o on o.id = k.organization_id where o.slug = ${slug}) as keys,
             (select count(*)::int from platform.audit_log where entity_code = ${slug}) as audits`.execute(db.migrator);
    return rows[0]!;
  }

  it('creates the organisation row, schema, migrations, data key, vault repository and audit entry', async () => {
    const issuer = new TestDataKeyIssuer();
    const id = '00000000-0000-4000-8000-00000000a0f1';
    const created = await createTenant(db, 'acme', { id, name: '  PT Acme Sejahtera ', timeZone: 'Asia/Makassar', siteCount: 3, demoDeployLabel: 'onprem', dataKeys: issuer });
    expect(created).toEqual({
      id,
      slug: 'acme',
      schemaName: 'org_acme',
      migrations: expect.arrayContaining(['0001_core', '0007_registers_workflow']),
      vaultRepositoryId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kekId: issuer.kekId,
    });
    expect(issuer.issued).toEqual([id]);

    await inScope(db.migrator, { platformScope: true }, async (trx) => {
      const org = await trx.selectFrom('platform.organization').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(org).toMatchObject({
        slug: 'acme',
        name: 'PT Acme Sejahtera',
        schema_name: 'org_acme',
        time_zone: 'Asia/Makassar',
        site_count: 3,
        status: 'active',
        local_login: 'allowed',
        demo_deploy_label: 'onprem',
      });
      const key = await trx.selectFrom('platform.tenant_key').selectAll().where('organization_id', '=', id).executeTakeFirstOrThrow();
      expect(key.kek_id).toBe(issuer.kekId);
      // The key is a SecretBox (F.11) the storage KEK opens with the additional data dek:<orgId>.
      const [version, kekId, iv, sealed] = key.wrapped_dek.split('.');
      expect([version, kekId]).toEqual(['v1', issuer.kekId]);
      const kek = Buffer.from(readFileSync(TEST_STORAGE_KEY_FILE, 'utf8').trim(), 'base64');
      const data = Buffer.from(sealed!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(iv!, 'base64url'));
      decipher.setAAD(Buffer.from(`dek:${id}`));
      decipher.setAuthTag(data.subarray(data.length - 16));
      expect(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()])).toHaveLength(32);

      const audit = await trx.selectFrom('platform.audit_log').selectAll().where('action', '=', 'tenant.created').where('organization_id', '=', id).execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_kind: 'operator', actor_user_id: null, entity_type: 'organization', entity_id: id, entity_code: 'acme' });
      expect(audit[0]!.after_data).toMatchObject({ slug: 'acme', schemaName: 'org_acme', timeZone: 'Asia/Makassar', siteCount: 3, kekId: issuer.kekId });
    });

    const owner = await sql<{ owner: string }>`select nspowner::regrole::text as owner from pg_namespace where nspname = 'org_acme'`.execute(db.migrator);
    expect(owner.rows).toEqual([{ owner: 'mscd_migrator' }]);
    const vault = await inScope(db.app, { orgId: id, schema: 'org_acme' }, (trx) => trx.selectFrom('storage_repository').selectAll().execute());
    expect(vault).toHaveLength(1);
    expect(vault[0]).toMatchObject({
      id: created.vaultRepositoryId,
      organization_id: id,
      slug: 'vault',
      name: 'Managed Vault',
      adapter: 'managed_vault',
      modes: ['stored'],
      config: { prefix: `tenants/${id}/` },
      connection_status: 'ok',
      ownership_type: 'organizational',
    });
  });

  it('refuses a duplicate slug or id before asking for a key, and leaves nothing behind', async () => {
    const issuer = new TestDataKeyIssuer();
    await expect(createTenant(db, 'acme', { dataKeys: issuer })).rejects.toThrow(/Organisation acme already exists/);
    await expect(createTenant(db, 'acme2', { id: '00000000-0000-4000-8000-00000000a0f1', dataKeys: issuer })).rejects.toThrow(
      /is already used by organisation acme/,
    );
    expect(issuer.issued).toEqual([]);
    expect(await orgCount('acme2')).toEqual({ orgs: 0, schemas: 0, keys: 0, audits: 0 });
  });

  it('validates the input', async () => {
    const issuer = new TestDataKeyIssuer();
    const cases: [Parameters<typeof createTenant>[2] & { slug?: string }, RegExp][] = [
      [{ slug: 'Acme' }, /slug "Acme" is invalid/],
      [{ slug: 'a' }, /slug "a" is invalid/],
      [{ slug: '9lives' }, /is invalid/],
      [{ slug: 'with-dash' }, /is invalid/],
      [{ slug: `a${'b'.repeat(40)}` }, /is invalid/],
      [{ id: 'not-a-uuid' }, /is not a lower-case UUID/],
      [{ name: '   ' }, /name must have 1 to 200 characters/],
      [{ timeZone: 'Mars/Olympus' }, /Unknown time zone "Mars\/Olympus"/],
      [{ siteCount: -1 }, /site count must be a whole number/],
      [{ siteCount: 1.5 }, /site count must be a whole number/],
      [{ demoDeployLabel: 'cloud' as 'saas' }, /must be saas or onprem/],
    ];
    for (const [{ slug = 'valid_slug', ...options }, message] of cases) {
      await expect(createTenant(db, slug, { ...options, dataKeys: issuer })).rejects.toThrow(message);
    }
    expect(issuer.issued).toEqual([]);
    expect(await orgCount('valid_slug')).toEqual({ orgs: 0, schemas: 0, keys: 0, audits: 0 });
  });

  it('creates no tenant when the key issuer fails', async () => {
    const failing: DataKeyIssuer = { issue: () => Promise.reject(new Error('gateway down')) };
    await expect(createTenant(db, 'nokey', { dataKeys: failing })).rejects.toThrow(/No data key for organisation nokey: gateway down/);
    expect(await orgCount('nokey')).toEqual({ orgs: 0, schemas: 0, keys: 0, audits: 0 });
  });

  it('rolls every step back when a tenant migration fails', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mscd-migrations-'));
    await cp(MIGRATIONS_ROOT, tmp, { recursive: true });
    await writeFile(path.join(tmp, 'tenant', '0099_broken.sql'), 'CREATE TABLE broken (id int);\nSELECT platform.secure_tenant_schema(current_schema());\n');
    const provisioner = new TenantProvisioner({ connectionString: db.urls.migrator, dataKeys: new TestDataKeyIssuer(), migrationsRoot: tmp });
    await expect(provisioner.create({ slug: 'halfway', name: 'Halfway', timeZone: 'Asia/Jakarta', siteCount: 1 })).rejects.toThrow(
      /Migration of tenant into schema org_halfway failed at 0099_broken: Tenant table org_halfway.broken has no organization_id column/,
    );
    expect(await orgCount('halfway')).toEqual({ orgs: 0, schemas: 0, keys: 0, audits: 0 });
  });

  it('rejects a malformed wrapped key', async () => {
    const odd: DataKeyIssuer = { issue: () => Promise.resolve({ wrappedDek: 'plain-key', kekId: 'abcd1234' }) };
    await expect(createTenant(db, 'oddkey', { dataKeys: odd })).rejects.toThrow(/not a SecretBox text/);
    expect(await orgCount('oddkey')).toEqual({ orgs: 0, schemas: 0, keys: 0, audits: 0 });
  });

  describe('GatewayDataKeyIssuer (D.5)', () => {
    it('posts the organisation id with the bearer token and returns the wrapped key', async () => {
      const issuer = new GatewayDataKeyIssuer({ url: `${gateway.url}/`, token: GATEWAY_TOKEN });
      const key = await issuer.issue('00000000-0000-4000-8000-0000000000b1');
      expect(key.kekId).toBe(new TestDataKeyIssuer().kekId);
      expect(key.wrappedDek).toMatch(new RegExp(`^v1\\.${key.kekId}\\.`));
      expect(gateway.calls.at(-1)).toEqual({ orgId: '00000000-0000-4000-8000-0000000000b1', auth: `Bearer ${GATEWAY_TOKEN}` });
      await issuer.close();
    });

    it('reports refusals, malformed answers and an unreachable gateway', async () => {
      await expect(new GatewayDataKeyIssuer({ url: gateway.url, token: 'wrong' }).issue('x')).rejects.toThrow(
        /answered 401 to POST \/v1\/keys\/data-key: Unauthorized: bad token/,
      );
      gateway.respond.status = 200;
      gateway.respond.body = 'not json';
      await expect(new GatewayDataKeyIssuer({ url: gateway.url, token: GATEWAY_TOKEN }).issue('x')).rejects.toThrow(/not JSON/);
      gateway.respond.body = JSON.stringify({ wrappedDek: 42 });
      await expect(new GatewayDataKeyIssuer({ url: gateway.url, token: GATEWAY_TOKEN }).issue('x')).rejects.toThrow(/no wrappedDek and kekId/);
      gateway.respond.body = JSON.stringify({ wrappedDek: 'v1.zz.a.b', kekId: 'zz' });
      await expect(new GatewayDataKeyIssuer({ url: gateway.url, token: GATEWAY_TOKEN }).issue('x')).rejects.toThrow(/not a SecretBox text/);
      delete gateway.respond.status;
      delete gateway.respond.body;
      const port = await closedPort();
      await expect(new GatewayDataKeyIssuer({ url: `http://127.0.0.1:${port}`, token: GATEWAY_TOKEN }).issue('x')).rejects.toThrow(
        new RegExp(`storage gateway at http://127.0.0.1:${port} is not reachable`),
      );
      expect(() => new GatewayDataKeyIssuer({ url: 'ftp://gateway', token: 't' })).toThrow(TenantProvisioningError);
    });

    it('refuses plain http with tls mode mtls before any secret is read (D.4, D.5)', () => {
      const callsBefore = gateway.calls.length;
      const tls = { ca: 'ca', cert: 'cert', key: 'key' };
      expect(() => new GatewayDataKeyIssuer({ url: gateway.url, token: GATEWAY_TOKEN, tls })).toThrow(
        /must use https with tls mode mtls; plain http is allowed only with tls mode off/,
      );
      const readSecretFile = vi.fn(() => 'secret');
      const config = {
        profile: {
          storage: {
            gateway: {
              url: gateway.url,
              token_file: 'gateway.token',
              tls: { mode: 'mtls', ca_file: 'ca.crt', cert_file: 'client.crt', key_file: 'client.key' },
            },
          },
        },
        readSecretFile,
      } as unknown as MscdConfig;
      expect(() => gatewayDataKeyIssuer(config)).toThrow(TenantProvisioningError);
      expect(readSecretFile).not.toHaveBeenCalled();
      expect(gateway.calls).toHaveLength(callsBefore);
    });
  });

  describe('commands', () => {
    function useCliEnv(extra: Record<string, string> = {}): void {
      vi.stubEnv('MSCD_PROFILE_FILE', path.resolve(__dirname, '../../../profiles/test.yaml'));
      vi.stubEnv('MSCD_DATABASE_MIGRATOR_URL', db.urls.migrator);
      vi.stubEnv('MSCD_DATABASE_MIGRATOR_URL_FILE', '');
      vi.stubEnv('MSCD__OBSERVABILITY__METRICS_PORT', 'null');
      for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
    }

    /** Runs the command line in-process; returns stdout, stderr and the exit code. */
    async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
      let out = '';
      let err = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => ((err += String(chunk)), true));
      class Exit extends Error {
        constructor(readonly code: number) {
          super(`exit ${code}`);
        }
      }
      vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
        throw new Exit(Number(code ?? 0));
      });
      try {
        await buildProgram().exitOverride().parseAsync(['node', 'mscd-server', ...args]);
        return { out, err, code: 0 };
      } catch (error) {
        if (error instanceof Exit) return { out, err, code: error.code };
        throw error;
      } finally {
        vi.restoreAllMocks();
      }
    }

    it('tenant create takes its data key from the configured storage gateway', async () => {
      useCliEnv({ MSCD__STORAGE__GATEWAY__URL: gateway.url });
      const result = await cli(['tenant', 'create', '--slug', 'cli_org', '--name', 'CLI Org', '--time-zone', 'Asia/Jayapura', '--site-count', '2', '--demo-deploy-label', 'saas']);
      expect(result).toMatchObject({ code: 0, err: '' });
      expect(result.out).toMatch(/^tenant create: organisation cli_org \([0-9a-f-]{36}\) created: schema org_cli_org, 7 tenant migrations, data key [0-9a-f]{8}, Managed Vault repository [0-9a-f-]{36}\n$/);
      const org = await sql<{ time_zone: string; site_count: number; demo_deploy_label: string }>`
        select time_zone, site_count, demo_deploy_label from platform.organization where slug = 'cli_org'`.execute(db.migrator);
      expect(org.rows).toEqual([{ time_zone: 'Asia/Jayapura', site_count: 2, demo_deploy_label: 'saas' }]);
      expect(gateway.calls.at(-1)?.auth).toBe(`Bearer ${GATEWAY_TOKEN}`);
    });

    it('tenant create fails without a reachable gateway and creates nothing', async () => {
      useCliEnv({ MSCD__STORAGE__GATEWAY__URL: `http://127.0.0.1:${await closedPort()}` });
      const result = await cli(['tenant', 'create', '--slug', 'offline_org', '--name', 'Offline']);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/^tenant create failed: No data key for organisation offline_org: the storage gateway at http:\/\/127\.0\.0\.1:\d+ is not reachable/);
      expect(await orgCount('offline_org')).toEqual({ orgs: 0, schemas: 0, keys: 0, audits: 0 });
    });

    it('tenant create refuses a demo label outside demo mode and a bad site count', async () => {
      const config = { demoEnabled: false, databaseUrl: () => db.urls.migrator } as unknown as MscdConfig;
      const issuer = new TestDataKeyIssuer();
      await expect(tenantCreate(config, { slug: 'demo_only', name: 'Demo', demoDeployLabel: 'saas' }, issuer)).rejects.toThrow(/needs demo mode/);
      await expect(tenantCreate(config, { slug: 'demo_only', name: 'Demo', siteCount: 'two' }, issuer)).rejects.toThrow(/--site-count must be a whole number/);
      expect(issuer.issued).toEqual([]);
    });

    it('tenant verify-domain records a normalised domain once and audits it', async () => {
      useCliEnv();
      const first = await cli(['tenant', 'verify-domain', '--org', 'acme', '--domain', ' Acme.CO.ID. ', '--by', 'ops ticket 42']);
      expect(first).toEqual({ code: 0, err: '', out: 'tenant verify-domain: acme.co.id is now verified for organisation acme\n' });
      const second = await cli(['tenant', 'verify-domain', '--org', 'acme', '--domain', 'acme.co.id', '--by', 'someone else']);
      expect(second.out).toBe('tenant verify-domain: acme.co.id was already verified for organisation acme; nothing changed\n');

      await inScope(db.migrator, { platformScope: true }, async (trx) => {
        const rows = await trx.selectFrom('platform.verified_domain').select(['domain', 'verified_by']).execute();
        expect(rows).toEqual([{ domain: 'acme.co.id', verified_by: 'ops ticket 42' }]);
        const audit = await trx.selectFrom('platform.audit_log').select(['action', 'entity_code', 'after_data', 'actor_kind']).where('action', '=', 'tenant.domain_verified').execute();
        expect(audit).toEqual([{ action: 'tenant.domain_verified', entity_code: 'acme.co.id', after_data: { domain: 'acme.co.id', verifiedBy: 'ops ticket 42' }, actor_kind: 'operator' }]);
      });

      const unknown = await cli(['tenant', 'verify-domain', '--org', 'nobody', '--domain', 'nobody.com', '--by', 'ops']);
      expect(unknown).toMatchObject({ code: 1, err: 'tenant verify-domain failed: No organisation with slug nobody\n' });
      const config = { databaseUrl: () => db.urls.migrator } as unknown as MscdConfig;
      await expect(tenantVerifyDomain(config, { org: 'acme', domain: 'acme', by: 'ops' })).rejects.toThrow(/is not an email domain/);
      await expect(tenantVerifyDomain(config, { org: 'acme', domain: 'acme.co.id', by: ' ' })).rejects.toThrow(/1 to 150 characters/);
    });

    it('normalises and checks domains', () => {
      expect(normaliseDomain('Mail.Example.COM')).toBe('mail.example.com');
      expect(normaliseDomain('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
      for (const bad of ['', 'localhost', 'a..b.com', '-bad.com', 'bad-.com', 'under_score.com', 'x.c', 'example.123', 'a b.com', `${'a'.repeat(64)}.com`]) {
        expect(() => normaliseDomain(bad), bad).toThrow(TenantProvisioningError);
      }
    });
  });

  it('keeps the data key wrapping of the test issuer stable (kek id is the first 8 hex of the KEK hash)', () => {
    const kek = Buffer.from(readFileSync(TEST_STORAGE_KEY_FILE, 'utf8').trim(), 'base64');
    expect(new TestDataKeyIssuer().kekId).toBe(createHash('sha256').update(kek).digest('hex').slice(0, 8));
  });
});
