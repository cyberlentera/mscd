// SESSION_RESOLVER (build plan F.7 session resolution, F.1, F.2). For every contract route that needs a caller:
// the session cookie, then `platform.session` read with platform scope (not revoked, idle and absolute expiry),
// then the user (status active), then the current organisation: membership `active` and organisation `active`, or
// `offboarding` for reads and exports only, else 403 `organisation-inactive`. The sign-in steps under `/auth/`
// (second factor, enrolment, logout) are not business routes and work whatever the organisation's status.
// `verifyRequest` is the CSRF hook (F.2): non-GET requests with a session must send `X-CSRF-Token`; public non-GET
// routes and the guest one-time code must come from the application's own origin.
import { Injectable, Logger } from '@nestjs/common';
import { routes as contractRoutes, type RouteAuth, type RouteDef } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { MscdConfig } from '../../config/mscd-config';
import { CsrfError, OrganisationInactiveError } from '../../common/problems';
import type { Principal, SessionResolver } from '../../common/tokens';
import { GuestOtpResolverRegistry } from './guest-otp';
import { IdentityInfra } from './identity-infra';
import { SESSION_TOUCH_INTERVAL_MS, SessionService, type SessionRow } from './session.service';
import { sameBytes, sha256 } from './tokens';

/** Header of the synchronizer token (F.2). */
export const CSRF_HEADER = 'x-csrf-token';

/** Paths of the sign-in steps, which an inactive organisation does not block (D.1 Organisation status). */
const AUTH_PATH_PREFIX = '/api/v1/auth/';

interface LoadedSession {
  row: SessionRow;
  user: { id: string; handle: string; email: string; display_name: string; job_title: string | null; kind: 'person' | 'system' | 'guest'; status: string; deleted_at: Date | null };
  membershipStatus: string | null;
  membershipDeleted: boolean;
}

/** `method path` of every contract route, to find the route id from Fastify's route pattern. */
const ROUTE_BY_PATTERN = new Map<string, RouteDef>(contractRoutes.map((r) => [`${r.method} ${r.path}`, r]));

/** True for routes an `offboarding` organisation still serves: reads and exports (D.1 Organisation status). */
export function offboardingAllows(method: string, route: RouteDef | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  return route !== undefined && route.id.startsWith('exports.');
}

