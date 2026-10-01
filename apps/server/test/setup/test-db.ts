// Per-file test databases (build plan J.2): useTestDatabase('empty' | 'demo') copies the template built by the
// global setup into t_<random> before the file's tests and drops it afterwards. It returns Kysely instances for
// the migrator, app and pack installer roles, a configuration on the test profile pointing at that database,
// and a Nest testing module factory.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ModuleMetadata } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { ConfigModule } from '../../src/config/config.module';
import { MscdConfig, type RunMode } from '../../src/config/mscd-config';
import { DatabaseModule } from '../../src/db/database.module';
import { createKysely } from '../../src/db/kysely';
import type { DB } from '../../src/db/types';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { serverUrl, templateName, TEST_ROLE_PASSWORDS, type TemplateKind, type TestDbServer } from './test-db-server';

export const TEST_PROFILE_FILE = path.resolve(__dirname, '../../profiles/test.yaml');

export interface TestDatabase {
  readonly name: string;
  readonly server: TestDbServer;
  readonly urls: { readonly admin: string; readonly migrator: string; readonly app: string; readonly packInstaller: string };
  /** Role mscd_migrator: owns schemas, runs migrations and seeds. */
  readonly migrator: Kysely<DB>;
  /** Role mscd_app: what the api and worker use. */
  readonly app: Kysely<DB>;
  /** Role mscd_pack_installer. */
  readonly packInstaller: Kysely<DB>;
  /**
   * Configuration from profiles/test.yaml with the database URLs of this database and no metrics listener.
   * `env` adds or overrides variables (for example MSCD__TEST__ENDPOINTS_ENABLED=true).
   */
  config(env?: Record<string, string>, runMode?: RunMode): MscdConfig;
  /** Nest testing module with ConfigModule, PlatformModule (api mode) and DatabaseModule on this database. */
  createTestingModule(metadata?: ModuleMetadata, env?: Record<string, string>): TestingModuleBuilder;
  drop(): Promise<void>;
}

/** Copies `mscd_tpl_<kind>` into a new database for one test file. */
export async function createTestDatabase(kind: TemplateKind = 'empty'): Promise<TestDatabase> {
  const server = inject('mscdTestDb');
  if (!server) throw new Error('No test database server: run integration tests with vitest.int.config.ts');
  if (!server.templates.includes(kind)) {
    throw new Error(`Template ${templateName(kind)} was not built by the global setup (available: ${server.templates.join(', ')})`);
  }
  const name = `t_${randomBytes(8).toString('hex')}`;
  await withAdmin(server, async (admin) => {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateName(kind)}`);
    // Database-level privileges are not copied from the template (C.2).
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${name} TO mscd_migrator`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO mscd_app, mscd_pack_installer`);
  });

  const urls = {
    admin: serverUrl(server, name),
    migrator: serverUrl(server, name, 'mscd_migrator', TEST_ROLE_PASSWORDS.migrator),
    app: serverUrl(server, name, 'mscd_app', TEST_ROLE_PASSWORDS.app),
    packInstaller: serverUrl(server, name, 'mscd_pack_installer', TEST_ROLE_PASSWORDS.packInstaller),
  };
  const migrator = createKysely<DB>({ connectionString: urls.migrator, max: 4, applicationName: 'mscd-test-migrator' });
  const app = createKysely<DB>({ connectionString: urls.app, max: 4, applicationName: 'mscd-test-app' });
  const packInstaller = createKysely<DB>({ connectionString: urls.packInstaller, max: 2, applicationName: 'mscd-test-pack' });

  const config = (env: Record<string, string> = {}, runMode: RunMode = 'api') => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const variable of ['MSCD_DATABASE_URL', 'MSCD_DATABASE_MIGRATOR_URL', 'MSCD_DATABASE_PACK_URL', 'MSCD_DATABASE_ADMIN_URL']) {
      delete base[`${variable}_FILE`];
    }
    return MscdConfig.load({
      runMode,
      env: {
        ...base,
        MSCD_PROFILE_FILE: TEST_PROFILE_FILE,
        MSCD_DATABASE_URL: urls.app,
        MSCD_DATABASE_MIGRATOR_URL: urls.migrator,
        MSCD_DATABASE_PACK_URL: urls.packInstaller,
        MSCD_DATABASE_ADMIN_URL: urls.admin,
        MSCD__OBSERVABILITY__METRICS_PORT: 'null',
        ...env,
      },
    });
  };

  let dropped = false;
  return {
    name,
    server,
    urls,
    migrator,
    app,
    packInstaller,
    config,
    createTestingModule(metadata: ModuleMetadata = {}, env?: Record<string, string>) {
      return Test.createTestingModule({
        ...metadata,
        imports: [ConfigModule.forRoot(config(env)), PlatformModule.forRunMode('api'), DatabaseModule, ...(metadata.imports ?? [])],
      });
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      await Promise.all([migrator.destroy(), app.destroy(), packInstaller.destroy()]);
      await withAdmin(server, (admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/**
 * Registers beforeAll and afterAll hooks that create and drop a test database for the current file or describe
 * block. The returned handle is usable inside tests and hooks.
 */
export function useTestDatabase(kind: TemplateKind = 'empty'): TestDatabase {
  let current: TestDatabase | undefined;
  beforeAll(async () => {
    current = await createTestDatabase(kind);
  });
  afterAll(async () => {
    await current?.drop();
    current = undefined;
  });
  return new Proxy({} as TestDatabase, {
    get(_target, property) {
      if (!current) throw new Error('useTestDatabase(): the database exists only inside tests and hooks');
      const value: unknown = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
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
