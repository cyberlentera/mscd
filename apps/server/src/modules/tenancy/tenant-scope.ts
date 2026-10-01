// Tenant scoping per request (build plan D-03, F.10). Every tenant read and write runs in one transaction that sets
// `search_path` to the tenant schema and `ext`, and `app.org_id`, `app.user_id` and `app.request_id`, all
// transaction-local. `withPlatform` sets `app.platform_scope = 'on'` for the organisation-scoped platform tables
// (D-31); lint rules allow it only in the folders that may cross organisations.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { currentRequestId } from '../../common/request-context';
import type { Principal, TenantInfo, Trx } from '../../common/tokens';
import { SYSTEM_USER_ID } from '../../common/tokens';
import { discardTransactionHooks, openTransactionHooks, runAfterCommitHooks } from '../../common/transaction-hooks';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import type { DB } from '../../db/types';

/** C.4: tenant schemas are `org_<slug>`. */
export const TENANT_SCHEMA = /^org_[a-z0-9_]{1,59}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who acts in which organisation (F.10). */
export interface TenantContext {
  orgId: string;
  /** `org_<slug>`. */
  schema: string;
  /** Acting user; jobs use the system user (`SYSTEM_USER_ID`). */
  userId: string;
  /** Default: the current request id, else a new UUID. */
  requestId?: string;
}

/** Why platform scope is used (F.10): sign-in, platform operator, cross-tenant job, command line. */
export type PlatformScopeKind = 'auth' | 'operator' | 'job' | 'cli';

export interface PlatformScopeOptions {
  scope: PlatformScopeKind;
  /** Also sets `app.org_id` (for example to write an organisation's `platform.audit_log` row). */
  orgId?: string | null;
  userId?: string | null;
  requestId?: string;
}

/** The tenant context of a request's principal (its current organisation and user). */
export function tenantContextOf(principal: Principal, requestId?: string): TenantContext {
  if (!principal.org) throw new Error('The principal has no current organisation');
  return { orgId: principal.org.id, schema: principal.org.schema, userId: principal.user.id, requestId };
}

/** The tenant context of a job or command acting for an organisation as the system user. */
export function systemContextOf(org: Pick<TenantInfo, 'id' | 'schema'>, requestId?: string): TenantContext {
  return { orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID, requestId };
}

@Injectable()
export class TenantScope {
  private readonly logger = new Logger(TenantScope.name);

  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /** Runs `fn` in one transaction scoped to an organisation (F.10). */
  async withTenant<T>(ctx: TenantContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    if (!TENANT_SCHEMA.test(ctx.schema)) throw new Error('bad schema');
    if (!UUID.test(ctx.orgId) || !UUID.test(ctx.userId)) throw new Error('bad tenant context');
    const requestId = ctx.requestId ?? currentRequestId() ?? randomUUID();
    return this.transaction(async (trx) => {
      await sql`select set_config('search_path', ${`"${ctx.schema}", ext`}, true),
                       set_config('app.org_id', ${ctx.orgId}, true),
                       set_config('app.user_id', ${ctx.userId}, true),
                       set_config('app.request_id', ${requestId}, true)`.execute(trx);
      return fn(trx);
    });
  }

  /**
   * Runs `fn` in one transaction with platform scope (F.10, D-31): the organisation-scoped platform tables show
   * every row. Tenant tables stay invisible (no tenant schema, RLS on `app.org_id`).
   */
  async withPlatform<T>(fn: (trx: Trx) => Promise<T>, options: PlatformScopeOptions): Promise<T> {
    if (options.orgId && !UUID.test(options.orgId)) throw new Error('bad organisation id');
    if (options.userId && !UUID.test(options.userId)) throw new Error('bad user id');
    const requestId = options.requestId ?? currentRequestId() ?? randomUUID();
    return this.transaction(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true),
                       set_config('app.org_id', ${options.orgId ?? ''}, true),
                       set_config('app.user_id', ${options.userId ?? ''}, true),
                       set_config('app.request_id', ${requestId}, true)`.execute(trx);
      return fn(trx);
    });
  }

  /** A transaction with after-commit hooks (`src/common/transaction-hooks.ts`). */
  private async transaction<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    let opened: Transaction<DB> | undefined;
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        opened = trx;
        openTransactionHooks(trx);
        return fn(trx);
      });
      if (opened) {
        await runAfterCommitHooks(opened, (error) =>
          this.logger.error(`An after-commit hook failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      return result;
    } catch (error) {
      if (opened) discardTransactionHooks(opened);
      throw error;
    }
  }
}
