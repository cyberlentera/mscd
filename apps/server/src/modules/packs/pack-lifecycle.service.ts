// Edition lifecycle (TS 6.3, BR-33, E.2): `packs.lifecycle` withdraws editions whose transition period has ended
// (installation-wide, as `mscd_pack_installer`), refreshes the online pack catalogue, and queues
// `edition.withdrawn-alerts` for every active organisation; that job marks the systems still on a withdrawn edition
// critical (a `withdrawn_edition` alert) and tells their MS Managers (`edition_withdrawn`).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditAction } from '@mscd/shared';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import {
  AUDIT_WRITER,
  NOTIFICATION_WRITER,
  SYSTEM_USER_ID,
  type AuditWriter,
  type NotificationWriter,
  type Trx,
} from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { withInstallerTransaction } from './pack-installer';
import { PackInstallerDatabase } from './pack-installer.service';
import { fetchOnlineCatalog } from './packs.service';

/** Cron of `packs.lifecycle` (E.2, UTC); registered by the worker's schedules (WP-22). */
export const PACKS_LIFECYCLE_CRON = '10 0 * * *';

/**
 * Audit action of an edition withdrawal. F.11 names no action for it; the `pack.` prefix keeps it in the platform
 * audit log (handoff note: to be added to the F.11 list and the shared `AUDIT_ACTIONS`).
 */
export const PACK_EDITION_WITHDRAWN_ACTION = 'pack.edition_withdrawn' as AuditAction;

export interface LifecycleResult {
  /** `<pack_id> <edition>` of every edition withdrawn by this run. */
  withdrawn: string[];
  /** Organisations for which `edition.withdrawn-alerts` was queued. */
  organisations: number;
  /** Catalogue entries refreshed from the online channel (null for other channels or on a failed read). */
  catalogue: number | null;
}

@Injectable()
export class PackLifecycleService {
  private readonly logger = new Logger('PackLifecycle');

