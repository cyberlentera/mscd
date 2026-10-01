// Authorisation guard (build plan F.7), global for the api. For every `@ApiRoute` handler, in this order: test-only
// routes are 404 unless the profile enables them; the session resolver finds the caller and the route's auth level
// is checked (401); session checks of WP-11 (CSRF, F.2); rate limits keyed before validation (F.3); params, query,
// headers and body are validated (400); rate limits keyed on the body; the permission is evaluated in the system of
// the request (403, or 404 for an unknown system); BR-37 read-only mode blocks writes (403). The decision is
// stored on the request for services (`request.mscd`). A route under `/api/` without a contract definition is 404:
// the guard fails closed.
//
// WP-08 provides this guard with the default providers of the tokens; WP-39 owns the folder and refines role
// resolution, scoping and the external auditor rules behind the same tokens.
import { Inject, Injectable, Logger, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { effectiveGrant, machinePermissions, type Permission, type RouteDef } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { Counter } from 'prom-client';
import { MscdConfig } from '../../config/mscd-config';
import { ROUTE_DEF_METADATA } from '../../common/api-route';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../common/problems';
import { updateRequestContext } from '../../common/request-context';
import { validateRouteInput, type RouteInput } from '../../common/route-state';
import {
  AUDIT_WRITER,
  LICENCE_GATE,
  PERMISSION_EVALUATOR,
  SESSION_RESOLVER,
  type AuditWriter,
  type AuthzState,
  type LicenceGate,
  type PermissionCheckScope,
  type PermissionDecision,
  type PermissionEvaluator,
  type Principal,
  type SessionResolver,
} from '../../common/tokens';
import { MetricsService } from '../platform/metrics';
import { RateLimitService } from '../platform/rate-limit';

/** One permission check (WP-05 `PermissionCheck`): the permission and where it is checked. */
interface PermissionByCheck {
  permission: Permission;
  scope: PermissionCheckScope;
}

/**
 * `RouteDef` as the guard reads it. `anyOf` alternatives are `PermissionCheck` objects in the WP-05 contract; a bare
 * permission code is accepted too and checked at its matrix scope.
 */
type ContractRoute = Omit<RouteDef, 'anyOf'> & {
  anyOf?: readonly (Permission | PermissionByCheck)[];
  allOf?: readonly Permission[];
  permissionBy?: {
    source: 'path' | 'body' | 'query';
    member: string;
    cases: Readonly<Record<string, PermissionByCheck>>;
  };
};

/** True when the route checks a permission (auth-only routes do not). */
export function routeHasPermission(def: RouteDef): boolean {
  const route = def as unknown as ContractRoute;
  return Boolean(route.permission || route.anyOf?.length || route.machine || route.permissionBy || route.allOf?.length);
}

/** The `ms` slug of an ms-scoped request: from the place `msSource` names, else the `:ms` path parameter (F.7). */
export function msOfRequest(def: RouteDef, input: RouteInput): string | null {
  const source = def.msSource ?? (/:ms(\/|$)/.test(def.path) ? 'path' : undefined);
  if (!source) return null;
  const holder = (source === 'path' ? input.params : source === 'body' ? input.body : input.query) as { ms?: unknown } | undefined;
  const ms = holder?.ms;
  return typeof ms === 'string' && ms !== '' ? ms : null;
}

/** 401 unless the principal's session state fits the route's auth level (F.1, D.1). */
export function assertAuthLevel(def: RouteDef, principal: Principal | null): asserts principal is Principal {
  const state = principal?.session?.state;
  let ok: boolean;
  switch (def.auth) {
    case 'session':
      ok = state === 'active';
      break;
    case 'any_session':
      ok = state !== undefined;
      break;
    case 'mfa_pending':
      ok = state === 'mfa_pending';
      break;
    case 'enrolment':
      ok = state === 'mfa_enrolment' || state === 'active';
      break;
    case 'guest_otp':
      ok = Boolean(principal?.guestTransactionId);
      break;
    default:
      ok = false;
  }
  if (!ok || !principal) throw new UnauthenticatedError();
}

const DENIAL_CAP_KEYS = 10_000;

@Injectable()
export class AuthzGuard implements CanActivate {
  private readonly logger = new Logger('Authz');
  private readonly testRoutesEnabled: boolean;
  private readonly recentDenials = new Set<string>();
  private readonly deniedCounter?: Counter<'route'>;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: MscdConfig,
    @Inject(SESSION_RESOLVER) private readonly sessions: SessionResolver,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Optional() private readonly rateLimits?: RateLimitService,
    @Optional() @Inject(AUDIT_WRITER) private readonly audit?: AuditWriter,
    @Optional() private readonly pino?: PinoLogger,
    @Optional() metrics?: MetricsService,
  ) {
    const profile = config.profile;
    this.testRoutesEnabled = profile.demo.enabled && profile.test?.endpoints_enabled === true;
    if (metrics) {
      const name = 'mscd_authz_denied_total';
      this.deniedCounter =
        (metrics.registry.getSingleMetric(name) as Counter<'route'> | undefined) ??
        new Counter({ name, help: 'Requests denied by the authorisation guard (F.7)', labelNames: ['route'], registers: [metrics.registry] });
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const def = this.reflector.get<RouteDef | undefined>(ROUTE_DEF_METADATA, context.getHandler());
    if (!def) {
      if (request.url.startsWith('/api/')) throw new NotFoundError();
      return true;
    }
    if (def.testOnly) {
      if (!this.testRoutesEnabled) throw new NotFoundError();
      this.logger.warn(`Test-only route ${def.id} called (D.3 Test support)`);
    }
    updateRequestContext({ routeId: def.id });

    let principal: Principal | null = null;
    if (def.auth !== 'public') {
      principal = await this.sessions.resolve(request, def.auth);
      assertAuthLevel(def, principal);
      this.bindPrincipal(principal);
    }
    if (this.sessions.verifyRequest) await this.sessions.verifyRequest(request, def, principal);

    await this.rateLimits?.enforce('early', def, request, reply, principal, { query: request.query });
    const input = validateRouteInput(def, request);
    await this.rateLimits?.enforce('late', def, request, reply, principal, { body: input.body, query: input.query });

    const authz = await this.authorise(def, principal, input);
    if (authz?.ms) updateRequestContext({ ms: authz.ms });

    if (def.method !== 'GET' && !def.readOnlyAllowed && principal?.org) {
      await this.licence.assertWritable(principal.org.id);
    }
    request.mscd = { route: def, input, principal, authz };
    return true;
  }

  /** Evaluates the route's permission (F.7); null for auth-only routes. */
  private async authorise(def: RouteDef, principal: Principal | null, input: RouteInput): Promise<AuthzState | null> {
    const route = def as unknown as ContractRoute;
    const ms = msOfRequest(def, input);
    if (!routeHasPermission(def)) return null;
    if (!principal) throw new UnauthenticatedError();

    const granted = new Map<Permission, 'full' | 'own'>();
    const tenancy = this.config.profile.tenancy.mode;
    /**
     * One check. Without an explicit scope the permission's matrix scope applies. An `ms` check needs the system of
     * the request: without one it fails (WP-05 contract), so a route never widens an ms check by accident.
     */
    const evaluate = async (permission: Permission, scope?: PermissionCheckScope): Promise<PermissionDecision> => {
      const checkScope: PermissionCheckScope = scope ?? effectiveGrant(permission, tenancy).scope;
      if (checkScope === 'ms' && !ms) return null;
      const target = checkScope === 'ms' ? { scope: 'ms' as const, ms: ms! } : { scope: checkScope };
      const decision = await this.evaluator.evaluate(principal, permission, target);
      if (decision) granted.set(permission, decision);
      return decision;
    };

    let allowed = false;
    let ownOnly = false;
    const checked: Permission[] = [];
    if (route.permissionBy) {
      const { source, member, cases } = route.permissionBy;
      const holder = (source === 'path' ? input.params : source === 'body' ? input.body : input.query) as Record<string, unknown> | undefined;
      const value = holder?.[member];
      const check = (typeof value === 'string' && value !== '*' && Object.hasOwn(cases, value) ? cases[value] : undefined) ?? cases['*'];
      if (!check) throw new Error(`Route ${def.id}: permissionBy has no case for ${String(value)} and no * case`);
      checked.push(check.permission);
      const decision = await evaluate(check.permission, check.scope);
      allowed = decision !== null;
      ownOnly = decision === 'own';
    } else if (route.machine || route.anyOf?.length) {
      const candidates: PermissionByCheck[] = [];
      const add = (permission: Permission, scope: PermissionCheckScope | undefined) => {
        const resolved = scope ?? effectiveGrant(permission, tenancy).scope;
        if (!candidates.some((c) => c.permission === permission && c.scope === resolved)) candidates.push({ permission, scope: resolved });
      };
      if (route.permission) add(route.permission, route.scope);
      for (const item of route.anyOf ?? []) {
        if (typeof item === 'string') add(item, undefined);
        else add(item.permission, item.scope);
      }
      if (route.machine) for (const permission of machinePermissions(route.machine)) add(permission, 'ms');
      const decisions: PermissionDecision[] = [];
      for (const candidate of candidates) {
        checked.push(candidate.permission);
        decisions.push(await evaluate(candidate.permission, candidate.scope));
      }
      allowed = decisions.some((d) => d !== null);
      ownOnly = allowed && !decisions.includes('full');
    } else if (route.permission) {
      checked.push(route.permission);
      const decision = await evaluate(route.permission, route.scope);
      allowed = decision !== null;
      ownOnly = decision === 'own';
    } else {
      allowed = true;
    }
    if (allowed && route.allOf?.length) {
      for (const permission of route.allOf) {
        checked.push(permission);
        if ((await evaluate(permission, route.scope)) === null) allowed = false;
      }
    }
    if (!allowed) {
      await this.recordDenial(def, principal, ms, checked);
      throw new ForbiddenError();
    }
    return { ms, granted, ownOnly };
  }

  /** Request context and log fields of the caller. */
  private bindPrincipal(principal: Principal): void {
    updateRequestContext({
      userId: principal.user.id,
      actorKind: principal.user.kind === 'guest' ? 'guest' : principal.user.kind === 'system' ? 'system' : 'user',
      orgId: principal.org?.id,
      orgSlug: principal.org?.slug,
      schema: principal.org?.schema,
    });
    try {
      this.pino?.assign({ userId: principal.user.id, ...(principal.org ? { orgId: principal.org.id } : {}) });
    } catch {
      // Outside the request scope of nestjs-pino (for example in tests without its middleware): nothing to bind.
    }
  }

  /** F.7 Denials: `authz.denied` in the tenant audit trail, at most once per user, route and minute. */
  private async recordDenial(def: RouteDef, principal: Principal, ms: string | null, permissions: Permission[]): Promise<void> {
    this.deniedCounter?.inc({ route: def.id });
    if (!principal.org || !this.audit) return;
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${principal.user.id}|${def.id}|${minute}`;
    if (this.recentDenials.has(key)) return;
    if (this.recentDenials.size >= DENIAL_CAP_KEYS) {
      for (const k of this.recentDenials) if (!k.endsWith(`|${minute}`)) this.recentDenials.delete(k);
    }
    this.recentDenials.add(key);
    try {
      await this.audit.recordDetached(
        { action: 'authz.denied', entityType: 'route', entityCode: def.id, after: { routeId: def.id, permissions, ms } },
        { orgId: principal.org.id, schema: principal.org.schema },
      );
    } catch (error) {
      this.logger.error(`Could not audit a denial of ${def.id}: ${(error as Error).message}`);
    }
  }
}
