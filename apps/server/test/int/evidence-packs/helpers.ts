// Helpers of the evidence pack and auditor access tests (WP-26): an api application with the real session resolver,
// authorisation, licence, storage, files, ui, evidence pack and auditor access modules on the demo template, a
// settable clock, every api log line captured (to prove that no access link reaches the log), and sessions of demo
// users written through `SessionService`.
import { Writable } from 'node:stream';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuditorAccessModule } from '../../../src/modules/auditor-access/auditor-access.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { EvidencePackBuildJob } from '../../../src/modules/evidence-packs/evidence-pack-build.job';
import { EvidencePacksModule } from '../../../src/modules/evidence-packs/evidence-packs.module';
import { FilesModule } from '../../../src/modules/files/files.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { loggerParams } from '../../../src/modules/platform/logging';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { mutableClock, type Mailpit, type MutableClock } from '../identity/helpers';

export { ORG_IDS, type DemoOrg } from '../read-model/helpers';

export interface PackApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  jobs: JobQueue;
  clock: MutableClock;
  /** Every log line the application wrote (pino JSON lines), oldest first. */
  logs: string[];
  /** Runs `evidence-pack.build` in process for a pack (J.8). */
  build(orgId: string, packId: string): ReturnType<EvidencePackBuildJob['build']>;
  close(): Promise<void>;
}

export interface PackAppOptions {
  gatewayUrl?: string;
  mail?: Mailpit | null;
  env?: Record<string, string>;
  /** Start of the settable clock (default: the real time). */
  now?: Date;
}

/** The api application of the WP-26 tests on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createPackApp(db: TestDatabase, options: PackAppOptions = {}): Promise<PackApp> {
  const env: Record<string, string> = { MSCD__OBSERVABILITY__LOG_LEVEL: 'debug', ...(options.env ?? {}) };
  if (options.gatewayUrl) env.MSCD__STORAGE__GATEWAY__URL = options.gatewayUrl;
  if (options.mail) {
    env.MSCD__MAIL__SMTP__HOST = options.mail.host;
    env.MSCD__MAIL__SMTP__PORT = String(options.mail.smtpPort);
  } else {
    env.MSCD__MAIL__SMTP__PORT ??= '9';
  }
  const config = db.config(env);
  const clock = mutableClock(config, options.now ?? new Date());
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') logs.push(line);
      callback();
    },
  });
  const params = loggerParams(config);
  const pinoOptions = typeof params.pinoHttp === 'object' && !Array.isArray(params.pinoHttp) ? params.pinoHttp : {};
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule,
          AuditModule,
          KeysModule,
          AuthzModule,
          IdentityModule,
          LicenseModule,
          StorageModule,
          FilesModule,
          UiModule,
          EvidencePacksModule,
          AuditorAccessModule,
        ],
      },
      env,
    )
    .overrideProvider(Clock)
    .useValue(clock.clock)
    .overrideProvider(PARAMS_PROVIDER_TOKEN)
    .useValue({ ...params, pinoHttp: [{ ...(pinoOptions as object), level: 'debug' }, sink] })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const job = moduleRef.get(EvidencePackBuildJob);
  return {
    app,
    moduleRef,
    jobs: moduleRef.get<JobQueue>(JOB_QUEUE),
    clock,
    logs,
    build: (orgId, packId) => job.build(orgId, packId),
    close: () => app.close(),
  };
}
