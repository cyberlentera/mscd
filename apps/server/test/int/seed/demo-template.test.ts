// The demo template built by the global setup with `seed demo` (WP-14, G.3 to G.8): organisations, users, licences,
// packs, the sample records with their counts, fillers, repositories and credentials, storage objects that match the
// mock provider fixture, and the external auditor grant.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyLicence } from '@mscd/pack-tools';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { openCredential } from '../../../src/gateway/crypto/credentials';
import { DataKeyService } from '../../../src/gateway/crypto/data-keys';
import { verifySecret } from '../../../src/modules/identity/password-hasher';
import { FileKeyProvider } from '../../../src/modules/keys/file-key-provider';
import { compiledTrustAnchors } from '../../../src/modules/license/trust-anchors';
import { DEMO_PASSWORD, demoTotpSecret } from '../../../src/seed/people';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';
import { TEST_STORAGE_KEY_FILE } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { count, inOrg, inPlatform, ORG_IDS, ORG_SLUGS, stageRecordCount, type OrgSlug } from './helpers';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const sample = loadSampleSnapshot();
/** The sample organisation whose data each demo organisation holds (tst holds the ISMS data, G.3). */
const SOURCE: Record<OrgSlug, 'ndt' | 'bsd' | 'rmn'> = { ndt: 'ndt', bsd: 'bsd', rmn: 'rmn', tst: 'rmn' };
const systemsOf = (org: OrgSlug) => sample.snapshots[SOURCE[org]]!.MS.map((m) => m.id);

