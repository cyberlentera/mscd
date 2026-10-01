// Audit trail writer (build plan F.11). Entries are written in the same transaction as the change they record:
// platform-level actions (`auth.*`, `identity.*`, `idp.*`, `user.*`, `membership.*`, `tenant.*`, `licence.*`,
// `pack.*`, `ops.*`) go to `platform.audit_log` with the organisation id when there is one, every other action to
// the tenant `audit_trail`. Both tables are hash chains filled by the `chain_hash` trigger; the writer never sets
// `seq`, `prev_hash` or `row_hash`. Only changed fields are kept, and secrets are redacted first.
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { isPlatformAuditAction } from '@mscd/shared';
import { sql } from 'kysely';
import { redactAuditData } from '../../common/audit-redaction';
import { currentRequestContext } from '../../common/request-context';
import {
  SYSTEM_USER_ID,
  type AuditEntryInput,
  type AuditWriter,
  type RecordedAuditEntry,
  type Trx,
} from '../../common/tokens';
import { TenantScope } from '../tenancy/tenant-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cut(value: string | null | undefined, length: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value.length > length ? value.slice(0, length) : value;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

/** Keeps the keys whose values differ (F.11 "changed fields only"); a key present on one side only counts. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const outBefore: Record<string, unknown> = {};
  const outAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (isDeepStrictEqual(a, b)) continue;
    if (key in before) outBefore[key] = a === undefined ? null : a;
    if (key in after) outAfter[key] = b === undefined ? null : b;
  }
  return { before: outBefore, after: outAfter };
}

/** The before and after documents of an entry: changed fields only, secrets redacted, JSON text for the driver. */
function dataOf(entry: AuditEntryInput): { before: string | null; after: string | null } {
  let before = entry.before ?? null;
  let after = entry.after ?? null;
  if (before && after) ({ before, after } = changedFields(before, after));
  return {
    before: before ? JSON.stringify(redactAuditData(before)) : null,
    after: after ? JSON.stringify(redactAuditData(after)) : null,
  };
}

@Injectable()
export class ChainedAuditWriter implements AuditWriter {
  constructor(private readonly scope: TenantScope) {}

  async record(trx: Trx, entry: AuditEntryInput): Promise<RecordedAuditEntry> {
    const context = currentRequestContext();
    const actor = entry.actor ?? (context?.userId ? { userId: context.userId, kind: context.actorKind ?? 'user' } : { userId: SYSTEM_USER_ID, kind: 'system' as const });
    const ip = entry.sourceIp !== undefined ? entry.sourceIp : (context?.ip ?? null);
    const { before, after } = dataOf(entry);
    const common = {
      management_system_id: uuidOrNull(entry.msId),
      actor_user_id: uuidOrNull(actor.userId),
      actor_kind: actor.kind,
      action: entry.action,
      entity_type: cut(entry.entityType, 40),
      entity_id: uuidOrNull(entry.entityId),
      entity_code: cut(entry.entityCode, 80),
      before_data: before,
      after_data: after,
      request_id: cut(entry.requestId !== undefined ? entry.requestId : (context?.requestId ?? null), 64),
      source_ip: ip && isIP(ip) ? ip : null,
      user_agent: cut(entry.userAgent !== undefined ? entry.userAgent : (context?.userAgent ?? null), 1000),
    };

    if (isPlatformAuditAction(entry.action)) {
      const organizationId = entry.organizationId !== undefined ? entry.organizationId : (context?.orgId ?? null);
      const row = await trx
        .insertInto('platform.audit_log')
        .values({ ...common, organization_id: uuidOrNull(organizationId), edition: cut(entry.edition ?? null, 40) })
        .returning(['id', 'seq'])
        .executeTakeFirstOrThrow();
      return { chain: 'platform', id: row.id, seq: String(row.seq) };
    }

    const edition = entry.edition !== undefined ? entry.edition : await this.editionOf(trx, common.management_system_id);
    const row = await trx
      .insertInto('audit_trail')
      .values({ ...common, edition: cut(edition, 40) })
      .returning(['id', 'seq'])
      .executeTakeFirstOrThrow();
    return { chain: 'tenant', id: row.id, seq: String(row.seq) };
  }

  async recordDetached(entry: AuditEntryInput, target?: { orgId: string; schema: string } | null): Promise<RecordedAuditEntry> {
    const context = currentRequestContext();
    if (isPlatformAuditAction(entry.action)) {
      const organizationId = entry.organizationId !== undefined ? entry.organizationId : (target?.orgId ?? context?.orgId ?? null);
      const kind = /^(auth|identity)\./.test(entry.action) ? 'auth' : 'operator';
      return this.scope.withPlatform((trx) => this.record(trx, { ...entry, organizationId }), {
        scope: kind,
        orgId: organizationId,
        userId: context?.userId ?? null,
      });
    }
    const orgId = target?.orgId ?? context?.orgId;
    const schema = target?.schema ?? context?.schema;
    if (!orgId || !schema) throw new Error(`Audit entry ${entry.action} needs an organisation`);
    return this.scope.withTenant({ orgId, schema, userId: uuidOrNull(context?.userId) ?? SYSTEM_USER_ID }, (trx) => this.record(trx, entry));
  }

  /** `<pack_id> <version>` of the system's active edition, and of the transition target when there is one. */
  private async editionOf(trx: Trx, msId: string | null): Promise<string | null> {
    if (!msId) return null;
    const { rows } = await sql<{ edition: string | null }>`
      select string_agg(fv.pack_id || ' ' || fv.pack_version, ', '
                        order by case when fv.id = ms.framework_version_id then 0 else 1 end) as edition
      from management_system ms
      join ref.framework_version fv on fv.id in (ms.framework_version_id, ms.transition_target_version_id)
      where ms.id = ${msId}`.execute(trx);
    return rows[0]?.edition ?? null;
  }
}
