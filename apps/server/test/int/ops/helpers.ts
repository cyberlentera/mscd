// Helpers of the operations and observability tests (WP-34): an HTTP application with the platform core modules,
// the job modules, observability and ops on a test database, fake identities for the platform operator and a
// Tenant Admin, and a free TCP port for the metrics listener.
import { createServer } from 'node:net';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { TenantInfo } from '../../../src/common/tokens';
import type { DB } from '../../../src/db/types';
import { FreshnessModule } from '../../../src/modules/freshness/freshness.module';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { ObservabilityModule } from '../../../src/modules/observability/observability.module';
import { OpsModule } from '../../../src/modules/ops/ops.module';
import type { FakeIdentity } from '../../setup/auth-fakes';
import type { TestDatabase } from '../../setup/test-db';
import { createIntApp, type IntApp } from '../platform/helpers';
import type { Kysely } from 'kysely';

/** Modules of the ops suites besides the platform core (jobs give handlers of allow-listed jobs). */
export const OPS_MODULES = [JobsModule, FreshnessModule, ObservabilityModule, OpsModule];

export async function createOpsApp(
  db: TestDatabase,
  identities: Record<string, FakeIdentity>,
  options: { env?: Record<string, string>; overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder } = {},
): Promise<IntApp> {
  return createIntApp(db, { imports: OPS_MODULES }, { auth: { identities }, env: options.env, overrides: options.overrides });
}

/** `TenantInfo` of an organisation of the database, by slug. */
export async function tenantInfo(migrator: Kysely<DB>, slug: string): Promise<TenantInfo> {
  const row = await migrator
    .selectFrom('platform.organization')
    .select(['id', 'slug', 'name', 'schema_name', 'status', 'time_zone', 'local_login', 'demo_deploy_label', 'site_count', 'position'])
    .where('slug', '=', slug)
    .executeTakeFirstOrThrow();
  return {
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
}

/** The platform operator (no organisation) and a Tenant Admin of `org` as fake identities. */
export function opsIdentities(operator: { id: string; handle: string }, admin: { id: string; handle: string; org: TenantInfo }): Record<string, FakeIdentity> {
  return {
    ops: { user: { id: operator.id, handle: operator.handle, displayName: 'Platform Operator' }, org: null, platformRoles: ['platform_operator'] },
    ta: { user: { id: admin.id, handle: admin.handle }, org: admin.org, orgRoles: ['tenant_admin'] },
  };
}

/** A TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export const as = (who: string): Record<string, string> => ({ 'x-test-principal': who });
