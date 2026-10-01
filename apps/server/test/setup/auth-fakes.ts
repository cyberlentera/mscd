// Authentication and authorisation fakes for Nest testing modules (build plan J.2, WP-08). They override
// SESSION_RESOLVER and PERMISSION_EVALUATOR with fixed users, organisations and role sets, and evaluate permissions
// from the shared F.6 matrix (scopes and tenancy-specific rows included; own checks are left to the services), so
// work packages can test their routes before WP-11 and WP-39 finish. Later suites use real sessions.
//
// A request picks its identity with the header `X-Test-Principal: <name>`; without the header the default identity
// is used, and `anonymous` means no session.
import { randomBytes } from 'node:crypto';
import type { TestingModuleBuilder } from '@nestjs/testing';
import {
  evaluatePermission,
  permissionsFor,
  type AuthMethod,
  type BusinessRole,
  type OrgRole,
  type Permission,
  type PermissionSet,
  type PlatformRole,
  type SessionState,
  type TenancyMode,
  type UserKind,
} from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { NotFoundError } from '../../src/common/problems';
import {
  PERMISSION_EVALUATOR,
  SESSION_RESOLVER,
  type PermissionDecision,
  type PermissionEvaluator,
  type PermissionTarget,
  type Principal,
  type SessionResolver,
  type TenantInfo,
} from '../../src/common/tokens';

export const FAKE_PRINCIPAL_HEADER = 'x-test-principal';

export interface FakeIdentity {
  user: { id: string; handle: string; email?: string; displayName?: string; jobTitle?: string | null; kind?: UserKind };
  /** Current organisation of the session (null for an operator without one). */
  org: TenantInfo | null;
  /** Business roles per management system slug of `org`. */
  rolesByMs?: Record<string, BusinessRole[]>;
  orgRoles?: OrgRole[];
  platformRoles?: PlatformRole[];
  /**
   * System slugs that exist in the organisation; a check in another system answers 404 (F.7). Default: the keys of
   * `rolesByMs`, and any slug when both are empty.
   */
  knownMs?: string[];
  sessionState?: SessionState;
  authMethod?: AuthMethod;
}

/** The principal a fake identity resolves to. */
export function fakePrincipal(identity: FakeIdentity): Principal {
  const now = Date.now();
  const user = identity.user;
  return {
    user: {
      id: user.id,
      handle: user.handle,
      email: user.email ?? `${user.handle}@test.invalid`,
      displayName: user.displayName ?? user.handle,
      jobTitle: user.jobTitle ?? null,
      kind: user.kind ?? 'person',
    },
    org: identity.org,
    session: {
      idHash: randomBytes(32).toString('hex'),
      state: identity.sessionState ?? 'active',
      authMethod: identity.authMethod ?? 'test',
      authOrgId: identity.org?.id ?? null,
      authGrantId: null,
      identityProviderId: null,
      idleExpiresAt: new Date(now + 60 * 60_000),
      absoluteExpiresAt: new Date(now + 8 * 60 * 60_000),
      passwordAt: new Date(now),
      mfaAt: new Date(now),
    },
  };
}

/** SESSION_RESOLVER fake: the identity named by `X-Test-Principal`, else the default one. */
export class FakeSessionResolver implements SessionResolver {
  private readonly principals = new Map<string, Principal>();

  constructor(
    identities: Readonly<Record<string, FakeIdentity>>,
    private readonly defaultName: string | null,
  ) {
    for (const [name, identity] of Object.entries(identities)) this.principals.set(name, fakePrincipal(identity));
  }

  async resolve(request: FastifyRequest): Promise<Principal | null> {
    const header = request.headers[FAKE_PRINCIPAL_HEADER];
    const name = (Array.isArray(header) ? header[0] : header) ?? this.defaultName;
    if (!name || name === 'anonymous') return null;
    const principal = this.principals.get(name);
    if (!principal) throw new Error(`Unknown fake principal ${name}`);
    return principal;
  }

