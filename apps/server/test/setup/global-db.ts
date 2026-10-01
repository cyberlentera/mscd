// Vitest global setup of the integration tests (build plan J.2).
//
// Uses the PostgreSQL server of MSCD_TEST_DATABASE_URL (an administrator URL) when set; otherwise starts
// postgres:16.15-alpine (or MSCD_TEST_PG_IMAGE) with Testcontainers, labelled mscd.test=true. Then builds the
// template database mscd_tpl_empty: the C.2 bootstrap (roles, schema ext, pg_trgm). WP-06 adds the platform and
// ref migrations to this template; WP-14 adds mscd_tpl_demo. Test files copy a template through
// useTestDatabase() in test/setup/test-db.ts. Teardown stops the container.
//
// MSCD_TEST_CONTAINER_PREFIX names the container <prefix>postgres-<random> (useful when several runs share a host).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runBootstrap } from '../../src/db/bootstrap';
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
