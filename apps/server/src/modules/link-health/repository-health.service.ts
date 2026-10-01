// `link-health.repository` (build plan E.2, TS 5.7): a gateway connection test of every repository of the
// organisation. Stores `connection_status`, `connection_status_since`, `last_checked_at` and the messages, keeps
// the certificate expiry the gateway reports, raises a `connector` alert on the systems the repository serves and
// notifies the Tenant Admins (`connector_revoked`) when the credential is revoked, resolves the alerts when the
// connection works again, and warns Tenant and Storage Admins (`credential_expiring`) 30 and 7 days before
// `storage_credential.expires_at`.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConnectionStatus, TestConnectionResponse } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { diffDays, fmtDay, localDate } from '../../common/dates';
import { AUDIT_WRITER, GATEWAY_CLIENT, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type GatewayClient, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { activeTenantAdmins } from '../storage/storage-policy';
import { windowNow } from '../jobs/job-support';
import { TenantJobRunner } from '../jobs/tenant-job';
import { GatewayProblemError, StorageGatewayContext, activeCredential, type RepositoryRow } from '../storage';

/** E.2: `credential_expiring` 30 and 7 days before the credential expires. */
export const CREDENTIAL_WARNING_DAYS = [30, 7] as const;

export interface RepositoryCheck {
  slug: string;
  before: ConnectionStatus;
  after: ConnectionStatus;
  expiryWarning: number | null;
}

type Message = { en: string; id: string };

/** The message stored for a connection test that the gateway refused. */
function refusalMessage(error: GatewayProblemError): Message {
  switch (error.gatewaySlug) {
    case 'forbidden':
      if (error.reason === 'credential-binding' || error.reason === 'credential-missing') {
        return { en: 'The credential does not fit the repository: set the credential again', id: 'Kredensial tidak cocok dengan repositori: atur ulang kredensial' };
      }
      return { en: 'The storage provider refused access', id: 'Penyedia penyimpanan menolak akses' };
    case 'unsupported':
      return { en: 'This repository type is not available in the storage gateway', id: 'Jenis repositori ini tidak tersedia di storage gateway' };
    case 'rate-limited':
      return { en: 'The storage provider is throttling requests', id: 'Penyedia penyimpanan membatasi permintaan' };
    default:
      return { en: 'The storage provider cannot be reached', id: 'Penyedia penyimpanan tidak dapat dijangkau' };
  }
}

/** Members holding `tenant_admin` or `storage_admin` (active membership and account). */
async function tenantAndStorageAdmins(trx: Trx, orgId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('platform.org_membership as m')
    .innerJoin('platform.app_user as u', 'u.id', 'm.user_id')
    .select('m.user_id')
    .where('m.organization_id', '=', orgId)
    .where('m.status', '=', 'active')
    .where('m.deleted_at', 'is', null)
    .where('u.status', '=', 'active')
    .where('u.deleted_at', 'is', null)
    .where(sql<boolean>`m.admin_roles && array['tenant_admin', 'storage_admin']::text[]`)
    .orderBy('m.user_id')
    .execute();
  return rows.map((r) => r.user_id);
}

@Injectable()
export class RepositoryHealthService {
  private readonly logger = new Logger('RepositoryHealth');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly gatewayContext: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async checkAll(org: TenantInfo, requestId?: string): Promise<RepositoryCheck[]> {
    const repositories = await this.runner.run(
      org,
      (trx) => trx.selectFrom('storage_repository').select('id').where('deleted_at', 'is', null).orderBy('position').orderBy('slug').execute(),
      requestId,
    );
    const results: RepositoryCheck[] = [];
    for (const { id } of repositories) results.push(await this.checkOne(org, id, requestId));
    return results;
  }

  async checkOne(org: TenantInfo, repositoryId: string, requestId?: string): Promise<RepositoryCheck> {
    const prepared = await this.runner.run(
      org,
      async (trx) => {
        const row = await this.gatewayContext.repositoryRow(trx, repositoryId);
        return { row, tenant: await this.gatewayContext.tenant(trx, org.id), descriptor: await this.gatewayContext.repository(trx, row) };
      },
      requestId,
    );
    let outcome: Pick<TestConnectionResponse, 'status' | 'message'> & { credentialExpiresAt?: string };
    try {
      outcome = await this.gateway.post<TestConnectionResponse>('/v1/test-connection', { tenant: prepared.tenant, repository: prepared.descriptor }, { requestId });
    } catch (error) {
      if (!(error instanceof GatewayProblemError)) throw error;
      outcome = { status: 'failed', message: refusalMessage(error) };
    }
    const at = windowNow(this.clock, org.timeZone);
    return this.runner.run(
      org,
      async (trx) => {
        const row = await this.gatewayContext.repositoryRow(trx, repositoryId, { forUpdate: true });
        const before = row.connection_status;
        const after = outcome.status;
        const changed = before !== after;
        const ok = after === 'ok';
        await trx
          .updateTable('storage_repository')
          .set({
            connection_status: after,
            last_checked_at: at,
            updated_at: sql<Date>`now()`,
            // The message describes the state since it began; a repeated test of the same state keeps it.
            ...(changed
              ? {
                  connection_status_since: at,
                  connection_message_en: ok ? null : outcome.message.en,
                  connection_message_id: ok ? null : outcome.message.id,
                  updated_by: SYSTEM_USER_ID,
                }
              : {}),
          })
          .where('id', '=', row.id)
          .execute();
        if (changed) {
          await this.audit.record(trx, {
            action: 'storage.repository.updated',
            actor: { userId: SYSTEM_USER_ID, kind: 'system' },
            entityType: 'storage_repository',
            entityId: row.id,
            entityCode: row.slug,
            before: { connectionStatus: before },
            after: { connectionStatus: after, source: 'link-health.repository' },
          });
        }
        const credential = await activeCredential(trx, row);
        if (outcome.credentialExpiresAt && credential) {
          const reported = new Date(outcome.credentialExpiresAt);
          if (!credential.expires_at || credential.expires_at.getTime() !== reported.getTime()) {
            await trx.updateTable('storage_credential').set({ expires_at: reported, updated_at: sql<Date>`now()` }).where('id', '=', credential.id).execute();
            credential.expires_at = reported;
          }
        }
        if (after === 'revoked') await this.raiseConnectorAlerts(trx, org, row, outcome.message, changed);
        else if (ok) await this.resolveConnectorAlerts(trx, row);
        const expiryWarning = credential?.expires_at ? await this.warnExpiry(trx, org, row, credential, at) : null;
        return { slug: row.slug, before, after, expiryWarning };
      },
      requestId,
    );
  }

  /** Systems the repository serves: its default systems, the systems with a root folder in it, active routing rules. */
  private async systemsOf(trx: Trx, row: RepositoryRow): Promise<{ id: string; slug: string }[]> {
    const roots = Object.keys(((row.config ?? {}) as { roots?: Record<string, unknown> }).roots ?? {});
    return trx
      .selectFrom('management_system as m')
      .select(['m.id', 'm.slug'])
      .where('m.deleted_at', 'is', null)
      .where('m.status', '<>', 'archived')
      .where((eb) =>
        eb.or([
          eb('m.default_storage_repository_id', '=', row.id),
          ...(roots.length > 0 ? [eb('m.slug', 'in', roots)] : []),
          eb.exists(
            eb
              .selectFrom('storage_routing_rule as r')
              .select('r.id')
              .whereRef('r.management_system_id', '=', 'm.id')
              .where('r.storage_repository_id', '=', row.id)
              .where('r.approval_status', '=', 'active')
              .where('r.deleted_at', 'is', null),
          ),
        ]),
      )
      .orderBy('m.position')
      .execute();
  }

  private openConnectorAlerts(trx: Trx, row: RepositoryRow, msId?: string) {
    let query = trx
      .selectFrom('ms_alert')
      .select(['id', 'management_system_id'])
      .where('kind', '=', 'connector')
      .where('resolved_at', 'is', null)
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb(sql<string>`source_ref->>'repositoryId'`, '=', row.id), eb(sql<string>`source_ref->>'repository'`, '=', row.slug)]));
    if (msId) query = query.where('management_system_id', '=', msId);
    return query.execute();
  }

  /** TS 5.7: a `connector` alert (tone bad) on every system the repository serves; Tenant Admins told once. */
  private async raiseConnectorAlerts(trx: Trx, org: TenantInfo, row: RepositoryRow, message: Message, changed: boolean): Promise<void> {
    for (const system of await this.systemsOf(trx, row)) {
      if ((await this.openConnectorAlerts(trx, row, system.id)).length > 0) continue;
      await trx
        .insertInto('ms_alert')
        .values({
          management_system_id: system.id,
          kind: 'connector',
          tone: 'bad',
          text_en: `${row.name}: the connection was revoked. ${message.en}. Integrity checks of its files are paused until the credential is renewed.`,
          text_id: `${row.name}: koneksi dicabut. ${message.id}. Pemeriksaan integritas berkasnya tertunda sampai kredensial diperbarui.`,
          source_ref: JSON.stringify({ source: 'link-health.repository', repository: row.slug, repositoryId: row.id }),
          created_by: SYSTEM_USER_ID,
          updated_by: SYSTEM_USER_ID,
        })
        .execute();
    }
    if (!changed) return;
    for (const admin of await activeTenantAdmins(trx, org.id)) {
      await this.notifications.create(trx, {
        recipientUserId: admin,
        kind: 'connector_revoked',
        createdBy: SYSTEM_USER_ID,
        title: { en: `Repository ${row.name} disconnected`, id: `Repositori ${row.name} terputus` },
        body: {
          en: `The connection to ${row.name} (${row.slug}) was revoked: ${message.en}. Renew the credential or authorise the repository again; file checks are paused until then.`,
          id: `Koneksi ke ${row.name} (${row.slug}) dicabut: ${message.id}. Perbarui kredensial atau otorisasi ulang repositori; pemeriksaan berkas tertunda sampai saat itu.`,
        },
        ref: { module: 'storage', entityType: 'storage_repository', id: row.id, code: row.slug },
      });
    }
  }

  private async resolveConnectorAlerts(trx: Trx, row: RepositoryRow): Promise<void> {
    const open = await this.openConnectorAlerts(trx, row);
    if (open.length === 0) return;
    await trx
      .updateTable('ms_alert')
      .set({ resolved_at: sql<Date>`now()`, updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
      .where(
        'id',
        'in',
        open.map((a) => a.id),
      )
      .execute();
  }

  /**
   * `credential_expiring` to Tenant and Storage Admins once the credential is 30 days from expiry, and again at 7
   * days. The notification's ref code names the step (`<slug> 30d`, `<slug> 7d`), so each step is sent once.
   */
  private async warnExpiry(
    trx: Trx,
    org: TenantInfo,
    row: RepositoryRow,
    credential: { id: string; expires_at: Date | null },
    at: Date,
  ): Promise<number | null> {
    const expiry = credential.expires_at!;
    const today = this.clock.fixedToday ?? localDate(at, org.timeZone);
    const expiryDay = localDate(expiry, org.timeZone);
    const left = diffDays(today, expiryDay);
    if (left < 0) return null;
    const step = [...CREDENTIAL_WARNING_DAYS].sort((a, b) => a - b).find((days) => left <= days);
    if (step === undefined) return null;
    const code = `${row.slug} ${step}d`;
    const sent = await trx
      .selectFrom('notification')
      .select('id')
      .where('kind', '=', 'credential_expiring')
      .where(sql<string>`entity_ref->>'id'`, '=', credential.id)
      .where(sql<string>`entity_ref->>'code'`, '=', code)
      .limit(1)
      .executeTakeFirst();
    if (sent) return null;
    const when = fmtDay(expiryDay, 'en');
    const whenId = fmtDay(expiryDay, 'id');
    const recipients = await tenantAndStorageAdmins(trx, org.id);
    for (const user of recipients) {
      await this.notifications.create(trx, {
        recipientUserId: user,
        kind: 'credential_expiring',
        createdBy: SYSTEM_USER_ID,
        title: { en: `Credential of ${row.name} expires in ${left} days`, id: `Kredensial ${row.name} kedaluwarsa dalam ${left} hari` },
        body: {
          en: `The credential of ${row.name} (${row.slug}) expires on ${when}. Renew it before then, or file checks and uploads through this repository stop.`,
          id: `Kredensial ${row.name} (${row.slug}) kedaluwarsa pada ${whenId}. Perbarui sebelum tanggal itu, atau pemeriksaan dan unggahan berkas melalui repositori ini berhenti.`,
        },
        ref: { module: 'storage', entityType: 'storage_credential', id: credential.id, code },
      });
    }
    this.logger.log({ orgId: org.id, repository: row.slug, daysLeft: left, recipients: recipients.length }, 'credential_expiring sent');
    return step;
  }
}
