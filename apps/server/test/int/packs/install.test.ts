// E.8 pack installation as `mscd_pack_installer` (D-17): the six development packs and their rows, reinstall as a
// no-op, an in-place minor update that never rewrites tenant activity copies (D-30), downgrades, the J.5 archive
// cases, tampering and untrusted keys (nothing written), supersession in either order (TS 6.3).
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { PackRejectedError } from '../../../src/modules/packs/pack-verification';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  DEV_PACK_IDS,
  addMember,
  archiveEntries,
  archiveOf,
  changedPack,
  createPackApp,
  devLicence,
  devPack,
  editDataset,
  gzipBomb,
  installDevPacks,
  orgIdentities,
  testInstaller,
} from './fixtures';

const OPERATOR = { userId: null, kind: 'operator' as const };

async function refCounts(db: TestDatabase, packId: string): Promise<Record<string, number>> {
  const { rows } = await sql<Record<string, string>>`
    select
      (select count(*) from ref.requirement r where r.framework_version_id = v.id) as requirements,
      (select count(*) from ref.catalogue_item c where c.framework_version_id = v.id) as catalogue,
      (select count(*) from ref.traceability_chain_def c where c.framework_version_id = v.id) as chain,
      (select count(*) from ref.activity_template a where a.framework_version_id = v.id) as activities,
      (select count(distinct a.phase_no) from ref.activity_template a where a.framework_version_id = v.id) as phases,
      (select count(*) from ref.evidence_frequency_rule f where f.framework_version_id = v.id) as frequencies,
      (select count(*) from ref.label l where l.framework_version_id = v.id) as labels,
      (select count(*) from ref.lookup_value l where l.framework_version_id = v.id) as lookups,
      (select count(*) from ref.audit_activity_template a where a.framework_version_id = v.id) as audit_activities,
      (select count(*) from ref.finding_condition f where f.framework_version_id = v.id) as finding_conditions,
      (select count(*) from ref.cycle_requirement_def c where c.framework_version_id = v.id) as cycle_requirements,
      (select count(*) from ref.drift_rule_def d where d.framework_version_id = v.id) as drift_rules,
      (select count(*) from ref.prep_task_template p where p.framework_version_id = v.id) as prep_tasks,
      (select count(*) from ref.rule_activation r where r.framework_version_id = v.id) as rules,
      (select count(*) from ref.risk_profile r where r.framework_version_id = v.id) as risk_profiles
    from ref.framework_version v where v.pack_id = ${packId}`.execute(db.migrator);
  return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));
}

