// The answer of a sign-in step (build plan D.2 `LoginResponse`): sets the new session cookie and tells the client
// the next step (`mfa_required`, `mfa_enrolment_required`) or, once the session is active, returns `Me`. The CSRF
// token of the new session is always included, because the next step is a POST that must carry it (F.2).
import { Injectable } from '@nestjs/common';
import type { LoginResponse } from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import type { Principal, PrincipalUser } from '../../common/tokens';
import { IdentityInfra } from './identity-infra';
import { SessionService, type IssuedSession } from './session.service';

/** The `app_user` columns a principal needs. */
export interface UserColumns {
  id: string;
  handle: string;
  email: string;
  display_name: string;
  job_title: string | null;
  kind: 'person' | 'system' | 'guest';
}

export function principalUser(user: UserColumns): PrincipalUser {
  return { id: user.id, handle: user.handle, email: user.email, displayName: user.display_name, jobTitle: user.job_title, kind: user.kind };
}

@Injectable()
export class SignInResponder {
  constructor(
    private readonly infra: IdentityInfra,
    private readonly sessions: SessionService,
  ) {}

  /** The principal of a newly written session. */
  async principalOf(issued: IssuedSession, user: PrincipalUser): Promise<Principal> {
    const org = issued.row.organization_id ? await this.infra.tenants.resolveById(issued.row.organization_id) : null;
    return { user, org, session: this.sessions.principalSession(issued.row) };
  }

  /** Sets the cookie of `issued` and builds the `LoginResponse` of its state. */
  async respond(reply: FastifyReply, issued: IssuedSession, user: PrincipalUser): Promise<LoginResponse> {
    this.sessions.setCookie(reply, issued);
    const state = issued.row.state;
    if (state === 'mfa_pending') return { status: 'mfa_required', csrfToken: issued.csrfToken };
    if (state === 'mfa_enrolment') return { status: 'mfa_enrolment_required', csrfToken: issued.csrfToken };
    const me = await this.infra.me.assemble(await this.principalOf(issued, user), { csrfToken: issued.csrfToken });
    return { status: 'ok', csrfToken: issued.csrfToken, me };
  }
}
