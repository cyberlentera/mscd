// F.11 audit trail: writer (both chains, changed fields, redaction, edition), chain verification with anchors, and
// the four /admin/audit-trail routes (D.3) with full and metadata views, the CSV export (F.13, F.15) and isolation.
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonicalJson } from '@mscd/shared';
import { parse } from 'csv-parse/sync';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_WRITER, type AuditWriter } from '../../../src/common/tokens';
import { createKysely } from '../../../src/db/kysely';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { anchorKeyId, signAnchor } from '../../../src/modules/audit/anchors';
import { AUDIT_ANCHOR_KEYS, AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { FAKE_PRINCIPAL_HEADER, type FakeIdentity } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, addUser, inScope } from '../db/helpers';
import { createIntApp, infoOf, type IntApp } from './helpers';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';
const anchorKey = generateKeyPairSync('ed25519');
const TRUSTED = [{ keyId: anchorKeyId(anchorKey.publicKey), publicKeyPem: anchorKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const INSTALLATION = '00000000-0000-4000-8000-0000000000f1';

describe('audit trail (F.11, D.3)', () => {
  const db = useTestDatabase('empty');
  let ndt: CreatedTenant;
  let bsd: CreatedTenant;
  let isms: string;
  let users: Record<string, string>;
  let ctx: IntApp;
  let writer: AuditWriter;
  let scope: TenantScope;

  const as = (who: string) => ({ [FAKE_PRINCIPAL_HEADER]: who });

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt');
    bsd = await createTenant(db, 'bsd');
    const fw = await addFramework(db.migrator);
    isms = await addManagementSystem(db.migrator, ndt, fw.versionId, 'isms');
    await addManagementSystem(db.migrator, ndt, fw.versionId, 'qms');
    users = {
      rina: await addUser(db.migrator, 'rina', [ndt.id]),
      ta: await addUser(db.migrator, 'tenant.admin', [ndt.id]),
      budi: await addUser(db.migrator, 'budi', [bsd.id]),
    };
    const identities: Record<string, FakeIdentity> = {
      rina: { user: { id: users.rina!, handle: 'rina', displayName: 'Rina Kusuma' }, org: infoOf(ndt), rolesByMs: { isms: ['ms_manager'] }, knownMs: ['isms', 'qms'] },
      ta: { user: { id: users.ta!, handle: 'tenant.admin' }, org: infoOf(ndt), orgRoles: ['tenant_admin'], knownMs: ['isms', 'qms'] },
      budi: { user: { id: users.budi!, handle: 'budi' }, org: infoOf(bsd), orgRoles: ['tenant_admin'], rolesByMs: { isms: ['ms_manager'] } },
    };
    ctx = await createIntApp(db, {}, { auth: { identities }, overrides: (b) => b.overrideProvider(AUDIT_ANCHOR_KEYS).useValue(TRUSTED) });
    writer = ctx.moduleRef.get<AuditWriter>(AUDIT_WRITER);
    scope = ctx.moduleRef.get(TenantScope);

    // Fixture entries: two in isms (one with a formula in a title), one without a system, one platform entry of ndt and one of bsd.
    await scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: users.rina! }, async (trx) => {
      await writer.record(trx, {
        action: 'register.updated',
        actor: { userId: users.rina!, kind: 'user' },
        msId: isms,
        entityType: 'risk',
        entityId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b',
        entityCode: 'R-031',
        before: { title: 'Old', owner: 'rina', secret_sealed: 'v1.x' },
        after: { title: '=HYPERLINK("http://x")', owner: 'rina', secret_sealed: 'v1.y' },
        requestId: 'req-audit-0001',
        sourceIp: '203.0.113.9',
        userAgent: 'test-agent',
      });
      await writer.record(trx, { action: 'document.created', msId: isms, entityType: 'document', entityCode: '@SUM(1)', after: { title: 'Policy', password: 'p' } });
      await writer.record(trx, { action: 'record.deleted', entityType: 'risk', entityCode: 'R-099', edition: 'X 1.0.0' });
      await writer.record(trx, { action: 'auth.login', actor: { userId: users.rina!, kind: 'user' }, after: { method: 'local' } });
    });
    await writer.recordDetached({ action: 'auth.login', organizationId: bsd.id, actor: { userId: users.budi!, kind: 'user' } });
    await writer.recordDetached({ action: 'register.created', entityType: 'risk', entityCode: 'R-B1' }, { orgId: bsd.id, schema: bsd.schemaName });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('writes tenant entries with changed fields only, secrets redacted and the active edition', async () => {
    const rows = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
      trx.selectFrom('audit_trail').selectAll().orderBy('seq').execute(),
    );
    expect(rows.map((r) => [Number(r.seq), r.action])).toEqual([
      [1, 'register.updated'],
      [2, 'document.created'],
      [3, 'record.deleted'],
    ]);
    const first = rows[0]!;
    expect(first.before_data).toEqual({ title: 'Old', secret_sealed: '[redacted]' });
    expect(first.after_data).toEqual({ title: '=HYPERLINK("http://x")', secret_sealed: '[redacted]' });
    expect(first).toMatchObject({
      actor_user_id: users.rina,
      actor_kind: 'user',
      management_system_id: isms,
      entity_code: 'R-031',
      edition: 'TEST-2024 1.0.0',
      request_id: 'req-audit-0001',
      source_ip: '203.0.113.9',
      user_agent: 'test-agent',
      organization_id: ndt.id,
    });
    expect(rows[1]!.after_data).toEqual({ title: 'Policy', password: '[redacted]' });
    expect(rows[1]).toMatchObject({ actor_user_id: SYSTEM_USER, actor_kind: 'system' });
    expect(rows[2]).toMatchObject({ edition: 'X 1.0.0', management_system_id: null });
  });

  it('writes platform-level actions to platform.audit_log with the organisation', async () => {
    const rows = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select(['action', 'organization_id', 'actor_user_id']).where('action', '=', 'auth.login').orderBy('seq').execute(),
    );
    expect(rows).toEqual([
      { action: 'auth.login', organization_id: ndt.id, actor_user_id: users.rina },
      { action: 'auth.login', organization_id: bsd.id, actor_user_id: users.budi },
    ]);
  });

  it('verifies both chains and compares the newest anchor (F.11)', async () => {
    const verifier = ctx.moduleRef.get(AuditChainVerifier);
    const [tenant, platform] = await verifier.verifyForOrganisation({ orgId: ndt.id, schema: ndt.schemaName });
    expect(tenant).toEqual({ chain: 'org_ndt.audit_trail', checked: 3, firstBrokenSeq: null, anchorOk: true });
    expect(platform).toMatchObject({ chain: 'platform.audit_log', firstBrokenSeq: null, anchorOk: true });
    expect(platform!.checked).toBeGreaterThanOrEqual(4);

    const head = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
      trx.selectFrom('audit_trail').select(['seq', 'row_hash']).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow(),
    );
    const signed = signAnchor(
      { chain: 'org_ndt.audit_trail', seq: Number(head.seq), rowHash: head.row_hash.toString('hex'), anchoredAt: '2026-09-29T04:00:00.000Z', installationId: INSTALLATION },
      anchorKey.privateKey,
      anchorKey.publicKey,
    );
    const { keyId, signature, ...payload } = signed;
    await sql`insert into platform.audit_anchor (chain, seq, row_hash, anchored_at, payload, signature, key_id)
              values (${signed.chain}, ${String(signed.seq)}, ${head.row_hash}, ${'2026-09-29T04:00:00Z'}, ${JSON.stringify(payload)}, ${signature}, ${keyId})`.execute(db.app);
    expect((await verifier.verifyTenant({ orgId: ndt.id, schema: ndt.schemaName })).anchorOk).toBe(true);
    const untrusted = new AuditChainVerifier(ctx.moduleRef.get(TenantScope), []);
    expect((await untrusted.verifyTenant({ orgId: ndt.id, schema: ndt.schemaName })).anchorOk).toBe(false);
  });

  it('serves full entries of a system to its MS Manager', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail?ms=isms', headers: as('rina') });
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page).toMatchObject({ page: 1, pageSize: 200, total: 2 });
    expect(page.items.map((e: { action: string }) => e.action)).toEqual(['document.created', 'register.updated']);
    expect(page.items[1]).toMatchObject({
      seq: 1,
      actor: { handle: 'rina', displayName: 'rina', kind: 'user' },
      entityCode: 'R-031',
      ms: 'isms',
      before: { title: 'Old', secret_sealed: '[redacted]' },
      edition: 'TEST-2024 1.0.0',
      sourceIp: '203.0.113.9',
    });
    const filtered = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail?ms=isms&entityType=document&pageSize=1', headers: as('rina') });
    expect(filtered.json()).toMatchObject({ total: 1, pageSize: 1, items: [{ action: 'document.created' }] });
    const future = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail?ms=isms&from=2099-01-01', headers: as('rina') });
    expect(future.json()).toMatchObject({ total: 0, items: [] });
  });

  it('serves metadata only to the Tenant Admin, including the organisation platform rows', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail', headers: as('ta') });
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.total).toBe(5);
    expect(page.items.map((e: { action: string }) => e.action).sort()).toEqual([
      'auth.login', 'document.created', 'record.deleted', 'register.updated', 'tenant.created',
    ]);
    for (const item of page.items) {
      expect(item).not.toHaveProperty('before');
      expect(item).not.toHaveProperty('after');
      expect(item).not.toHaveProperty('entityCode');
    }
    const forSystem = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail?ms=isms', headers: as('ta') });
    expect(forSystem.json().items.every((e: Record<string, unknown>) => !('before' in e))).toBe(true);
    expect(forSystem.json().total).toBe(2);
  });

  it('never shows another organisation, refuses systems without a role and unknown systems', async () => {
    const theirs = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail', headers: as('budi') });
    expect(theirs.json().items.map((e: { action: string }) => e.action).sort()).toEqual(['auth.login', 'register.created', 'tenant.created']);
    expect(JSON.stringify(theirs.json())).not.toContain('R-031');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail?ms=qms', headers: as('rina') })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail', headers: as('rina') })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail?ms=nope', headers: as('rina') })).statusCode).toBe(404);
  });

  it('exports a system as formula-safe CSV with the F.13 headers and audits the download', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/export?ms=isms&format=csv', headers: as('rina') });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="audit-trail-ndt-isms-2026-09-29\.csv"/);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const rows = parse(response.body, { columns: true }) as Record<string, string>[];
    expect(rows.map((r) => r.action)).toEqual(['register.updated', 'document.created']);
    expect(JSON.parse(rows[0]!.after!)).toEqual({ title: '=HYPERLINK("http://x")', secret_sealed: '[redacted]' });
    expect(rows[1]!.entity_code).toBe("'@SUM(1)");
    expect(rows[0]).toMatchObject({ seq: '1', actor: 'rina', actor_kind: 'user', ms: 'isms', source_ip: '203.0.113.9' });
    const downloads = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
      trx.selectFrom('audit_trail').select(['action', 'entity_type', 'actor_user_id']).where('action', '=', 'file.downloaded').execute(),
    );
    expect(downloads).toEqual([{ action: 'file.downloaded', entity_type: 'audit_trail', actor_user_id: users.rina }]);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/export?ms=isms&format=csv', headers: as('ta') })).statusCode).toBe(403);
  });

  it('verifies chains for Tenant Admins and MS Managers', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/verify', headers: as('ta') });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((r: { chain: string }) => r.chain)).toEqual(['org_ndt.audit_trail', 'platform.audit_log']);
    expect(response.json().every((r: { firstBrokenSeq: number | null; anchorOk: boolean }) => r.firstBrokenSeq === null && r.anchorOk)).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/verify', headers: as('rina') })).statusCode).toBe(200);
  });

  it('returns signed anchors as NDJSON that verify offline', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/anchors?from=2026-09-01&to=2026-09-30', headers: as('rina') });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const lines = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    const { keyId, signature, ...payload } = lines[0]!;
    expect(keyId).toBe(TRUSTED[0]!.keyId);
    const ok = verify(null, Buffer.from(canonicalJson(payload)), anchorKey.publicKey, Buffer.from(String(signature).slice('ed25519:'.length), 'base64'));
    expect(ok).toBe(true);
    const outside = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/anchors?from=2026-10-01', headers: as('rina') });
    expect(outside.body).toBe('');
    const other = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-trail/anchors', headers: as('budi') });
    expect(other.body).toBe('');
  });

  it('detects a row changed by the database owner with triggers disabled', async () => {
    const superuser = createKysely<DB>({ connectionString: db.urls.admin, max: 1 });
    try {
      await sql`ALTER TABLE ${sql.id(bsd.schemaName, 'audit_trail')} DISABLE TRIGGER USER`.execute(superuser);
      await sql`UPDATE ${sql.id(bsd.schemaName, 'audit_trail')} SET entity_code = 'R-FORGED' WHERE seq = 1`.execute(superuser);
      await sql`ALTER TABLE ${sql.id(bsd.schemaName, 'audit_trail')} ENABLE TRIGGER USER`.execute(superuser);
    } finally {
      await superuser.destroy();
    }
    const result = await ctx.moduleRef.get(AuditChainVerifier).verifyTenant({ orgId: bsd.id, schema: bsd.schemaName });
    expect(result).toMatchObject({ chain: 'org_bsd.audit_trail', firstBrokenSeq: 1 });
  });
});
