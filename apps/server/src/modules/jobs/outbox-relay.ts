// Outbox relay of the BullMQ driver (build plan E.1): runs in the api and the worker and moves committed
// `platform.job_outbox` rows to BullMQ every 500 ms, and at once after a transaction of this process that wrote
// outbox rows commits. With the pg-boss and in-memory drivers it does nothing.
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { MscdConfig } from '../../config/mscd-config';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { TenantScope } from '../tenancy/tenant-scope';
import { BullMqJobQueue, OUTBOX_BATCH } from './bullmq-job-queue';

/** E.1: the relay polls every 500 ms. */
export const OUTBOX_RELAY_INTERVAL_MS = 500;

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private again = false;
  private unsubscribe?: () => void;
  private lastError?: string;

  constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly scope: TenantScope,
    private readonly config: MscdConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!(this.queue instanceof BullMqJobQueue)) return;
    if (this.config.runMode !== 'api' && this.config.runMode !== 'worker') return;
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopTimer();
    await this.running?.catch(() => undefined);
  }

  /** Starts polling (tests may start a relay by hand). */
  start(): void {
    if (this.timer || !(this.queue instanceof BullMqJobQueue)) return;
    this.unsubscribe = this.queue.onOutboxCommitted(() => this.kick());
    this.timer = setInterval(() => this.kick(), OUTBOX_RELAY_INTERVAL_MS);
    this.timer.unref();
  }

  /** Runs passes until the outbox has no more ready rows; returns the rows moved. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const moved = await this.runOnce();
      total += moved;
      if (moved < OUTBOX_BATCH) return total;
    }
  }

  /** One pass now, or right after the pass that is running. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.runOnce().catch(() => undefined);
  }

  private runOnce(): Promise<number> {
    if (this.running) return this.running;
    const queue = this.queue;
    if (!(queue instanceof BullMqJobQueue)) return Promise.resolve(0);
    this.running = this.scope
      .withPlatform((trx) => queue.relayOutbox(trx), { scope: 'job' })
      .then((moved) => {
        this.lastError = undefined;
        return moved;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.lastError) this.logger.error(`Outbox relay pass failed: ${message}`);
        this.lastError = message;
        return 0;
      })
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
    return this.running;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
