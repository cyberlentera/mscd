// The services of other modules the identity module works with. They are injected as optional dependencies: the
// api, the worker and the command line load every one of them, while request-pipeline test applications without a
// database load the identity module alone, where the session resolver then authenticates nobody (as the WP-08
// default did). A missing dependency is reported when it is first used.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Clock } from '../../common/clock';
import {
  AUDIT_WRITER,
  LICENCE_GATE,
  ME_ASSEMBLER,
  type AuditWriter,
  type LicenceGate,
  type MeAssembler,
} from '../../common/tokens';
import { SecretBox } from '../keys/secret-box';
import { RateLimitBucketStore } from '../tenancy/rate-limit-store';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';

function missing(what: string, module: string): Error {
  return new Error(`The identity module needs ${what} (${module}) in this application`);
}

@Injectable()
export class IdentityInfra {
  constructor(
    @Optional() private readonly tenantScope?: TenantScope,
    @Optional() private readonly tenantResolver?: TenantResolver,
    @Optional() private readonly clockService?: Clock,
    @Optional() private readonly secretBox?: SecretBox,
    @Optional() private readonly buckets?: RateLimitBucketStore,
    @Optional() @Inject(AUDIT_WRITER) private readonly auditWriter?: AuditWriter,
    @Optional() @Inject(LICENCE_GATE) private readonly licenceGate?: LicenceGate,
    @Optional() @Inject(ME_ASSEMBLER) private readonly meAssembler?: MeAssembler,
  ) {}

  /** True when the database services are present (every real run mode). */
  get available(): boolean {
    return Boolean(this.tenantScope && this.tenantResolver && this.clockService);
  }

  get scope(): TenantScope {
    if (!this.tenantScope) throw missing('TenantScope', 'TenancyModule');
    return this.tenantScope;
  }

  get tenants(): TenantResolver {
    if (!this.tenantResolver) throw missing('TenantResolver', 'TenancyModule');
    return this.tenantResolver;
  }

  get clock(): Clock {
    if (!this.clockService) throw missing('Clock', 'CommonModule');
    return this.clockService;
  }

  get secrets(): SecretBox {
    if (!this.secretBox) throw missing('SecretBox', 'KeysModule');
    return this.secretBox;
  }

  get rateBuckets(): RateLimitBucketStore {
    if (!this.buckets) throw missing('RateLimitBucketStore', 'TenancyModule');
    return this.buckets;
  }

  get audit(): AuditWriter {
    if (!this.auditWriter) throw missing('AUDIT_WRITER', 'AuditModule');
    return this.auditWriter;
  }

  get licence(): LicenceGate {
    if (!this.licenceGate) throw missing('LICENCE_GATE', 'LicenseModule');
    return this.licenceGate;
  }

  get me(): MeAssembler {
    if (!this.meAssembler) throw missing('ME_ASSEMBLER', 'AuthzModule');
    return this.meAssembler;
  }
}
