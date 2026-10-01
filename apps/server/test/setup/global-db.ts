// Vitest global setup of the integration tests (build plan J.2).
//
// Uses the PostgreSQL server of MSCD_TEST_DATABASE_URL (an administrator URL) when set; otherwise starts
// postgres:16.15-alpine (or MSCD_TEST_PG_IMAGE) with Testcontainers, labelled mscd.test=true. Then builds the
// template database mscd_tpl_empty: the C.2 bootstrap (roles, schema ext, pg_trgm) and the platform and ref
// migrations (C.3 steps 1 and 2), no tenants. WP-14 adds mscd_tpl_demo. Test files copy a template through
// useTestDatabase() in test/setup/test-db.ts and add organisations with createTenant() below. Teardown stops the
// container.
//
// MSCD_TEST_CONTAINER_PREFIX names the container <prefix>postgres-<random> (useful when several runs share a host).
import { execFile } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runBootstrap } from '../../src/db/bootstrap';
import { migrateFolder, openDedicatedDatabase } from '../../src/db/migrator';
import { TenantProvisioner, type CreatedTenant, type CreateTenantInput, type DataKeyIssuer, type WrappedDataKey } from '../../src/db/tenant-provisioner';
import type { TestDatabase } from './test-db';
import { serverUrl, templateName, TEST_ROLE_PASSWORDS, type TemplateKind, type TestDbServer } from './test-db-server';

const DEFAULT_IMAGE = 'postgres:16.15-alpine';
/** Containers of crashed runs are removed by later runs once this old (R-06). */
const CONTAINER_LIFETIME_MS = 3 * 60 * 60 * 1000;
const run = promisify(execFile);

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  await removeExpiredTestContainers();

  let stopContainer: (() => Promise<void>) | undefined;
  let server: TestDbServer;
  const external = process.env.MSCD_TEST_DATABASE_URL;
  if (external) {
    const url = new URL(external);
    server = {
      host: url.hostname,
      port: Number(url.port || 5432),
      adminUser: decodeURIComponent(url.username),
      adminPassword: decodeURIComponent(url.password),
      adminDatabase: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
      templates: [],
    };
  } else {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const image = process.env.MSCD_TEST_PG_IMAGE || DEFAULT_IMAGE;
    let container = new PostgreSqlContainer(image)
      .withDatabase('postgres')
      .withUsername('postgres')
      .withPassword(randomBytes(12).toString('hex'))
      .withLabels({ 'mscd.test': 'true', 'mscd.test.expires': String(Date.now() + CONTAINER_LIFETIME_MS) });
    const prefix = process.env.MSCD_TEST_CONTAINER_PREFIX;
    if (prefix) container = container.withName(`${prefix}postgres-${randomBytes(4).toString('hex')}`);
    const started = await container.start();
    stopContainer = async () => {
      await started.stop();
    };
    server = {
      host: started.getHost(),
      port: started.getPort(),
      adminUser: started.getUsername(),
      adminPassword: started.getPassword(),
      adminDatabase: 'postgres',
      templates: [],
    };
  }

  try {
    await buildTemplate(server, 'empty', async (adminUrlOfTemplate) => {
      await runBootstrap({ adminUrl: adminUrlOfTemplate, passwords: { ...TEST_ROLE_PASSWORDS } });
      await migratePlatformAndRef(serverUrl(server, templateName('empty'), 'mscd_migrator', TEST_ROLE_PASSWORDS.migrator));
    });
  } catch (error) {
    await stopContainer?.();
    throw error;
  }

  project.provide('mscdTestDb', server);
  return async () => {
    await stopContainer?.();
    await removeExpiredTestContainers();
  };
}

/** C.3 steps 1 and 2 as `migrate` runs them: each folder on a dedicated migrator connection with platform scope. */
export async function migratePlatformAndRef(migratorUrl: string): Promise<void> {
  for (const folder of ['platform', 'ref'] as const) {
    const migrator = openDedicatedDatabase(migratorUrl, { platformScope: true, applicationName: 'mscd-test-template' });
    try {
      await migrateFolder(migrator, folder, { migrationTableSchema: folder });
    } finally {
      await migrator.destroy();
    }
  }
}

