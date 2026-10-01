// `GET /auth/providers` (build plan D.2 `AuthProviders`, D.3): the sign-in buttons of the login page. Only enabled
// providers of a kind the profile offers (`identity.providers`) and of organisations that are not archived are
// listed. With `tenancy.mode = multi` the list holds the providers of one organisation, chosen by `?org=<slug>` or by
// the domain of `?email=` (only domains the platform operator verified, `platform.verified_domain`); without either
// it is empty, so the page never shows the providers of every tenant. A single-tenant installation lists every
// provider unless the query names an organisation. `local` says whether the page offers email and password: the
// profile offers local sign-in and the chosen organisation does not disable it.
import { Injectable } from '@nestjs/common';
import type { AuthProvider, AuthProviders, AuthProvidersQuery } from '@mscd/shared';
import { MscdConfig } from '../../../config/mscd-config';
import type { Trx } from '../../../common/tokens';
import { TenantScope } from '../../tenancy/tenant-scope';
import { emailDomain } from './oidc-rules';
import { kindEnabled } from './provider-lookup';

interface ChosenOrganisation {
  id: string;
  localLogin: 'allowed' | 'admins_only' | 'disabled';
}

@Injectable()
export class AuthProvidersService {
  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
  ) {}

  async list(query: AuthProvidersQuery): Promise<AuthProviders> {
    const profile = this.config.profile;
    const kinds = (['oidc', 'saml'] as const).filter((kind) => kindEnabled(profile, kind));
    const localOffered = kindEnabled(profile, 'local');
    const multi = profile.tenancy.mode === 'multi';
    return this.scope.withPlatform(
      async (trx) => {
        const org = await this.chosenOrganisation(trx, query);
        const local = localOffered && (org ? org.localLogin !== 'disabled' : true);
        if ((multi && !org) || kinds.length === 0) return { local, providers: [] };
        let rows = trx
          .selectFrom('platform.identity_provider as p')
          .innerJoin('platform.organization as o', 'o.id', 'p.organization_id')
          .select(['p.slug', 'p.kind', 'p.display_name', 'p.icon'])
          .where('p.enabled', '=', true)
          .where('p.deleted_at', 'is', null)
          .where('p.kind', 'in', kinds)
          .where('o.deleted_at', 'is', null)
          .where('o.status', '<>', 'archived');
        if (org) rows = rows.where('p.organization_id', '=', org.id);
        const found = await rows.orderBy('o.position').orderBy('p.display_name').orderBy('p.slug').execute();
        const providers: AuthProvider[] = found.map((r) => ({ slug: r.slug, kind: r.kind, label: r.display_name, icon: r.icon }));
        return { local, providers };
      },
      { scope: 'auth' },
    );
  }

  /** The organisation of `?org=`, else of the verified domain of `?email=`; null when the query names none. */
  private async chosenOrganisation(trx: Trx, query: AuthProvidersQuery): Promise<ChosenOrganisation | null> {
    if (query.org) {
      const row = await trx
        .selectFrom('platform.organization')
        .select(['id', 'local_login'])
        .where('slug', '=', query.org)
        .where('deleted_at', 'is', null)
        .where('status', '<>', 'archived')
        .executeTakeFirst();
      return row ? { id: row.id, localLogin: row.local_login } : null;
    }
    if (query.email) {
      const domain = emailDomain(query.email.trim());
      const rows = await trx
        .selectFrom('platform.verified_domain as d')
        .innerJoin('platform.organization as o', 'o.id', 'd.organization_id')
        .select(['o.id', 'o.local_login'])
        .where('d.domain', '=', domain)
        .where('o.deleted_at', 'is', null)
        .where('o.status', '<>', 'archived')
        .execute();
      // A domain verified for several organisations names none of them.
      return rows.length === 1 ? { id: rows[0]!.id, localLogin: rows[0]!.local_login } : null;
    }
    return null;
  }
}
