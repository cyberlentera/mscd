// `@ApiRoute(def)` (build plan D.1 Contract source). One decorator mounts a handler from its shared `RouteDef`:
// method and path, success status, the route metadata the authorisation guard reads (auth level, permission,
// scope, read-only and test-only flags, rate limits), and the interceptor that applies idempotency keys and, in
// development builds, validates the response against the contract. Input validation runs in the guard, before
// the permission check, because some permissions depend on a validated request member (`permissionBy`).
import { createParamDecorator, applyDecorators, HttpCode, RequestMapping, RequestMethod, SetMetadata, UseInterceptors } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { RouteDef } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { ApiRouteInterceptor } from './api-route.interceptor';
import { routeStateOf, type RouteInput } from './route-state';
import type { AuthzState, Principal } from './tokens';

/** Metadata key of the `RouteDef` on a handler. */
export const ROUTE_DEF_METADATA = 'mscd:route-def';

const METHODS: Readonly<Record<RouteDef['method'], RequestMethod>> = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PUT: RequestMethod.PUT,
  PATCH: RequestMethod.PATCH,
};

/**
 * Mounts a handler for a contract route. The controller must have no path prefix (`@Controller()`), because
 * `def.path` is absolute (`/api/v1/...`). Storage gateway routes (`auth: 'gateway'`) are served by the gateway, not
 * through this decorator.
 */
export function ApiRoute(def: RouteDef): MethodDecorator {
  if (def.auth === 'gateway') throw new Error(`@ApiRoute(${def.id}): gateway routes are not served by the api`);
  if (!def.path.startsWith('/api/v1/')) throw new Error(`@ApiRoute(${def.id}): the path must start with /api/v1/`);
  return applyDecorators(
    RequestMapping({ path: def.path, method: METHODS[def.method] }),
    HttpCode(def.status ?? 200),
    SetMetadata(ROUTE_DEF_METADATA, def),
    UseInterceptors(ApiRouteInterceptor),
  );
}

function requestOf(ctx: ExecutionContext): FastifyRequest {
  return ctx.switchToHttp().getRequest<FastifyRequest>();
}

/** The validated input of the route: `{params, query, body, headers}`, or one part of it. */
export const RouteInputParam = createParamDecorator((part: keyof RouteInput | undefined, ctx: ExecutionContext) => {
  const input = routeStateOf(requestOf(ctx)).input;
  return part ? input[part] : input;
});

/** The caller of the request (null on public routes). */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal | null => {
  return routeStateOf(requestOf(ctx)).principal;
});

/** What the guard decided (system, granted permissions, own-only). Null on routes without a permission. */
export const CurrentAuthz = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthzState | null => {
  return routeStateOf(requestOf(ctx)).authz;
});
