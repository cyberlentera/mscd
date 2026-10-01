// Helpers of the notification and export tests (WP-24): an api application with the real session resolver,
// authorisation, licence, storage, notifications and exports modules on the demo template, a settable clock whose
// "today" the tests move (E.6 review alert tiers), every log line captured (F.12: no calendar token in a log), and
// the job services that the tests run in process (J.8).
import { Writable } from 'node:stream';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { localDate } from '../../../src/common/dates';
import { JOB_QUEUE, NOTIFICATION_WRITER, SYSTEM_USER_ID, type JobQueue, type NotificationInput, type NotificationWriter } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { ExportBuildJob } from '../../../src/modules/exports/export-build.job';
import { ExportsModule } from '../../../src/modules/exports/exports.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { DocumentReviewAlertsService } from '../../../src/modules/notifications/document-review-alerts.service';
import { NotificationDeliveryService } from '../../../src/modules/notifications/notification-delivery.service';
import { DocumentReviewAlertsJob, NotificationDigestJob, NotificationDispatchJob } from '../../../src/modules/notifications/notification.jobs';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { loggerParams } from '../../../src/modules/platform/logging';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import type { TestDatabase } from '../../setup/test-db';
import { ORG_IDS, type DemoOrg } from '../files/helpers';
import type { Mailpit } from '../identity/helpers';

export { ORG_IDS, type DemoOrg };

/** A clock whose instant and "today" the tests set (today follows the instant unless pinned). */
export interface TestClock {
  clock: Clock;
  now(): Date;
  setNow(at: Date): void;
  /** Pins "today" of every organisation (null: the local date of `now` in the organisation's zone). */
  setToday(day: string | null): void;
}

export function testClock(config: ConstructorParameters<typeof Clock>[0], start: Date, today: string | null): TestClock {
  let current = start.getTime();
  let pinned = today;
  const clock = new Clock(config);
  clock.now = () => new Date(current);
  Object.defineProperty(clock, 'fixedToday', { get: () => pinned });
  clock.todayIn = (timeZone: string) => pinned ?? localDate(new Date(current), timeZone);
  clock.today = async () => pinned ?? localDate(new Date(current), 'Asia/Jakarta');
  return {
    clock,
    now: () => new Date(current),
    setNow: (at) => {
      current = at.getTime();
    },
    setToday: (day) => {
      pinned = day;
    },
  };
}

export interface Wp24App {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  jobs: JobQueue;
  clock: TestClock;
  logs: string[];
  delivery: NotificationDeliveryService;
  alerts: DocumentReviewAlertsService;
  dispatchJob: NotificationDispatchJob;
  digestJob: NotificationDigestJob;
  alertsJob: DocumentReviewAlertsJob;
  exportJob: ExportBuildJob;
  /** Writes a notification through `NOTIFICATION_WRITER` in a transaction of the organisation. */
  notify(org: DemoOrg, input: NotificationInput): Promise<string | null>;
  close(): Promise<void>;
}

export interface Wp24AppOptions {
  gatewayUrl?: string;
  mail?: Mailpit | null;
  env?: Record<string, string>;
  now?: Date;
  /** Default: the test profile's `demo.fixed_today` (2026-09-29). */
  today?: string | null;
}

export async function createWp24App(db: TestDatabase, options: Wp24AppOptions = {}): Promise<Wp24App> {
  const env: Record<string, string> = { MSCD__OBSERVABILITY__LOG_LEVEL: 'debug', ...(options.env ?? {}) };
  if (options.gatewayUrl) env.MSCD__STORAGE__GATEWAY__URL = options.gatewayUrl;
  if (options.mail) {
    env.MSCD__MAIL__SMTP__HOST = options.mail.host;
    env.MSCD__MAIL__SMTP__PORT = String(options.mail.smtpPort);
  } else {
    // Nothing listens on the discard port: every send fails at once.
    env.MSCD__MAIL__SMTP__HOST ??= '127.0.0.1';
    env.MSCD__MAIL__SMTP__PORT ??= '9';
  }
  const config = db.config(env);
  const clock = testClock(config, options.now ?? new Date(), options.today === undefined ? '2026-09-29' : options.today);
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
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, StorageModule, NotificationsModule, ExportsModule] },
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
  const writer = moduleRef.get<NotificationWriter>(NOTIFICATION_WRITER);
  const scope = moduleRef.get(TenantScope);
  return {
    app,
    moduleRef,
    jobs: moduleRef.get<JobQueue>(JOB_QUEUE),
    clock,
    logs,
    delivery: moduleRef.get(NotificationDeliveryService),
    alerts: moduleRef.get(DocumentReviewAlertsService),
    dispatchJob: moduleRef.get(NotificationDispatchJob),
    digestJob: moduleRef.get(NotificationDigestJob),
    alertsJob: moduleRef.get(DocumentReviewAlertsJob),
    exportJob: moduleRef.get(ExportBuildJob),
    notify: (org, input) =>
      scope.withTenant({ orgId: ORG_IDS[org], schema: `org_${org}`, userId: SYSTEM_USER_ID }, (trx) => writer.create(trx, input)),
    close: () => app.close(),
  };
}