/** Development storage KEK of the test profile (`gateway.kms.file.path`), R-11. */
export const TEST_STORAGE_KEY_FILE = path.resolve(__dirname, '../fixtures/secrets/storage.key');

/**
 * Test implementation of `DataKeyIssuer`: wraps a random 32-byte data key the way the storage gateway does
 * (F.11 SecretBox `v1.<kekId>.<iv>.<ciphertext and tag>`, AES-256-GCM, additional data `dek:<orgId>`) with the
 * development storage KEK, so the gateway of later work packages can unwrap keys of test tenants.
 */
export class TestDataKeyIssuer implements DataKeyIssuer {
  readonly kekId: string;
  readonly issued: string[] = [];
  private readonly kek: Buffer;

  constructor(kek: Buffer = Buffer.from(readFileSync(TEST_STORAGE_KEY_FILE, 'utf8').trim(), 'base64')) {
    if (kek.length !== 32) throw new Error('The storage KEK must be 32 bytes');
    this.kek = kek;
    this.kekId = createHash('sha256').update(kek).digest('hex').slice(0, 8);
  }

  async issue(orgId: string): Promise<WrappedDataKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(Buffer.from(`dek:${orgId}`, 'utf8'));
    const sealed = Buffer.concat([cipher.update(randomBytes(32)), cipher.final(), cipher.getAuthTag()]);
    this.issued.push(orgId);
    return { wrappedDek: `v1.${this.kekId}.${iv.toString('base64url')}.${sealed.toString('base64url')}`, kekId: this.kekId };
  }
}

/**
 * Creates an organisation in a test database with `TenantProvisioner` (C.8): row, schema `org_<slug>`, tenant
 * migrations, data key from `TestDataKeyIssuer`, Managed Vault repository and audit entry.
 */
export async function createTenant(
  db: Pick<TestDatabase, 'urls'>,
  slug: string,
  options: Partial<Omit<CreateTenantInput, 'slug'>> & { dataKeys?: DataKeyIssuer } = {},
): Promise<CreatedTenant> {
  const { dataKeys, ...input } = options;
  return new TenantProvisioner({ connectionString: db.urls.migrator, dataKeys: dataKeys ?? new TestDataKeyIssuer() }).create({
    name: `Test organisation ${slug}`,
    timeZone: 'Asia/Jakarta',
    siteCount: 1,
    ...input,
    slug,
  });
}

/**
 * (Re)creates `mscd_tpl_<kind>`, fills it, then marks it as a template that accepts no connections, so a copy
 * (`CREATE DATABASE ... TEMPLATE`, about 100 ms) never fails because a session is open on it.
 */
export async function buildTemplate(
  server: TestDbServer,
  kind: TemplateKind,
  fill: (adminUrlOfTemplate: string) => Promise<void>,
): Promise<void> {
  const name = templateName(kind);
  await withAdmin(server, async (admin) => {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) {
      await admin.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    }
    await admin.query(`CREATE DATABASE ${name}`);
  });
  await fill(serverUrl(server, name));
  await withAdmin(server, async (admin) => {
    await admin.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  });
  server.templates.push(kind);
}

async function withAdmin<T>(server: TestDbServer, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl(server, server.adminDatabase) });
  client.on('notice', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Removes test containers (label mscd.test=true) whose expiry label has passed: leftovers of crashed runs. */
async function removeExpiredTestContainers(): Promise<void> {
  let listing: string;
  try {
    ({ stdout: listing } = await run('docker', [
      'ps',
      '-a',
      '--filter',
      'label=mscd.test=true',
      '--format',
      '{{.ID}} {{.Label "mscd.test.expires"}}',
    ]));
  } catch {
    return; // No docker CLI: nothing to clean.
  }
  const expired = listing
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter(([id, expires]) => id && expires && Number(expires) < Date.now())
    .map(([id]) => id!);
  if (expired.length > 0) await run('docker', ['rm', '-f', ...expired]).catch(() => undefined);
}
