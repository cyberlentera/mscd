// Audit chain verification (build plan F.11): the verification query over `platform.audit_log` and a tenant
// `audit_trail`, and the comparison of each chain with its newest signed anchor (detects the removal of the newest
// rows and a rewrite by the database owner, who cannot forge an anchor signature). Used by
// `GET /admin/audit-trail/verify` and the `audit.verify-chain` job (WP-22).
import { Inject, Injectable } from '@nestjs/common';
import type { AuditChainVerifyResult } from '@mscd/shared';
import { sql } from 'kysely';
import { SYSTEM_USER_ID, type Trx } from '../../common/tokens';
import type { TrustedKey } from '../../generated/build-info';
import { TenantScope } from '../tenancy/tenant-scope';
import { verifyAnchorRow, type AnchorRow } from './anchors';

/** Injection token of the anchor public keys the verifier trusts (default: the compiled `anchor` keys, D-16). */
export const AUDIT_ANCHOR_KEYS = Symbol.for('mscd.auditAnchorKeys');
export type AnchorKeys = readonly Pick<TrustedKey, 'keyId' | 'publicKeyPem'>[];

export const PLATFORM_CHAIN = 'platform.audit_log';

/** Chain name of a tenant schema's trail (`org_ndt.audit_trail`). */
export function tenantChainName(schema: string): string {
  return `${schema}.audit_trail`;
}

export interface ChainCheck {
  chain: string;
  checked: number;
  firstBrokenSeq: number | null;
  /** Newest row of the chain. */
  head: { seq: number; rowHash: string } | null;
}

/** The F.11 verification query over one chain table, in the transaction's scope. */
async function runVerification(trx: Trx, table: 'tenant' | 'platform'): Promise<{ checked: number; firstBrokenSeq: number | null; head: ChainCheck['head'] }> {
  const from = table === 'tenant' ? sql`audit_trail` : sql`platform.audit_log`;
  const { rows } = await sql<{ checked: string; first_broken_seq: string | null; head_seq: string | null; head_hash: Buffer | null }>`
    WITH c AS (
      SELECT seq, prev_hash, row_hash,
             lag(row_hash) OVER (ORDER BY seq) AS expected_prev,
             lag(seq) OVER (ORDER BY seq) AS prev_seq,
             sha256(prev_hash || convert_to(platform.audit_canonical_text(seq, id, occurred_at, organization_id,
               management_system_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code,
               before_data, after_data, edition, request_id, source_ip, user_agent), 'UTF8')) AS expected_hash
      FROM ${from})
    SELECT count(*) AS checked,
           min(seq) FILTER (WHERE row_hash <> expected_hash
                               OR prev_hash <> coalesce(expected_prev, '\\x'::bytea)
                               OR seq <> coalesce(prev_seq, 0) + 1) AS first_broken_seq,
           max(seq) AS head_seq,
           (SELECT row_hash FROM c ORDER BY seq DESC LIMIT 1) AS head_hash
    FROM c`.execute(trx);
  const row = rows[0]!;
  return {
    checked: Number(row.checked),
    firstBrokenSeq: row.first_broken_seq === null ? null : Number(row.first_broken_seq),
    head: row.head_seq === null || !row.head_hash ? null : { seq: Number(row.head_seq), rowHash: row.head_hash.toString('hex') },
  };
}

@Injectable()
export class AuditChainVerifier {
  constructor(
    private readonly scope: TenantScope,
    @Inject(AUDIT_ANCHOR_KEYS) private readonly anchorKeys: AnchorKeys,
  ) {}

  /** Verifies the platform chain (with platform scope: every row of `platform.audit_log`). */
  async verifyPlatform(): Promise<AuditChainVerifyResult> {
    return this.scope.withPlatform(async (trx) => {
      const check = await runVerification(trx, 'platform');
      return this.withAnchor(trx, PLATFORM_CHAIN, check, (seq) =>
        trx.selectFrom('platform.audit_log').select('row_hash').where('seq', '=', String(seq)).executeTakeFirst(),
      );
    }, { scope: 'job' });
  }

  /** Verifies the tenant chain of an organisation. */
  async verifyTenant(org: { orgId: string; schema: string }): Promise<AuditChainVerifyResult> {
    return this.scope.withTenant({ orgId: org.orgId, schema: org.schema, userId: SYSTEM_USER_ID }, async (trx) => {
      const check = await runVerification(trx, 'tenant');
      return this.withAnchor(trx, tenantChainName(org.schema), check, (seq) =>
        trx.selectFrom('audit_trail').select('row_hash').where('seq', '=', String(seq)).executeTakeFirst(),
      );
    });
  }

  /** Both chains an organisation's administrators can verify: the tenant chain and the platform chain. */
  async verifyForOrganisation(org: { orgId: string; schema: string }): Promise<AuditChainVerifyResult[]> {
    return [await this.verifyTenant(org), await this.verifyPlatform()];
  }

  /**
   * `anchorOk`: true when the chain has no anchor yet, or when its newest anchor has a valid signature by a trusted
   * key and the stored row of that `seq` still has the anchored hash (F.11).
   */
  private async withAnchor(
    trx: Trx,
    chain: string,
    check: Omit<ChainCheck, 'chain'>,
    rowAt: (seq: number) => Promise<{ row_hash: Buffer } | undefined>,
  ): Promise<AuditChainVerifyResult> {
    const anchor = await trx
      .selectFrom('platform.audit_anchor')
      .select(['chain', 'seq', 'row_hash', 'payload', 'signature', 'key_id'])
      .where('chain', '=', chain)
      .orderBy('anchored_at', 'desc')
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    let anchorOk = true;
    if (anchor) {
      const row = await rowAt(Number(anchor.seq));
      anchorOk =
        verifyAnchorRow(anchor as AnchorRow, this.anchorKeys) && row !== undefined && Buffer.compare(row.row_hash, anchor.row_hash) === 0;
    }
    return { chain, checked: check.checked, firstBrokenSeq: check.firstBrokenSeq, anchorOk };
  }
}
