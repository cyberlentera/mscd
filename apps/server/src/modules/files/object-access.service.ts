// Opening and reading stored files (build plan D.3, D-28, D-34, F.7, F.13, BR-35): `open` answers a short-lived
// URL (the content route for Managed Vault and pass-through files, the api's own redirect for linked and
// zero-transit files), `redirect` re-checks the token and the permission and sends the browser to the provider,
// `content` streams the bytes through `FileResponder`. Every route checks `ScopePolicy.canReadObject`; external
// auditors open pack copies only and never receive a provider URL; Top Management has no file access.
import { Inject, Injectable } from '@nestjs/common';
import type { GatewayRepository, GatewayTenant, ObjectOpenResponse, OpenUrlResult } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { FileResponder } from '../../common/file-response';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, GATEWAY_CLIENT, type AuditWriter, type GatewayClient, type Principal, type Trx } from '../../common/tokens';
import { addAuditorReadRefs, type AuditorReadRef } from '../authz/auditor-read';
import { ScopePolicyService, type ScopeContext } from '../authz/scope-policy';
import type { RepositoryRow } from '../storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { FilesCommon, type StorageObjectRow } from './files-common';
import { refusal, ruleMessages, viaGateway } from './files-support';
import { RedirectTokens } from './redirect-token';

/** How long the content URL of `open` is offered (the route itself re-checks everything). */
const CONTENT_URL_TTL_MS = 5 * 60 * 1000;

interface ReadableObject {
  ctx: ScopeContext;
  object: StorageObjectRow;
  repository: RepositoryRow;
  refs: AuditorReadRef[];
}

/** Whether the api streams the object itself: Managed Vault objects and pass-through uploads (hash computed). */
export function streamsContent(object: Pick<StorageObjectRow, 'hash_source'>, repository: Pick<RepositoryRow, 'adapter' | 'modes'>): boolean {
  if (repository.adapter === 'managed_vault') return true;
  return object.hash_source === 'computed' && repository.modes.includes('pass_through');
}

/** External auditors read pack copies only through the api: vault copies, or copies in a pass-through repository. */
function auditorStreams(repository: Pick<RepositoryRow, 'adapter' | 'modes'>): boolean {
  return repository.adapter === 'managed_vault' || repository.modes.includes('pass_through');
}