async function totalRefRows(db: TestDatabase): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    select (select count(*) from ref.framework) + (select count(*) from ref.framework_version) + (select count(*) from ref.requirement)
         + (select count(*) from ref.catalogue_item) + (select count(*) from ref.activity_template) + (select count(*) from ref.label)
         + (select count(*) from ref.lookup_value) + (select count(*) from ref.rule_activation) as n`.execute(db.migrator);
  return Number(rows[0]!.n);
}

async function packInstallRows(db: TestDatabase): Promise<{ pack_id: string; pack_version: string; status: string }[]> {
  const { rows } = await sql<{ pack_id: string; pack_version: string; status: string }>`
    select pack_id, pack_version, status from platform.pack_install order by pack_id, created_at`.execute(db.migrator);
  return rows;
}

async function auditActions(db: TestDatabase, action: string): Promise<{ entity_code: string | null; organization_id: string | null; actor_kind: string; after_data: Record<string, unknown> | null }[]> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const { rows } = await sql<{ entity_code: string | null; organization_id: string | null; actor_kind: string; after_data: Record<string, unknown> | null }>`
      select entity_code, organization_id, actor_kind, after_data from platform.audit_log where action = ${action} order by seq`.execute(trx);
    return rows;
  });
}

async function expectRejected(promise: Promise<unknown>, code: string, message?: RegExp): Promise<PackRejectedError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PackRejectedError);
  const rejected = caught as PackRejectedError;
  expect(rejected.code).toBe(code);
  if (message) expect([rejected.message, ...rejected.issues].join('\n')).toMatch(message);
  return rejected;
}

describe('installing the development packs (E.8)', () => {
  const db = useTestDatabase('empty');

  it('installs the six packs with every dataset as mscd_pack_installer', async () => {
    const outcomes = await installDevPacks(db);
    expect(outcomes.map((o) => [o.packId, o.status])).toEqual(DEV_PACK_IDS.map((id) => [id, 'installed']));

    expect(await refCounts(db, 'ISO27001-2022')).toEqual({
      requirements: 24, catalogue: 93, chain: 8, activities: 69, phases: 9, frequencies: 7, labels: 20, lookups: 11,
      audit_activities: 6, finding_conditions: 6, cycle_requirements: 6, drift_rules: 4, prep_tasks: 7, rules: 40, risk_profiles: 1,
    });
    expect(await refCounts(db, 'ISO9001-2026')).toMatchObject({ requirements: 28, catalogue: 0, chain: 8, activities: 57, lookups: 11, rules: 39 });
    expect(await refCounts(db, 'ISO22301-2019')).toMatchObject({ requirements: 27, chain: 8, activities: 43, lookups: 15 });
    expect(await refCounts(db, 'ISO37001-2025')).toMatchObject({ requirements: 32, chain: 6, activities: 43, lookups: 19, rules: 40 });

    const gate = await sql<{ phase_no: number }>`
      select distinct a.phase_no from ref.activity_template a join ref.framework_version v on v.id = a.framework_version_id
      where v.pack_id = 'ISO27001-2022' and a.is_gate_phase`.execute(db.migrator);
    expect(gate.rows.map((r) => r.phase_no)).toEqual([4]);
    const catalogue = await sql<{ item_code: string; theme_code: string; requirement_id: string | null }>`
      select c.item_code, c.theme_code, c.requirement_id from ref.catalogue_item c join ref.framework_version v on v.id = c.framework_version_id
      where v.pack_id = 'ISO27001-2022' order by c.sort_order limit 1`.execute(db.migrator);
    expect(catalogue.rows[0]).toMatchObject({ item_code: 'A.5.1', theme_code: 'A.5' });

    const versions = await sql<{ pack_id: string; pack_version: string; status: string; pre_release: boolean; transition_ends_at: string | null; supersedes: string | null; target: string }>`
      select v.pack_id, v.pack_version, v.status, v.pre_release, v.transition_ends_at, s.pack_id as supersedes, v.applicability_target as target
      from ref.framework_version v left join ref.framework_version s on s.id = v.supersedes_version_id order by v.pack_id`.execute(db.migrator);
    expect(versions.rows).toEqual([
      { pack_id: 'ISO22301-2019', pack_version: '1.0.0', status: 'current', pre_release: false, transition_ends_at: null, supersedes: null, target: 'requirement' },
      { pack_id: 'ISO27001-2022', pack_version: '1.2.0', status: 'current', pre_release: false, transition_ends_at: null, supersedes: null, target: 'catalogue_item' },
      { pack_id: 'ISO37001-2016', pack_version: '1.0.0', status: 'withdrawn', pre_release: false, transition_ends_at: null, supersedes: null, target: 'requirement' },
      { pack_id: 'ISO37001-2025', pack_version: '0.6.0', status: 'current', pre_release: true, transition_ends_at: null, supersedes: null, target: 'requirement' },
      { pack_id: 'ISO9001-2015', pack_version: '1.4.2', status: 'transition', pre_release: false, transition_ends_at: '2029-09-15', supersedes: null, target: 'requirement' },
      { pack_id: 'ISO9001-2026', pack_version: '0.9.0', status: 'current', pre_release: false, transition_ends_at: null, supersedes: 'ISO9001-2015', target: 'requirement' },
    ]);
    const frameworks = await sql<{ code: string; name: string }>`select code, name from ref.framework order by code`.execute(db.migrator);
    expect(frameworks.rows).toEqual([
      { code: 'ISO22301', name: 'ISO 22301' },
      { code: 'ISO27001', name: 'ISO/IEC 27001' },
      { code: 'ISO37001', name: 'ISO 37001' },
      { code: 'ISO9001', name: 'ISO 9001' },
    ]);
    const br02 = await sql<{ pack_id: string }>`
      select v.pack_id from ref.rule_activation r join ref.framework_version v on v.id = r.framework_version_id
      where r.rule_id = 'BR-02' order by v.pack_id`.execute(db.migrator);
    expect(br02.rows.map((r) => r.pack_id)).toEqual(['ISO27001-2022', 'ISO37001-2016', 'ISO37001-2025']);

    const installs = await sql<{ pack_id: string; status: string; signature_key_id: string; archive_sha256: string; framework_version_id: string | null }>`
      select pack_id, status, signature_key_id, archive_sha256, framework_version_id from platform.pack_install order by pack_id`.execute(db.migrator);
    expect(installs.rows).toHaveLength(6);
    for (const row of installs.rows) {
      const pack = devPack(row.pack_id as (typeof DEV_PACK_IDS)[number]);
      expect(row).toMatchObject({ status: 'installed', signature_key_id: pack.keyId, archive_sha256: pack.sha256 });
      expect(row.framework_version_id).not.toBeNull();
    }
    const audited = await auditActions(db, 'pack.installed');
    expect(audited.map((a) => a.entity_code)).toEqual(DEV_PACK_IDS.map((id) => `${id} ${devPack(id).manifest.pack_version}`));
    expect(audited.every((a) => a.organization_id === null && a.actor_kind === 'operator')).toBe(true);
    expect(audited[1]!.after_data).toMatchObject({ pack_id: 'ISO27001-2022', rows: { catalogue: 93, activities: 69, chain: 8 } });
  });

  it('treats a second installation of the same versions as a no-op', async () => {
    const before = { ref: await totalRefRows(db), installs: await packInstallRows(db), audited: (await auditActions(db, 'pack.installed')).length };
    const outcomes = await installDevPacks(db);
    expect(outcomes.map((o) => o.status)).toEqual(DEV_PACK_IDS.map(() => 'unchanged'));
    expect(await totalRefRows(db)).toBe(before.ref);
    expect(await packInstallRows(db)).toEqual(before.installs);
    expect((await auditActions(db, 'pack.installed')).length).toBe(before.audited);
  });

  describe('a newer minor version of an installed edition', () => {
    let tenant: CreatedTenant;

    beforeAll(async () => {
      tenant = await createTenant(db, 'upd');
      const ta = await addMember(db, 'ta.upd', tenant.id, ['tenant_admin']);
      const mm = await addMember(db, 'mm.upd', tenant.id);
      const app = await createPackApp(db, { identities: orgIdentities(tenant, { ta, mm }) });
      try {
        const headers = { [FAKE_PRINCIPAL_HEADER]: 'ta@upd' };
        expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers, payload: devLicence(tenant.id) })).statusCode).toBe(200);
        const created = await app.app.inject({
          method: 'POST',
          url: '/api/v1/admin/management-systems',
          headers,
          payload: { slug: 'isms', code: 'ISMS', name: 'Information security', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Whole organisation', defaultRepository: 'vault', color: '#e8731a' },
        });
        expect(created.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it('updates titles, labels and lookups in place, adds rows, and leaves tenant activity copies unchanged (D-30)', async () => {
      const before = await sql<{ id: string; n: string }>`
        select v.id, (select count(*) from ref.requirement r where r.framework_version_id = v.id) as n
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
      const update = changedPack('ISO27001-2022', (s) => {
        s.manifest.pack_version = '1.3.0';
        editDataset(s, 'activities.csv', ',Secure top management mandate,', ',Secure the mandate of top management,');
        editDataset(s, 'requirements.csv', 'Understanding the organization and its context', 'Understanding the organisation and its context');
        editDataset(s, 'catalogue.csv', 'Policies for information security', 'Information security policies');
        editDataset(s, 'labels.en.json', '"ISMS Manager"', '"ISMS Lead"');
        editDataset(s, 'lookups.csv', 'doc_type,policy,Policy,', 'doc_type,policy,Policy document,');
      });
      const outcome = await testInstaller(db.packInstaller).install(update.bytes, { actor: OPERATOR });
      expect(outcome).toMatchObject({ status: 'installed', version: '1.3.0', updatedEdition: true, previousVersion: '1.2.0' });

      const after = await sql<{ id: string; pack_version: string; status: string; n: string }>`
        select v.id, v.pack_version, v.status, (select count(*) from ref.requirement r where r.framework_version_id = v.id) as n
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
      expect(after.rows).toEqual([{ id: before.rows[0]!.id, pack_version: '1.3.0', status: 'current', n: before.rows[0]!.n }]);
      const titles = await sql<{ requirement: string; item: string; activity: string; label: string; lookup: string }>`
        select (select title_short from ref.requirement where framework_version_id = v.id and requirement_code = '4.1') as requirement,
               (select title_short from ref.catalogue_item where framework_version_id = v.id and item_code = 'A.5.1') as item,
               (select title from ref.activity_template where framework_version_id = v.id and phase_no = 1 and activity_no = 1) as activity,
               (select value from ref.label where framework_version_id = v.id and key = 'ms.manager_role' and lang = 'en') as label,
               (select label_en from ref.lookup_value where framework_version_id = v.id and domain = 'doc_type' and code = 'policy') as lookup
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
      expect(titles.rows[0]).toEqual({
        requirement: 'Understanding the organisation and its context',
        item: 'Information security policies',
        activity: 'Secure the mandate of top management',
        label: 'ISMS Lead',
        lookup: 'Policy document',
      });
      const installs = (await packInstallRows(db)).filter((r) => r.pack_id === 'ISO27001-2022');
      expect(installs).toEqual([
        { pack_id: 'ISO27001-2022', pack_version: '1.2.0', status: 'superseded' },
        { pack_id: 'ISO27001-2022', pack_version: '1.3.0', status: 'installed' },
      ]);

      // The tenant's activity copies keep the titles and the template version of the activation.
      const scoped = await db.migrator.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${tenant.id}, true)`.execute(trx);
        return sql<{ title: string; template_pack_version: string }>`
          select title, template_pack_version from ${sql.id(tenant.schemaName, 'implementation_activity_progress')} order by phase_no, activity_no`.execute(trx);
      });
      expect(scoped.rows).toHaveLength(69);
      expect(scoped.rows[0]).toEqual({ title: 'Secure top management mandate', template_pack_version: '1.2.0' });
      expect(scoped.rows.every((r) => r.template_pack_version === '1.2.0')).toBe(true);
    });

    it('rejects an older version than the installed one and writes nothing but the rejection', async () => {
      const refBefore = await totalRefRows(db);
      const installsBefore = await packInstallRows(db);
      const older = changedPack('ISO27001-2022', (s) => {
        s.manifest.pack_version = '1.1.0';
      });
      await expectRejected(testInstaller(db.packInstaller).install(older.bytes, { actor: OPERATOR }), 'downgrade', /older than the installed version 1\.3\.0/);
      expect(await totalRefRows(db)).toBe(refBefore);
      expect(await packInstallRows(db)).toEqual(installsBefore);
      const rejected = await auditActions(db, 'pack.rejected');
      expect(rejected.at(-1)).toMatchObject({ entity_code: 'ISO27001-2022 1.1.0', after_data: { reason: 'downgrade' } });
    });
  });
});

describe('packs that are refused before anything is written (E.8 steps 1 to 4, J.5)', () => {
  const db = useTestDatabase('empty');
  const base = () => devPack('ISO22301-2019');

  async function expectNothingWritten(): Promise<void> {
    expect(await totalRefRows(db)).toBe(0);
    expect(await packInstallRows(db)).toEqual([]);
  }

  it('rejects a tampered dataset (checksum) with no row written', async () => {
    const entries = archiveEntries(base().bytes).map((e) =>
      e.path === 'requirements.csv' ? { ...e, data: Buffer.from(e.data!.toString('utf8').replace('Understanding', 'Misunderstanding')) } : e,
    );
    await expectRejected(testInstaller(db.packInstaller).install(archiveOf(entries), { actor: OPERATOR }), 'checksum', /requirements\.csv/);
    await expectNothingWritten();
    expect((await auditActions(db, 'pack.rejected')).at(-1)).toMatchObject({ after_data: { reason: 'checksum' } });
  });

  it('rejects path traversal, duplicate names, an extra file, a link and a decompression bomb', async () => {
    const installer = testInstaller(db.packInstaller);
    const entries = archiveEntries(base().bytes);
    const cases: [string, Buffer, RegExp][] = [
      ['traversal', archiveOf([...entries.slice(0, -1), { path: '../evil.csv', data: Buffer.from('x') }, entries.at(-1)!]), /\.\./],
      ['duplicate', archiveOf([...entries.slice(0, -1), { path: 'requirements.csv', data: Buffer.from('x') }, entries.at(-1)!]), /more than once/],
      ['extra file', archiveOf([...entries.slice(0, -1), { path: 'extra.csv', data: Buffer.from('x') }, entries.at(-1)!]), /extra\.csv/],
      ['symbolic link', archiveOf([...entries.slice(0, -1), { path: 'link.csv', type: 'symlink', linkPath: '/etc/passwd' }, entries.at(-1)!]), /link/i],
      ['bomb', gzipBomb(), /larger than/],
    ];
    for (const [name, bytes, message] of cases) {
      const rejected = await expectRejected(installer.install(bytes, { actor: OPERATOR }), 'archive', message);
      expect(rejected.status, name).toBe(400);
    }
    await expectNothingWritten();
  });

  it('rejects a pack signed with a key that is not compiled into the build', async () => {
    const stranger = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const foreign = changedPack('ISO22301-2019', () => undefined, stranger);
    await expectRejected(testInstaller(db.packInstaller).install(foreign.bytes, { actor: OPERATOR }), 'untrusted_key', /not a trusted pack key/);
    await expectNothingWritten();
  });

  it('rejects a pack that needs a newer server (422) or names an unknown chain table (400)', async () => {
    const future = changedPack('ISO22301-2019', (s) => {
      s.manifest.engine_min_version = '99.0.0';
    });
    const engine = await expectRejected(testInstaller(db.packInstaller).install(future.bytes, { actor: OPERATOR }), 'engine_version', /99\.0\.0/);
    expect(engine.status).toBe(422);
    const unknownTable = changedPack('ISO22301-2019', (s) => {
      editDataset(s, 'chain.csv', ',entity,context_issue,', ',entity,invoice,');
    });
    const reference = await expectRejected(testInstaller(db.packInstaller).install(unknownTable.bytes, { actor: OPERATOR }), 'reference', /entity type invoice/);
    expect(reference.status).toBe(400);
    await expectNothingWritten();
  });

  it('moves a superseded edition to transition when the newer edition was installed first (TS 6.3)', async () => {
    const installer = testInstaller(db.packInstaller);
    await installer.install(devPack('ISO9001-2026').bytes, { actor: OPERATOR });
    await installer.install(devPack('ISO9001-2015').bytes, { actor: OPERATOR });
    const { rows } = await sql<{ pack_id: string; status: string; transition_ends_at: string | null; supersedes: string | null }>`
      select v.pack_id, v.status, v.transition_ends_at, s.pack_id as supersedes from ref.framework_version v
      left join ref.framework_version s on s.id = v.supersedes_version_id order by v.pack_id`.execute(db.migrator);
    expect(rows).toEqual([
      { pack_id: 'ISO9001-2015', status: 'transition', transition_ends_at: '2029-09-15', supersedes: null },
      { pack_id: 'ISO9001-2026', status: 'current', transition_ends_at: null, supersedes: 'ISO9001-2015' },
    ]);
  });
});
