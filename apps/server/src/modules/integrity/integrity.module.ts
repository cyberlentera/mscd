import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { LinkHealthModule } from '../link-health/link-health.module';
import { StorageModule } from '../storage/storage.module';
import { IntegrityRehashJob } from './integrity.job';
import { IntegrityService } from './integrity.service';

/** Weekly re-hashing of Managed Vault objects (`integrity.rehash`, A-08); a mismatch sets `hash_mismatch`. */
@Module({
  imports: [JobsModule, StorageModule, LinkHealthModule],
  providers: [IntegrityService, IntegrityRehashJob],
  exports: [IntegrityService],
})
export class IntegrityModule {}
