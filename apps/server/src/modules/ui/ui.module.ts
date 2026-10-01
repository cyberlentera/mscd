import { Module } from '@nestjs/common';
import { ReadModelModule } from '../read-model/read-model.module';
import { UiController } from './ui.controller';

/** UI parity reads: `GET /ui/org`, `GET /ui/ms/{ms}` and `GET /tasks` (D-05, D.3). Built by WP-17. */
@Module({
  imports: [ReadModelModule],
  controllers: [UiController],
})
export class UiModule {}
