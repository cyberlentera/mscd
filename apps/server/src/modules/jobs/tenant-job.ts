// Helpers of tenant-scope job handlers (E.1): resolve the organisation of the job envelope and run inside
// `withTenant(org, SYSTEM_USER)`.
import { Injectable } from '@nestjs/common';
import { SYSTEM_USER_ID, type TenantInfo, type Trx } from '../../common/tokens';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';

@Injectable()
export class TenantJobRunner {
  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
  ) {}

  /** The organisation of a tenant job, or null when it is gone or not active (the job then does nothing). */
  async organisation(orgId: string | null, jobName: string): Promise<TenantInfo | null> {
    if (!orgId) throw new Error(`${jobName} needs the organisation of the job envelope`);
    const org = await this.tenants.resolveById(orgId);
    if (!org || org.status !== 'active') return null;
    return org;
  }

  /** Runs `fn` in one transaction of the organisation as the system user. */
  run<T>(org: TenantInfo, fn: (trx: Trx) => Promise<T>, requestId?: string): Promise<T> {
    return this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID, requestId }, fn);
  }
}
