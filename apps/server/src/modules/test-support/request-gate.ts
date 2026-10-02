// Request gate of the test reset (build plan D.3 "Test support"): `POST /test/reset` first drains the api's request
// queue, that is, it holds every new request at the door and waits until the requests already inside have answered,
// so no request runs while the database is dropped and recreated. The gate is a pair of Fastify hooks registered only
// when the profile enables the test endpoints; without them it is never installed.
import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { testResetRoute } from '@mscd/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MscdConfig } from '../../config/mscd-config';

/** True when the profile mounts the test routes (D.3): demo mode and `test.endpoints_enabled`. */
export function testEndpointsEnabled(config: MscdConfig): boolean {
  return config.profile.demo.enabled && config.profile.test?.endpoints_enabled === true;
}

/** The reset route itself passes the gate (it is the one that closes it). */
const RESET_PATH = testResetRoute.path;

@Injectable()
export class TestRequestGate implements OnModuleInit {
  private readonly logger = new Logger('TestSupport');
  private readonly inside = new WeakSet<FastifyRequest>();
  private inFlight = 0;
  private closed: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly config: MscdConfig,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    if (!testEndpointsEnabled(this.config)) return;
    const adapter = this.adapterHost?.httpAdapter;
    if (!adapter || typeof adapter.getInstance !== 'function') return;
    const fastify = adapter.getInstance<FastifyInstance>();
    if (!fastify || typeof fastify.addHook !== 'function') return;
    fastify.addHook('onRequest', async (request) => {
      if (pathOf(request.url) === RESET_PATH) return;
      while (this.closed) await this.closed;
      this.enter(request);
    });
    const leave = async (request: FastifyRequest) => {
      this.leave(request);
    };
    fastify.addHook('onResponse', leave);
    fastify.addHook('onRequestAbort', leave);
  }

  /** Requests currently inside the gate (tests). */
  get active(): number {
    return this.inFlight;
  }

  enter(request: FastifyRequest): void {
    if (this.inside.has(request)) return;
    this.inside.add(request);
    this.inFlight += 1;
  }

  leave(request: FastifyRequest): void {
    if (!this.inside.has(request)) return;
    this.inside.delete(request);
    this.inFlight -= 1;
    if (this.inFlight === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  /**
   * Closes the gate and waits until the requests inside have answered, at most `timeoutMs`. Requests still running
   * after that are logged and the reset goes on (their database connections end with the database).
   */
  async closeAndDrain(timeoutMs: number): Promise<void> {
    if (!this.closed) {
      this.closed = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.inFlight === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      new Promise<boolean>((resolve) => this.idleWaiters.push(() => resolve(true))),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) this.logger.warn(`Test reset goes on with ${this.inFlight} request(s) still running after ${timeoutMs} ms`);
  }

  /** Opens the gate; held requests go on. */
  open(): void {
    const release = this.release;
    this.closed = null;
    this.release = null;
    release?.();
  }
}

function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}
