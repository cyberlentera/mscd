// Per-request state of a contract route (build plan D.1, F.7): the route definition, the validated input, the
// principal and the authorisation decision. The guard fills it; handlers read it through the parameter decorators
// of `api-route.ts`, services through `request.mscd`.
import type { RouteDef } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { ValidationError } from './problems';
import { zodFieldErrors } from './problem-filter';
import type { AuthzState, Principal } from './tokens';

/** Params, query, body and headers after validation with the route's zod schemas. */
export interface RouteInput<P = unknown, Q = unknown, B = unknown, H = unknown> {
  params: P;
  query: Q;
  body: B;
  headers: H;
}

export interface RouteState {
  route: RouteDef;
  input: RouteInput;
  principal: Principal | null;
  authz: AuthzState | null;
  /**
   * The `If-Match` header of a route with `ifMatch: true` (D.1 Concurrency), else undefined. Services compare it with
   * the record's `updated_at` through `assertIfMatch` (412 when stale).
   */
  ifMatch?: string;
  /**
   * Set by the route interceptor when a route with a streamed body (`hasStreamedBody`) accepts `Idempotency-Key` and
   * the request sends one: the handler claims the key with a digest of the content (D.1 `request_hash`).
   */
  idempotency?: StreamedIdempotency;
}

/**
 * Idempotency of a route whose body the handler streams (multipart or `application/octet-stream`). The request hash
 * of D.1 must cover the body, which only the handler reads, so the interceptor cannot claim the key before the
 * handler runs. The handler reads the upload, computes a digest of the content (for example the SHA-256 of the file
 * and of the form fields) and calls `claim(digest)` once, before it changes anything:
 * - the first request with the key continues, and its response is stored when the handler returns;
 * - a repeat with the same key and digest ends the request with the stored response (`claim` throws a signal the
 *   interceptor turns into the replay, so the handler must let it propagate);
 * - another digest with the same key, or a key still in progress, is a 409 `conflict`.
 * Without `Idempotency-Key` (or on a route that is not idempotent) `claim` does nothing.
 */
export interface StreamedIdempotency {
  claim(contentDigest: string): Promise<void>;
}

/** True when the route's body is streamed to the handler instead of parsed and validated (multipart, raw bytes). */
export function hasStreamedBody(def: RouteDef): boolean {
  return def.requestType === 'application/octet-stream' || def.requestType === 'multipart/form-data';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authorisation guard for every contract route. */
    mscd: RouteState | null;
  }
}

/** The route state of a request; throws when the guard has not run (a route without `@ApiRoute`). */
export function routeStateOf(request: FastifyRequest): RouteState {
  const state = request.mscd;
  if (!state) throw new Error(`No route state on ${request.method} ${request.url}: the route has no @ApiRoute definition`);
  return state;
}

function parsePart(schema: ZodType | undefined, value: unknown, part: 'params' | 'query' | 'body' | 'headers'): unknown {
  if (!schema) return part === 'body' ? value : (value ?? {});
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(zodFieldErrors(result.error, part));
  return result.data;
}

/**
 * Validates params, query, headers and body of a request with the route's schemas (D.1 Validation). Failures are
 * one 400 `validation` with every failing member; paths start with `params`, `query`, `headers` or `body`.
 * Streamed and multipart bodies are not read here: the handler consumes them.
 */
export function validateRouteInput(def: RouteDef, request: FastifyRequest): RouteInput {
  const errors: ValidationError[] = [];
  const parts = {} as Record<'params' | 'query' | 'body' | 'headers', unknown>;
  const raw: Record<'params' | 'query' | 'body' | 'headers', unknown> = {
    params: request.params,
    query: request.query,
    body: request.body,
    headers: request.headers,
  };
  const streamed = hasStreamedBody(def);
  const schemas: Record<'params' | 'query' | 'body' | 'headers', ZodType | undefined> = {
    params: def.params,
    query: def.query,
    body: streamed ? undefined : def.body,
    headers: def.headers,
  };
  for (const part of ['params', 'query', 'headers', 'body'] as const) {
    try {
      parts[part] = parsePart(schemas[part], raw[part], part);
    } catch (error) {
      if (error instanceof ValidationError) errors.push(error);
      else throw error;
    }
  }
  if (errors.length > 0) throw new ValidationError(errors.flatMap((e) => e.extras.errors ?? []));
  return { params: parts.params, query: parts.query, body: parts.body, headers: parts.headers };
}
