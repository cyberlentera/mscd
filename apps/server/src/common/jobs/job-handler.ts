// `@JobHandler` and handler discovery (build plan E.1). Modules register job handlers by decorating a provider class;
// the worker finds them through Nest's DiscoveryService, so no central file lists them.
import { Injectable, Logger, SetMetadata } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { JOB_NAMES, type JobName } from '@mscd/shared';
import type { JobQueue, JobRun } from './job-queue';

export const JOB_HANDLER_METADATA = 'mscd:job-handler';

export interface JobHandlerOptions {
  /** Jobs of this queue run at most this many at a time per worker process. */
  concurrency: number;
  /** `tenant` handlers run inside `withTenant(orgId, SYSTEM_USER)`; `installation` handlers inside `withPlatform` (E.1). */
  scope: 'tenant' | 'installation';
}

export interface JobHandlerMetadata extends JobHandlerOptions {
  name: JobName;
}

/** A provider class decorated with `@JobHandler(name, ...)` implements this method. */
export interface JobHandlerInstance<N extends JobName = JobName> {
  handle(job: JobRun<N>): Promise<void>;
}

const KNOWN_JOBS: ReadonlySet<string> = new Set(JOB_NAMES);

/** Marks a provider class as the handler of one job (E.1). The class must also be a provider of its module. */
export function JobHandler(name: JobName, options: JobHandlerOptions): ClassDecorator {
  if (!KNOWN_JOBS.has(name)) throw new Error(`@JobHandler: unknown job ${name}`);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error(`@JobHandler(${name}): concurrency must be a positive integer`);
  }
  const metadata: JobHandlerMetadata = { name, ...options };
  return SetMetadata(JOB_HANDLER_METADATA, metadata);
}

export interface DiscoveredJobHandler {
  metadata: JobHandlerMetadata;
  instance: JobHandlerInstance;
}

/** Finds every `@JobHandler` provider of the application. */
@Injectable()
export class JobHandlerRegistry {
  private readonly logger = new Logger(JobHandlerRegistry.name);

  constructor(private readonly discovery: DiscoveryService) {}

  /** Every decorated provider, sorted by job name; throws when two providers handle the same job. */
  discover(): DiscoveredJobHandler[] {
    const found = new Map<JobName, DiscoveredJobHandler>();
    for (const wrapper of this.discovery.getProviders()) {
      const { metatype, instance } = wrapper;
      if (!metatype || typeof metatype !== 'function' || !instance) continue;
      const metadata = Reflect.getMetadata(JOB_HANDLER_METADATA, metatype) as JobHandlerMetadata | undefined;
      if (!metadata) continue;
      if (typeof (instance as Partial<JobHandlerInstance>).handle !== 'function') {
        throw new Error(`@JobHandler(${metadata.name}) on ${metatype.name}: the class has no handle(job) method`);
      }
      const existing = found.get(metadata.name);
      if (existing && existing.instance !== instance) {
        throw new Error(`Two job handlers for ${metadata.name}: ${existing.instance.constructor.name} and ${metatype.name}`);
      }
      found.set(metadata.name, { metadata, instance: instance as JobHandlerInstance });
    }
    return [...found.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  /**
   * Starts a worker on `queue` for every discovered handler, or only for `queues` when given
   * (`mscd-server worker --queues a,b`). Returns the job names now worked on.
   */
  async registerAll(queue: JobQueue, options: { queues?: readonly string[] } = {}): Promise<JobName[]> {
    const wanted = options.queues && options.queues.length > 0 ? new Set(options.queues) : null;
    if (wanted) {
      for (const name of wanted) if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown queue ${name}`);
    }
    const started: JobName[] = [];
    for (const { metadata, instance } of this.discover()) {
      if (wanted && !wanted.has(metadata.name)) continue;
      await queue.work(metadata.name, { concurrency: metadata.concurrency }, (job) => instance.handle(job));
      started.push(metadata.name);
    }
    this.logger.log(`Working on ${started.length} queue(s): ${started.join(', ') || 'none'}`);
    return started;
  }
}
