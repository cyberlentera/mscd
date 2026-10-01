// `PATCH /admin/organization` (build plan F.4, D.3): the organisation's local sign-in policy (`allowed`,
// `admins_only`, `disabled`). The change is audited (`org.settings_updated`) and drops the organisation from the
// tenant resolver cache, so sign-in and `PUT /me/org` decide with the new policy at once.
import { Inject, Injectable } from '@nestjs/common';
import type { OrgPolicyPatch } from '@mscd/shared';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';

@Injectable()
export class OrganizationService {
  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async update(principal: Principal, patch: OrgPolicyPatch): Promise<void> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No current organisation');
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const current = await trx.selectFrom('platform.organization').select('local_login').where('id', '=', org.id).forUpdate().executeTakeFirst();
      if (!current) throw new NotFoundError('No current organisation');
      if (current.local_login === patch.localLogin) return;
      await trx.updateTable('platform.organization').set({ local_login: patch.localLogin }).where('id', '=', org.id).execute();
      await this.audit.record(trx, {
        action: 'org.settings_updated',
        entityType: 'organization',
        entityId: org.id,
        entityCode: org.slug,
        before: { localLogin: current.local_login },
        after: { localLogin: patch.localLogin },
      });
    });
    // After the commit: the next lookup reads the new policy (F.7 cache rule).
    this.tenants.invalidate(org.id);
  }
}
