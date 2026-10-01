// `audit.verify-chain` (E.2, F.11, D-33): daily at 04:00 UTC. Verifies the platform chain and every tenant chain
// (hash chain and the newest signed anchor), sets the metric `mscd_audit_chain_broken` per chain, and anchors the
// head of every intact chain: the payload `{chain, seq, rowHash, anchoredAt, installationId}` is signed with the
// worker's Ed25519 key `audit-anchor.key` (never in the database) and leaves the database three ways: a structured
// log line `audit.anchor` for the customer's log platform, an object in the vault bucket through gateway
// `/v1/anchors`, and a `platform.audit_anchor` row. A chain whose head is already anchored gets no second anchor,
// and a broken chain is never anchored (an anchor would vouch for the rewritten rows).
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AuditChainVerifyResult } from '@mscd/shared';
import { Gauge } from 'prom-client';
import { sql } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { GATEWAY_CLIENT, SYSTEM_USER_ID, type GatewayClient } from '../../common/tokens';
import { anchorKeyId, signAnchor, type SignedAnchor } from '../audit/anchors';
import { AUDIT_ANCHOR_KEYS, AuditChainVerifier, PLATFORM_CHAIN, tenantChainName, type AnchorKeys } from '../audit/chain-verifier';
import { MetricsService } from '../platform/metrics';
import { TENANT_SCHEMA, TenantScope } from '../tenancy/tenant-scope';

/** Where the vault copy of an anchor goes (D.5 `/v1/anchors`, F.11): one object per chain, day and head. */
export function anchorObjectKey(chain: string, anchoredAt: string, seq: number): string {
  return `audit-anchors/${chain}/${anchoredAt.slice(0, 10)}-${seq}.json`;
}

export interface ChainOutcome {
  chain: string;
  checked: number;
  firstBrokenSeq: number | null;
  anchorOk: boolean;
  broken: boolean;
  /** The anchor written by this run, if any. */
  anchored: SignedAnchor | null;
  /** Where the anchor went (`log`, `vault`, `database`). */
  exportedTo: string[];
  /** Why no anchor was written (`empty`, `unchanged`, `broken`, `no-key`). */
  skipped?: string;
}

/** The anchor signing key of `audit.anchor_key_file` (worker only, I.3). */
export interface AnchorSigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

