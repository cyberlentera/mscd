// Helpers of the job integration tests (WP-22): a Nest application with the job modules on a test database (the
// in-memory queue of the test profile, drained in process, J.8), a settable clock, a recording gateway client, a
// Valkey container for the BullMQ driver, and small fixture writers.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Global, Module, type ModuleMetadata, type Type } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { JobName } from '@mscd/shared';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE, type JobEnvelope, type JobPayloads, type SendOptions } from '../../../src/common/jobs/job-queue';
import { GATEWAY_CLIENT, type GatewayClient } from '../../../src/common/tokens';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { WorkerRuntime } from '../../../src/worker/worker-runtime';
import { WorkerRuntimeModule } from '../../../src/worker/worker-runtime.module';
import { CORE_MODULES } from '../platform/helpers';
import type { TestDatabase } from '../../setup/test-db';

/** Development anchor key pair (packages/pack-tools/dev-keys, key id 0abdc91769bacddd, compiled into dev builds). */
export const DEV_ANCHOR_KEY_FILE = path.resolve(__dirname, '../../../../../packages/pack-tools/dev-keys/anchor-signing.key');
export const DEV_ANCHOR_PUB_FILE = path.resolve(__dirname, '../../../../../packages/pack-tools/dev-keys/anchor-signing.pub');

/** Environment of every job test application: the development anchor key. */
export const JOB_TEST_ENV: Record<string, string> = { MSCD__AUDIT__ANCHOR_KEY_FILE: DEV_ANCHOR_KEY_FILE };

/** Gateway client that records calls (anchors) and answers them, or fails when `fail` is set. */
export class RecordingGateway implements GatewayClient {
  readonly calls: { path: string; body: unknown }[] = [];
  fail = false;
  async post<T>(p: string, body: unknown): Promise<T> {
    if (this.fail) throw new Error('gateway unreachable');
    this.calls.push({ path: p, body });
    return { location: `s3://mscd-vault/${(body as { objectKey?: string }).objectKey ?? ''}` } as T;
  }
  async putObject<T>(): Promise<T> {
    throw new Error('not used');
  }
  async stream(): Promise<never> {
    throw new Error('not used');
  }
}

export interface JobsApp {
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  gateway: RecordingGateway;
  /** Sets the instant `Clock.now()` returns (null: the real time). */
  setNow(at: Date | string | null): void;
  /** Sends a job through the `JobQueue` and runs the worker in process until idle (J.8). */
  run<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts?: SendOptions): Promise<void>;
  /** Runs everything queued until idle. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface JobsAppOptions {
  env?: Record<string, string>;
  imports?: Type<unknown>[];
  metadata?: ModuleMetadata;
  /** Start the worker runtime on these queues only (default: every handler). */
  queues?: string[];
}

/** A Nest application context with the core modules, `JobsModule` and the worker runtime started on the in-memory queue. */
export async function createJobsApp(db: TestDatabase, options: JobsAppOptions = {}): Promise<JobsApp> {
  const gateway = new RecordingGateway();
  @Global()
  @Module({ providers: [{ provide: GATEWAY_CLIENT, useValue: gateway }], exports: [GATEWAY_CLIENT] })
  class TestGatewayModule {}
  const env = { ...JOB_TEST_ENV, ...(options.env ?? {}) };
  const moduleRef = await db
    .createTestingModule({ imports: [...CORE_MODULES, JobsModule, WorkerRuntimeModule, TestGatewayModule, ...(options.imports ?? [])] }, env)
    .compile();
  moduleRef.useLogger(moduleRef.get(Logger));
  await moduleRef.init();
  const queue = moduleRef.get<InMemoryJobQueue>(JOB_QUEUE);
  if (!(queue instanceof InMemoryJobQueue)) throw new Error('The job tests expect the in-memory queue of the test profile');
  const clock = moduleRef.get(Clock);
  let fixed: Date | null = null;
  clock.now = () => (fixed ? new Date(fixed.getTime()) : new Date());
  await moduleRef.get(WorkerRuntime).start({ queues: options.queues });
  return {
    moduleRef,
    queue,
    gateway,
    setNow(at) {
      fixed = at === null ? null : new Date(at);
    },
    async run(name, env, opts) {
      await queue.send(name, env, opts);
      await queue.drain({ includeDelayed: true });
    },
    drain: () => queue.drain({ includeDelayed: true }),
    close: () => moduleRef.close(),
  };
}

/** Polls `condition` every 100 ms until it holds or `timeoutMs` passes. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface StartedValkey {
  url: string;
  stop(): Promise<void>;
}

/** Starts `valkey/valkey:8.1-alpine` (A.3) labelled mscd.test=true, or uses MSCD_TEST_VALKEY_URL. */
export async function startValkey(): Promise<StartedValkey> {
  const external = process.env.MSCD_TEST_VALKEY_URL;
  if (external) return { url: external, stop: async () => undefined };
  const { GenericContainer, Wait } = await import('testcontainers');
  let container = new GenericContainer('valkey/valkey:8.1-alpine')
    .withExposedPorts(6379)
    .withLabels({ 'mscd.test': 'true', 'mscd.test.expires': String(Date.now() + 3 * 60 * 60 * 1000) })
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/));
  const prefix = process.env.MSCD_TEST_CONTAINER_PREFIX;
  if (prefix) container = container.withName(`${prefix}valkey-${randomBytes(4).toString('hex')}`);
  const started = await container.start();
  return {
    url: `redis://${started.getHost()}:${started.getMappedPort(6379)}`,
    stop: async () => {
      await started.stop();
    },
  };
}
