import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EvidencePackBuildJob } from './evidence-pack-build.job';
import { EvidencePacksController } from './evidence-packs.controller';
import { EvidencePacksService } from './evidence-packs.service';

/**
 * Evidence pack builds, manifests and downloads (E.7, D-34, F.13; WP-26): the request, list, get and download routes
 * and the `evidence-pack.build` job handler (discovered by the worker).
 */
@Module({
  imports: [StorageModule],
  controllers: [EvidencePacksController],
  providers: [EvidencePacksService, EvidencePackBuildJob],
  exports: [EvidencePacksService, EvidencePackBuildJob],
})
export class EvidencePacksModule {}
