// Storage repository administration (build plan D.3 "Administration", D-08, F.8, BR-30, TS 5.7): repositories with
// config validation, credentials sealed by the gateway (the api stores only the sealed blob), connection tests,
// repository OAuth consent, move requests and the storage object metadata list.
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GoogleDriveRepositoryConfig,
  M365RepositoryConfig,
  SealedCredential,
  TestConnectionResponse,
  VaultRepositoryConfig,
  type CommandResult,
  type CredentialKind,
  type FieldError,
  type GatewayRepository,
  type MoveRequest,
  type OAuthCallbackQuery,
  type Page,
  type RepositoryCreate,
  type RepositoryCredential,
  type RepositoryPatch,
  type RepositoryTestResult,
  type RepositoryView,
  type StorageAdapter,
  type StorageMode,
  type StorageObjectListQuery,
  type StorageObjectMeta,
} from '@mscd/shared';
import { sql } from 'kysely';
import type { ZodType } from 'zod';
import { addDays, localDate, startOfLocalDay } from '../../common/dates';
import {
  BusinessRuleError,
  ConflictError,
  DependencyUnavailableError,
  NotFoundError,
  ProblemError,
  ValidationError,
} from '../../common/problems';
import {
  AUDIT_WRITER,
  GATEWAY_CLIENT,
  LICENCE_GATE,
  NOTIFICATION_WRITER,
  type AuditWriter,
  type GatewayClient,
  type LicenceGate,
  type NotificationWriter,
  type Principal,
  type Trx,
} from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { SecretBox } from '../keys/secret-box';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { GatewayProblemError } from './gateway-client';
import { StorageGatewayContext, repositoryConfigSha256 } from './gateway-context';
import {
  REPO_OAUTH_TTL_SECONDS,
  googleConsentUrl,
  randomToken,
  repoOAuthRedirectUri,
  sha256,
} from './repo-oauth';
import { activeCredential, listRepositoryViews, nextRepositoryPosition, repositoryUsage, toRepositoryView, type RepositoryRow } from './repository-view';
import { activeTenantAdmins } from './storage-policy';

/** Credential kinds each adapter takes through `PUT .../credentials` (D.2). */
const CREDENTIAL_KINDS: Readonly<Record<StorageAdapter, readonly CredentialKind[]>> = {
  managed_vault: [],
  m365: ['m365_certificate'],
  google_drive: ['google_service_account', 'oauth_refresh_token'],
  smb: [],
  s3: [],
  webdav: [],
};

/** Hour and minute of the daily `link-health.repository` check (E.2, 02:30 local). */
const REPOSITORY_CHECK_TIME = { hour: 2, minute: 30 };

const NO_CREDENTIAL_MESSAGE = {
  en: 'No credential set: set the credential, then test the connection',
  id: 'Kredensial belum diatur: atur kredensial, lalu uji koneksi',
};
const CONFIG_CHANGED_MESSAGE = {
  en: 'The configuration changed: set the credential again',
  id: 'Konfigurasi berubah: atur ulang kredensial',
};

export interface OAuthCallbackOutcome {
  /** Relative path the browser is sent to. */
  location: string;
  /** Whether the binding cookie should be cleared (always). */
  clearCookie: true;
}

