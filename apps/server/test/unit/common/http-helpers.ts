// HTTP test applications for the request pipeline (no database): a Nest testing module on Fastify with the
// production HTTP bootstrap (`configureHttpApplication`), the authz, identity and license modules with their
// default providers, and optional fake authentication (test/setup/auth-fakes.ts).
import { Global, Module, type ModuleMetadata, type Provider } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { AUDIT_WRITER, type AuditEntryInput, type AuditWriter, type RecordedAuditEntry, type TenantInfo } from '../../../src/common/tokens';
import { ConfigModule } from '../../../src/config/config.module';
import { MscdConfig } from '../../../src/config/mscd-config';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { withFakeAuth, type FakeAuthOptions } from '../../setup/auth-fakes';

export const TEST_PROFILE = `${__dirname}/../../../profiles/test.yaml`;

export function unitConfig(env: Record<string, string> = {}): MscdConfig {
  return MscdConfig.load({
    runMode: 'api',
    flavor: 'dev',
    env: {
      MSCD_PROFILE_FILE: TEST_PROFILE,
      MSCD_DATABASE_URL: 'postgres://mscd_app:unused@127.0.0.1:1/mscd',
      MSCD__OBSERVABILITY__METRICS_PORT: 'null',
      MSCD__OBSERVABILITY__LOG_LEVEL: 'silent',
      ...env,
    },
  });
}

/** An organisation as the tenant resolver would return it. */
export function tenantInfo(slug: string, id: string): TenantInfo {
  return {
    id,
    slug,
    name: `Organisation ${slug}`,
    schema: `org_${slug}`,
    status: 'active',
    timeZone: 'Asia/Jakarta',
    localLogin: 'allowed',
    demoDeployLabel: null,
    siteCount: 1,
    position: 0,
  };
}

/** AUDIT_WRITER that records entries in memory. */
export class RecordingAuditWriter implements AuditWriter {
  readonly entries: { entry: AuditEntryInput; target?: { orgId: string; schema: string } | null }[] = [];

  async record(_trx: unknown, entry: AuditEntryInput): Promise<RecordedAuditEntry> {
    this.entries.push({ entry });
    return { chain: 'tenant', id: `id-${this.entries.length}`, seq: String(this.entries.length) };
  }

  async recordDetached(entry: AuditEntryInput, target?: { orgId: string; schema: string } | null): Promise<RecordedAuditEntry> {
    this.entries.push({ entry, target });
    return { chain: 'tenant', id: `id-${this.entries.length}`, seq: String(this.entries.length) };
  }
}

export interface TestAppOptions {
  config?: MscdConfig;
  auth?: FakeAuthOptions;
  audit?: AuditWriter;
  overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  providers?: Provider[];
}

/** Builds, configures and starts a Fastify test application around `metadata`. */
export async function createTestApp(metadata: ModuleMetadata, options: TestAppOptions = {}): Promise<NestFastifyApplication> {
  const config = options.config ?? unitConfig();
  const audit = options.audit ?? new RecordingAuditWriter();

  const extra = options.providers ?? [];
  const tokens = extra.map((p) => (typeof p === 'function' ? p : (p as { provide: unknown }).provide));

  @Global()
  @Module({ providers: [{ provide: AUDIT_WRITER, useValue: audit }, ...extra], exports: [AUDIT_WRITER, ...(tokens as never[])] })
  class TestSupportModule {}

  let builder = Test.createTestingModule({
    ...metadata,
    imports: [ConfigModule.forRoot(config), PlatformModule.forRunMode('api'), AuthzModule, IdentityModule, LicenseModule, TestSupportModule, ...(metadata.imports ?? [])],
  });
  if (options.auth) builder = withFakeAuth(builder, options.auth);
  if (options.overrides) builder = options.overrides(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** Keeps `MscdConfig` importable for tests that build their own configuration. */
export { MscdConfig };
