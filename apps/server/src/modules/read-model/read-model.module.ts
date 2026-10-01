import { Module } from '@nestjs/common';
import { ReadModelService } from './read-model.service';

/**
 * Read model (build plan D-05, E.3, G.5, WP-17): derivation functions, one per concept, under `derive/` (pure, shared
 * with the commands and jobs), loaders under `load/` (a fixed number of queries per request), snapshot builders under
 * `build/`, and `ReadModelService`, which assembles `GET /ui/org`, `GET /ui/ms/{ms}` and `GET /tasks` and applies
 * `ScopePolicy` (F.7). Exported for the `ui` module and the per-screen endpoints (WP-32).
 */
@Module({
  providers: [ReadModelService],
  exports: [ReadModelService],
})
export class ReadModelModule {}
