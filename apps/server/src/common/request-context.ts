// Request context (build plan D.1, F.12): one mutable record per HTTP request, kept in an AsyncLocalStorage so
// services, the audit writer and log lines reach the request id, the caller and the organisation without passing
// them through every call. The HTTP bootstrap opens it in an `onRequest` hook (request id per D.1, client address,
// user agent); the authorisation guard adds the user, the organisation and the system once they are known.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorKind } from '@mscd/shared';

export interface RequestContextData {
  /** Validated `X-Request-Id` or a new UUID (D.1). */
  readonly requestId: string;
  /** Client address as Fastify computed it with the F.12 proxy rules. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** `RouteDef.id` once the route is known. */
  routeId?: string;
  userId?: string;
  actorKind?: ActorKind;
  orgId?: string;
  orgSlug?: string;
  /** Tenant schema of the organisation (`org_<slug>`). */
  schema?: string;
  /** Management system slug of an ms-scoped route. */
  ms?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/** Runs `fn` with a new request context. */
export function runWithRequestContext<T>(data: RequestContextData, fn: () => T): T {
  return storage.run(data, fn);
}

/** The context of the current request, or undefined outside a request (jobs, commands, start-up). */
export function currentRequestContext(): RequestContextData | undefined {
  return storage.getStore();
}

/** Adds fields to the current request context; does nothing outside a request. */
export function updateRequestContext(fields: Partial<Omit<RequestContextData, 'requestId' | 'ip' | 'userAgent'>>): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (store as unknown as Record<string, unknown>)[key] = value;
  }
}

/** Request id of the current request, or undefined. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Fields of the current context suitable for a log line (no secrets, nothing personal besides ids). */
export function requestLogFields(): Record<string, string> {
  const store = storage.getStore();
  if (!store) return {};
  const fields: Record<string, string> = { requestId: store.requestId };
  if (store.routeId) fields.routeId = store.routeId;
  if (store.userId) fields.userId = store.userId;
  if (store.orgId) fields.orgId = store.orgId;
  if (store.ms) fields.ms = store.ms;
  return fields;
}
