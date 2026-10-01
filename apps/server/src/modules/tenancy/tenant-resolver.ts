// Organisation resolution (build plan F.7, F.10): slug or id to organisation, schema and status, cached for 60
// seconds. Every status change made through the command line or the operator routes calls `invalidate(orgId)`, so a
// suspended organisation is refused within the request that follows the change in this process.
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../common/problems';
import type { OrgTimeZoneLookup } from '../../common/clock';
import { DEFAULT_TIME_ZONE } from '../../common/clock';
import type { TenantInfo } from '../../common/tokens';
import { DATABASE, type AppDatabase } from '../../db/database.module';

export const TENANT_CACHE_TTL_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9_]{1,39}$/;

interface CacheEntry {
  info: TenantInfo;
  expiresAt: number;
}

@Injectable()
export class TenantResolver implements OrgTimeZoneLookup {
  private readonly byId = new Map<string, CacheEntry>();
  private readonly bySlug = new Map<string, CacheEntry>();

  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /** The organisation with this id or slug (not deleted), or null. */
  async resolve(slugOrId: string): Promise<TenantInfo | null> {
    if (UUID.test(slugOrId)) return this.resolveById(slugOrId.toLowerCase());
    if (SLUG.test(slugOrId)) return this.resolveBySlug(slugOrId);
    return null;
  }

  /** The organisation with this id or slug; 404 `not-found` when there is none. */
  async require(slugOrId: string): Promise<TenantInfo> {
    const info = await this.resolve(slugOrId);
    if (!info) throw new NotFoundError('Unknown organisation');
    return info;
  }

  async resolveById(id: string): Promise<TenantInfo | null> {
    const cached = this.fresh(this.byId.get(id));
    if (cached) return cached;
    return this.load('id', id);
  }

  async resolveBySlug(slug: string): Promise<TenantInfo | null> {
    const cached = this.fresh(this.bySlug.get(slug));
    if (cached) return cached;
    return this.load('slug', slug);
  }

  /** Drops the cache entry of an organisation (call on every status or settings change, F.7). */
  invalidate(orgId: string): void {
    const entry = this.byId.get(orgId);
    this.byId.delete(orgId);
    if (entry) this.bySlug.delete(entry.info.slug);
    for (const [slug, e] of this.bySlug) if (e.info.id === orgId) this.bySlug.delete(slug);
  }

  /** Drops every cache entry (test reset, D.3 Test support). */
  invalidateAll(): void {
    this.byId.clear();
    this.bySlug.clear();
  }

  /** `OrgTimeZoneLookup` for the clock: the organisation's time zone, the C.4 default when it is unknown. */
  async timeZoneOf(orgId: string): Promise<string> {
    return (await this.resolveById(orgId))?.timeZone ?? DEFAULT_TIME_ZONE;
  }

  private fresh(entry: CacheEntry | undefined): TenantInfo | null {
    return entry && entry.expiresAt > Date.now() ? entry.info : null;
  }

  private async load(by: 'id' | 'slug', value: string): Promise<TenantInfo | null> {
    const row = await this.db
      .selectFrom('platform.organization')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'time_zone', 'local_login', 'demo_deploy_label', 'site_count', 'position'])
      .where(by, '=', value)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    const info: TenantInfo = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      schema: row.schema_name,
      status: row.status,
      timeZone: row.time_zone,
      localLogin: row.local_login,
      demoDeployLabel: row.demo_deploy_label,
      siteCount: row.site_count,
      position: row.position,
    };
    const entry: CacheEntry = { info, expiresAt: Date.now() + TENANT_CACHE_TTL_MS };
    this.byId.set(info.id, entry);
    this.bySlug.set(info.slug, entry);
    return info;
  }
}
