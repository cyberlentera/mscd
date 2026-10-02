// Tenant cleanup steps of `cleanup.expired` (E.2): other modules register a step at start (for example the auditor
// access module closes expired guest grants, F.14 step 5), and the hourly job runs every registered step inside a
// transaction of each active organisation as the system user, so expiries take effect on time without the jobs
// module depending on those modules.
import { Injectable } from '@nestjs/common';
import type { Trx } from '../../common/tokens';

export interface TenantCleanupStep {
  /** Name in the job's result and log lines (for example `auditorGrantsExpired`). */
  name: string;
  /** Runs in the organisation's tenant transaction; returns the number of records it ended or changed. */
  run(trx: Trx, orgId: string, now: Date): Promise<number>;
}

@Injectable()
export class TenantCleanupRegistry {
  private readonly steps = new Map<string, TenantCleanupStep>();

  /** Registers a step once per name (a second registration of a name replaces the first). */
  register(step: TenantCleanupStep): void {
    this.steps.set(step.name, step);
  }

  /** Registered steps in registration order. */
  list(): TenantCleanupStep[] {
    return [...this.steps.values()];
  }
}