/** The origin (`scheme://host[:port]`) of a URL, or null when it is not one. */
function originOf(value: string | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

@Injectable()
export class IdentitySessionResolver implements SessionResolver {
  private readonly logger = new Logger('SessionResolver');
  private readonly publicOrigin: string;
  private unavailableReported = false;

  constructor(
    config: MscdConfig,
    private readonly infra: IdentityInfra,
    private readonly sessions: SessionService,
    private readonly guests: GuestOtpResolverRegistry,
  ) {
    this.publicOrigin = new URL(config.profile.http.public_url).origin;
  }

  async resolve(request: FastifyRequest, auth: RouteAuth): Promise<Principal | null> {
    if (auth === 'guest_otp') return this.guests.resolve(request);
    const cookieValue = this.sessions.readCookie(request);
    if (!cookieValue) return null;
    if (!this.infra.available) {
      if (!this.unavailableReported) {
        this.unavailableReported = true;
        this.logger.error('Sessions cannot be resolved: this application has no database services (TenancyModule)');
      }
      return null;
    }
    const now = this.infra.clock.now();
    const loaded = await this.load(cookieValue, now);
    if (!loaded) return null;
    const { row, user } = loaded;
    if (user.status !== 'active' || user.deleted_at !== null) return null;

    let org = null;
    if (row.organization_id) {
      org = await this.infra.tenants.resolveById(row.organization_id);
      const pattern = request.routeOptions?.url ?? '';
      if (!pattern.startsWith(AUTH_PATH_PREFIX)) {
        const memberActive = loaded.membershipStatus === 'active' && !loaded.membershipDeleted;
        const route = ROUTE_BY_PATTERN.get(`${request.method} ${pattern}`);
        const orgUsable = org !== null && (org.status === 'active' || (org.status === 'offboarding' && offboardingAllows(request.method, route)));
        if (!memberActive || !orgUsable) throw new OrganisationInactiveError();
      }
    }

    const principal: Principal = {
      user: { id: user.id, handle: user.handle, email: user.email, displayName: user.display_name, jobTitle: user.job_title, kind: user.kind },
      org,
      session: this.sessions.principalSession(row),
    };
    this.sessions.remember(request, { cookieValue, row, principal });
    return principal;
  }

  async verifyRequest(request: FastifyRequest, route: RouteDef, principal: Principal | null): Promise<void> {
    if (route.csrfExempt || route.method === 'GET') return;
    const current = this.sessions.currentOf(request);
    if (route.auth !== 'public' && route.auth !== 'guest_otp' && principal?.session && current) {
      const header = request.headers[CSRF_HEADER];
      const token = typeof header === 'string' ? header : '';
      if (token === '' || !sameBytes(sha256(token), current.row.csrf_token_hash)) throw new CsrfError();
      return;
    }
    // Public POST routes and the guest one-time code: the request must come from the application's origin (F.2).
    const origin = originOf(typeof request.headers.origin === 'string' ? request.headers.origin : undefined);
    const referer = originOf(typeof request.headers.referer === 'string' ? request.headers.referer : undefined);
    const from = typeof request.headers.origin === 'string' ? origin : referer;
    if (from !== this.publicOrigin) throw new CsrfError('The request must come from the MSCD application (Origin check)');
  }

  /**
   * The open session of a cookie with its user and current membership, or null. An expired session is revoked
   * here; an active one gets its idle expiry extended, at most once per minute (F.1).
   */
  private async load(cookieValue: string, now: Date): Promise<LoadedSession | null> {
    const idHash = sha256(cookieValue);
    return this.infra.scope.withPlatform(
      async (trx) => {
        const found = await trx
          .selectFrom('platform.session as s')
          .innerJoin('platform.app_user as u', 'u.id', 's.user_id')
          .leftJoin('platform.org_membership as m', (join) => join.onRef('m.organization_id', '=', 's.organization_id').onRef('m.user_id', '=', 's.user_id'))
          .selectAll('s')
          .select([
            'u.handle',
            'u.email',
            'u.display_name',
            'u.job_title',
            'u.kind',
            'u.status as user_status',
            'u.deleted_at as user_deleted_at',
            'm.status as membership_status',
            'm.deleted_at as membership_deleted_at',
          ])
          .where('s.id_hash', '=', idHash)
          .where('s.revoked_at', 'is', null)
          .executeTakeFirst();
        if (!found) return null;
        const {
          handle,
          email,
          display_name,
          job_title,
          kind,
          user_status,
          user_deleted_at,
          membership_status,
          membership_deleted_at,
          ...session
        } = found;
        let row: SessionRow = session;
        if (row.idle_expires_at.getTime() <= now.getTime() || row.absolute_expires_at.getTime() <= now.getTime()) {
          await this.sessions.revoke(trx, row.id_hash, 'expired');
          return null;
        }
        if (now.getTime() - row.last_seen_at.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
          const idle = new Date(Math.min(now.getTime() + this.sessions.timeouts(row.auth_method).idleMs, row.absolute_expires_at.getTime()));
          await trx.updateTable('platform.session').set({ last_seen_at: now, idle_expires_at: idle }).where('id_hash', '=', row.id_hash).execute();
          row = { ...row, last_seen_at: now, idle_expires_at: idle };
        }
        return {
          row,
          user: { id: row.user_id, handle, email, display_name, job_title, kind, status: user_status, deleted_at: user_deleted_at },
          membershipStatus: membership_status,
          membershipDeleted: membership_deleted_at !== null,
        };
      },
      { scope: 'auth' },
    );
  }
}
