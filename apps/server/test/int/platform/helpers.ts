// Helpers of the platform integration tests (WP-08): an HTTP application on a test database with the platform core
// modules, fake authentication, and fixture rows.
import type { ModuleMetadata } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { TenantInfo } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { withFakeAuth, type FakeAuthOptions } from '../../setup/auth-fakes';
import type { TestDatabase } from '../../setup/test-db';

/** The platform core modules of WP-08 (besides ConfigModule, PlatformModule and DatabaseModule of the test helper). */
export const CORE_MODULES = [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule];

export interface IntAppOptions {
  auth?: FakeAuthOptions;
  env?: Record<string, string>;
  overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface IntApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  close(): Promise<void>;
}

/** A started Fastify application on the test database with the WP-08 modules and `metadata`. */
export async function createIntApp(db: TestDatabase, metadata: ModuleMetadata = {}, options: IntAppOptions = {}): Promise<IntApp> {
  const config = db.config(options.env);
  let builder = db.createTestingModule({ ...metadata, imports: [...CORE_MODULES, ...(metadata.imports ?? [])] }, options.env);
  if (options.auth) builder = withFakeAuth(builder, options.auth);
  if (options.overrides) builder = options.overrides(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, close: () => app.close() };
}

/** `TenantInfo` of a tenant created by `createTenant()`. */
export function infoOf(tenant: CreatedTenant, name = `Test organisation ${tenant.slug}`): TenantInfo {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name,
    schema: tenant.schemaName,
    status: 'active',
    timeZone: 'Asia/Jakarta',
    localLogin: 'allowed',
    demoDeployLabel: null,
    siteCount: 1,
    position: 0,
  };
}
