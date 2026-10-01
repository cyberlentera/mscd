// Authorisation guard (build plan F.7), global for the api. For every `@ApiRoute` handler, in this order: test-only
// routes are 404 unless the profile enables them; the session resolver finds the caller and the route's auth level
// is checked (401); session checks of WP-11 (CSRF, F.2); rate limits keyed before validation (F.3); params, query,
// headers and body are validated (400); rate limits keyed on the body; the permission is evaluated in the system of
// the request (403, or 404 for an unknown system); the external auditor rules (F.7: a grant that comes only from
// the external auditor role admits GET routes of the audited system only, and external auditor accounts never write); BR-37 read-only
// mode blocks writes (403). The decision is stored on the request for services (`request.mscd`); requests of
// external auditors are marked for the `auditor.read` entry (`auditor-read.ts`). A route under `/api/` without a
// contract definition is 404: the guard fails closed.
//
// WP-08 built the pipeline; WP-39 owns the folder and added the role-based evaluator, the external auditor rules and
// the system id on denial entries.
import { Inject, Injectable, Logger, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EXTERNAL_AUDITOR, effectiveGrant, machinePermissions, type Permission, type RouteDef } from '@mscd/shared';
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
import { markAuditorRead } from './auditor-read';
import { isDetailedEvaluator } from './permission-evaluator';
import { RoleResolver } from './role-resolver';

/** The result of one permission check of the guard. */
interface Outcome {
  decision: PermissionDecision;
  /** Granted only through the external auditor role (F.7). */
  auditorOnly: boolean;
}

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

/**
 * True for business routes: every authenticated route except the sign-in steps under `/auth/` and the routes of the
 * user's own session (`me.*`). Guests may only read business routes (F.7, F.14).
 */
export function isBusinessRoute(def: RouteDef): boolean {
  return def.auth !== 'public' && !def.path.startsWith('/api/v1/auth/') && !def.id.startsWith('me.');
}

