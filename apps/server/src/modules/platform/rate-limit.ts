// Rate limits (build plan F.3). `@fastify/rate-limit` is registered without global limits and with a PostgreSQL
// store (`platform.rate_limit_bucket`, fixed window), or Valkey when `jobs.driver = bullmq`. The authorisation guard
// applies the limits of each route through `RateLimitService`: the route's own `RouteDef.rateLimits` and, for
// authenticated requests, the per-user and per-organisation limits of every api request. Keys use `request.ip`
// (trustworthy with the F.12 proxy rules), the normalised email of the body, the session, the user, the
// organisation, the guest grant or the calendar token.
import { createHash } from 'node:crypto';
import fastifyRateLimit from '@fastify/rate-limit';
import { Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEFAULT_RATE_LIMITS, type RateLimitDef, type RouteDef } from '@mscd/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import type { MscdConfig } from '../../config/mscd-config';
import { RateLimitedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { RATE_LIMIT_BACKEND, type RateLimitBackend } from '../tenancy/rate-limit-store';

/** Request member that carries the bucket key to the plugin's key generator. */
const BUCKET_KEY = Symbol('mscd.rateLimitBucketKey');
/** Request member with the most restrictive result so far, for the response headers. */
const TIGHTEST = Symbol('mscd.rateLimitTightest');

interface LimiterResult {
  isAllowed: boolean;
  key: string;
  max?: number;
  remaining?: number;
  ttlInSeconds?: number;
  isExceeded?: boolean;
}

type Limiter = (request: FastifyRequest) => Promise<LimiterResult>;

type RateLimitedRequest = FastifyRequest & { [BUCKET_KEY]?: string; [TIGHTEST]?: { max: number; remaining: number; reset: number } };

type FastifyWithRateLimit = FastifyInstance & {
  createRateLimit?: (options: { max: number; timeWindow: number; keyGenerator: (request: FastifyRequest) => string }) => Limiter;
};

/** Store class for the plugin over a `RateLimitBackend` (the plugin calls `incr` with the window and limit). */
function backendStore(backend: RateLimitBackend) {
  return class PostgresRateLimitStore {
    incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void, timeWindow: number): void {
      backend.hit(key, timeWindow).then(
        (hit) => callback(null, { current: hit.current, ttl: hit.ttlMs }),
        (error: Error) => callback(error),
      );
    }

    child(): PostgresRateLimitStore {
      return this;
    }
  };
}

/**
 * Registers `@fastify/rate-limit` for run mode `api` (called by `configureHttpApplication`): no global limit, headers
 * of the IETF draft (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`), PostgreSQL store,
 * or Valkey with `jobs.driver = bullmq`.
 */