  constructor(
    private readonly config: MscdConfig,
    private readonly installerDatabase: PackInstallerDatabase,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /** `packs.lifecycle`: withdraw, refresh the catalogue, queue the alerts. Idempotent. */
  async runLifecycle(requestId?: string): Promise<LifecycleResult> {
    const today = this.clock.todayIn('UTC');
    const withdrawn = await withInstallerTransaction(this.installerDatabase.get(), { requestId }, async (trx) => {
      const due = await trx
        .selectFrom('ref.framework_version')
        .select(['id', 'pack_id', 'pack_version', 'edition', 'transition_ends_at'])
        .where('status', '=', 'transition')
        .where('transition_ends_at', '<', today)
        .orderBy('pack_id')
        .execute();
      const names: string[] = [];
      for (const version of due) {
        await trx.updateTable('ref.framework_version').set({ status: 'withdrawn' }).where('id', '=', version.id).where('status', '=', 'transition').execute();
        await this.audit.record(trx, {
          action: PACK_EDITION_WITHDRAWN_ACTION,
          actor: { userId: SYSTEM_USER_ID, kind: 'system' },
          organizationId: null,
          entityType: 'framework_version',
          entityId: version.id,
          entityCode: `${version.pack_id} ${version.pack_version}`.slice(0, 80),
          before: { status: 'transition' },
          after: { status: 'withdrawn', transition_ends_at: version.transition_ends_at, withdrawn_on: today },
          edition: `${version.pack_id} ${version.pack_version}`,
          requestId,
        });
        names.push(`${version.pack_id} ${version.edition}`);
      }
      return names;
    });

    let catalogue: number | null = null;
    if (this.config.profile.packs.channel === 'online' && this.config.profile.packs.channel_url) {
      try {
        catalogue = await this.refreshOnlineCatalogue(this.config.profile.packs.channel_url, requestId);
      } catch (error) {
        this.logger.warn(`packs.lifecycle: the online pack catalogue could not be refreshed: ${(error as Error).message}`);
      }
    }

    const organisations = await this.scope.withPlatform(
      (trx) => trx.selectFrom('platform.organization').select('id').where('status', '=', 'active').where('deleted_at', 'is', null).orderBy('position').execute(),
      { scope: 'job', requestId },
    );
    for (const org of organisations) {
      await this.jobs.send('edition.withdrawn-alerts', { orgId: org.id, requestId, payload: {} }, { singletonKey: `ewa:${org.id}:${today}`, retryLimit: 3 });
    }
    if (withdrawn.length > 0) this.logger.log(`packs.lifecycle: withdrew ${withdrawn.join(', ')}`);
    return { withdrawn, organisations: organisations.length, catalogue };
  }

  /** Online channel: `<channel_url>/catalog.json` into `platform.pack_catalog` (installer role). */
  private async refreshOnlineCatalogue(channelUrl: string, requestId?: string): Promise<number> {
    const catalogue = await fetchOnlineCatalog(channelUrl);
    if (catalogue.packs.length === 0) return 0;
    await withInstallerTransaction(this.installerDatabase.get(), { requestId }, async (trx) => {
      await trx
        .insertInto('platform.pack_catalog')
        .values(
          catalogue.packs.map((p) => ({
            pack_id: p.pack_id,
            pack_version: p.pack_version,
            channel: 'online' as const,
            note_en: p.note_en,
            note_id: p.note_id,
            published_at: p.published_at ?? null,
            retrieved_at: new Date(),
          })),
        )
        .onConflict((oc) =>
          oc.columns(['pack_id', 'pack_version']).doUpdateSet((eb) => ({
            channel: eb.ref('excluded.channel'),
            note_en: eb.ref('excluded.note_en'),
            note_id: eb.ref('excluded.note_id'),
            published_at: eb.ref('excluded.published_at'),
            retrieved_at: eb.ref('excluded.retrieved_at'),
          })),
        )
        .execute();
    });
    return catalogue.packs.length;
  }

  /**
   * `edition.withdrawn-alerts` for one organisation (BR-33): every system that is not archived and whose active
   * edition is withdrawn gets one open `withdrawn_edition` alert (tone `bad`) and its MS Managers one
   * `edition_withdrawn` notification; systems no longer on a withdrawn edition have the alert resolved. Idempotent.
   */
  async raiseWithdrawnAlerts(orgId: string): Promise<{ raised: number; resolved: number } | null> {
    const org = await this.tenants.resolveById(orgId);
    if (!org) {
      this.logger.warn(`edition.withdrawn-alerts: organisation ${orgId} does not exist`);
      return null;
    }
    return this.scope.withTenant(systemContextOf(org), async (trx) => {
      const systems = await trx
        .selectFrom('management_system as ms')
        .innerJoin('ref.framework_version as fv', 'fv.id', 'ms.framework_version_id')
        .innerJoin('ref.framework as f', 'f.id', 'fv.framework_id')
        .select(['ms.id', 'ms.slug', 'ms.code', 'fv.id as version_id', 'fv.pack_id', 'fv.edition', 'fv.status', 'fv.transition_ends_at', 'f.name as framework_name'])
        .where('ms.deleted_at', 'is', null)
        .where('ms.status', '<>', 'archived')
        .orderBy('ms.position')
        .execute();
      let raised = 0;
      let resolved = 0;
      for (const system of systems) {
        const open = await trx
          .selectFrom('ms_alert')
          .select(['id', 'source_ref'])
          .where('management_system_id', '=', system.id)
          .where('kind', '=', 'withdrawn_edition')
          .where('resolved_at', 'is', null)
          .where('deleted_at', 'is', null)
          .execute();
        if (system.status !== 'withdrawn') {
          if (open.length > 0) {
            await trx.updateTable('ms_alert').set({ resolved_at: new Date(), updated_by: SYSTEM_USER_ID }).where('id', 'in', open.map((a) => a.id)).execute();
            resolved += open.length;
          }
          continue;
        }
        if (open.some((a) => (a.source_ref as { frameworkVersionId?: unknown } | null)?.frameworkVersionId === system.version_id)) continue;
        const editionName = `${system.framework_name}:${system.edition}`;
        const text = {
          en: `The edition of the standard in use is past its transition period. ${editionName} is withdrawn; move ${system.code} to the current edition.`,
          id: `Edisi standar yang digunakan telah melewati masa transisinya. ${editionName} telah ditarik; pindahkan ${system.code} ke edisi terbaru.`,
        };
        await trx
          .insertInto('ms_alert')
          .values({
            management_system_id: system.id,
            kind: 'withdrawn_edition',
            tone: 'bad',
            text_en: text.en,
            text_id: text.id,
            source_ref: JSON.stringify({ rule: 'BR-33', frameworkVersionId: system.version_id, packId: system.pack_id }),
            created_by: SYSTEM_USER_ID,
            updated_by: SYSTEM_USER_ID,
          })
          .execute();
        raised += 1;
        for (const userId of await msManagers(trx, system.id)) {
          await this.notifications.create(trx, {
            recipientUserId: userId,
            kind: 'edition_withdrawn',
            msId: system.id,
            title: { en: `Edition withdrawn: ${editionName}`, id: `Edisi ditarik: ${editionName}` },
            body: text,
            createdBy: SYSTEM_USER_ID,
          });
        }
      }
      return { raised, resolved };
    });
  }
}

/** Active MS Managers of a system (E.6 recipients of `edition_withdrawn`). */
async function msManagers(trx: Trx, msId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('user_ms_role')
    .select('user_id')
    .distinct()
    .where('management_system_id', '=', msId)
    .where('role', '=', 'ms_manager')
    .where('approval_status', '=', 'active')
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())]))
    .orderBy('user_id')
    .execute();
  return rows.map((r) => r.user_id);
}
