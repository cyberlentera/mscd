// The routes of the session user (build plan D.3 "System, session and identity", WP-39 rows): `GET /me`,
// `PUT /me/org` with the D-26 pin rule, `POST /me/memberships/{org}/accept` and the demo persona switch (D-20).
// Session changes go through the identity module's `SessionService` (F.1 rotation): a switch of organisation and a
// persona switch give the browser a new session id.
import { Inject, Injectable } from '@nestjs/common';
import { DEMO_PERSONAS, type Me, type ReauthMethods, type UiRole } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ForbiddenError,
  NotFoundError,
  OrganisationInactiveError,
  ReauthRequiredError,
  UnauthenticatedError,
} from '../../common/problems';
import { ME_ASSEMBLER, type MeAssembler, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { localLoginAllowed, providerMethods } from '../identity/local-login-policy';
import { SessionService, type CurrentSession, type IssuedSession } from '../identity/session.service';
import { tenantContextOf } from '../tenancy/tenant-scope';
import { AuthzInfra } from './authz-infra';

/** The membership of the session user in an organisation, as `PUT /me/org` checks it. */
interface OwnMembership {
  status: 'active' | 'invited' | 'disabled';
  admin_roles: ('tenant_admin' | 'storage_admin')[];
  deleted_at: Date | null;
}

/**
 * D-26: whether an organisation accepts the authentication of a session. Local sign-in (and the development
 * methods `demo` and `test`) is accepted where the organisation's `local_login` policy allows it for the member;
 * an SSO or guest session only by the organisation that authenticated it (`auth_org_id`: the provider's or the
 * grant's organisation).
 */
export function acceptsAuthentication(
  session: { authMethod: string; authOrgId: string | null },
  target: Pick<TenantInfo, 'id' | 'localLogin'>,
  adminRoles: readonly string[],
): boolean {
  switch (session.authMethod) {
    case 'local':
    case 'demo':
    case 'test':
      return localLoginAllowed(target.localLogin, adminRoles);
    default:
      return session.authOrgId !== null && session.authOrgId === target.id;
  }
}

@Injectable()
export class MeService {
  constructor(
    private readonly infra: AuthzInfra,
    private readonly sessions: SessionService,
    @Inject(ME_ASSEMBLER) private readonly me: MeAssembler,
  ) {}

  /** `GET /me`. */
  async get(request: FastifyRequest, principal: Principal): Promise<Me> {
    const csrfToken = this.sessions.csrfTokenOf(request);
    if (!csrfToken) throw new UnauthenticatedError();
    return this.me.assemble(principal, { csrfToken });
  }

  /** `PUT /me/org` (D-26): switch to another organisation of the user; a new session id on success. */
  async switchOrganisation(request: FastifyRequest, reply: FastifyReply, principal: Principal, slug: string): Promise<Me> {
    const current = this.currentSession(request);
    const target = await this.infra.tenants.resolveBySlug(slug);
    if (!target || target.status === 'archived') throw new NotFoundError('Not a member of this organisation');
    const userId = principal.user.id;
    const context = { orgId: target.id, schema: target.schema, userId };
    const outcome = await this.infra.scope.withTenant(context, async (trx): Promise<{ issued: IssuedSession } | { methods: ReauthMethods } | null> => {
      const membership = await this.ownMembership(trx, target.id, userId);
      if (!membership || membership.status !== 'active' || membership.deleted_at !== null) return null;
      if (target.status !== 'active' && target.status !== 'offboarding') throw new OrganisationInactiveError();
      const session = { authMethod: current.row.auth_method, authOrgId: current.row.auth_org_id };
      if (!acceptsAuthentication(session, target, membership.admin_roles)) {
        const local = principal.user.kind !== 'guest' && localLoginAllowed(target.localLogin, membership.admin_roles);
        return { methods: await providerMethods(trx, [target.id], local) };
      }
      const issued = await this.sessions.rotate(trx, current.row, { organizationId: target.id });
      await this.infra.audit.record(trx, {
        action: 'auth.org_switched',
        organizationId: target.id,
        entityType: 'user',
        entityId: userId,
        entityCode: principal.user.handle,
        after: { from: principal.org?.slug ?? null, to: target.slug, method: current.row.auth_method },
      });
      return { issued };
    });
    if (!outcome) throw new NotFoundError('Not a member of this organisation');
    if ('methods' in outcome) throw new ReauthRequiredError(outcome.methods, 'This organisation does not accept the sign-in of this session; sign in again');
    this.sessions.setCookie(reply, outcome.issued);
    const next: Principal = { user: principal.user, org: target, session: this.sessions.principalSession(outcome.issued.row) };
    return this.me.assemble(next, { csrfToken: outcome.issued.csrfToken });
  }

  /** `POST /me/memberships/{org}/accept`: an invited membership becomes active (licence user limit, D-15). */
  async acceptMembership(request: FastifyRequest, principal: Principal, slug: string): Promise<Me> {
    const csrfToken = this.sessions.csrfTokenOf(request);
    if (!csrfToken) throw new UnauthenticatedError();
    const target = await this.infra.tenants.resolveBySlug(slug);
    if (!target || target.status === 'archived') throw new NotFoundError('No invitation of this organisation');
    if (principal.user.kind === 'guest') throw new NotFoundError('No invitation of this organisation');
    const userId = principal.user.id;
    const now = this.infra.now();
    const accepted = await this.infra.scope.withTenant({ orgId: target.id, schema: target.schema, userId }, async (trx) => {
      const membership = await trx
        .selectFrom('platform.org_membership')
        .select(['status', 'deleted_at'])
        .where('organization_id', '=', target.id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!membership || membership.status !== 'invited' || membership.deleted_at !== null) return false;
      // An accepted membership is an active member of that organisation: the licence user limit applies (D-15).
      await this.infra.licence.assertCanAddUser(trx, target.id);
      await trx
        .updateTable('platform.org_membership')
        .set({ status: 'active', accepted_at: now })
        .where('organization_id', '=', target.id)
        .where('user_id', '=', userId)
        .execute();
      await this.infra.audit.record(trx, {
        action: 'membership.updated',
        organizationId: target.id,
        entityType: 'org_membership',
        entityId: userId,
        entityCode: principal.user.handle,
        before: { status: 'invited' },
        after: { status: 'active', accepted: true },
      });
      return true;
    });
    if (!accepted) throw new NotFoundError('No invitation of this organisation');
    return this.me.assemble(principal, { csrfToken });
  }

  /** `POST /auth/demo/persona` (D-20): a demo user signs in as the demo persona of a UI role; 404 outside demo mode. */
  async switchPersona(request: FastifyRequest, reply: FastifyReply, principal: Principal, role: UiRole): Promise<Me> {
    const config = this.infra.config;
    if (!config.demoEnabled || !config.profile.demo.personas) throw new NotFoundError();
    const current = this.currentSession(request);
    const org = principal.org;
    if (!org) throw new NotFoundError('No demo persona without an organisation');
    const handle = DEMO_PERSONAS[role];
    const outcome = await this.infra.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const self = await trx.selectFrom('platform.app_user').select(['is_demo']).where('id', '=', principal.user.id).executeTakeFirst();
      if (!self?.is_demo) throw new ForbiddenError('Only demo users switch personas');
      const persona = await trx
        .selectFrom('platform.app_user as u')
        .innerJoin('platform.org_membership as m', (join) =>
          join.onRef('m.user_id', '=', 'u.id').on('m.organization_id', '=', org.id).on('m.status', '=', 'active').on('m.deleted_at', 'is', null),
        )
        .select(['u.id', 'u.handle', 'u.email', 'u.display_name', 'u.job_title', 'u.kind'])
        .where('u.handle', '=', handle)
        .where('u.is_demo', '=', true)
        .where('u.status', '=', 'active')
        .where('u.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!persona) return null;
      // F.1: a persona switch gives a new session id; the old session ends.
      if (!(await this.sessions.revoke(trx, current.row.id_hash, 'rotated'))) throw new UnauthenticatedError();
      const issued = await this.sessions.create(trx, {
        userId: persona.id,
        organizationId: org.id,
        authOrgId: org.id,
        state: 'active',
        authMethod: 'demo',
        mfaAt: this.infra.now(),
      });
      await this.infra.audit.record(trx, {
        action: 'auth.persona_switch',
        organizationId: org.id,
        entityType: 'user',
        entityId: persona.id,
        entityCode: persona.handle,
        after: { role, from: principal.user.handle, to: persona.handle },
      });
      return { issued, persona };
    });
    if (!outcome) throw new NotFoundError('No demo persona of this role in the organisation');
    this.sessions.setCookie(reply, outcome.issued);
    const p = outcome.persona;
    const next: Principal = {
      user: { id: p.id, handle: p.handle, email: p.email, displayName: p.display_name, jobTitle: p.job_title, kind: p.kind },
      org,
      session: this.sessions.principalSession(outcome.issued.row),
    };
    return this.me.assemble(next, { csrfToken: outcome.issued.csrfToken });
  }

  private currentSession(request: FastifyRequest): CurrentSession {
    const current = this.sessions.currentOf(request);
    if (!current) throw new UnauthenticatedError();
    return current;
  }

  private async ownMembership(trx: Trx, orgId: string, userId: string): Promise<OwnMembership | undefined> {
    return trx
      .selectFrom('platform.org_membership')
      .select(['status', 'admin_roles', 'deleted_at'])
      .where('organization_id', '=', orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }
}
