// Interceptor of every `@ApiRoute` handler (build plan D.1): idempotency keys on routes with `idempotent: true`, and
// response validation against the contract in development builds (the dev flavour: local runs, the demo image and
// tests; release builds skip it).
import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { canonicalJson, type RouteDef } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, of, throwError, type Observable } from 'rxjs';
import { MscdConfig } from '../config/mscd-config';
import { IdempotencyStore, type IdempotencyScope } from '../modules/tenancy/idempotency-store';
import { ConflictError, InternalError, ValidationError } from './problems';
import { zodFieldErrors } from './problem-filter';

/** D.1: `Idempotency-Key` is 1 to 100 visible ASCII characters (`platform.idempotency_key.key`). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,100}$/;

/** Statuses whose body is not JSON and is never validated. */
const NO_JSON_STATUS = new Set([204, 302]);

/** `request_hash` of D.1: SHA-256 over the organisation id, method, path and body. */
export function idempotencyRequestHash(orgId: string, method: string, path: string, body: unknown): string {
  const payload = canonicalJson([orgId, method.toUpperCase(), path, body === undefined ? null : body]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
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
    const hash = idempotencyRequestHash(idem.orgId, request.method, request.url.split('?')[0]!, request.body);

    return from(store.claim(idem, def.id, hash)).pipe(
      mergeMap((claim) => {
        switch (claim.kind) {
          case 'replay':
            reply.header('idempotent-replayed', 'true');
            reply.status(claim.status);
            return of(claim.body ?? undefined);
          case 'mismatch':
            return throwError(
              () => new ConflictError('The Idempotency-Key was already used for a different request', { messageKey: 'idempotency.key_reused' }),
            );
          case 'in_progress':
            return throwError(
              () => new ConflictError('A request with this Idempotency-Key is still being processed', { messageKey: 'idempotency.in_progress' }),
            );
          case 'claimed':
            return handled().pipe(
              mergeMap(async (body) => {
                await store.complete(idem, def.status ?? 200, body).catch((error: unknown) => {
                  this.logger.error(`Could not store the idempotent response of ${def.id}: ${(error as Error).message}`);
                });
                return body;
              }),
              catchError((error: unknown) =>
                from(
                  store.release(idem).catch((releaseError: unknown) => {
                    this.logger.error(`Could not release the idempotency key of ${def.id}: ${(releaseError as Error).message}`);
                  }),
                ).pipe(mergeMap(() => throwError(() => error))),
              ),
            );
        }
      }),
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
