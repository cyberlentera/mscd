// `audit.verify-chain` (E.2, F.11, D-33): anchors of every chain signed with `audit-anchor.key`, written to the log,
// the vault (gateway `/v1/anchors`) and `platform.audit_anchor`; anchors verify offline with `audit-anchor.pub`; a
// second run adds nothing; a chain rewritten by a superuser with triggers disabled and hashes recomputed still
// passes the hash check but no longer matches its last anchor, and is reported broken and not anchored again.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter } from '../../../src/common/tokens';
import { anchorKeyId, signedAnchorOf, verifyAnchorRow, verifyAnchorSignature, type AnchorRow } from '../../../src/modules/audit/anchors';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { AuditVerifyChainJob, anchorObjectKey } from '../../../src/modules/jobs/audit-verify-chain.job';
import { MetricsService } from '../../../src/modules/platform/metrics';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, DEV_ANCHOR_PUB_FILE, type AdminClient, type JobsApp } from './helpers';

const PUB = readFileSync(DEV_ANCHOR_PUB_FILE, 'utf8');
const OFFLINE_KEYS = [{ keyId: anchorKeyId(PUB), publicKeyPem: PUB }];

describe('audit.verify-chain (F.11)', () => {
  const db = useTestDatabase('empty');
  let app: JobsApp;
  let admin: AdminClient;
  let tenant: { id: string; schemaName: string };

  const writeTenantEntries = async (count: number) => {
    const audit = app.moduleRef.get<AuditWriter>(AUDIT_WRITER);
    await app.moduleRef.get(TenantScope).withTenant({ orgId: tenant.id, schema: tenant.schemaName, userId: SYSTEM_USER_ID }, async (trx) => {
      for (let i = 0; i < count; i += 1) {
        await audit.record(trx, { action: 'register.updated', actor: { userId: SYSTEM_USER_ID, kind: 'system' }, entityType: 'risk', entityCode: `R-${i}`, after: { n: i } });
      }
    });
  };
  const anchors = async () =>
    (await admin.query<AnchorRow & { exported_to: string[] }>(`SELECT chain, seq, row_hash, payload, signature, key_id, exported_to FROM platform.audit_anchor ORDER BY anchored_at, chain`)).rows;
  const gauge = async () => (await app.moduleRef.get(MetricsService).registry.getSingleMetricAsString('mscd_audit_chain_broken'));

  beforeAll(async () => {
    const created = await createTenant(db, 'chain_a');
    tenant = { id: created.id, schemaName: created.schemaName };
    admin = await adminClient(db);
    app = await createJobsApp(db);
    await writeTenantEntries(3);
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('anchors the head of every chain three ways, and the anchors verify offline with audit-anchor.pub', async () => {
    await app.run('audit.verify-chain', { orgId: null, payload: {} });
    expect(app.queue.failed('audit.verify-chain')).toEqual([]);
    const rows = await anchors();
    expect(rows.map((r) => r.chain).sort()).toEqual(['org_chain_a.audit_trail', 'platform.audit_log']);
    for (const row of rows) {
      expect(row.key_id).toBe('0abdc91769bacddd');
      expect(row.exported_to).toEqual(['log', 'vault', 'database']);
      expect(verifyAnchorRow(row, OFFLINE_KEYS)).toBe(true);
      const signed = signedAnchorOf(row)!;
      expect(verifyAnchorSignature(signed, OFFLINE_KEYS)).toBe(true);
      expect(verifyAnchorSignature({ ...signed, seq: signed.seq + 1 }, OFFLINE_KEYS)).toBe(false);
    }
    const tenantAnchor = rows.find((r) => r.chain === 'org_chain_a.audit_trail')!;
    expect(Number(tenantAnchor.seq)).toBe(3);
    expect(app.gateway.calls).toHaveLength(2);
    for (const call of app.gateway.calls) {
      const body = call.body as { tenant: null; objectKey: string; body: { chain: string; seq: number; anchoredAt: string } };
      expect(call.path).toBe('/anchors');
      expect(body.tenant).toBeNull();
      expect(body.objectKey).toBe(anchorObjectKey(body.body.chain, body.body.anchoredAt, body.body.seq));
      expect(body.objectKey).toMatch(/^audit-anchors\/(platform\.audit_log|org_chain_a\.audit_trail)\/\d{4}-\d{2}-\d{2}-\d+\.json$/);
    }
    const verifier = app.moduleRef.get(AuditChainVerifier);
    expect(await verifier.verifyTenant({ orgId: tenant.id, schema: tenant.schemaName })).toMatchObject({ firstBrokenSeq: null, anchorOk: true, checked: 3 });
    expect(await gauge()).toMatch(/mscd_audit_chain_broken\{chain="org_chain_a\.audit_trail"[^}]*\} 0/);
  });

  it('adds no anchor when no chain changed, and anchors only the chain that grew', async () => {
    await app.run('audit.verify-chain', { orgId: null, payload: {} });
    expect(await anchors()).toHaveLength(2);
    await writeTenantEntries(2);
    const outcomes = await app.moduleRef.get(AuditVerifyChainJob).run();
    expect(outcomes.map((o) => [o.chain, o.skipped ?? 'anchored'])).toEqual([
      ['platform.audit_log', 'unchanged'],
      ['org_chain_a.audit_trail', 'anchored'],
    ]);
    const rows = await anchors();
    expect(rows).toHaveLength(3);
    expect(Number(rows.at(-1)!.seq)).toBe(5);
  });

  it('keeps the database anchor when the vault cannot be reached', async () => {
    await writeTenantEntries(1);
    app.gateway.fail = true;
    try {
      const outcomes = await app.moduleRef.get(AuditVerifyChainJob).run();
      expect(outcomes.find((o) => o.chain === 'org_chain_a.audit_trail')?.exportedTo).toEqual(['log', 'database']);
    } finally {
      app.gateway.fail = false;
    }
  });

  it('detects a chain rewritten with triggers disabled and hashes recomputed, and does not anchor it', async () => {
    const schema = tenant.schemaName;
    await admin.query('BEGIN');
    await admin.query(`ALTER TABLE ${schema}.audit_trail DISABLE TRIGGER ALL`);
    await admin.query(`UPDATE ${schema}.audit_trail SET after_data = '{"n": 999}'::jsonb WHERE seq = 2`);
    await admin.query(`
      DO $$
      DECLARE r record; prev bytea := '\\x'::bytea; h bytea;
      BEGIN
        FOR r IN SELECT * FROM ${schema}.audit_trail ORDER BY seq LOOP
          h := sha256(prev || convert_to(platform.audit_canonical_text(r.seq, r.id, r.occurred_at, r.organization_id,
                 r.management_system_id, r.actor_user_id, r.actor_kind, r.action, r.entity_type, r.entity_id, r.entity_code,
                 r.before_data, r.after_data, r.edition, r.request_id, r.source_ip, r.user_agent), 'UTF8'));
          UPDATE ${schema}.audit_trail SET prev_hash = prev, row_hash = h WHERE seq = r.seq;
          prev := h;
        END LOOP;
      END $$`);
    await admin.query(`ALTER TABLE ${schema}.audit_trail ENABLE TRIGGER ALL`);
    await admin.query('COMMIT');

    const verifier = app.moduleRef.get(AuditChainVerifier);
    const check = await verifier.verifyTenant({ orgId: tenant.id, schema });
    expect(check.firstBrokenSeq).toBeNull(); // the hash chain itself is consistent again
    expect(check.anchorOk).toBe(false); // but it no longer matches the signed anchor

    const before = (await anchors()).length;
    const outcomes = await app.moduleRef.get(AuditVerifyChainJob).run();
    const outcome = outcomes.find((o) => o.chain === `${schema}.audit_trail`)!;
    expect(outcome).toMatchObject({ broken: true, anchorOk: false, skipped: 'broken', anchored: null });
    expect(outcomes.find((o) => o.chain === 'platform.audit_log')).toMatchObject({ broken: false });
    expect(await anchors()).toHaveLength(before);
    expect(await gauge()).toMatch(/mscd_audit_chain_broken\{chain="org_chain_a\.audit_trail"[^}]*\} 1/);
    expect(await gauge()).toMatch(/mscd_audit_chain_broken\{chain="platform\.audit_log"[^}]*\} 0/);
  });
});