@Injectable()
export class ObjectAccessService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly common: FilesCommon,
    private readonly scope: ScopePolicyService,
    private readonly tokens: RedirectTokens,
    private readonly files: FileResponder,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // GET /storage/objects/{id}/open?ms=
  // ---------------------------------------------------------------------------------------------------------------

  async open(principal: Principal, id: string, ms: string, request: FastifyRequest): Promise<ObjectOpenResponse> {
    const org = this.common.org(principal);
    const now = this.common.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const readable = await this.readable(trx, principal, ms, id);
      const { ctx, object, repository } = readable;
      if (ctx.kind === 'external_auditor') addAuditorReadRefs(request, readable.refs);
      let response: ObjectOpenResponse;
      let via: 'content' | 'redirect';
      if (ctx.kind === 'external_auditor' ? auditorStreams(repository) : streamsContent(object, repository)) {
        via = 'content';
        response = {
          url: `/api/v1/storage/objects/${object.id}/content?ms=${encodeURIComponent(ctx.ms.slug)}`,
          expiresAt: new Date(now.getTime() + CONTENT_URL_TTL_MS).toISOString(),
        };
      } else if (ctx.kind === 'external_auditor') {
        // D-34: auditors never get a provider URL; a copy the api cannot stream stays closed to them.
        throw refusal('files.copy_not_streamable', {
          en: 'This evidence copy cannot be opened here. Ask the organisation for a copy in the Managed Vault.',
          id: 'Salinan bukti ini tidak dapat dibuka di sini. Minta organisasi menyediakan salinan di Managed Vault.',
        });
      } else {
        via = 'redirect';
        const issued = this.tokens.issue({ u: principal.user.id, g: org.id, m: ctx.ms.slug, o: object.id }, now);
        response = { url: `/api/v1/storage/objects/${object.id}/redirect?t=${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
      }
      await this.audit.record(trx, {
        action: 'file.opened',
        msId: ctx.ms.id,
        entityType: 'storage_object',
        entityId: object.id,
        entityCode: object.display_name,
        after: { via, repository: repository.slug, records: readable.refs.map((r) => `${r.entityType}:${r.code}`) },
      });
      return response;
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // GET /storage/objects/{id}/redirect?t=
  // ---------------------------------------------------------------------------------------------------------------

  /** 302 to the provider URL after the token, the permission and the scope are checked again (never for auditors). */
  async redirect(principal: Principal, id: string, token: string, reply: FastifyReply): Promise<void> {
    const org = this.common.org(principal);
    const claims = this.tokens.verify(token, this.common.clock.now());
    if (!claims || claims.o !== id || claims.u !== principal.user.id || claims.g !== org.id) {
      throw new ForbiddenError('The link has expired or was issued to someone else', { messageKey: 'files.redirect_token' });
    }
    // The permission is checked again at use (D.3): a role revoked since `open` ends the access.
    if (!(await this.common.holds(principal, claims.m, 'storage.object.read'))) throw new ForbiddenError();
    const call = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const readable = await this.readable(trx, principal, claims.m, id);
      if (readable.ctx.kind === 'external_auditor') throw new NotFoundError();
      if (streamsContent(readable.object, readable.repository)) throw new NotFoundError('This file opens through the content route');
      const call = await this.gatewayCall(trx, org.id, readable);
      await this.audit.record(trx, {
        action: 'file.opened',
        msId: readable.ctx.ms.id,
        entityType: 'storage_object',
        entityId: readable.object.id,
        entityCode: readable.object.display_name,
        after: { via: 'provider', repository: readable.repository.slug },
      });
      return { ...call, readable };
    });
    const result = await viaGateway(call.readable.repository, () =>
      this.gateway.post<OpenUrlResult>('/v1/open-url', { tenant: call.tenant, repository: call.descriptor, object: this.common.objectRef(call.readable.object) }),
    );
    await reply.code(302).header('location', result.url).header('referrer-policy', 'no-referrer').send();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // GET /storage/objects/{id}/content?ms=&inline=
  // ---------------------------------------------------------------------------------------------------------------

  async content(principal: Principal, id: string, ms: string, inline: boolean, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const org = this.common.org(principal);
    const call = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const readable = await this.readable(trx, principal, ms, id);
      const auditor = readable.ctx.kind === 'external_auditor';
      if (!(auditor ? auditorStreams(readable.repository) : streamsContent(readable.object, readable.repository))) {
        // BR-35: linked and zero-transit files are never proxied for preview; they open in the repository.
        throw new BusinessRuleError('BR-35', ruleMessages('BR-35', readable.repository.name), undefined, { messageKey: 'files.opens_in_repository' });
      }
      if (auditor) addAuditorReadRefs(request, readable.refs);
      return { ...(await this.gatewayCall(trx, org.id, readable)), readable };
    });
    const { object, repository, ctx } = call.readable;
    const streamed = await viaGateway(repository, () =>
      this.gateway.stream({ tenant: call.tenant, repository: call.descriptor, object: this.common.objectRef(object) }),
    );
    const size = streamed.size ?? (object.size_bytes === null ? null : Number(object.size_bytes));
    return this.files.send(reply, {
      body: streamed.stream,
      // F.13: the type the gateway detected at upload; the gateway's detection of this stream otherwise.
      storedType: object.mime_type ?? streamed.detectedType,
      fileName: object.display_name ?? `file-${object.id}`,
      size,
      inline,
      audit: {
        action: 'file.downloaded',
        msId: ctx.ms.id,
        entityType: 'storage_object',
        entityId: object.id,
        entityCode: object.display_name,
        after: { repository: repository.slug, inline, records: call.readable.refs.map((r) => `${r.entityType}:${r.code}`) },
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Shared steps
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * F.7 `canReadObject` with the caller's scope of `ms`: 404 unless a record of the system the caller can see holds
   * the object (Top Management never, external auditors pack copies of ready packs only).
   */
  private async readable(trx: Trx, principal: Principal, ms: string, id: string): Promise<ReadableObject> {
    const ctx = await this.scope.scopeContext(trx, principal, ms);
    if (!(await this.scope.canReadObjectIn(trx, ctx, id))) throw new NotFoundError();
    const object = await this.common.object(trx, id);
    const repository = await this.common.repositoryOf(trx, object);
    return { ctx, object, repository, refs: await this.recordsOf(trx, id, ctx.ms.id) };
  }

  /** The records of the system that hold an object (for the audit entry and the auditor's read log). */
  private async recordsOf(trx: Trx, objectId: string, msId: string): Promise<AuditorReadRef[]> {
    const { rows } = await sql<AuditorReadRef>`
      select 'evidence' as "entityType", e.id, e.evidence_code as code from evidence e
       where e.deleted_at is null
         and (e.storage_object_id = ${objectId}
              or exists (select 1 from evidence_pack_item i join evidence_pack p on p.id = i.evidence_pack_id
                          where i.evidence_id = e.id and i.copy_storage_object_id = ${objectId}
                            and p.management_system_id = ${msId} and p.deleted_at is null))
      union
      select 'document', d.id, d.doc_code from document_version v join document d on d.id = v.document_id
       where v.storage_object_id = ${objectId} and v.deleted_at is null and d.deleted_at is null
      order by 1, 3 limit 20`.execute(trx);
    return rows;
  }

  private async gatewayCall(trx: Trx, orgId: string, readable: ReadableObject): Promise<{ tenant: GatewayTenant; descriptor: GatewayRepository }> {
    return { tenant: await this.common.storage.tenant(trx, orgId), descriptor: await this.common.storage.repository(trx, readable.repository) };
  }
}
