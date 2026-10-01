// Interceptor of every `@ApiRoute` handler (build plan D.1): idempotency keys on routes with `idempotent: true`, and
// response validation against the contract in development builds (the dev flavour: local runs, the demo image and
// tests; release builds skip it).
//
// The key is claimed before the handler runs, with the request hash over organisation, method, path and JSON body.
// Routes with a streamed body (multipart, raw bytes) are claimed by the handler instead, once it has a digest of the
// content (`StreamedIdempotency` in route-state.ts), because the hash must cover the body.
import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { canonicalJson, type RouteDef } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, of, throwError, type Observable } from 'rxjs';
import { MscdConfig } from '../config/mscd-config';
import { IDEMPOTENCY_LEASE_SECONDS, IdempotencyStore, type IdempotencyClaim, type IdempotencyScope } from '../modules/tenancy/idempotency-store';
import { ConflictError, InternalError, ValidationError } from './problems';
import { zodFieldErrors } from './problem-filter';
import { hasStreamedBody, type RouteState } from './route-state';

/** D.1: `Idempotency-Key` is 1 to 100 visible ASCII characters (`platform.idempotency_key.key`). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,100}$/;

/** Statuses whose body is not JSON and is never validated. */
const NO_JSON_STATUS = new Set([204, 302]);

/** Longest content digest a streamed route may claim with. */
const CONTENT_DIGEST_MAX = 200;

/**
 * `request_hash` of D.1: SHA-256 over the organisation id, method, path and body. For a route with a streamed body,
 * `body` is `{contentDigest}` with the digest the handler computed over the content.
 */
export function idempotencyRequestHash(orgId: string, method: string, path: string, body: unknown): string {
  const payload = canonicalJson([orgId, method.toUpperCase(), path, body === undefined ? null : body]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Thrown by `StreamedIdempotency.claim` when the request repeats a completed one: the interceptor answers with the
 * stored response. Handlers must let it propagate.
 */
export class IdempotentReplay extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('Idempotent replay of a stored response');
    this.name = 'IdempotentReplay';
  }
}

/** The 409 of a key that cannot run now: reused for another request, or still in progress (with `Retry-After`). */
function refusal(claim: Extract<IdempotencyClaim, { kind: 'mismatch' | 'in_progress' }>): ConflictError {
  if (claim.kind === 'mismatch') {
    return new ConflictError('The Idempotency-Key was already used for a different request', { messageKey: 'idempotency.key_reused' });
  }
  return new ConflictError('A request with this Idempotency-Key is still being processed', {
    messageKey: 'idempotency.in_progress',
    retryAfter: Math.min(claim.retryAfter, IDEMPOTENCY_LEASE_SECONDS),
  });
}

