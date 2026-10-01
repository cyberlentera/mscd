// Identity provider rows as sign-in reads them (build plan C.4 `platform.identity_provider`, F.8): by slug, with the
// status of the provider's organisation. Runs with platform scope (the caller's sign-in transaction).
import type { IdentityProviderKind } from '@mscd/shared';
import type { Selectable } from 'kysely';
import type { Profile } from '../../../config/profile.schema';
import type { Trx } from '../../../common/tokens';
import type { IdentityProviderTable } from '../../../db/types/platform';

export type ProviderRow = Selectable<IdentityProviderTable> & { org_status: string };

/** The provider of a slug (not deleted, organisation not deleted), whatever its state; undefined when none. */
export async function providerBySlug(trx: Trx, slug: string): Promise<ProviderRow | undefined> {
  return trx
    .selectFrom('platform.identity_provider as p')
    .innerJoin('platform.organization as o', 'o.id', 'p.organization_id')
    .selectAll('p')
    .select('o.status as org_status')
    .where('p.slug', '=', slug)
    .where('p.deleted_at', 'is', null)
    .where('o.deleted_at', 'is', null)
    .executeTakeFirst();
}

/** True when the installation offers sign-in through providers of this kind (`identity.providers` of the profile). */
export function kindEnabled(profile: Profile, kind: IdentityProviderKind | 'local'): boolean {
  return (profile.identity.providers as readonly string[]).includes(kind);
}

/**
 * True when a provider can be used for sign-in now: enabled, of a kind the profile offers, and of an organisation
 * that is not archived.
 */
export function providerUsable(profile: Profile, row: Pick<ProviderRow, 'enabled' | 'kind' | 'org_status'>, kind?: IdentityProviderKind): boolean {
  return row.enabled && (kind === undefined || row.kind === kind) && kindEnabled(profile, row.kind) && row.org_status !== 'archived';
}
