import { Global, Module } from '@nestjs/common';
import { ORG_TIME_ZONE_LOOKUP } from '../../common/clock';
import { CommonModule } from '../../common/common.module';
import { IdempotencyStore } from './idempotency-store';
import { RATE_LIMIT_BACKEND, RateLimitBucketStore } from './rate-limit-store';
import { SchemaReadiness } from './schema-readiness';
import { TenantResolver } from './tenant-resolver';
import { TenantScope } from './tenant-scope';

/**
 * Organisation resolution, `withTenant` and `withPlatform` (F.10), the C.3 readiness checks, and the PostgreSQL
 * stores of rate limits (F.3) and idempotency keys (D.1). Global; also loads the common services
 * (`CommonModule`). Needs `DatabaseModule` and `PlatformModule`.
 */
@Global()
@Module({
  imports: [CommonModule],
  providers: [
    TenantScope,
    TenantResolver,
    { provide: ORG_TIME_ZONE_LOOKUP, useExisting: TenantResolver },
    SchemaReadiness,
    RateLimitBucketStore,
    { provide: RATE_LIMIT_BACKEND, useExisting: RateLimitBucketStore },
    IdempotencyStore,
  ],
  exports: [TenantScope, TenantResolver, ORG_TIME_ZONE_LOOKUP, RATE_LIMIT_BACKEND, RateLimitBucketStore, IdempotencyStore],
})
export class TenancyModule {}
