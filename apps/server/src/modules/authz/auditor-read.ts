// External auditor reads (build plan F.7, BR-20, TS 7.1): every request an external auditor makes writes
// `auditor.read` to the tenant audit trail with the route id and the record refs returned. The guard marks the
// request (`markAuditorRead`); the interceptor writes the entry once the handler has answered, with the refs found in
// the response body plus any a service added with `addAuditorReadRefs` (for example the record behind a file).
import { Injectable, Logger, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { RECORD_MODULES, type RouteDef } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, throwError, type Observable } from 'rxjs';
import type { Principal } from '../../common/tokens';
import { AuthzInfra } from './authz-infra';

/** A record ref as the `auditor.read` entry lists it. */
export interface AuditorReadRef {
  entityType: string;
  id: string;
  code: string;
}

/** What the guard knows about an external auditor request. */
export interface AuditorReadMark {
  routeId: string;
  orgId: string;
  schema: string;
  ms: string | null;
  msId: string | null;
  params: Record<string, unknown>;
  refs: AuditorReadRef[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authorisation guard for requests of external auditors (F.7). */
    mscdAuditorRead?: AuditorReadMark;
  }
}

/** Most refs one entry lists; the entry also carries the total count. */
export const AUDITOR_READ_MAX_REFS = 500;
/** Most JSON nodes visited when collecting refs from a response body. */
const MAX_NODES = 50_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULES: ReadonlySet<string> = new Set(RECORD_MODULES);

/** Marks a request of an external auditor so the interceptor writes `auditor.read`. */
export function markAuditorRead(
  request: FastifyRequest,
  def: RouteDef,
  principal: Principal,
  system: { ms: string | null; msId: string | null },
  params: unknown,
): void {
  if (!principal.org) return;
  request.mscdAuditorRead = {
    routeId: def.id,
    orgId: principal.org.id,
    schema: principal.org.schema,
    ms: system.ms,
    msId: system.msId,
    params: params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {},
    refs: [],
  };
}

/** Adds record refs to the `auditor.read` entry of the request (no effect for other callers). */
export function addAuditorReadRefs(request: FastifyRequest, refs: readonly AuditorReadRef[]): void {
  request.mscdAuditorRead?.refs.push(...refs);
}

/** RecordRef-shaped objects (`module`, `entityType`, uuid `id`, `code`) anywhere in a response body. */
export function collectRecordRefs(body: unknown): AuditorReadRef[] {
  const found: AuditorReadRef[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [body];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    visited += 1;
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    if (Buffer.isBuffer(node) || node instanceof Uint8Array) continue;
    const record = node as Record<string, unknown>;
    if (
      typeof record.entityType === 'string' &&
      typeof record.id === 'string' &&
      UUID.test(record.id) &&
      typeof record.code === 'string' &&
      typeof record.module === 'string' &&
      MODULES.has(record.module)
    ) {
      found.push({ entityType: record.entityType, id: record.id, code: record.code });
    }
    for (const value of Object.values(record)) if (value !== null && typeof value === 'object') stack.push(value);
  }
  return found;
}

/** Writes the `auditor.read` entry of a marked request after the handler answered (or failed). */
@Injectable()
export class AuditorReadInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditorRead');

  constructor(private readonly infra: AuthzInfra) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const mark = request.mscdAuditorRead;
    if (!mark) return next.handle();
    return next.handle().pipe(
      mergeMap(async (body) => {
        await this.write(mark, body, 'ok');
        return body;
      }),
      catchError((error: unknown) => from(this.write(mark, undefined, 'error')).pipe(mergeMap(() => throwError(() => error)))),
    );
  }

  private async write(mark: AuditorReadMark, body: unknown, outcome: 'ok' | 'error'): Promise<void> {
    const audit = this.infra.optionalAudit;
    if (!audit) return;
    const unique = new Map<string, AuditorReadRef>();
    for (const ref of [...mark.refs, ...collectRecordRefs(body)]) unique.set(`${ref.entityType}:${ref.id}`, ref);
    const refs = [...unique.values()];
    try {
      await audit.recordDetached(
        {
          action: 'auditor.read',
          ...(mark.msId ? { msId: mark.msId } : { msSlug: mark.ms }),
          entityType: 'route',
          entityCode: mark.routeId,
          after: {
            routeId: mark.routeId,
            ms: mark.ms,
            outcome,
            params: mark.params,
            refCount: refs.length,
            // `entityCode`, not `code`: the F.11 redaction treats a key named `code` as a one-time code.
            refs: refs.slice(0, AUDITOR_READ_MAX_REFS).map((r) => ({ entityType: r.entityType, id: r.id, entityCode: r.code })),
          },
        },
        { orgId: mark.orgId, schema: mark.schema },
      );
    } catch (error) {
      // The read happened; a failed entry is logged at error level for the operator (the response is not withheld).
      this.logger.error(`Could not write auditor.read for ${mark.routeId}: ${(error as Error).message}`);
    }
  }
}