/** Reads the Ed25519 private key of `audit.anchor_key_file`; null when the profile names none. */
export function loadAnchorSigningKey(config: MscdConfig): AnchorSigningKey | null {
  const file = config.profile.audit.anchor_key_file;
  if (!file) return null;
  const privateKey = createPrivateKey(config.readSecretFile(file, 'audit.anchor_key_file'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('audit.anchor_key_file must hold an Ed25519 private key');
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, keyId: anchorKeyId(publicKey) };
}

@Injectable()
@JobHandler('audit.verify-chain', { concurrency: 1, scope: 'installation' })
export class AuditVerifyChainJob implements JobHandlerInstance<'audit.verify-chain'> {
  private readonly logger = new Logger('audit.verify-chain');
  private readonly brokenGauge: Gauge<'chain'>;
  private key?: AnchorSigningKey | null;

  constructor(
    private readonly verifier: AuditChainVerifier,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly config: MscdConfig,
    @Inject(AUDIT_ANCHOR_KEYS) private readonly trustedKeys: AnchorKeys,
    metrics: MetricsService,
    @Optional() @Inject(GATEWAY_CLIENT) private readonly gateway?: GatewayClient,
  ) {
    const existing = metrics.registry.getSingleMetric('mscd_audit_chain_broken');
    this.brokenGauge =
      (existing as Gauge<'chain'> | undefined) ??
      new Gauge({
        name: 'mscd_audit_chain_broken',
        help: '1 when the last audit.verify-chain run found the chain broken or not matching its newest signed anchor, else 0',
        labelNames: ['chain'],
        registers: [metrics.registry],
      });
  }

  async handle(job: JobRun<'audit.verify-chain'>): Promise<void> {
    const outcomes = await this.run(job.env.requestId);
    const broken = outcomes.filter((o) => o.broken).map((o) => o.chain);
    this.logger.log(
      { jobId: job.id, attempt: job.attempt, chains: outcomes.length, broken, anchored: outcomes.filter((o) => o.anchored).length },
      'audit.verify-chain done',
    );
    if (outcomes.some((o) => o.skipped === 'no-key')) {
      throw new Error('audit.verify-chain: no anchor key (audit.anchor_key_file); the chains were verified but not anchored');
    }
  }

  /** Verifies and anchors every chain; returns one outcome per chain (platform first). */
  async run(requestId?: string): Promise<ChainOutcome[]> {
    const installationId = await this.scope.withPlatform(
      async (trx) => (await trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow()).id,
      { scope: 'job', requestId },
    );
    const orgs = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization')
          .select(['id', 'schema_name'])
          .where('deleted_at', 'is', null)
          .where(sql<boolean>`to_regnamespace(schema_name) IS NOT NULL`)
          .orderBy('position')
          .orderBy('slug')
          .execute(),
      { scope: 'job', requestId },
    );
    const outcomes: ChainOutcome[] = [];
    outcomes.push(await this.verifyAndAnchor(PLATFORM_CHAIN, null, () => this.verifier.verifyPlatform(), installationId, requestId));
    for (const org of orgs) {
      if (!TENANT_SCHEMA.test(org.schema_name)) continue;
      const chain = tenantChainName(org.schema_name);
      try {
        const tenant = { orgId: org.id, schema: org.schema_name };
        outcomes.push(await this.verifyAndAnchor(chain, tenant, () => this.verifier.verifyTenant(tenant), installationId, requestId));
      } catch (error) {
        this.logger.error({ chain, orgId: org.id, error: (error as Error).message }, 'audit chain verification failed');
        this.brokenGauge.set({ chain }, 1);
        outcomes.push({ chain, checked: 0, firstBrokenSeq: null, anchorOk: false, broken: true, anchored: null, exportedTo: [], skipped: 'error' });
      }
    }
    return outcomes;
  }

  private signingKey(): AnchorSigningKey | null {
    if (this.key === undefined) {
      try {
        this.key = loadAnchorSigningKey(this.config);
      } catch (error) {
        this.logger.error(`The audit anchor key cannot be read: ${(error as Error).message}`);
        this.key = null;
      }
      if (this.key && !this.trustedKeys.some((k) => k.keyId === this.key!.keyId)) {
        this.logger.warn(`The audit anchor key ${this.key.keyId} is not among the anchor keys compiled into this build; its anchors will not verify`);
      }
    }
    return this.key;
  }

  private async verifyAndAnchor(
    chain: string,
    tenant: { orgId: string; schema: string } | null,
    verify: () => Promise<AuditChainVerifyResult>,
    installationId: string,
    requestId?: string,
  ): Promise<ChainOutcome> {
    const result = await verify();
    const firstBrokenSeq = result.firstBrokenSeq ?? null;
    const broken = firstBrokenSeq !== null || !result.anchorOk;
    this.brokenGauge.set({ chain }, broken ? 1 : 0);
    const outcome: ChainOutcome = { chain, checked: result.checked, firstBrokenSeq, anchorOk: result.anchorOk, broken, anchored: null, exportedTo: [] };
    if (broken) {
      this.logger.error({ event: 'audit.chain_broken', chain, firstBrokenSeq, anchorOk: result.anchorOk }, 'audit chain broken');
      return { ...outcome, skipped: 'broken' };
    }
    // The anchored head is the newest row the verification covered (seq 1 to `checked`, contiguous when intact).
    const head = result.checked === 0 ? null : await this.head(chain, tenant, result.checked, requestId);
    if (!head) return { ...outcome, skipped: 'empty' };
    if (head.anchoredSeq === head.seq && head.anchoredHash === head.rowHash) return { ...outcome, skipped: 'unchanged' };
    const key = this.signingKey();
    if (!key) return { ...outcome, skipped: 'no-key' };

    const anchoredAt = this.clock.now().toISOString();
    const signed = signAnchor({ chain, seq: head.seq, rowHash: head.rowHash, anchoredAt, installationId }, key.privateKey, key.publicKey);
    const exportedTo: string[] = [];
    // (1) One JSON line for the customer's log platform (F.11).
    this.logger.log({ event: 'audit.anchor', ...signed }, 'audit.anchor');
    exportedTo.push('log');
    // (2) The vault bucket, through the gateway (worker certificate only).
    if (this.gateway) {
      try {
        await this.gateway.post('/anchors', { tenant: null, objectKey: anchorObjectKey(chain, anchoredAt, head.seq), body: signed }, { requestId });
        exportedTo.push('vault');
      } catch (error) {
        this.logger.error({ chain, error: (error as Error).message }, 'audit anchor not written to the vault');
      }
    }
    // (3) The database row the verifier compares with.
    exportedTo.push('database');
    await this.scope.withPlatform(
      (trx) =>
        trx
          .insertInto('platform.audit_anchor')
          .values({
            chain,
            seq: String(head.seq),
            row_hash: Buffer.from(head.rowHash, 'hex'),
            anchored_at: new Date(anchoredAt),
            payload: JSON.stringify({ chain, seq: head.seq, rowHash: head.rowHash, anchoredAt, installationId }),
            signature: signed.signature,
            key_id: signed.keyId,
            exported_to: exportedTo,
          })
          .execute(),
      { scope: 'job', requestId },
    );
    return { ...outcome, anchored: signed, exportedTo };
  }

  /** Row `seq` of a chain (the verified head) and the newest anchor of the chain. */
  private async head(
    chain: string,
    tenant: { orgId: string; schema: string } | null,
    seq: number,
    requestId?: string,
  ): Promise<{ seq: number; rowHash: string; anchoredSeq: number | null; anchoredHash: string | null } | null> {
    const row = tenant
      ? await this.scope.withTenant({ orgId: tenant.orgId, schema: tenant.schema, userId: SYSTEM_USER_ID, requestId }, (trx) =>
          trx.selectFrom('audit_trail').select(['seq', 'row_hash']).where('seq', '=', String(seq)).executeTakeFirst(),
        )
      : await this.scope.withPlatform(
          (trx) => trx.selectFrom('platform.audit_log').select(['seq', 'row_hash']).where('seq', '=', String(seq)).executeTakeFirst(),
          { scope: 'job', requestId },
        );
    if (!row) return null;
    return this.scope.withPlatform(
      async (trx) => {
        const anchor = await trx
          .selectFrom('platform.audit_anchor')
          .select(['seq', 'row_hash'])
          .where('chain', '=', chain)
          .orderBy('anchored_at', 'desc')
          .orderBy('seq', 'desc')
          .limit(1)
          .executeTakeFirst();
        return {
          seq: Number(row.seq),
          rowHash: row.row_hash.toString('hex'),
          anchoredSeq: anchor ? Number(anchor.seq) : null,
          anchoredHash: anchor ? anchor.row_hash.toString('hex') : null,
        };
      },
      { scope: 'job', requestId },
    );
  }
}