  /** The principal of a named identity (for assertions). */
  principal(name: string): Principal {
    const principal = this.principals.get(name);
    if (!principal) throw new Error(`Unknown fake principal ${name}`);
    return principal;
  }
}

/** PERMISSION_EVALUATOR fake: the F.6 matrix over the identity's role sets. */
export class MatrixPermissionEvaluator implements PermissionEvaluator {
  private readonly byUser = new Map<string, FakeIdentity>();

  constructor(
    identities: Readonly<Record<string, FakeIdentity>>,
    private readonly tenancy: TenancyMode = 'single',
  ) {
    for (const identity of Object.values(identities)) this.byUser.set(identity.user.id, identity);
  }

  private identityOf(principal: Principal): FakeIdentity {
    const identity = this.byUser.get(principal.user.id);
    if (!identity) throw new Error(`No fake identity for user ${principal.user.id}`);
    return identity;
  }

  async evaluate(principal: Principal, permission: Permission, target: PermissionTarget): Promise<PermissionDecision> {
    const identity = this.identityOf(principal);
    const rolesByMs = identity.rolesByMs ?? {};
    const known = identity.knownMs ?? Object.keys(rolesByMs);
    const base = {
      tenancy: this.tenancy,
      anyMsRoles: [...new Set(Object.values(rolesByMs).flat())],
      orgRoles: identity.orgRoles ?? [],
      platformRoles: identity.platformRoles ?? [],
    };
    if (target.scope === 'ms') {
      if (!target.ms || (known.length > 0 && !known.includes(target.ms))) throw new NotFoundError('Unknown management system');
      return evaluatePermission(permission, { ...base, msRoles: rolesByMs[target.ms] ?? [] });
    }
    if (target.scope === 'any_ms') {
      const decisions = [...new Set([...known, ...Object.keys(rolesByMs)])].map((ms) =>
        evaluatePermission(permission, { ...base, msRoles: rolesByMs[ms] ?? [] }),
      );
      if (decisions.length === 0) decisions.push(evaluatePermission(permission, { ...base, msRoles: [] }));
      return decisions.includes('full') ? 'full' : decisions.includes('own') ? 'own' : null;
    }
    return evaluatePermission(permission, { ...base, msRoles: [] });
  }

  async permissionSet(principal: Principal): Promise<PermissionSet> {
    const identity = this.identityOf(principal);
    const rolesByMs = identity.rolesByMs ?? {};
    const base = {
      tenancy: this.tenancy,
      anyMsRoles: [...new Set(Object.values(rolesByMs).flat())],
      orgRoles: identity.orgRoles ?? [],
      platformRoles: identity.platformRoles ?? [],
    };
    const org = [...permissionsFor('org', { ...base, msRoles: [] }), ...permissionsFor('platform', { ...base, msRoles: [] })];
    const ms: Record<string, Permission[]> = {};
    for (const [slug, roles] of Object.entries(rolesByMs)) ms[slug] = permissionsFor('ms', { ...base, msRoles: roles });
    return { org, ms };
  }

  async rolesByMs(principal: Principal): Promise<Record<string, BusinessRole[]>> {
    return { ...(this.identityOf(principal).rolesByMs ?? {}) };
  }
}

export interface FakeAuthOptions {
  identities: Readonly<Record<string, FakeIdentity>>;
  /** Identity of requests without `X-Test-Principal` (default: none, so such requests are unauthenticated). */
  defaultIdentity?: string | null;
  tenancy?: TenancyMode;
}

/** Overrides SESSION_RESOLVER and PERMISSION_EVALUATOR of a testing module with the fakes. */
export function withFakeAuth(builder: TestingModuleBuilder, options: FakeAuthOptions): TestingModuleBuilder {
  return builder
    .overrideProvider(SESSION_RESOLVER)
    .useValue(new FakeSessionResolver(options.identities, options.defaultIdentity ?? null))
    .overrideProvider(PERMISSION_EVALUATOR)
    .useValue(new MatrixPermissionEvaluator(options.identities, options.tenancy ?? 'single'));
}