export async function registerRateLimitPlugin(app: NestFastifyApplication, config: MscdConfig): Promise<void> {
  const logger = new Logger('RateLimit');
  const options: Record<string, unknown> = { global: false, enableDraftSpec: true, skipOnError: false };
  const bullmqUrl = config.profile.jobs.driver === 'bullmq' ? config.profile.jobs.bullmq.url : null;
  if (bullmqUrl) {
    const redis = new Redis(bullmqUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    redis.on('error', (error: Error) => logger.error(`Valkey rate limit store: ${error.message}`));
    options.redis = redis;
    options.nameSpace = 'mscd-rl:';
    const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    fastify.addHook('onClose', async () => {
      await redis.quit().catch(() => undefined);
    });
  } else {
    let backend: RateLimitBackend | undefined;
    try {
      backend = app.get<RateLimitBackend>(RATE_LIMIT_BACKEND, { strict: false });
    } catch {
      backend = undefined;
    }
    if (backend) options.store = backendStore(backend);
    else logger.warn('No database rate limit store in this application: rate limits are counted in memory');
  }
  await app.register(fastifyRateLimit as never, options);
}

/** Bucket value of one key kind for a request, or undefined when the request has none. */
function keyValue(kind: RateLimitDef['key'], request: FastifyRequest, principal: Principal | null, input: { body?: unknown; query?: unknown }): string | undefined {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40);
  switch (kind) {
    case 'ip':
      return request.ip;
    case 'email': {
      const email = (input.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' && email.trim() !== '' ? digest(email.trim().toLowerCase()) : undefined;
    }
    case 'session':
      return principal?.session?.idHash ? digest(principal.session.idHash) : undefined;
    case 'user':
      return principal?.user.id;
    case 'org':
      return principal?.org?.id;
    case 'grant':
      return principal?.session?.authGrantId ?? undefined;
    case 'token': {
      const token = (input.query as { token?: unknown } | undefined)?.token ?? (request.query as { token?: unknown } | undefined)?.token;
      return typeof token === 'string' && token !== '' ? digest(token) : undefined;
    }
  }
}

/** Limits that depend on the validated body are applied after validation; the others before. */
const BODY_KEYS = new Set<RateLimitDef['key']>(['email']);

/** Applies the F.3 limits of a route; throws 429 `rate-limited` when one is exceeded. */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly limiters = new Map<string, Limiter>();
  private missingPluginReported = false;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  /**
   * Applies the limits of `phase` (`early`: keys known before validation; `late`: keys read from the validated body).
   * Sets the `RateLimit-*` headers of the tightest limit and throws `RateLimitedError` with `Retry-After`.
   */
  async enforce(
    phase: 'early' | 'late',
    def: RouteDef,
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal | null,
    input: { body?: unknown; query?: unknown } = {},
  ): Promise<void> {
    const limits: { scope: string; limit: RateLimitDef }[] = (def.rateLimits ?? []).map((limit) => ({ scope: def.id, limit }));
    if (principal && def.auth !== 'public') for (const limit of DEFAULT_RATE_LIMITS) limits.push({ scope: 'api', limit });
    let retryAfter = 0;
    for (const { scope, limit } of limits) {
      if (BODY_KEYS.has(limit.key) !== (phase === 'late')) continue;
      const value = keyValue(limit.key, request, principal, input);
      if (value === undefined) continue;
      const result = await this.consume(request, scope, limit, value);
      if (!result) continue;
      this.track(request as RateLimitedRequest, result, limit);
      if (result.isExceeded) retryAfter = Math.max(retryAfter, result.ttlInSeconds ?? limit.windowSeconds);
    }
    this.writeHeaders(request as RateLimitedRequest, reply);
    if (retryAfter > 0) throw new RateLimitedError(retryAfter);
  }

  /**
   * Counts one hit of a limit for a key value outside the guard (services: per guest grant, per token) and returns
   * whether it is exceeded with the seconds until the window ends.
   */
  async hit(request: FastifyRequest, scope: string, limit: RateLimitDef, value: string): Promise<{ exceeded: boolean; retryAfter: number }> {
    const result = await this.consume(request, scope, limit, value);
    if (!result) return { exceeded: false, retryAfter: 0 };
    return { exceeded: result.isExceeded === true, retryAfter: result.ttlInSeconds ?? limit.windowSeconds };
  }

  private async consume(request: FastifyRequest, scope: string, limit: RateLimitDef, value: string): Promise<LimiterResult | null> {
    const limiter = this.limiterFor(scope, limit);
    if (!limiter) return null;
    const bucket = `${scope}:${limit.key}:${limit.max}/${limit.windowSeconds}:${value}`.slice(0, 200);
    const req = request as RateLimitedRequest;
    req[BUCKET_KEY] = bucket;
    try {
      return await limiter(request);
    } finally {
      delete req[BUCKET_KEY];
    }
  }

  private limiterFor(scope: string, limit: RateLimitDef): Limiter | null {
    const id = `${scope}:${limit.key}:${limit.max}/${limit.windowSeconds}`;
    const cached = this.limiters.get(id);
    if (cached) return cached;
    const fastify = this.adapterHost.httpAdapter?.getInstance() as FastifyWithRateLimit | undefined;
    if (!fastify?.createRateLimit) {
      if (!this.missingPluginReported) {
        this.missingPluginReported = true;
        this.logger.error('@fastify/rate-limit is not registered: rate limits are not applied (call configureHttpApplication)');
      }
      return null;
    }
    const limiter = fastify.createRateLimit({
      max: limit.max,
      timeWindow: limit.windowSeconds * 1000,
      keyGenerator: (request) => (request as RateLimitedRequest)[BUCKET_KEY] ?? `${id}:unknown`,
    });
    this.limiters.set(id, limiter);
    return limiter;
  }

  private track(request: RateLimitedRequest, result: LimiterResult, limit: RateLimitDef): void {
    const max = result.max ?? limit.max;
    const remaining = result.isExceeded ? 0 : Math.max(0, result.remaining ?? max);
    const reset = result.ttlInSeconds ?? limit.windowSeconds;
    const current = request[TIGHTEST];
    if (!current || remaining < current.remaining || (remaining === current.remaining && reset > current.reset)) {
      request[TIGHTEST] = { max, remaining, reset };
    }
  }

  private writeHeaders(request: RateLimitedRequest, reply: FastifyReply): void {
    const tightest = request[TIGHTEST];
    if (!tightest) return;
    reply.header('ratelimit-limit', String(tightest.max));
    reply.header('ratelimit-remaining', String(tightest.remaining));
    reply.header('ratelimit-reset', String(tightest.reset));
  }
}