function parseConfig<T>(schema: ZodType<T>, config: unknown): T {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => ({ path: ['body', 'config', ...issue.path.map(String)].join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger('StorageRepositories');

  constructor(
    private readonly scope: TenantScope,
    private readonly config: MscdConfig,
    private readonly gatewayContext: StorageGatewayContext,
    private readonly secrets: SecretBox,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  // ----------------------------------------------------------------------------------------------- reads

  async list(principal: Principal): Promise<RepositoryView[]> {
    return this.scope.withTenant(tenantContextOf(principal), (trx) =>
      listRepositoryViews(trx, { timeZone: principal.org!.timeZone, configSha256: repositoryConfigSha256 }),
    );
  }

  async objects(principal: Principal, query: StorageObjectListQuery): Promise<Page<StorageObjectMeta>> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      let base = trx
        .selectFrom('storage_object as o')
        .innerJoin('storage_repository as r', 'r.id', 'o.storage_repository_id')
        .where('o.deleted_at', 'is', null)
        .where('r.deleted_at', 'is', null);
      if (query.repository) base = base.where('r.slug', '=', query.repository);
      if (query.status) base = base.where('o.link_status', '=', query.status);
      const total = await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
      const rows = await base
        .select([
          'o.id',
          'r.slug',
          'o.external_item_id',
          'o.external_version_id',
          'o.version_label',
          'o.display_name',
          'o.mime_type',
          'o.size_bytes',
          'o.hash_algorithm',
          'o.hash_value',
          'o.hash_source',
          'o.folder_path',
          'o.link_status',
          'o.link_status_since',
          'o.link_status_reason',
          'o.last_verified_at',
          'o.last_good_check_at',
          'o.next_check_at',
        ])
        .orderBy('o.created_at', 'desc')
        .orderBy('o.id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      const iso = (value: Date | null) => (value ? value.toISOString() : null);
      return {
        items: rows.map((row) => ({
          id: row.id,
          repository: row.slug,
          externalItemId: row.external_item_id,
          externalVersionId: row.external_version_id,
          versionLabel: row.version_label,
          displayName: row.display_name,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
          hashAlgorithm: row.hash_algorithm,
          hashValue: row.hash_value,
          hashSource: row.hash_source,
          folderPath: row.folder_path,
          linkStatus: row.link_status,
          linkStatusSince: row.link_status_since.toISOString(),
          linkStatusReason: row.link_status_reason,
          lastVerifiedAt: iso(row.last_verified_at),
          lastGoodCheckAt: iso(row.last_good_check_at),
          nextCheckAt: iso(row.next_check_at),
        })),
        page: query.page,
        pageSize: query.pageSize,
        total: Number(total.n),
      };
    });
  }

  // ----------------------------------------------------------------------------------------------- create and update

  async create(principal: Principal, body: RepositoryCreate): Promise<RepositoryView> {
    const org = principal.org!;
    await this.checkAdapterAvailable(org.id, body.adapter);
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const config = await this.validConfig(trx, org.id, body.adapter, body.config as Record<string, unknown>);
      const existing = await trx.selectFrom('storage_repository').select('id').where('slug', '=', body.slug).where('deleted_at', 'is', null).executeTakeFirst();
      if (existing) throw new ConflictError(`A repository with the slug ${body.slug} exists`);
      const provider = body.adapter !== 'managed_vault';
      const row = await trx
        .insertInto('storage_repository')
        .values({
          slug: body.slug,
          name: body.name,
          adapter: body.adapter,
          modes: [...body.modes],
          config: JSON.stringify(config),
          ownership_type: body.ownershipType,
          retention_confirmed: body.retentionConfirmed,
          metadata_minimization: body.metadataMinimization,
          display: JSON.stringify(body.display ?? {}),
          position: await nextRepositoryPosition(trx),
          // A provider repository cannot work before its credential is set and tested.
          connection_status: provider ? 'failed' : 'ok',
          connection_message_en: provider ? NO_CREDENTIAL_MESSAGE.en : null,
          connection_message_id: provider ? NO_CREDENTIAL_MESSAGE.id : null,
          created_by: principal.user.id,
          updated_by: principal.user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'storage.repository.created',
        entityType: 'storage_repository',
        entityId: row.id,
        entityCode: row.slug,
        after: { slug: row.slug, name: row.name, adapter: row.adapter, modes: row.modes, ownershipType: row.ownership_type, config },
      });
      return this.view(trx, principal, row);
    });
  }

  async update(principal: Principal, id: string, patch: RepositoryPatch): Promise<RepositoryView> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await this.gatewayContext.repositoryRow(trx, id, { forUpdate: true });
      const changes: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const note = (key: string, oldValue: unknown, newValue: unknown) => {
        before[key] = oldValue;
        after[key] = newValue;
      };
      if (patch.name !== undefined && patch.name !== row.name) {
        changes.name = patch.name;
        note('name', row.name, patch.name);
      }
      if (patch.modes !== undefined) {
        this.checkModes(row.adapter, patch.modes);
        changes.modes = [...patch.modes];
        note('modes', row.modes, patch.modes);
      }
      let configChanged = false;
      if (patch.config !== undefined) {
        const config = await this.validConfig(trx, org.id, row.adapter, patch.config as Record<string, unknown>);
        if (row.adapter === 'managed_vault' && config.prefix !== (row.config as { prefix?: unknown } | null)?.prefix) {
          // D-10: vault keys are immutable (<prefix><object id>) and the gateway serves only keys under the current
          // prefix, so a new prefix would cut off every stored object, or an upload in progress.
          throw new ConflictError('The key prefix of a Managed Vault cannot change after creation', {
            messageKey: 'storage.vault_prefix_fixed',
            messages: {
              en: 'The key prefix of a Managed Vault is fixed when it is created; the stored files depend on it.',
              id: 'Prefiks kunci Managed Vault ditetapkan saat dibuat; file yang tersimpan bergantung padanya.',
            },
          });
        }
        configChanged = repositoryConfigSha256(config) !== repositoryConfigSha256((row.config ?? {}) as Record<string, unknown>);
        changes.config = JSON.stringify(config);
        note('config', row.config, config);
      }
      if (patch.ownershipType !== undefined && patch.ownershipType !== row.ownership_type) {
        changes.ownership_type = patch.ownershipType;
        note('ownershipType', row.ownership_type, patch.ownershipType);
      }
      if (patch.metadataMinimization !== undefined && patch.metadataMinimization !== row.metadata_minimization) {
        changes.metadata_minimization = patch.metadataMinimization;
        note('metadataMinimization', row.metadata_minimization, patch.metadataMinimization);
      }
      if (patch.retentionConfirmed !== undefined && patch.retentionConfirmed !== row.retention_confirmed) {
        changes.retention_confirmed = patch.retentionConfirmed;
        note('retentionConfirmed', row.retention_confirmed, patch.retentionConfirmed);
      }
      if (patch.display !== undefined) {
        changes.display = JSON.stringify(patch.display);
        note('display', row.display, patch.display);
      }
      if (configChanged && row.credential_ref) {
        // D-08: the sealed credential is bound to the old configuration; it must be set again.
        const credential = await activeCredential(trx, row);
        if (credential) {
          await trx
            .updateTable('storage_credential')
            .set({ revoked_at: sql<Date>`now()`, updated_by: principal.user.id, updated_at: sql<Date>`now()` })
            .where('id', '=', credential.id)
            .execute();
          await this.audit.record(trx, {
            action: 'storage.credential.revoked',
            entityType: 'storage_repository',
            entityId: row.id,
            entityCode: row.slug,
            after: { credentialRef: credential.credential_ref, reason: 'config_changed' },
          });
        }
        Object.assign(changes, {
          credential_ref: null,
          connection_status: 'failed',
          connection_status_since: sql<Date>`now()`,
          connection_message_en: CONFIG_CHANGED_MESSAGE.en,
          connection_message_id: CONFIG_CHANGED_MESSAGE.id,
        });
      }
      let updated = row;
      if (Object.keys(changes).length > 0) {
        updated = await trx
          .updateTable('storage_repository')
          .set({ ...changes, updated_by: principal.user.id, updated_at: sql<Date>`now()` })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          action: 'storage.repository.updated',
          entityType: 'storage_repository',
          entityId: row.id,
          entityCode: row.slug,
          before,
          after,
        });
      }
      return this.view(trx, principal, updated);
    });
  }

  // ----------------------------------------------------------------------------------------------- credentials

  async setCredential(principal: Principal, id: string, body: RepositoryCredential): Promise<void> {
    const org = principal.org!;
    const { row, tenant, descriptor } = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const repository = await this.gatewayContext.repositoryRow(trx, id);
      return {
        row: repository,
        tenant: await this.gatewayContext.tenant(trx, org.id),
        descriptor: await this.gatewayContext.repository(trx, repository, { withCredential: false }),
      };
    });
    this.checkCredentialKind(row, body);
    const expiresAt = body.kind === 'm365_certificate' ? certificateExpiry(body.secret.certificatePem) : null;
    const externalAccount = body.kind === 'google_service_account' ? body.secret.clientEmail : body.kind === 'm365_certificate' ? body.secret.clientId : null;
    const sealed = await this.callGateway(SealedCredential, '/v1/credentials/seal', { tenant, repository: descriptor, kind: body.kind, secret: body.secret });
    await this.storeCredential(principal, row, descriptor, { kind: body.kind, sealed, expiresAt, externalAccount });
  }

  // ----------------------------------------------------------------------------------------------- connection test

  async test(principal: Principal, id: string): Promise<CommandResult> {
    const org = principal.org!;
    const prepared = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await this.gatewayContext.repositoryRow(trx, id);
      const references = await trx
        .selectFrom('storage_object')
        .select(sql<string>`count(*)`.as('n'))
        .where('storage_repository_id', '=', row.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return {
        row,
        references: Number(references.n),
        tenant: await this.gatewayContext.tenant(trx, org.id),
        descriptor: await this.gatewayContext.repository(trx, row),
      };
    });
    let outcome: { status: RepositoryTestResult['status']; permissions: string[]; message: { en: string; id: string }; credentialExpiresAt?: string };
    try {
      outcome = await this.callGateway(TestConnectionResponse, '/v1/test-connection', { tenant: prepared.tenant, repository: prepared.descriptor });
    } catch (error) {
      if (!(error instanceof GatewayProblemError)) throw error;
      outcome = { status: 'failed', permissions: [], message: testFailureMessage(error) };
    }
    const nextCheckAt = nextRepositoryCheck(new Date(), org.timeZone);
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const ok = outcome.status === 'ok';
      await trx
        .updateTable('storage_repository')
        .set({
          connection_status: outcome.status,
          connection_status_since: outcome.status === prepared.row.connection_status ? prepared.row.connection_status_since : sql<Date>`now()`,
          connection_message_en: ok ? null : outcome.message.en,
          connection_message_id: ok ? null : outcome.message.id,
          last_checked_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', prepared.row.id)
        .execute();
      if (outcome.credentialExpiresAt && prepared.descriptor.credential) {
        await trx
          .updateTable('storage_credential')
          .set({ expires_at: new Date(outcome.credentialExpiresAt), updated_at: sql<Date>`now()` })
          .where('storage_repository_id', '=', prepared.row.id)
          .where('credential_ref', '=', prepared.descriptor.credential.ref)
          .execute();
      }
    });
    const message: [string, string] = [outcome.message.en, outcome.message.id];
    const data: RepositoryTestResult = {
      status: outcome.status,
      permissions: outcome.permissions,
      references: prepared.references,
      nextCheckAt: nextCheckAt.toISOString(),
      message,
    };
    return { ok: true, changed: [], message, data };
  }

  // ----------------------------------------------------------------------------------------------- OAuth consent (F.8)

  async reauthorize(principal: Principal, id: string): Promise<{ result: CommandResult; bindingCookie: string }> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await this.gatewayContext.repositoryRow(trx, id);
      const credential = await activeCredential(trx, row);
      if (row.adapter !== 'google_drive' || (credential && credential.kind !== 'oauth_refresh_token')) {
        throw new ConflictError('The repository uses app-only credentials; there is nothing to authorise');
      }
      const clientId = (row.config as { oauthClientId?: unknown }).oauthClientId;
      if (!credential || typeof clientId !== 'string') {
        throw new ConflictError('Set the OAuth client of the repository (config.oauthClientId and its credential) first');
      }
      const state = randomToken();
      const binding = randomToken();
      const verifier = randomToken();
      const transactionId = randomUUID();
      await trx
        .insertInto('platform.auth_transaction')
        .values({
          id: transactionId,
          kind: 'repo_oauth',
          organization_id: org.id,
          user_id: principal.user.id,
          target_id: row.id,
          state_hash: sha256(state),
          browser_binding_hash: sha256(binding),
          code_verifier_sealed: await this.secrets.seal(verifier, { purpose: 'pkce', transactionId }),
          return_to: '/storage',
          expires_at: new Date(Date.now() + REPO_OAUTH_TTL_SECONDS * 1000),
        })
        .execute();
      const redirectUrl = googleConsentUrl({
        tokenUrl: this.config.profile.gateway.providers.google.token_url,
        clientId,
        redirectUri: repoOAuthRedirectUri(this.config.profile.http.public_url),
        state,
        verifier,
      });
      return {
        bindingCookie: binding,
        result: {
          ok: true,
          changed: [],
          redirectUrl,
          message: ['Continue in the Google consent screen', 'Lanjutkan di layar persetujuan Google'],
        },
      };
    });
  }

  /**
   * The consent callback. The transaction is consumed only when the signed-in user, the organisation, the binding
   * cookie and the expiry all match; otherwise nothing changes. Then the gateway exchanges the code and seals the
   * refresh token; the api stores the sealed blob only.
   */
  async oauthCallback(principal: Principal, query: OAuthCallbackQuery, bindingCookie: string | undefined): Promise<OAuthCallbackOutcome> {
    const failed = (reason: string): OAuthCallbackOutcome => ({ location: `/storage?oauth=${reason}`, clearCookie: true });
    if (!bindingCookie || !principal.org) return failed('failed');
    const org = principal.org;
    const transaction = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await trx
        .deleteFrom('platform.auth_transaction')
        .where('state_hash', '=', sha256(query.state))
        .where('kind', '=', 'repo_oauth')
        .where('user_id', '=', principal.user.id)
        .where('organization_id', '=', org.id)
        .where('browser_binding_hash', '=', sha256(bindingCookie))
        .where('expires_at', '>', sql<Date>`now()`)
        .returning(['id', 'target_id', 'code_verifier_sealed', 'return_to'])
        .executeTakeFirst();
      return row ?? null;
    });
    if (!transaction || !transaction.target_id || !transaction.code_verifier_sealed) return failed('failed');
    if (query.error || !query.code) return failed('denied');
    const code = query.code;
    try {
      const verifier = await this.secrets.openText(transaction.code_verifier_sealed, { purpose: 'pkce', transactionId: transaction.id });
      const prepared = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
        const row = await this.gatewayContext.repositoryRow(trx, transaction.target_id!);
        const credential = await activeCredential(trx, row);
        if (row.adapter !== 'google_drive' || !credential || credential.kind !== 'oauth_refresh_token') return null;
        return {
          row,
          credential,
          tenant: await this.gatewayContext.tenant(trx, org.id),
          descriptor: await this.gatewayContext.repository(trx, row, { withCredential: false }),
        };
      });
      if (!prepared) return failed('failed');
      const sealed = await this.callGateway(SealedCredential, '/v1/credentials/oauth-exchange', {
        tenant: prepared.tenant,
        repository: prepared.descriptor,
        credential: { ref: prepared.credential.credential_ref, sealedBlob: prepared.credential.sealed_blob, kind: 'oauth_refresh_token' },
        code,
        redirectUri: repoOAuthRedirectUri(this.config.profile.http.public_url),
        codeVerifier: verifier,
      });
      await this.storeCredential(principal, prepared.row, prepared.descriptor, {
        kind: 'oauth_refresh_token',
        sealed,
        expiresAt: null,
        externalAccount: sealed.externalAccount ?? null,
        connected: true,
      });
      return { location: transaction.return_to ?? '/storage', clearCookie: true };
    } catch (error) {
      this.logger.warn(`Repository OAuth consent failed: ${(error as Error).message}`);
      return failed('failed');
    }
  }

  // ----------------------------------------------------------------------------------------------- move requests (BR-30)

  async moveRequest(principal: Principal, id: string, body: MoveRequest): Promise<CommandResult> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await this.gatewayContext.repositoryRow(trx, id);
      if (row.ownership_type !== 'personal') {
        // Not BR-30 itself (a warn-and-allow rule, D.1): a refusal with its own message key.
        throw new ProblemError('business-rule', {
          messageKey: 'storage.move_not_personal',
          messages: {
            en: 'Only personal repositories are moved to a team library',
            id: 'Hanya repositori pribadi yang dipindahkan ke library tim',
          },
        });
      }
      const system = await trx.selectFrom('management_system').select(['id', 'code']).where('slug', '=', body.ms).where('deleted_at', 'is', null).executeTakeFirst();
      if (!system) throw new NotFoundError('No such management system');
      const request = await trx
        .insertInto('repository_move_request')
        .values({ storage_repository_id: row.id, status: 'open', note: body.note ?? null, created_by: principal.user.id, updated_by: principal.user.id })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      let notified = 0;
      for (const adminId of await activeTenantAdmins(trx, org.id)) {
        const created = await this.notifications.create(trx, {
          recipientUserId: adminId,
          kind: 'move_request',
          msId: system.id,
          title: { en: `Move evidence out of ${row.name}`, id: `Pindahkan evidence dari ${row.name}` },
          body: {
            en: `${principal.user.displayName} asks to move the ${system.code} evidence of the personal repository ${row.name} to a team library.${body.note ? ` Note: ${body.note}` : ''}`,
            id: `${principal.user.displayName} meminta evidence ${system.code} di repositori pribadi ${row.name} dipindahkan ke library tim.${body.note ? ` Catatan: ${body.note}` : ''}`,
          },
        });
        if (created) notified += 1;
      }
      await this.audit.record(trx, {
        action: 'storage.move_requested',
        msId: system.id,
        entityType: 'repository_move_request',
        entityId: request.id,
        entityCode: row.slug,
        after: { repository: row.slug, note: body.note ?? null, notified },
      });
      return {
        ok: true,
        changed: [],
        count: notified,
        message: ['Move request sent to the Tenant Admins', 'Permintaan pemindahan dikirim ke Tenant Admin'],
        data: { id: request.id },
      };
    });
  }

  // ----------------------------------------------------------------------------------------------- helpers

  private async view(trx: Trx, principal: Principal, row: RepositoryRow): Promise<RepositoryView> {
    const usage = await repositoryUsage(trx);
    return toRepositoryView(row, await activeCredential(trx, row), {
      ms: usage.get(row.id) ?? [],
      timeZone: principal.org!.timeZone,
      configSha256: repositoryConfigSha256((row.config ?? {}) as Record<string, unknown>),
    });
  }

  /** 422 when the adapter is not enabled in this installation (I.1) or not in the licence (TS 5.7). */
  private async checkAdapterAvailable(orgId: string, adapter: StorageAdapter): Promise<void> {
    if (!(this.config.profile.storage.adapters.enabled as readonly string[]).includes(adapter)) {
      throw new ProblemError('business-rule', {
        messageKey: 'storage.adapter_not_enabled',
        messages: { en: `The ${adapter} adapter is not enabled in this installation`, id: `Adapter ${adapter} tidak diaktifkan di instalasi ini` },
      });
    }
    if (!(await this.licence.isAdapterLicensed(orgId, adapter))) {
      throw new BusinessRuleError('LIC-FEATURE', {
        en: `The licence does not include the ${adapter} storage adapter`,
        id: `Lisensi tidak mencakup adapter penyimpanan ${adapter}`,
      });
    }
  }

  private checkModes(adapter: StorageAdapter, modes: readonly StorageMode[]): void {
    const vault = adapter === 'managed_vault';
    const ok = vault ? modes.length === 1 && modes[0] === 'stored' : !modes.includes('stored');
    if (!ok || new Set(modes).size !== modes.length) {
      throw new ValidationError([
        { path: 'body.modes', message: vault ? 'The Managed Vault has the single mode stored' : 'Provider repositories use pass_through, link or zero_transit' },
      ]);
    }
  }

  /** The config of an adapter, checked: id patterns, per-system roots naming existing systems, the tenant's vault prefix. */
  private async validConfig(trx: Trx, orgId: string, adapter: StorageAdapter, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (adapter === 'managed_vault') {
      const parsed = parseConfig(VaultRepositoryConfig, config);
      if (!parsed.prefix.startsWith(`tenants/${orgId}/`)) {
        throw new ValidationError([{ path: 'body.config.prefix', message: `The prefix must start with tenants/${orgId}/` }]);
      }
      return parsed;
    }
    const parsed: { roots: Record<string, unknown> } & Record<string, unknown> =
      adapter === 'm365' ? parseConfig(M365RepositoryConfig, config) : adapter === 'google_drive' ? parseConfig(GoogleDriveRepositoryConfig, config) : { roots: {}, ...config };
    const slugs = Object.keys(parsed.roots ?? {});
    if (slugs.length > 0) {
      const known = new Set(
        (await trx.selectFrom('management_system').select('slug').where('slug', 'in', slugs).where('deleted_at', 'is', null).execute()).map((s) => s.slug),
      );
      const errors: FieldError[] = slugs.filter((slug) => !known.has(slug)).map((slug) => ({ path: `body.config.roots.${slug}`, message: 'No management system with this slug' }));
      if (errors.length > 0) throw new ValidationError(errors);
    }
    return parsed;
  }

  private checkCredentialKind(row: RepositoryRow, body: RepositoryCredential): void {
    if (!CREDENTIAL_KINDS[row.adapter].includes(body.kind)) {
      throw new ProblemError('business-rule', {
        messageKey: 'storage.credential_kind',
        messages: {
          en: row.adapter === 'managed_vault' ? 'The Managed Vault needs no credential' : `A ${row.adapter} repository takes no ${body.kind} credential`,
          id: row.adapter === 'managed_vault' ? 'Managed Vault tidak memerlukan kredensial' : `Repositori ${row.adapter} tidak menerima kredensial ${body.kind}`,
        },
      });
    }
    if (body.kind === 'oauth_refresh_token') {
      const clientId = (row.config as { oauthClientId?: unknown }).oauthClientId;
      if (clientId !== body.secret.clientId) {
        throw new ValidationError([{ path: 'body.secret.clientId', message: 'Must equal config.oauthClientId of the repository' }]);
      }
    }
  }

  /** Stores a sealed credential as the repository's active one, after checking it is bound to the current config. */
  private async storeCredential(
    principal: Principal,
    row: RepositoryRow,
    descriptor: GatewayRepository,
    input: {
      kind: CredentialKind;
      sealed: { sealedBlob: string; keyId: string; configSha256: string };
      expiresAt: Date | null;
      externalAccount: string | null;
      connected?: boolean;
    },
  ): Promise<void> {
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const current = await this.gatewayContext.repositoryRow(trx, row.id, { forUpdate: true });
      if (repositoryConfigSha256((current.config ?? {}) as Record<string, unknown>) !== input.sealed.configSha256) {
        throw new ConflictError('The repository configuration changed while the credential was sealed; set it again');
      }
      if (input.sealed.configSha256 !== repositoryConfigSha256(descriptor.config)) {
        throw new ConflictError('The gateway sealed the credential for another configuration');
      }
      const previous = await activeCredential(trx, current);
      if (previous) {
        await trx
          .updateTable('storage_credential')
          .set({ revoked_at: sql<Date>`now()`, updated_by: principal.user.id, updated_at: sql<Date>`now()` })
          .where('id', '=', previous.id)
          .execute();
      }
      const credentialRef = `${current.slug}-${randomBytes(6).toString('hex')}`;
      await trx
        .insertInto('storage_credential')
        .values({
          storage_repository_id: current.id,
          credential_ref: credentialRef,
          kind: input.kind,
          sealed_blob: input.sealed.sealedBlob,
          key_id: input.sealed.keyId,
          config_sha256: input.sealed.configSha256,
          external_account: input.externalAccount?.slice(0, 254) ?? null,
          expires_at: input.expiresAt,
          created_by: principal.user.id,
          updated_by: principal.user.id,
        })
        .execute();
      const connected = input.connected === true;
      await trx
        .updateTable('storage_repository')
        .set({
          credential_ref: credentialRef,
          ...(connected
            ? { connection_status: 'ok', connection_message_en: null, connection_message_id: null }
            : current.connection_message_en === NO_CREDENTIAL_MESSAGE.en || current.connection_message_en === CONFIG_CHANGED_MESSAGE.en
              ? {
                  connection_message_en: 'Credential set: test the connection',
                  connection_message_id: 'Kredensial diatur: uji koneksi',
                }
              : {}),
          ...(connected && current.connection_status !== 'ok' ? { connection_status_since: sql<Date>`now()` } : {}),
          updated_by: principal.user.id,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', current.id)
        .execute();
      await this.audit.record(trx, {
        action: 'storage.credential.set',
        entityType: 'storage_repository',
        entityId: current.id,
        entityCode: current.slug,
        after: {
          kind: input.kind,
          credentialRef,
          keyId: input.sealed.keyId,
          externalAccount: input.externalAccount,
          expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
          replaced: previous?.credential_ref ?? null,
        },
      });
    });
  }

  /** A gateway call whose answer is checked against its schema; transport failures are 503. */
  private async callGateway<T>(schema: ZodType<T>, path: string, body: unknown): Promise<T> {
    const answer = await this.gateway.post<unknown>(path, body);
    const parsed = schema.safeParse(answer);
    if (!parsed.success) throw new DependencyUnavailableError(`The storage gateway answered ${path} with an unexpected body`);
    return parsed.data;
  }
}

