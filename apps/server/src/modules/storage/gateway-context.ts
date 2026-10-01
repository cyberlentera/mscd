// The tenant and repository descriptors every gateway call carries (build plan D.5): `tenant: {orgId, wrappedDek}`
// from `platform.tenant_key`, and `repository: {id, slug, adapter, modes, config, credential?}` with the active
// sealed credential. Other modules (files WP-21, link health WP-23, evidence packs WP-26) build their calls with it.
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { canonicalJson, credentialBindingConfig, type GatewayRepository, type GatewayTenant } from '@mscd/shared';
import { InternalError, NotFoundError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { activeCredential, type RepositoryRow } from './repository-view';

/** SHA-256 (hex) of the binding part of a repository config, as the gateway computes it (D-08). */
export function repositoryConfigSha256(config: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(credentialBindingConfig(config)), 'utf8').digest('hex');
}

@Injectable()
export class StorageGatewayContext {
  /** The tenant of a gateway call; every organisation has a data key from its creation (C.8). */
  async tenant(trx: Trx, orgId: string): Promise<GatewayTenant> {
    const row = await trx.selectFrom('platform.tenant_key').select(['wrapped_dek']).where('organization_id', '=', orgId).executeTakeFirst();
    if (!row) throw new InternalError(`The organisation ${orgId} has no tenant data key`);
    return { orgId, wrappedDek: row.wrapped_dek };
  }

  /** A repository of the transaction's organisation by id; 404 when there is none. */
  async repositoryRow(trx: Trx, id: string, options: { forUpdate?: boolean } = {}): Promise<RepositoryRow> {
    let query = trx.selectFrom('storage_repository').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
    if (options.forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundError('No such storage repository');
    return row;
  }

  /** A repository by slug; 404 when there is none. */
  async repositoryBySlug(trx: Trx, slug: string): Promise<RepositoryRow> {
    const row = await trx.selectFrom('storage_repository').selectAll().where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('No such storage repository');
    return row;
  }

  /** The repository descriptor of a gateway call, with the active credential when one is set. */
  async repository(trx: Trx, row: RepositoryRow, options: { withCredential?: boolean } = {}): Promise<GatewayRepository> {
    const descriptor: GatewayRepository = {
      id: row.id,
      slug: row.slug,
      adapter: row.adapter,
      modes: [...row.modes],
      config: { ...((row.config ?? {}) as Record<string, unknown>) },
    };
    if (options.withCredential !== false) {
      const credential = await activeCredential(trx, row);
      if (credential) descriptor.credential = { ref: credential.credential_ref, sealedBlob: credential.sealed_blob, kind: credential.kind };
    }
    return descriptor;
  }
}
