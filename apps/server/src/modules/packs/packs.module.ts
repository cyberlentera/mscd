import { Module } from '@nestjs/common';
import { EditionWithdrawnAlertsJob } from './edition-withdrawn-alerts.job';
import { PackBundleStore } from './pack-bundle-store';
import { PackInstallJob } from './pack-install.job';
import { PackInstallerDatabase, PackInstallService } from './pack-installer.service';
import { PackLifecycleService } from './pack-lifecycle.service';
import { PacksController } from './packs.controller';
import { PacksLifecycleJob } from './packs-lifecycle.job';
import { PacksService } from './packs.service';

/**
 * Framework packs (E.8, D-16, D-17, TS 6.3): the installer on a lazily opened `mscd_pack_installer` pool with the
 * compiled trust anchors (from the licence module), `GET /admin/packs`, `POST /admin/packs/import`,
 * `POST /admin/packs/check-updates`, and the jobs `pack.install`, `packs.lifecycle` and `edition.withdrawn-alerts`.
 */
@Module({
  controllers: [PacksController],
  providers: [
    PackInstallerDatabase,
    PackInstallService,
    PackBundleStore,
    PacksService,
    PackLifecycleService,
    PackInstallJob,
    PacksLifecycleJob,
    EditionWithdrawnAlertsJob,
  ],
  exports: [PackInstallService, PackLifecycleService],
})
export class PacksModule {}