/** Expiry of a PEM certificate; 400 when it does not parse. */
function certificateExpiry(pem: string): Date {
  try {
    return new Date(new X509Certificate(pem).validTo);
  } catch {
    throw new ValidationError([{ path: 'body.secret.certificatePem', message: 'Not a PEM certificate' }]);
  }
}

/** The bilingual message of a failed test from the gateway problem. */
function testFailureMessage(error: GatewayProblemError): { en: string; id: string } {
  switch (error.gatewaySlug) {
    case 'forbidden':
      if (error.reason === 'credential-binding') {
        return {
          en: 'The credential does not match the repository configuration: set it again',
          id: 'Kredensial tidak cocok dengan konfigurasi repositori: atur ulang kredensial',
        };
      }
      return { en: 'The storage provider refused access', id: 'Penyedia penyimpanan menolak akses' };
    case 'unsupported':
      return { en: 'This repository type is not available in the storage gateway', id: 'Jenis repositori ini tidak tersedia di storage gateway' };
    case 'rate-limited':
      return { en: 'The storage provider is throttling requests: try again later', id: 'Penyedia penyimpanan membatasi permintaan: coba lagi nanti' };
    default:
      return { en: 'The storage provider cannot be reached', id: 'Penyedia penyimpanan tidak dapat dijangkau' };
  }
}

/** The next daily repository check (02:30 in the organisation's time zone) after `now`. */
export function nextRepositoryCheck(now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  const offsetMs = (REPOSITORY_CHECK_TIME.hour * 60 + REPOSITORY_CHECK_TIME.minute) * 60_000;
  const candidate = new Date(startOfLocalDay(today, timeZone).getTime() + offsetMs);
  return candidate > now ? candidate : new Date(startOfLocalDay(addDays(today, 1), timeZone).getTime() + offsetMs);
}
