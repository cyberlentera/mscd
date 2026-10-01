import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { LinkHealthController } from './link-health.controller';
import { LinkHealthCheckJob, LinkHealthPlanJob, LinkHealthRepositoryJob } from './link-health.jobs';
import { LinkHealthService } from './link-health.service';
import { LinkStatusWriter } from './link-status-writer';
import { RepositoryHealthService } from './repository-health.service';
import { RequestPacer } from './request-pacer';

/**
 * Link health (E.2, E.4, TS 5.5, TS 5.7): `link-health.plan` selects due storage objects, `link-health.check` asks
 * the gateway `stat` under a per-repository token bucket and stores the E.4 status, `link-health.repository` tests
 * every repository connection, and `POST /ms/{ms}/link-health/run` checks one system now. `LinkStatusWriter` is
 * shared with `integrity.rehash`.
 */
@Module({
  imports: [JobsModule, StorageModule],
  controllers: [LinkHealthController],
  providers: [
    RequestPacer,
    LinkStatusWriter,
    LinkHealthService,
    RepositoryHealthService,
    LinkHealthPlanJob,
    LinkHealthCheckJob,
    LinkHealthRepositoryJob,
  ],
  exports: [LinkStatusWriter, LinkHealthService, RepositoryHealthService, RequestPacer],
})
export class LinkHealthModule {}