@Injectable()
export class ApiRouteInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ApiRoute');
  private readonly validateResponses: boolean;

  constructor(
    config: MscdConfig,
    @Optional() private readonly idempotency?: IdempotencyStore,
  ) {
    this.validateResponses = config.flavor === 'dev';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const state = request.mscd;
    if (!state) return next.handle();
    const def = state.route;
    const handled = () => next.handle().pipe(mergeMap((body) => of(this.checkResponse(def, body))));

    let scope: IdempotencyScope | null;
    try {
      scope = this.idempotencyScope(def, request);
    } catch (error) {
      return throwError(() => error);
    }
    if (!scope || !this.idempotency) return handled();
    const store = this.idempotency;
    const idem = scope;
    const path = request.url.split('?')[0]!;
    const hashOf = (body: unknown) => idempotencyRequestHash(idem.orgId, request.method, path, body);
    if (hasStreamedBody(def)) return this.handlerClaimed(def, state, reply, store, idem, hashOf, handled);

    return from(store.claim(idem, def.id, hashOf(request.body))).pipe(
      mergeMap((claim) => {
        switch (claim.kind) {
          case 'replay':
            return of(this.replay(reply, claim.status, claim.body));
          case 'mismatch':
          case 'in_progress':
            return throwError(() => refusal(claim));
          case 'claimed':
            if (claim.reclaimed) this.logReclaim(def);
            return handled().pipe(
              mergeMap((body) => this.complete(store, idem, def, body)),
              catchError((error: unknown) => from(this.release(store, idem, def)).pipe(mergeMap(() => throwError(() => error)))),
            );
        }
      }),
    );
  }

  /**
   * Routes with a streamed body: the handler claims the key with a content digest (`request.mscd.idempotency`). The
   * response is stored when a claimed handler returns; a failed one releases the key; a replay signal from `claim`
   * answers with the stored response. A handler that never claims ran without idempotency: logged, and a 500 in
   * development builds so the route's tests catch it.
   */
  private handlerClaimed(
    def: RouteDef,
    state: RouteState,
    reply: FastifyReply,
    store: IdempotencyStore,
    idem: IdempotencyScope,
    hashOf: (body: unknown) => string,
    handled: () => Observable<unknown>,
  ): Observable<unknown> {
    let attempted = false;
    let claimed = false;
    state.idempotency = {
      claim: async (contentDigest: string) => {
        if (attempted) throw new Error(`${def.id}: the Idempotency-Key was already claimed for this request`);
        if (typeof contentDigest !== 'string' || contentDigest === '' || contentDigest.length > CONTENT_DIGEST_MAX) {
          throw new Error(`${def.id}: the content digest must be 1 to ${CONTENT_DIGEST_MAX} characters`);
        }
        attempted = true;
        const claim = await store.claim(idem, def.id, hashOf({ contentDigest }));
        switch (claim.kind) {
          case 'claimed':
            claimed = true;
            if (claim.reclaimed) this.logReclaim(def);
            return;
          case 'replay':
            throw new IdempotentReplay(claim.status, claim.body);
          default:
            throw refusal(claim);
        }
      },
    };
    return handled().pipe(
      mergeMap(async (body) => {
        if (claimed) return this.complete(store, idem, def, body);
        if (!attempted) {
          this.logger.error(`${def.id} accepted an Idempotency-Key but the handler did not claim it (StreamedIdempotency.claim)`);
          if (this.validateResponses) throw new InternalError(`${def.id} did not claim its Idempotency-Key`);
        }
        return body;
      }),
      catchError((error: unknown) => {
        if (error instanceof IdempotentReplay) return of(this.replay(reply, error.status, error.body));
        if (!claimed) return throwError(() => error);
        return from(this.release(store, idem, def)).pipe(mergeMap(() => throwError(() => error)));
      }),
    );
  }

  /** Answers with a stored response. */
  private replay(reply: FastifyReply, status: number, body: unknown): unknown {
    reply.header('idempotent-replayed', 'true');
    reply.status(status);
    return body ?? undefined;
  }

  /** Stores the response of a claimed key. A failure is logged; the key becomes free again when its lease ends. */
  private async complete(store: IdempotencyStore, idem: IdempotencyScope, def: RouteDef, body: unknown): Promise<unknown> {
    await store.complete(idem, def.status ?? 200, body).catch((error: unknown) => {
      this.logger.error(
        `Could not store the idempotent response of ${def.id}: ${(error as Error).message}; the key is in progress until its lease of ${IDEMPOTENCY_LEASE_SECONDS} seconds ends`,
      );
    });
    return body;
  }

  /** Releases the key of a failed command, so a retry runs. */
  private async release(store: IdempotencyStore, idem: IdempotencyScope, def: RouteDef): Promise<void> {
    await store.release(idem).catch((error: unknown) => {
      this.logger.error(`Could not release the idempotency key of ${def.id}: ${(error as Error).message}`);
    });
  }

  private logReclaim(def: RouteDef): void {
    this.logger.warn(
      `${def.id}: took over an Idempotency-Key whose earlier request stored no response within ${IDEMPOTENCY_LEASE_SECONDS} seconds; that request may have run`,
    );
  }

  /** The key scope when the route accepts `Idempotency-Key` and the request sends one; null otherwise. */
  private idempotencyScope(def: RouteDef, request: FastifyRequest): IdempotencyScope | null {
    if (!def.idempotent) return null;
    const header = request.headers['idempotency-key'];
    if (header === undefined) return null;
    const key = Array.isArray(header) ? header[0] : header;
    if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new ValidationError([{ path: 'headers.idempotency-key', message: 'Must be 1 to 100 visible ASCII characters' }]);
    }
    const principal = request.mscd?.principal;
    if (!principal?.org) return null;
    return { orgId: principal.org.id, userId: principal.user.id, key };
  }

  /** Development builds: the response body must match `def.response`; a mismatch is a 500 and logged. */
  private checkResponse(def: RouteDef, body: unknown): unknown {
    if (!this.validateResponses || def.file || def.responseType || NO_JSON_STATUS.has(def.status ?? 200)) return body;
    const result = def.response.safeParse(body);
    if (!result.success) {
      const issues = zodFieldErrors(result.error, 'response');
      this.logger.error({ routeId: def.id, issues }, `Response of ${def.id} does not match the contract`);
      throw new InternalError(`Response of ${def.id} does not match the contract`);
    }
    return body;
  }
}
