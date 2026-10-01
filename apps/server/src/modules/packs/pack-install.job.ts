// `pack.install` (E.2): installs a bundle imported through `POST /admin/packs/import` with role
// `mscd_pack_installer` (D-17). No retries: a failed install is final and recorded; the administrator re-imports.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { PackBundleStore } from './pack-bundle-store';
import { PackInstallFailedError, type PackInstallRequest } from './pack-installer';
import { PackInstallService } from './pack-installer.service';
import { PackRejectedError } from './pack-verification';

@Injectable()
@JobHandler('pack.install', { concurrency: 1, scope: 'installation' })
export class PackInstallJob implements JobHandlerInstance<'pack.install'> {
  private readonly logger = new Logger('pack.install');

  constructor(
    private readonly installer: PackInstallService,
    private readonly bundles: PackBundleStore,
  ) {}

  async handle(job: JobRun<'pack.install'>): Promise<void> {
    const { installId, objectKey, requestedBy, orgId } = job.env.payload;
    const request: PackInstallRequest = {
      actor: { userId: requestedBy, kind: orgId ? 'user' : 'operator' },
      orgId: orgId ?? null,
      installId,
      requestId: job.env.requestId,
    };
    const log = { jobId: job.id, installId, orgId: orgId ?? null, attempt: job.attempt };
    let bytes: Buffer;
    try {
      bytes = await this.bundles.get(objectKey);
    } catch (error) {
      const rejection = new PackRejectedError('archive', `the imported bundle cannot be read: ${(error as Error).message}`);
      await this.installer.get().recordRejection(rejection, request);
      this.logger.error(log, rejection.message);
      return;
    }
    try {
      const outcome = await this.installer.get().install(bytes, request);
      this.logger.log({ ...log, status: outcome.status, packId: outcome.packId, version: outcome.version }, 'pack.install done');
    } catch (error) {
      if (error instanceof PackRejectedError || error instanceof PackInstallFailedError) {
        // Recorded by the installer (`pack.rejected`, or a failed install with `pack.install_failed`).
        this.logger.error({ ...log, error: error.message }, 'pack.install refused the bundle');
        return;
      }
      throw error;
    } finally {
      await this.bundles.remove(objectKey).catch((error: unknown) => this.logger.warn(`Could not remove the imported bundle: ${(error as Error).message}`));
    }
  }
}
