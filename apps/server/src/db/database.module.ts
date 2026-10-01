import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { MscdConfig } from '../config/mscd-config';
import { ReadinessService } from '../modules/platform/readiness.service';
import { createAppDatabase } from './kysely';
import type { DB } from './types';

/**
 * Injection token of the application database (`Kysely<DB>` on a pool of role `mscd_app`). Tenant code never
 * queries it directly: it goes through `withTenant` (F.10, enforced by lint rules).
 */
export const DATABASE = Symbol.for('mscd.database');

export type AppDatabase = Kysely<DB>;

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    private readonly readiness: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.readiness.register({
      name: 'database',
      check: async () => {
        await sql`select 1`.execute(this.db);
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/** The application database for run modes `api` and `worker` (D.4). Needs `ConfigModule` and `PlatformModule`. */
@Global()
@Module({
  providers: [
    { provide: DATABASE, inject: [MscdConfig], useFactory: (config: MscdConfig) => createAppDatabase(config) },
    DatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