/** The guard's decision for one request (F.7). */
interface Authorisation {
  authz: AuthzState | null;
  /** The request relies on a grant that only the external auditor role gives (or on a guest's grant). */
  externalAuditor: boolean;
  /** `management_system.id` of the request's system, when the evaluator resolved it. */
  msId: string | null;
}

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
    @Optional() private readonly roles?: RoleResolver,
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

    const { authz, externalAuditor, msId } = await this.authorise(def, principal, input);
    if (authz?.ms) updateRequestContext({ ms: authz.ms });
    if (principal) {
      // F.7, F.14: external auditors (guests, and regular accounts whose only role is the external auditor role) never
      // change anything on business routes, and every business request they make is logged as `auditor.read`.
      const auditorAccount = isBusinessRoute(def) && (await this.isExternalAuditorAccount(principal));
      if (auditorAccount && def.method !== 'GET') {
        await this.recordDenial(def, principal, authz?.ms ?? null, msId, []);
        throw new ForbiddenError('External auditors have read access only');
      }
      if (externalAuditor || auditorAccount) {
        markAuditorRead(request, def, principal, { ms: authz?.ms ?? null, msId }, input.params);
      }
    }

    if (def.method !== 'GET' && !def.readOnlyAllowed && principal?.org) {
      await this.licence.assertWritable(principal.org.id);
    }
    const ifMatch = def.ifMatch ? request.headers['if-match'] : undefined;
    request.mscd = { route: def, input, principal, authz, ...(typeof ifMatch === 'string' && ifMatch.trim() !== '' ? { ifMatch } : {}) };
    return true;
  }

  /**
   * True for a guest account, and for a regular account whose business roles in the organisation are all the external
   * auditor role and who holds no organisation or platform role (F.6, F.14 step 6).
   */
  private async isExternalAuditorAccount(principal: Principal): Promise<boolean> {
    if (principal.user.kind === 'guest') return true;
    // With an evaluator that cannot tell roles apart (test fakes), only guests count, as for the permission checks.
    if (!principal.org || !this.roles || !isDetailedEvaluator(this.evaluator)) return false;
    const resolved = await this.roles.rolesOf(principal);
    if (resolved.orgRoles.length > 0 || resolved.platformRoles.length > 0) return false;
    const held = [...resolved.systems.values()].flatMap((s) => s.roles);
    return held.length > 0 && held.every((role) => role === EXTERNAL_AUDITOR);
  }

  /** Evaluates the route's permission (F.7); `authz` is null for auth-only routes. */
  private async authorise(def: RouteDef, principal: Principal | null, input: RouteInput): Promise<Authorisation> {
    const route = def as unknown as ContractRoute;
    const ms = msOfRequest(def, input);
    if (!routeHasPermission(def)) return { authz: null, externalAuditor: false, msId: null };
    if (!principal) throw new UnauthenticatedError();

    const granted = new Map<Permission, 'full' | 'own'>();
    const tenancy = this.config.profile.tenancy.mode;
    const detailed = isDetailedEvaluator(this.evaluator) ? this.evaluator : null;
    let msId: string | null = null;
    /**
     * One check. Without an explicit scope the permission's matrix scope applies. An `ms` check needs the system of
     * the request: without one it fails (WP-05 contract), so a route never widens an ms check by accident. The
     * outcome says whether only the external auditor role grants it (F.7); with an evaluator that cannot tell
     * (test fakes), a guest's grant counts as an external auditor grant.
     */
    const evaluate = async (permission: Permission, scope?: PermissionCheckScope): Promise<Outcome> => {
      const checkScope: PermissionCheckScope = scope ?? effectiveGrant(permission, tenancy).scope;
      if (checkScope === 'ms' && !ms) return { decision: null, auditorOnly: false };
      const target = checkScope === 'ms' ? { scope: 'ms' as const, ms: ms! } : { scope: checkScope };
      let decision: PermissionDecision;
      let auditorOnly: boolean;
      if (detailed) {
        const d = await detailed.evaluateDetailed(principal, permission, target);
        decision = d.decision;
        auditorOnly = d.externalAuditorOnly;
        if (d.system) msId = d.system.id;
      } else {
        decision = await this.evaluator.evaluate(principal, permission, target);
        auditorOnly = decision !== null && principal.user.kind === 'guest';
      }
      if (decision) granted.set(permission, decision);
      return { decision, auditorOnly };
    };

    let outcomes: Outcome[] = [];
    const checked: Permission[] = [];
    if (route.permissionBy) {
      const { source, member, cases } = route.permissionBy;
      const holder = (source === 'path' ? input.params : source === 'body' ? input.body : input.query) as Record<string, unknown> | undefined;
      const value = holder?.[member];
      const check = (typeof value === 'string' && value !== '*' && Object.hasOwn(cases, value) ? cases[value] : undefined) ?? cases['*'];
      if (!check) throw new Error(`Route ${def.id}: permissionBy has no case for ${String(value)} and no * case`);
      checked.push(check.permission);
      outcomes = [await evaluate(check.permission, check.scope)];
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
      for (const candidate of candidates) {
        checked.push(candidate.permission);
        outcomes.push(await evaluate(candidate.permission, candidate.scope));
      }
    } else if (route.permission) {
      checked.push(route.permission);
      outcomes = [await evaluate(route.permission, route.scope)];
    }
    const grants = outcomes.filter((o) => o.decision !== null);
    let allowed = route.permissionBy || route.machine || route.anyOf?.length || route.permission ? grants.length > 0 : true;
    // A request relies on the external auditor role when every grant that admits it comes from that role alone.
    let externalAuditor = allowed && grants.length > 0 && grants.every((o) => o.auditorOnly);
    const ownOnly = allowed && grants.length > 0 && !grants.some((o) => o.decision === 'full');
    if (allowed && route.allOf?.length) {
      for (const permission of route.allOf) {
        checked.push(permission);
        const outcome = await evaluate(permission, route.scope);
        if (outcome.decision === null) allowed = false;
        else if (outcome.auditorOnly) externalAuditor = true;
      }
    }
    // F.7: external auditors are allowed only on GET routes of the audited system. Their role grants nothing in an
    // `any_ms`, organisation or platform check, so a grant that comes only from it always names that system.
    if (allowed && externalAuditor && def.method !== 'GET') allowed = false;
    if (!allowed) {
      await this.recordDenial(def, principal, ms, msId, checked);
      throw new ForbiddenError();
    }
    return { authz: { ms, granted, ownOnly }, externalAuditor, msId };
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

  /**
   * F.7 Denials: `authz.denied` in the tenant audit trail, at most once per user, route and minute, with the system
   * of the request when it names one (its id when known, so the system's full-entry view lists it).
   */
  private async recordDenial(def: RouteDef, principal: Principal, ms: string | null, msId: string | null, permissions: Permission[]): Promise<void> {
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
        {
          action: 'authz.denied',
          // The system id when the evaluator resolved it, so the system's full-entry view lists the denial (F.11);
          // otherwise the writer looks the slug up.
          ...(msId ? { msId } : { msSlug: ms }),
          entityType: 'route',
          entityCode: def.id,
          after: { routeId: def.id, permissions, ms },
        },
        { orgId: principal.org.id, schema: principal.org.schema },
      );
    } catch (error) {
      this.logger.error(`Could not audit a denial of ${def.id}: ${(error as Error).message}`);
    }
  }
}