describe('seed demo: the demo template (G.3 to G.8)', () => {
  const db = useTestDatabase('demo');
  let platformKeys: FileKeyProvider;

  beforeAll(() => {
    platformKeys = FileKeyProvider.fromFiles(db.config().profile.kms.file.path);
  });

  it('creates the four organisations with fixed ids, names, labels, sites and order (G.3)', async () => {
    const rows = await db.migrator.selectFrom('platform.organization').select(['id', 'slug', 'name', 'schema_name', 'demo_deploy_label', 'site_count', 'position', 'local_login', 'time_zone']).orderBy('position').execute();
    expect(rows).toEqual([
      { id: ORG_IDS.ndt, slug: 'ndt', name: 'PT Nusantara Digital Teknologi', schema_name: 'org_ndt', demo_deploy_label: 'saas', site_count: 2, position: 0, local_login: 'allowed', time_zone: 'Asia/Jakarta' },
      { id: ORG_IDS.bsd, slug: 'bsd', name: 'PT Bank Sentosa Digital', schema_name: 'org_bsd', demo_deploy_label: 'onprem', site_count: 3, position: 1, local_login: 'allowed', time_zone: 'Asia/Jakarta' },
      { id: ORG_IDS.rmn, slug: 'rmn', name: 'RS Medika Nusantara', schema_name: 'org_rmn', demo_deploy_label: 'saas', site_count: 1, position: 2, local_login: 'allowed', time_zone: 'Asia/Jakarta' },
      { id: ORG_IDS.tst, slug: 'tst', name: 'Test Organisation', schema_name: 'org_tst', demo_deploy_label: null, site_count: 1, position: 3, local_login: 'allowed', time_zone: 'Asia/Jakarta' },
    ]);
    for (const org of ORG_SLUGS) {
      const systems = await inOrg(db.migrator, org, (trx) => trx.selectFrom('management_system').select(['slug', 'code', 'status']).orderBy('position').execute());
      expect(systems.map((s) => s.slug)).toEqual(systemsOf(org));
    }
    const ndt = await inOrg(db.migrator, 'ndt', (trx) => trx.selectFrom('management_system').select(['slug', 'code', 'status']).orderBy('position').execute());
    expect(ndt).toEqual([
      { slug: 'isms', code: 'ISMS', status: 'certified' },
      { slug: 'qms', code: 'QMS', status: 'certified' },
      { slug: 'bcms', code: 'BCMS', status: 'implementing' },
      { slug: 'abms', code: 'ABMS', status: 'implementing' },
    ]);
  });

  it('installs the six packs (D-14) with the sample install dates and the catalogue entries of newer versions', async () => {
    const installs = await db.migrator.selectFrom('platform.pack_install').select(['pack_id', 'pack_version', 'installed_at']).where('status', '=', 'installed').orderBy('pack_id').execute();
    expect(installs.map((i) => `${i.pack_id} ${i.pack_version}`)).toEqual([
      'ISO22301-2019 1.0.0', 'ISO27001-2022 1.2.0', 'ISO37001-2016 1.0.0', 'ISO37001-2025 0.6.0', 'ISO9001-2015 1.4.2', 'ISO9001-2026 0.9.0',
    ]);
    const date = (packId: string) => installs.find((i) => i.pack_id === packId)!.installed_at!.toISOString();
    expect(date('ISO27001-2022')).toBe('2026-02-02T02:00:00.000Z'); // 02 Feb 2026, 09:00 in Jakarta
    expect(date('ISO9001-2026')).toBe('2026-09-18T02:00:00.000Z');
    expect(date('ISO22301-2019')).toBe('2026-04-02T02:00:00.000Z');
    expect(date('ISO37001-2025')).toBe('2026-09-01T02:00:00.000Z');
    const catalog = await db.migrator.selectFrom('platform.pack_catalog').select(['pack_id', 'pack_version', 'note_en']).orderBy('pack_id').execute();
    expect(catalog).toEqual([
      { pack_id: 'ISO37001-2025', pack_version: '0.7.0', note_en: '26 more activities, 80 finding conditions' },
      { pack_id: 'ISO9001-2026', pack_version: '1.0.0', note_en: 'subclause numbering verified against published text' },
    ]);
  });

  it('installs a development licence per organisation that verifies and binds to it (D-15)', async () => {
    const anchors = compiledTrustAnchors();
    const rows = await inPlatform(db.migrator, (trx) =>
      sql<{ organization_id: string; license_id: string; document: unknown; document_sha256: string }>`
        select organization_id, license_id, document, document_sha256 from platform.licence where superseded_at is null order by license_id`.execute(trx),
    );
    expect(rows.rows.map((r) => r.license_id)).toEqual(['LIC-DEMO-BSD', 'LIC-DEMO-NDT', 'LIC-DEMO-RMN', 'LIC-DEMO-TST']);
    for (const row of rows.rows) {
      const verified = verifyLicence(row.document, anchors.keys, { rejectKeyIds: anchors.rejectKeyIds });
      expect(verified.binding).toEqual({ kind: 'organization', id: row.organization_id });
      expect(row.license_id).toBe(`LIC-DEMO-${ORG_SLUGS.find((s) => ORG_IDS[s] === row.organization_id)!.toUpperCase()}`);
      expect(verified.document.max_users).toBe(150);
    }
  });

  it('has 86 active members in each sample organisation and the users of G.3', async () => {
    const active = (org: OrgSlug) =>
      inPlatform(db.migrator, (trx) =>
        count(sql<{ count: string }>`select count(*) from platform.org_membership m join platform.app_user u on u.id = m.user_id
          where m.organization_id = ${ORG_IDS[org]} and m.status = 'active' and u.kind = 'person' and u.status = 'active'`.execute(trx)),
      );
    expect(await active('ndt')).toBe(86);
    expect(await active('bsd')).toBe(86);
    expect(await active('rmn')).toBe(86);
    const users = await db.migrator.selectFrom('platform.app_user').select(['handle', 'email', 'display_name', 'job_title', 'kind', 'is_demo']).where('is_demo', '=', true).execute();
    const byHandle = new Map(users.map((u) => [u.handle, u]));
    expect(users).toHaveLength(11 + 4 + 75);
    expect(byHandle.get('rina')).toMatchObject({ email: 'rina.kusuma@nusantaradigital.co.id', display_name: 'Rina Kusuma', job_title: 'ISMS Manager', kind: 'person' });
    expect(byHandle.get('dewi')).toMatchObject({ email: 'dewi.anggraini@nusantaradigital.co.id' });
    expect(byHandle.get('ext.auditor')).toMatchObject({ display_name: 'Eko Santoso', job_title: 'Lead Auditor', kind: 'guest', email: 'ext.auditor@mscd.test' });
    expect(byHandle.get('staff75')).toMatchObject({ display_name: 'Staff 75', job_title: 'Employee', email: 'staff75@nusantaradigital.co.id' });
    const memberships = await inPlatform(db.migrator, (trx) =>
      sql<{ handle: string; slug: string; admin_roles: string[]; is_default: boolean }>`
        select u.handle, o.slug, m.admin_roles, m.is_default from platform.org_membership m
        join platform.app_user u on u.id = m.user_id join platform.organization o on o.id = m.organization_id
        where u.handle in ('rina', 'sari', 'tenant.admin', 'ext.auditor', 'mfa.tester', 'ops') order by u.handle, o.position`.execute(trx),
    );
    const of = (handle: string) => memberships.rows.filter((m) => m.handle === handle);
    expect(of('rina').map((m) => [m.slug, m.admin_roles, m.is_default])).toEqual([
      ['ndt', ['tenant_admin', 'storage_admin'], true],
      ['bsd', ['tenant_admin', 'storage_admin'], false],
      ['rmn', ['tenant_admin', 'storage_admin'], false],
      ['tst', ['tenant_admin', 'storage_admin'], false],
    ]);
    expect(of('sari').map((m) => m.slug)).toEqual(['ndt', 'bsd', 'rmn']);
    expect(of('tenant.admin').map((m) => [m.slug, m.admin_roles])).toEqual([['tst', ['tenant_admin']]]);
    expect(of('ext.auditor').map((m) => m.slug)).toEqual(['tst']);
    expect(of('mfa.tester').map((m) => m.slug)).toEqual(['tst']);
    expect(of('ops')).toEqual([]);
    const operator = await db.migrator.selectFrom('platform.platform_role as r').innerJoin('platform.app_user as u', 'u.id', 'r.user_id').select(['u.handle', 'r.role']).execute();
    expect(operator).toEqual([{ handle: 'ops', role: 'platform_operator' }]);
  });

  it('gives sign-in users the demo password and TOTP secret; staff cannot sign in and mfa.tester has no factor (G.3)', async () => {
    const users = await db.migrator.selectFrom('platform.app_user').select(['id', 'handle', 'password_hash']).where('is_demo', '=', true).execute();
    const factors = await db.migrator.selectFrom('platform.mfa_factor').select(['user_id', 'secret_sealed', 'confirmed_at']).execute();
    const rina = users.find((u) => u.handle === 'rina')!;
    expect(await verifySecret(rina.password_hash!, DEMO_PASSWORD)).toBe(true);
    expect(await verifySecret(rina.password_hash!, 'wrong password')).toBe(false);
    for (const user of users) {
      const factor = factors.find((f) => f.user_id === user.id);
      const staff = user.handle.startsWith('staff');
      expect(user.password_hash === null, user.handle).toBe(staff || user.handle === 'ext.auditor');
      expect(factor === undefined, user.handle).toBe(staff || user.handle === 'mfa.tester');
      if (factor) {
        expect(factor.confirmed_at).not.toBeNull();
        expect(await platformKeys.unwrap(factor.secret_sealed, `mfa:${user.id}`)).toEqual(demoTotpSecret(user.handle));
      }
    }
  });

  it('assigns the business roles of G.3 with one primary MS Manager per system', async () => {
    const roles = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('user_ms_role as r')
        .innerJoin('management_system as m', 'm.id', 'r.management_system_id')
        .innerJoin('platform.app_user as u', 'u.id', 'r.user_id')
        .select(['u.handle', 'm.slug', 'r.role', 'r.is_primary'])
        .execute(),
    );
    const primary = roles.filter((r) => r.is_primary).map((r) => `${r.slug}:${r.handle}:${r.role}`).sort();
    expect(primary).toEqual(['abms:lina:ms_manager', 'bcms:tono:ms_manager', 'isms:rina:ms_manager', 'qms:sari:ms_manager']);
    const of = (handle: string) => roles.filter((r) => r.handle === handle).map((r) => `${r.slug}:${r.role}`).sort();
    expect(of('rina')).toEqual(['abms:ms_manager', 'bcms:ms_manager', 'isms:ms_manager', 'qms:ms_manager']);
    expect(of('sari')).toEqual(['abms:domain_owner', 'bcms:domain_owner', 'isms:domain_owner', 'qms:ms_manager']);
    expect(of('maya')).toEqual(['abms:internal_auditor', 'bcms:internal_auditor', 'isms:internal_auditor', 'qms:internal_auditor']);
    expect(of('hendra')).toEqual(['abms:top_management', 'bcms:top_management', 'isms:top_management', 'qms:top_management']);
    expect(of('staff01')).toEqual([]);
    expect(roles.filter((r) => r.role === 'domain_owner').map((r) => r.handle)).toEqual(expect.arrayContaining(['bagus', 'dewi', 'fajar', 'andi', 'yusuf']));
  });

  it('seeds the reference counts of UI 4.7 in every organisation (ISMS 93 entries, 79 evidence, 22 documents)', async () => {
    const expected: Record<string, [number, number, number]> = { isms: [93, 79, 22], qms: [28, 27, 10], bcms: [27, 11, 8], abms: [32, 2, 5] };
    for (const org of ORG_SLUGS) {
      for (const ms of systemsOf(org)) {
        const actual = await inOrg(db.migrator, org, async (trx) => [
          await stageRecordCountOf(trx, ms, 'applicability'),
          await stageRecordCountOf(trx, ms, 'evidence'),
          await stageRecordCountOf(trx, ms, 'document'),
        ]);
        expect(actual, `${org} ${ms}`).toEqual(expected[ms]);
      }
    }
    const shared = await inOrg(db.migrator, 'ndt', (trx) =>
      trx.selectFrom('document').select('doc_code').where('is_org_wide', '=', true).orderBy('doc_code').execute(),
    );
    expect(shared.map((d) => d.doc_code)).toEqual(['IMS-01', 'IMS-02', 'IMS-03', 'IMS-04']);
    const links = await inOrg(db.migrator, 'ndt', (trx) =>
      sql<{ systems: number; primary_slug: string }>`select count(*)::int as systems, max(m.slug) filter (where l.is_primary) as primary_slug
        from entity_ms_link l join document d on d.id = l.entity_id join management_system m on m.id = l.management_system_id
        where d.doc_code = 'IMS-01'`.execute(trx),
    );
    expect(links.rows[0]).toEqual({ systems: 4, primary_slug: 'isms' });
  });

  it('gives every chain stage exactly its sample record count (STAGES.rec) in every organisation (C.10, G.7)', async () => {
    for (const org of ORG_SLUGS) {
      const snapshot = sample.snapshots[SOURCE[org]]!;
      for (const ms of systemsOf(org)) {
        for (const stage of snapshot.STAGES[ms]!) {
          const expected = snapshot.bundles[ms]!.chain.recs[stage.id];
          const actual = await inOrg(db.migrator, org, (trx) => stageRecordCount(trx, ms, stage.id));
          expect(actual, `${org} ${ms} ${stage.id}`).toBe(expected);
        }
      }
    }
  });

  it('writes filler codes with the stage prefix, once per organisation (no CI-F01 collision)', async () => {
    const contexts = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('context_issue as c')
        .innerJoin('entity_ms_link as l', (join) => join.onRef('l.entity_id', '=', 'c.id').on('l.entity_type', '=', 'context_issue'))
        .innerJoin('management_system as m', 'm.id', 'l.management_system_id')
        .select(['c.code', 'm.slug', 'c.title', 'c.pending_action'])
        .orderBy('m.position')
        .orderBy('c.position')
        .execute(),
    );
    const codes = contexts.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(contexts.filter((c) => c.slug === 'isms').map((c) => c.code)).toEqual(['CI-09', 'CI-02', 'CI-05', 'CI-03', 'CI-01', 'CI-F01', 'CI-F02', 'CI-F03', 'CI-F04', 'CI-F05', 'CI-F06', 'CI-F07']);
    expect(contexts.filter((c) => c.slug === 'qms').map((c) => c.code)).toEqual(['CI-Q04', 'CI-Q01', 'CI-QF01', 'CI-QF02', 'CI-QF03', 'CI-QF04', 'CI-QF05', 'CI-QF06', 'CI-QF07']);
    expect(contexts.filter((c) => c.slug === 'bcms').map((c) => c.code)).toEqual(['CI-B02', 'CI-BF01', 'CI-BF02', 'CI-BF03', 'CI-BF04', 'CI-BF05', 'CI-BF06']);
    expect(contexts.find((c) => c.code === 'CI-F01')).toMatchObject({ title: 'Ready record CI-F01', pending_action: null });
    expect(contexts.find((c) => c.code === 'CI-02')).toMatchObject({ title: 'Dependence on privileged administrators', pending_action: null });
    for (const org of ORG_SLUGS) {
      for (const table of ['context_issue', 'risk', 'metric', 'document', 'evidence'] as const) {
        const column = table === 'document' ? 'doc_code' : table === 'evidence' ? 'evidence_code' : 'code';
        const duplicates = await inOrg(db.migrator, org, (trx) =>
          sql<{ code: string }>`select ${sql.ref(column)} as code from ${sql.table(table)} group by 1 having count(*) > 1`.execute(trx),
        );
        expect(duplicates.rows, `${org} ${table}`).toEqual([]);
      }
    }
  });

  it('stores the open records of X with their action, holder, due date, gate flag and references (G.6)', async () => {
    const risks = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('risk as r')
        .leftJoin('platform.app_user as u', 'u.id', 'r.owner_user_id')
        .select(['r.id', 'r.code', 'r.pending_action', 'r.action_due_at', 'r.is_gate_item', 'u.handle', 'r.risk_profile_code', 'r.position'])
        .where('r.pending_action', 'is not', null)
        .orderBy('r.risk_profile_code')
        .orderBy('r.position')
        .execute(),
    );
    const isms = sample.snapshots.ndt!.X.isms!.risk!;
    const seeded = risks.filter((r) => r.risk_profile_code === 'information_security');
    expect(seeded.map((r) => [r.code, r.pending_action, r.handle ?? 'none', r.action_due_at, r.is_gate_item])).toEqual(
      isms.map((x) => [x.id, x.act, x.h, x.due, x.gate === true]),
    );
    const r014 = seeded.find((r) => r.code === 'R-014')!;
    const references = await inOrg(db.migrator, 'ndt', (trx) =>
      trx.selectFrom('record_reference').select(['direction', 'target_code']).where('entity_id', '=', r014.id).orderBy('direction').orderBy('position').execute(),
    );
    expect(references).toEqual([
      { direction: 'down', target_code: 'T-014' },
      { direction: 'down', target_code: 'A.8.2' },
      { direction: 'up', target_code: 'CI-02' },
    ]);
    const soa = await inOrg(db.migrator, 'ndt', (trx) =>
      trx.selectFrom('chain_record as c').leftJoin('document as d', 'd.id', 'c.related_entity_id').select(['c.code', 'c.stage_key', 'c.is_gate_item', 'd.doc_code']).execute(),
    );
    expect(soa).toEqual([{ code: 'SOA-01', stage_key: 'soa', is_gate_item: true, doc_code: 'SOA-01' }]);
    const treatments = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('risk_treatment as t')
        .innerJoin('management_system as m', 'm.id', 't.management_system_id')
        .leftJoin('risk as r', 'r.id', 't.risk_id')
        .select(['t.code', 'm.slug', 't.status', 't.target_type', 'r.code as risk', 't.implemented_by_user_id', 't.owner_user_id'])
        .execute(),
    );
    expect(treatments.find((t) => t.code === 'T-014')).toMatchObject({ slug: 'isms', status: 'in_progress', target_type: 'catalogue_item', risk: 'R-014' });
    expect(treatments.find((t) => t.code === 'T-031')).toMatchObject({ status: 'proposed', target_type: null, risk: 'R-031', owner_user_id: null });
    expect(treatments.find((t) => t.code === 'T-022')).toMatchObject({ status: 'implemented', risk: 'R-022' });
    for (const ready of treatments.filter((t) => t.status === 'implemented')) {
      expect(ready.implemented_by_user_id, ready.code).toBe(ready.owner_user_id);
      expect(ready.target_type, ready.code).not.toBeNull();
    }
    expect(treatments.find((t) => t.code === 'ACT-09')).toMatchObject({ slug: 'qms', status: 'in_progress', target_type: 'requirement' });
  });

  it('stores what the read model needs to rebuild the chain items and gate items of the sample (UI 2.3, 2.4)', async () => {
    for (const org of ['ndt', 'tst'] as const) {
      const snapshot = sample.snapshots[SOURCE[org]]!;
      for (const ms of systemsOf(org)) {
        const items = snapshot.bundles[ms]!.chain.items;
        const kinds = (kind: string) => items.filter((i) => i.kind === kind);
        const stored = await inOrg(db.migrator, org, async (trx) => {
          const msId = sql`(select id from management_system where slug = ${ms})`;
          const entries = await trx
            .selectFrom('applicability_entry')
            .select(['implementation_status', 'holds_gate', 'action_due_at', 'position'])
            .where('management_system_id', '=', sql<string>`${msId}`)
            .orderBy('position')
            .execute();
          const documents = await sql<{ status: string }>`select d.status from document d join entity_ms_link l on l.entity_id = d.id
            where l.entity_type = 'document' and l.management_system_id = ${msId}`.execute(trx);
          const open = await sql<{ code: string; gate: boolean }>`
            select code, is_gate_item as gate from (
              select c.code, c.is_gate_item, c.pending_action from context_issue c join entity_ms_link l on l.entity_id = c.id where l.management_system_id = ${msId}
              union all select r.code, r.is_gate_item, r.pending_action from risk r join entity_ms_link l on l.entity_id = r.id where l.management_system_id = ${msId}
              union all select m.code, m.is_gate_item, m.pending_action from metric m join entity_ms_link l on l.entity_id = m.id where l.management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from risk_treatment where management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from quality_objective where management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from prioritized_activity where management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from business_impact_analysis where management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from exercise where management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from business_associate where management_system_id = ${msId}
              union all select code, is_gate_item, pending_action from chain_record where management_system_id = ${msId}
            ) x where pending_action is not null`.execute(trx);
          return { entries, documents: documents.rows, open: open.rows };
        });
        const openEntries = stored.entries.filter((e) => e.implementation_status !== 'implemented' && e.implementation_status !== 'not_applicable');
        expect(openEntries.length, `${org} ${ms} req items`).toBe(kinds('req').length);
        expect(openEntries.map((e) => e.action_due_at), `${org} ${ms} req dues`).toEqual(kinds('req').map((i) => i.due));
        // Blocked entries are also justification items where the framework has a justification stage (ISO 27001 SoA).
        const justification = snapshot.STAGES[ms]!.some((stage) => stage.src === 'soa');
        expect(justification ? stored.entries.filter((e) => e.holds_gate).length : 0, `${org} ${ms} soa items`).toBe(kinds('soa').length);
        expect(stored.documents.filter((d) => d.status !== 'approved').length, `${org} ${ms} doc items`).toBe(kinds('doc').length);
        expect(stored.open.map((o) => o.code).sort(), `${org} ${ms} x items`).toEqual(kinds('x').map((i) => i.id).sort());
        const gates = stored.entries.filter((e) => e.holds_gate).length + stored.open.filter((o) => o.gate).length;
        expect(gates, `${org} ${ms} gate items`).toBe(snapshot.bundles[ms]!.gates.length);
      }
    }
  });

  it('dates only the risks of the stale_risk drift rows 400 days back, so drift.evaluate finds exactly them (G.7)', async () => {
    const stale = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('risk as r')
        .leftJoin('platform.app_user as u', 'u.id', 'r.owner_user_id')
        .select(['r.code', 'u.handle', 'r.assessed_at'])
        .where('r.assessed_at', '<', sql<string>`date '2026-09-29' - interval '12 months'`)
        .orderBy('r.code')
        .execute(),
    );
    const rows = ['isms', 'qms'].flatMap((ms) => sample.snapshots.ndt!.DRIFT[ms]!.find((d) => d.id === 'risk12')!.rows!);
    expect(stale.map((r) => [r.code, r.handle, r.assessed_at])).toEqual(
      rows.map(([code, , holder]) => [code, holder, '2025-08-25']).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
    const drift = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('drift_result as d')
        .leftJoin('risk as r', 'r.id', 'd.entity_id')
        .select(['d.rule_code', 'd.entity_code', 'd.entity_type', 'r.code as risk'])
        .where('d.rule_code', '=', 'risk12')
        .execute(),
    );
    expect(drift).toHaveLength(8);
    for (const row of drift) expect(row).toMatchObject({ entity_type: 'risk', risk: row.entity_code });
  });

  it('stores repositories whose sealed credentials open only for their organisation and config (G.6, D-08)', async () => {
    const config = db.config();
    const dataKeys = new DataKeyService(FileKeyProvider.fromFiles(TEST_STORAGE_KEY_FILE));
    expect(config.profile.gateway.kms.file.path).toBe(TEST_STORAGE_KEY_FILE);
    for (const org of ORG_SLUGS) {
      const rows = await inOrg(db.migrator, org, (trx) =>
        trx
          .selectFrom('storage_repository as r')
          .leftJoin('storage_credential as c', (join) => join.onRef('c.storage_repository_id', '=', 'r.id').onRef('c.credential_ref', '=', 'r.credential_ref'))
          .select(['r.id', 'r.slug', 'r.adapter', 'r.modes', 'r.config', 'r.connection_status', 'r.ownership_type', 'r.display', 'r.position', 'c.kind', 'c.sealed_blob', 'c.credential_ref', 'c.external_account'])
          .orderBy('r.position')
          .execute(),
      );
      const expectedSlugs = { ndt: ['sp', 'gd', 'vault', 'od'], bsd: ['sp', 'vault', 'od'], rmn: ['sp', 'od', 'vault'], tst: ['sp', 'od', 'vault'] }[org];
      expect(rows.map((r) => r.slug), org).toEqual(expectedSlugs);
      const key = await inPlatform(db.migrator, (trx) => trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', ORG_IDS[org]).executeTakeFirstOrThrow());
      const dataKey = await dataKeys.unwrap(ORG_IDS[org], key.wrapped_dek);
      for (const repo of rows) {
        if (repo.adapter === 'managed_vault') {
          expect(repo.config).toEqual({ prefix: `tenants/${ORG_IDS[org]}/` });
          expect(repo.kind).toBeNull();
          continue;
        }
        const opened = openCredential(dataKey, { id: repo.id, config: repo.config as Record<string, unknown> }, { ref: repo.credential_ref!, sealedBlob: repo.sealed_blob!, kind: repo.kind! });
        if (repo.adapter === 'm365') {
          expect(opened.secret).toMatchObject({ tenantId: sample.storage.m365.tenantId, clientId: sample.storage.m365.clientId, certificatePem: sample.storage.m365.certificatePem });
          expect(String(opened.secret.privateKeyPem)).toContain('PRIVATE KEY');
        } else {
          expect(opened.secret).toEqual({ clientId: sample.storage.google.clientId, clientSecret: sample.storage.google.clientSecret, refreshToken: sample.storage.google.refreshToken });
          expect(repo.external_account).toBe('tono.hartono@nusantaradigital.co.id');
        }
        // Bound to the repository: another repository id does not open it.
        expect(() => openCredential(dataKey, { id: ORG_IDS[org], config: repo.config as Record<string, unknown> }, { ref: repo.credential_ref!, sealedBlob: repo.sealed_blob!, kind: repo.kind! })).toThrow();
      }
      // jsonb keeps object keys in its own order, so compare the root systems as a set.
      const roots = (slug: string) => Object.keys((rows.find((r) => r.slug === slug)!.config as { roots: object }).roots).sort();
      expect(roots('sp'), org).toEqual([...systemsOf(org)].sort());
    }
    const ndt = await inOrg(db.migrator, 'ndt', (trx) => trx.selectFrom('storage_repository').select(['slug', 'modes', 'connection_status', 'ownership_type', 'display', 'connection_message_en']).execute());
    const by = (slug: string) => ndt.find((r) => r.slug === slug)!;
    expect(by('sp')).toMatchObject({ modes: ['link', 'pass_through'], connection_status: 'ok', ownership_type: 'organizational', display: { configSummary: 'Compliance library, Sites.Selected' } });
    expect(by('gd')).toMatchObject({ modes: ['zero_transit', 'link'], connection_status: 'revoked', connection_message_en: 'Delegated token expired 27 Sep 2026: checks paused for 11 references' });
    expect(by('od')).toMatchObject({ modes: ['link'], connection_status: 'ok', ownership_type: 'personal', display: { locName: 'OneDrive (personal)' } });
    expect(by('vault')).toMatchObject({ modes: ['stored'], display: { configSummary: ['Retention 6 years, encryption per tenant', 'Retensi 6 tahun, enkripsi per tenant'] } });
    const routing = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('storage_routing_rule as r')
        .innerJoin('management_system as m', 'm.id', 'r.management_system_id')
        .innerJoin('storage_repository as s', 's.id', 'r.storage_repository_id')
        .select(['m.code', 's.slug', 'r.mode', 'r.note'])
        .orderBy('m.position')
        .execute(),
    );
    expect(routing).toEqual([
      { code: 'ISMS', slug: 'sp', mode: 'link', note: 'Restricted to Zero-transit' },
      { code: 'QMS', slug: 'vault', mode: 'stored', note: null },
      { code: 'BCMS', slug: 'gd', mode: 'zero_transit', note: 'Internal to Link' },
      { code: 'ABMS', slug: 'vault', mode: 'stored', note: 'Concerns & investigations to restricted vault' },
    ]);
  });

  it('stores evidence and document storage objects that match the mock provider fixture (G.8)', async () => {
    const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools/mock-providers/fixtures/demo.json'), 'utf8')) as {
      m365: { drives: { id: string; items: { id: string; path: string; versions: { id: string; quickXorHash?: string; sha256?: string }[] }[] }[] };
      google: { drives: { id: string; items: { id: string; path: string; versions: { id: string; quickXorHash?: string; sha256?: string }[] }[] }[] };
    };
    const items = new Map([...fixture.m365.drives, ...fixture.google.drives].flatMap((d) => d.items.map((i) => [i.id, i] as const)));
    const objects = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('storage_object as o')
        .innerJoin('storage_repository as r', 'r.id', 'o.storage_repository_id')
        .select(['r.slug', 'o.external_item_id', 'o.external_version_id', 'o.hash_algorithm', 'o.hash_value', 'o.folder_path', 'o.link_status'])
        .execute(),
    );
    expect(objects).toHaveLength(119 + 33 - 1); // every evidence record and every document with a version (REG-Q01 has none)
    let compared = 0;
    for (const object of objects) {
      if (object.slug === 'vault') {
        expect(object.external_item_id.startsWith(`tenants/${ORG_IDS.ndt}/demo-vault-`)).toBe(true);
        continue;
      }
      const item = items.get(object.external_item_id);
      if (object.link_status === 'missing') {
        expect(item, object.external_item_id).toBeUndefined();
        continue;
      }
      expect(item, object.external_item_id).toBeDefined();
      const pinned = item!.versions.find((v) => v.id === object.external_version_id);
      expect(pinned, object.external_item_id).toBeDefined();
      if (object.hash_algorithm === 'quickxor') expect(pinned!.quickXorHash).toBe(object.hash_value);
      if (object.hash_algorithm === 'sha256') expect(pinned!.sha256).toBe(object.hash_value);
      expect(item!.path).toBe(object.folder_path!.split('/').map((s) => s.trim()).join('/'));
      const current = item!.versions[item!.versions.length - 1]!;
      expect(current.id === object.external_version_id, object.external_item_id).toBe(object.link_status !== 'version_changed');
      compared += 1;
    }
    expect(compared).toBeGreaterThan(100);
    const statuses = await inOrg(db.migrator, 'ndt', (trx) =>
      trx
        .selectFrom('evidence as e')
        .innerJoin('storage_object as o', 'o.id', 'e.storage_object_id')
        .select(['e.evidence_code', 'o.link_status', 'o.link_status_reason', 'o.hash_algorithm', 'o.hash_value'])
        .execute(),
    );
    const evidence = sample.snapshots.ndt!.bundles.isms!.evs;
    const code = (key: string) => evidence.find((e) => e.ctrlKey === key)!.code;
    const status = (c: string) => statuses.find((s) => s.evidence_code === c)!;
    expect(status(code('5.9')).link_status).toBe('version_changed');
    expect(status(code('8.13')).link_status).toBe('missing');
    expect(status(code('7.13')).link_status).toBe('access_denied');
    expect(status('EB-0100')).toMatchObject({ link_status: 'verification_pending', link_status_reason: 'credential_invalid' });
    expect(status(code('5.1')).hash_value).toBe(createHash('sha256').update(code('5.1')).digest().subarray(0, 20).toString('base64'));
    expect(status('EQ-0100')).toMatchObject({ hash_algorithm: 'sha256', hash_value: createHash('sha256').update('EQ-0100').digest('hex') });
  });

  it('copies the activity templates and stores the sample phase states, locked as not_started (G.6, D-13, D-30)', async () => {
    for (const ms of systemsOf('ndt')) {
      const rows = await inOrg(db.migrator, 'ndt', (trx) =>
        trx
          .selectFrom('implementation_activity_progress as a')
          .innerJoin('management_system as m', 'm.id', 'a.management_system_id')
          .leftJoin('platform.app_user as u', 'u.id', 'a.owner_user_id')
          .select(['a.phase_no', 'a.activity_no', 'a.title', 'a.status', 'u.handle', 'a.blocker_gate_item_ref', 'a.due_at', 'a.verified_at', 'a.template_pack_version'])
          .where('m.slug', '=', ms)
          .orderBy('a.phase_no')
          .orderBy('a.activity_no')
          .execute(),
      );
      const acts = sample.snapshots.ndt!.bundles[ms]!.phases.flatMap((p) => p.acts);
      expect(rows).toHaveLength(acts.length);
      const map = { verified: 'verified', complete: 'complete', progress: 'in_progress', ns: 'not_started', blocked: 'blocked', locked: 'not_started' } as const;
      acts.forEach((act, i) => {
        const row = rows[i]!;
        expect(`${row.phase_no}.${row.activity_no}`).toBe(act.no);
        expect(row.title).toBe(act.title);
        expect(row.status, `${ms} ${act.no}`).toBe(map[act.st]);
        expect(row.handle).toBe(act.owner);
        expect(row.blocker_gate_item_ref).toBe(act.blocker);
        expect(row.due_at).toBe(act.st === 'verified' || act.st === 'locked' ? null : act.date);
        expect(row.verified_at).toBe(act.st === 'verified' ? act.date : null);
      });
    }
  });

  it('stores events, preparation tasks, findings, cycle items, drift rows and chains of every system (G.6)', async () => {
    const isms = await inOrg(db.migrator, 'ndt', async (trx) => ({
      events: await trx.selectFrom('audit_event as e').innerJoin('management_system as m', 'm.id', 'e.management_system_id').select(['e.event_type', 'e.name_en', 'e.short_label', 'e.scheduled_at', 'e.lead_auditor_name', 'e.expected_focus', 'e.outcome_summary']).where('m.slug', '=', 'isms').orderBy('e.scheduled_at').execute(),
      prep: await trx.selectFrom('audit_prep_task').select(['title', 'status', 'due_at', 'template_code']).orderBy('position').execute(),
      findings: await trx.selectFrom('finding as f').innerJoin('management_system as m', 'm.id', 'f.management_system_id').select(['m.slug', 'f.code', 'f.classification', 'f.status', 'f.source']).orderBy('m.position').orderBy('f.position').execute(),
      chains: await trx.selectFrom('trace_chain_instance as c').innerJoin('management_system as m', 'm.id', 'c.management_system_id').select('c.anchor_code').orderBy('m.position').orderBy('c.position').execute(),
      nodes: await sql<{ count: string }>`select count(*) from trace_chain_node`.execute(trx),
      cycle: await trx.selectFrom('cycle_requirement_status').select(['title', 'status', 'cycle_requirement_def_id']).execute(),
    }));
    expect(isms.events.map((e) => [e.event_type, e.scheduled_at])).toEqual([
      ['stage1', '2025-01-20'], ['stage2', '2025-03-10'], ['surveillance', '2026-11-12'], ['surveillance', '2027-11-10'], ['recertification', '2028-02-14'],
    ]);
    expect(isms.events[2]).toMatchObject({ name_en: 'Surveillance audit 1', short_label: 'Surveillance 1', lead_auditor_name: 'Ir. Dwi Hartanto, IRCA LA' });
    expect(isms.events[2]!.expected_focus).toContain('Vulnerability remediation');
    expect(isms.events[1]!.outcome_summary).toBe('Certified, 2 Minor NC, 1 OFI');
    expect(isms.prep.filter((p) => p.status === 'done')).toHaveLength(3); // 2 ISMS, 1 QMS
    expect(isms.prep.every((p) => p.template_code !== null)).toBe(true);
    const findings = (slug: string) => isms.findings.filter((f) => f.slug === slug);
    const open = (slug: string) => findings(slug).filter((f) => f.status !== 'closed');
    for (const ms of sample.snapshots.ndt!.MS) {
      expect(open(ms.id).length, ms.id).toBe(ms.findings.open);
      expect(open(ms.id).filter((f) => f.classification === 'major').length, ms.id).toBe(ms.findings.major);
    }
    expect(findings('isms').map((f) => `${f.code}:${f.source}`)).toEqual([
      'NC-2025-01:certification_audit', 'NC-2025-02:certification_audit', 'OFI-2025-01:certification_audit', 'IA-2026-01:internal_audit', 'IA-2026-02:internal_audit',
    ]);
    expect(findings('qms').map((f) => f.code)).toEqual(['NC-2025-03', 'OFI-2025-04', 'IA-2026-03']);
    expect(isms.chains.map((c) => c.anchor_code)).toEqual(['R-014', 'R-022', 'R-031', 'R-003', 'RO-11', 'RO-07', 'PA-05']);
    expect(Number(isms.nodes.rows[0]!.count)).toBe(7 * 8);
    expect(isms.cycle).toHaveLength(6 + 6 + 5 + 4);
    expect(isms.cycle.every((c) => c.cycle_requirement_def_id !== null)).toBe(true);
    const alerts = await inOrg(db.migrator, 'ndt', (trx) => trx.selectFrom('ms_alert').select(['kind', 'tone']).orderBy('kind').execute());
    expect(alerts).toEqual([{ kind: 'beta', tone: 'warn' }, { kind: 'connector', tone: 'bad' }, { kind: 'transition', tone: 'info' }]);
  });

  it('seeds the external auditor grant of tst: guest account, used link, role until the grant expires (F.14)', async () => {
    const grant = await inOrg(db.migrator, 'tst', (trx) =>
      trx
        .selectFrom('auditor_access_grant as g')
        .innerJoin('user_ms_role as r', 'r.id', 'g.user_ms_role_id')
        .innerJoin('platform.app_user as u', 'u.id', 'g.user_id')
        .innerJoin('management_system as m', 'm.id', 'g.management_system_id')
        .select(['u.handle', 'u.kind', 'g.email', 'm.slug', 'r.role', 'r.valid_until', 'g.expires_at', 'g.link_used_at', 'g.revoked_at'])
        .execute(),
    );
    expect(grant).toHaveLength(1);
    expect(grant[0]).toMatchObject({ handle: 'ext.auditor', kind: 'guest', email: 'ext.auditor@mscd.test', slug: 'isms', role: 'external_auditor', revoked_at: null });
    expect(grant[0]!.link_used_at).not.toBeNull();
    expect(grant[0]!.valid_until!.getTime()).toBe(grant[0]!.expires_at.getTime());
    expect(grant[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
  });

  it('records the finished seed in platform.system_setting', async () => {
    const marker = await db.migrator.selectFrom('platform.system_setting').select('value').where('key', '=', 'demo.seed').executeTakeFirst();
    expect(marker?.value).toMatchObject({ version: 1, today: '2026-09-29', organisations: ['ndt', 'bsd', 'rmn', 'tst'], keys: 'local' });
  });
});

/** Record count of the applicability, evidence or document stage of a system (C.10). */
async function stageRecordCountOf(trx: Parameters<typeof stageRecordCount>[0], ms: string, source: 'applicability' | 'evidence' | 'document'): Promise<number> {
  const stage = await sql<{ stage_key: string }>`
    select d.stage_key from management_system m join ref.traceability_chain_def d on d.framework_version_id = m.framework_version_id
    where m.slug = ${ms} and d.source = ${source}`.execute(trx);
  return stageRecordCount(trx, ms, stage.rows[0]!.stage_key);
}
