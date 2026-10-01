// The services of other modules the authorisation module works with. They are optional dependencies: the api, the
// worker and the command line load every one of them, while the request-pipeline unit tests load the authorisation
// module without a database. Without the database services no role can be resolved, so every permission is denied
// (fail closed, as the WP-08 default did) and a missing dependency is reported when it is first used.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { Clock } from '../../common/clock';
import {
  AUDIT_WRITER,
  LICENCE_GATE,
  NOTIFICATION_WRITER,
  type AuditWriter,
  type LicenceGate,
  type NotificationWriter,
  type Trx,
} from '../../common/tokens';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';

function missing(what: string, module: string): Error {
  return new Error(`The authorisation module needs ${what} (${module}) in this application`);
}

/**
 * Organisation id and schema of a transaction bound to no organisation: no tenant row and no organisation-scoped
 * platform row of any organisation is visible in it (RLS compares `organization_id` with this id, which no
 * organisation has, and the schema name can never be a tenant schema because slugs start with a letter). Only rows
 * the platform tables show without an organisation remain: the acting user's own `org_membership` rows (C.4 policy
 * `user_id = app.user_id`) and tables without RLS such as `platform.platform_role`. Used for principals without a
 * current organisation (a platform operator) and for the user-scoped membership reads of D-26 and F.6.
 */
export const NO_ORGANISATION = { orgId: '00000000-0000-0000-0000-000000000000', schema: 'org__none' } as const;

@Injectable()
export class AuthzInfra {
  constructor(
    readonly config: MscdConfig,
    @Optional() private readonly tenantScope?: TenantScope,
    @Optional() private readonly tenantResolver?: TenantResolver,
    @Optional() private readonly clockService?: Clock,
    @Optional() @Inject(AUDIT_WRITER) private readonly auditWriter?: AuditWriter,
    @Optional() @Inject(LICENCE_GATE) private readonly licenceGate?: LicenceGate,
    @Optional() @Inject(NOTIFICATION_WRITER) private readonly notificationWriter?: NotificationWriter,
  ) {}

  /** True when the database services are present (every real run mode). */
  get available(): boolean {
    return Boolean(this.tenantScope && this.tenantResolver);
  }

  get scope(): TenantScope {
    if (!this.tenantScope) throw missing('TenantScope', 'TenancyModule');
    return this.tenantScope;
  }

  get tenants(): TenantResolver {
    if (!this.tenantResolver) throw missing('TenantResolver', 'TenancyModule');
    return this.tenantResolver;
  }

  /** The current instant from `Clock` (tests move it), else the system time. */
  now(): Date {
    return this.clockService ? this.clockService.now() : new Date();
  }

  get audit(): AuditWriter {
    if (!this.auditWriter) throw missing('AUDIT_WRITER', 'AuditModule');
    return this.auditWriter;
  }

  /** The audit writer when present (denials and auditor reads are logged when it is). */
  get optionalAudit(): AuditWriter | undefined {
    return this.auditWriter;
  }

  get licence(): LicenceGate {
    if (!this.licenceGate) throw missing('LICENCE_GATE', 'LicenseModule');
    return this.licenceGate;
  }

  get notifications(): NotificationWriter {
    if (!this.notificationWriter) throw missing('NOTIFICATION_WRITER', 'CommonModule');
    return this.notificationWriter;
  }

  /**
   * Runs `fn` in a transaction bound to no organisation, acting as `userId` (see `NO_ORGANISATION`). Read-only: the
   * transaction is set `READ ONLY` before `fn` runs.
   */
  async withUserOnly<T>(userId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.scope.withTenant({ ...NO_ORGANISATION, userId }, async (trx) => {
      // Setting a transaction read only is allowed after its first statement (only the reverse is not).
      await sql`set transaction read only`.execute(trx);
      return fn(trx);
    });
  }

  /**
   * Runs `fn` in a writable transaction bound to no organisation, acting as `userId`: for a platform operator
   * without a current organisation, whose changes touch only tables without organisation scope (an MFA reset).
   */
  async withoutOrganisation<T>(userId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.scope.withTenant({ ...NO_ORGANISATION, userId }, fn);
  }
}

