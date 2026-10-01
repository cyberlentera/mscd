import { Module } from '@nestjs/common';
import { ReadModelModule } from '../read-model/read-model.module';
import { ReadModelApiModule } from '../read-model-api/read-model-api.module';
import { StorageModule } from '../storage/storage.module';
import { CalendarFeedService } from './calendar-feed.service';
import { ExportBuildJob } from './export-build.job';
import { ExportContentService } from './export-content.service';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Exports (PDF, XLSX, CSV) and the review calendar feed (D.3 "Page actions", E.2 `export.build`, F.13, F.15; WP-24):
 * `POST /exports`, `GET /exports/{taskId}` and its download, the synchronous SoA and document register exports, the
 * calendar feed routes, and the `export.build` job handler (discovered by the worker). The content is read through
 * the read model's exported services, so `ScopePolicy` applies to every export as on the screens.
 */
@Module({
  imports: [ReadModelModule, ReadModelApiModule, StorageModule],
  controllers: [ExportsController],
  providers: [ExportContentService, ExportsService, CalendarFeedService, ExportBuildJob],
  exports: [ExportContentService, ExportsService, CalendarFeedService, ExportBuildJob],
})
export class ExportsModule {}
