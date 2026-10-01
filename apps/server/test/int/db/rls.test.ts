// Tenant isolation, platform table RLS, privileges and the database backstops (J.5 RLS list, D-02, D-31, F.10).
// Two organisations hold rows with identical business codes; every check runs against real roles.
import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import {
  addFramework,
  addManagementSystem,
  addUser,
  connect,
  expectPgError,
  inScope,
  PERSON_COLUMNS,
  rolledBack,
  SCHEMA_CREATE_PRIVILEGE_QUERY,
  schemaTables,
  SYSTEM_USER,
  type FrameworkFixture,
} from './helpers';

interface Org {
  tenant: CreatedTenant;
  msId: string;
}

describe('tenant isolation and privileges (J.5)', () => {
  const db = useTestDatabase('empty');
  let admin: Kysely<DB>;
  let fw: FrameworkFixture;
  let a: Org;
  let b: Org;
  let memberA: string;
  let memberB: string;
  let both: string;
  let tenantTables: string[];

  beforeAll(async () => {
    admin = connect(db.urls.admin, 'mscd-test-admin');
    const ta = await createTenant(db, 'rls_a');
    const tb = await createTenant(db, 'rls_b');
    memberA = await addUser(db.migrator, 'member.a', [ta.id]);
    memberB = await addUser(db.migrator, 'member.b', [tb.id]);
    both = await addUser(db.migrator, 'member.both', [ta.id, tb.id]);
    fw = await addFramework(db.migrator);
    a = { tenant: ta, msId: await addManagementSystem(db.migrator, ta, fw.versionId) };
    b = { tenant: tb, msId: await addManagementSystem(db.migrator, tb, fw.versionId) };
    await populate(a, memberA);
    await populate(b, memberB);
    await populatePlatform(a, memberA);
    await populatePlatform(b, memberB);
    tenantTables = await schemaTables(db.migrator, ta.schemaName);
    expect(tenantTables).toEqual(await schemaTables(db.migrator, tb.schemaName));
  });

  afterAll(async () => {
    await admin?.destroy();
  });

  /** Identical business codes in both organisations, across many tenant tables. */
  async function populate(org: Org, member: string): Promise<void> {
    await inScope(db.migrator, { orgId: org.tenant.id, schema: org.tenant.schemaName, userId: member }, async (trx) => {
      await trx.insertInto('user_ms_role').values({ user_id: member, management_system_id: org.msId, role: 'ms_manager', is_primary: true }).execute();
      await trx
        .insertInto('management_system_version')
        .values({ management_system_id: org.msId, framework_version_id: fw.versionId, role: 'active', activated_at: '2026-01-01' })
        .execute();
      const cycle = await trx
        .insertInto('certification_cycle')
        .values({ management_system_id: org.msId, cycle_start: '2026-01-01', cycle_end: '2029-01-01', status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('ms_alert').values({ management_system_id: org.msId, kind: 'other', tone: 'info', text_en: 'Hello', text_id: 'Halo' }).execute();
      await trx.insertInto('clause_readiness').values({ management_system_id: org.msId, clause_group: 4, readiness_pct: 50 }).execute();
      const issue = await trx.insertInto('context_issue').values({ code: 'CI-01', title: 'Market change', owner_user_id: member }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'context_issue', entity_id: issue.id, management_system_id: org.msId, is_primary: true }).execute();
      await trx.insertInto('interested_party').values({ code: 'IP-01', title: 'Regulator', owner_user_id: member }).execute();
      await trx.insertInto('asset').values({ code: 'AS-01', title: 'Core banking', owner_user_id: member }).execute();
      const risk = await trx
        .insertInto('risk')
        .values({ code: 'R-01', title: 'Data leak', owner_user_id: member, risk_profile_code: 'iso27001' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('risk_treatment').values({ management_system_id: org.msId, code: 'RT-01', title: 'Encrypt', risk_id: risk.id }).execute();
      await trx.insertInto('metric').values({ code: 'M-01', title: 'Phishing click rate', owner_user_id: member }).execute();
      const doc = await trx
        .insertInto('document')
        .values({ doc_code: 'DOC-01', title: 'Information security policy', doc_type: 'policy', owner_user_id: member })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'document', entity_id: doc.id, management_system_id: org.msId, is_primary: true }).execute();
      const entry = await trx
        .insertInto('applicability_entry')
        .values({ management_system_id: org.msId, target_type: 'catalogue_item', catalogue_item_id: fw.catalogueItemId, owner_user_id: member })
        .returning('id')
        .executeTakeFirstOrThrow();
      const evidence = await trx
        .insertInto('evidence')
        .values({ evidence_code: 'EV-01', title: 'Access review', owner_user_id: member, frequency_code: 'quarterly' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('evidence_target')
        .values({ evidence_id: evidence.id, management_system_id: org.msId, applicability_entry_id: entry.id, target_type: 'catalogue_item', catalogue_item_id: fw.catalogueItemId })
        .execute();
      const event = await trx
        .insertInto('audit_event')
        .values({ management_system_id: org.msId, certification_cycle_id: cycle.id, event_type: 'surveillance', name_en: 'Surveillance 1', name_id: 'Surveilans 1', short_label: 'S1', scheduled_at: '2026-11-20' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('audit_prep_task').values({ audit_event_id: event.id, management_system_id: org.msId, title: 'Internal audit', owner_user_id: member, due_at: '2026-10-30' }).execute();
      await trx
        .insertInto('finding')
        .values({ management_system_id: org.msId, code: 'F-01', title: 'Access reviews late', classification: 'minor', source: 'certification_audit', owner_user_id: member })
        .execute();
      await trx.insertInto('corrective_action').values({ management_system_id: org.msId, code: 'CA-01', title: 'Automate reviews', owner_user_id: member }).execute();
      await trx
        .insertInto('notification')
        .values({ recipient_user_id: member, kind: 'reminder', title_en: 'Due', title_id: 'Jatuh tempo', body_en: 'Due soon', body_id: 'Segera' })
        .execute();
      await trx
        .insertInto('reminder')
        .values({ management_system_id: org.msId, record_key: 'isms:risk:R-01', entity_type: 'risk', entity_id: risk.id, recipient_user_id: member, sent_by_user_id: member })
        .execute();
      await trx
        .insertInto('task')
        .values({ management_system_id: org.msId, source_rule: 'BR-10', entity_type: 'document', entity_id: doc.id, title_en: 'Review', title_id: 'Tinjau', owner_user_id: member })
        .execute();
      await trx.insertInto('audit_trail').values({ actor_kind: 'user', actor_user_id: member, action: 'risk.updated', entity_type: 'risk', entity_id: risk.id, entity_code: 'R-01' }).execute();
    });
  }

  async function populatePlatform(org: Org, member: string): Promise<void> {
    await inScope(db.migrator, { platformScope: true }, async (trx) => {
      const orgId = org.tenant.id;
      await trx
        .insertInto('platform.identity_provider')
        .values({ organization_id: orgId, slug: `idp-${org.tenant.slug.replace('_', '-')}`, kind: 'oidc', display_name: 'Entra', oidc_issuer: 'https://login.example', oidc_client_id: 'mscd' })
        .execute();
      await trx.insertInto('platform.verified_domain').values({ organization_id: orgId, domain: 'bank.co.id', verified_by: 'operator' }).execute();
      await trx
        .insertInto('platform.invitation')
        .values({ token_hash: randomBytes(32), organization_id: orgId, user_id: member, email: `${member}@test.invalid`, created_by: SYSTEM_USER, expires_at: new Date(Date.now() + 86_400_000) })
        .execute();
      await trx
        .insertInto('platform.licence')
        .values({ organization_id: orgId, license_id: `LIC-${org.tenant.slug}`, document: JSON.stringify({ licensee: org.tenant.slug }), document_sha256: 'a'.repeat(64), key_id: 'dev' })
        .execute();
      await trx
        .insertInto('platform.session')
        .values({
          id_hash: createHash('sha256').update(member).digest(),
          user_id: member,
          organization_id: orgId,
          state: 'active',
          auth_method: 'local',
          csrf_token_hash: randomBytes(32),
          idle_expires_at: new Date(Date.now() + 3_600_000),
          absolute_expires_at: new Date(Date.now() + 28_800_000),
        })
        .execute();
    });
    // Idempotency keys have no platform scope (D-31): they are written under the organisation's own id.
    await inScope(db.migrator, { orgId: org.tenant.id, userId: member }, (trx) =>
      trx
        .insertInto('platform.idempotency_key')
        .values({ organization_id: org.tenant.id, user_id: member, key: 'k-1', route: 'POST /x', request_hash: 'b'.repeat(64), expires_at: new Date(Date.now() + 86_400_000) })
        .execute(),
    );
  }

  describe('tenant tables', () => {
    it('show the rows of the session organisation only, also to a schema-qualified query of the other schema', async () => {
      const populated: string[] = [];
      for (const table of tenantTables) {
        const own = await inScope(db.migrator, { orgId: b.tenant.id }, (trx) =>
          sql<{ n: string }>`select count(*) as n from ${sql.id(b.tenant.schemaName, table)}`.execute(trx),
        );
        if (own.rows[0]!.n !== '0') populated.push(table);
        const foreign = await inScope(db.app, { orgId: a.tenant.id, schema: a.tenant.schemaName, userId: memberA }, (trx) =>
          sql<{ n: string }>`select count(*) as n from ${sql.id(b.tenant.schemaName, table)}`.execute(trx),
        );
        expect(foreign.rows[0]!.n, `${b.tenant.schemaName}.${table} seen with the id of ${a.tenant.schemaName}`).toBe('0');
      }
      expect(populated.length).toBeGreaterThanOrEqual(25);
      // Identical codes live side by side; each organisation sees its own row.
      for (const org of [a, b]) {
        const risks = await inScope(db.app, { orgId: org.tenant.id, schema: org.tenant.schemaName }, (trx) =>
          trx.selectFrom('risk').select(['code', 'organization_id']).execute(),
        );
        expect(risks).toEqual([{ code: 'R-01', organization_id: org.tenant.id }]);
      }
    });

    it('bind each schema to its own organisation: a row of A placed in schema B by a superuser stays invisible to A', async () => {
      await sql`insert into ${sql.id(b.tenant.schemaName, 'context_issue')} (organization_id, code, title)
                values (${a.tenant.id}, 'CI-SMUGGLED', 'Placed by a superuser')`.execute(admin);
      const seen = await inScope(db.app, { orgId: a.tenant.id }, (trx) =>
        sql<{ code: string }>`select code from ${sql.id(b.tenant.schemaName, 'context_issue')}`.execute(trx),
      );
      expect(seen.rows).toEqual([]);
      const updated = await inScope(db.app, { orgId: a.tenant.id }, (trx) =>
        sql`update ${sql.id(b.tenant.schemaName, 'context_issue')} set title = 'changed'`.execute(trx),
      );
      expect(updated.numAffectedRows).toBe(0n);
    });

    it('reject a schema-qualified insert into another schema, with either organisation id', async () => {
      for (const orgId of [a.tenant.id, b.tenant.id]) {
        await expectPgError(
          rolledBack(db.app, { orgId: a.tenant.id, userId: memberA }, (trx) =>
            sql`insert into ${sql.id(b.tenant.schemaName, 'risk')} (organization_id, code, title, risk_profile_code)
                values (${orgId}, 'R-99', 'Cross-tenant write', 'iso27001')`.execute(trx),
          ),
          '42501',
          /new row violates row-level security policy for table "risk"/,
        );
      }
    });

    it('show no rows without app.org_id, also to the owning migrator (FORCE ROW LEVEL SECURITY)', async () => {
      for (const database of [db.app, db.migrator]) {
        const none = await inScope(database, {}, (trx) =>
          sql<{ n: string }>`select (select count(*) from ${sql.id(a.tenant.schemaName, 'risk')})
                                  + (select count(*) from ${sql.id(a.tenant.schemaName, 'document')}) as n`.execute(trx),
        );
        expect(none.rows[0]!.n).toBe('0');
      }
      const withOrg = await inScope(db.migrator, { orgId: a.tenant.id }, (trx) =>
        sql<{ n: string }>`select count(*) as n from ${sql.id(a.tenant.schemaName, 'risk')}`.execute(trx),
      );
      expect(withOrg.rows[0]!.n).toBe('1');
    });

    it('never let mscd_app DELETE or TRUNCATE a tenant table', async () => {
      expect(tenantTables).toHaveLength(66);
      for (const table of tenantTables) {
        for (const statement of [sql`delete from ${sql.id(a.tenant.schemaName, table)}`, sql`truncate ${sql.id(a.tenant.schemaName, table)}`]) {
          await expectPgError(
            rolledBack(db.app, { orgId: a.tenant.id }, (trx) => statement.execute(trx)),
            '42501',
            new RegExp(`permission denied for table ${table}$`),
          );
        }
      }
    });

    it('grant mscd_app exactly SELECT, INSERT and UPDATE (no UPDATE on append-only tables) and nothing on Kysely tables', async () => {
      const { rows } = await sql<{ relname: string; privs: string[] }>`
        select c.relname,
               array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                     where has_table_privilege('mscd_app', c.oid, p)) as privs
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${a.tenant.schemaName} and c.relkind in ('r', 'p')
        order by c.relname`.execute(admin);
      const appendOnly = new Set(['audit_trail', 'link_health_result', 'reminder']);
      for (const row of rows) {
        const expected = row.relname.startsWith('kysely_') ? [] : appendOnly.has(row.relname) ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE'];
        expect(row.privs, row.relname).toEqual(expected);
      }
      const usage = await sql<{ app: boolean; pack: boolean; publicUsage: boolean }>`
        select has_schema_privilege('mscd_app', ${a.tenant.schemaName}, 'USAGE') as app,
               has_schema_privilege('mscd_pack_installer', ${a.tenant.schemaName}, 'USAGE') as pack,
               exists (select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x
                       where n.nspname = ${a.tenant.schemaName} and x.grantee = 0) as "publicUsage"`.execute(admin);
      expect(usage.rows[0]).toEqual({ app: true, pack: false, publicUsage: false });
    });

    it('enable and force RLS with one tenant_isolation policy bound to the organisation id on every table', async () => {
      const { rows } = await sql<{ relname: string; rls: boolean; forced: boolean; policies: string[]; qual: string | null }>`
        select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
               array(select p.polname::text from pg_policy p where p.polrelid = c.oid order by 1) as policies,
               (select pg_get_expr(p.polqual, p.polrelid) from pg_policy p where p.polrelid = c.oid limit 1) as qual
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${a.tenant.schemaName} and c.relkind in ('r', 'p') and c.relname not like 'kysely\\_%'`.execute(admin);
      expect(rows).toHaveLength(66);
      for (const row of rows) {
        expect({ table: row.relname, rls: row.rls, forced: row.forced, policies: row.policies }).toEqual({
          table: row.relname,
          rls: true,
          forced: true,
          policies: ['tenant_isolation'],
        });
        expect(row.qual).toContain(a.tenant.id);
        expect(row.qual).toContain("current_setting('app.org_id'::text, true)");
      }
    });
  });

  describe('assert_member', () => {
    it('is installed on every tenant table with person columns, for exactly those columns', async () => {
      const { rows } = await sql<{ table_name: string; columns: string[]; triggerdef: string | null }>`
        select c.table_name, array_agg(c.column_name::text order by c.column_name) as columns,
               (select pg_get_triggerdef(t.oid) from pg_trigger t
                join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace
                where n.nspname = c.table_schema and r.relname = c.table_name and t.tgname = 'assert_member') as triggerdef
        from information_schema.columns c
        where c.table_schema = ${a.tenant.schemaName} and c.column_name = any (${[...PERSON_COLUMNS]}::text[])
        group by c.table_schema, c.table_name order by c.table_name`.execute(admin);
      expect(rows.length).toBeGreaterThanOrEqual(30);
      for (const row of rows) {
        const args = row.columns.map((col) => `'${col}'`).join(', ');
        expect(row.triggerdef, row.table_name).toContain(`EXECUTE FUNCTION platform.assert_member(${args})`);
        expect(row.triggerdef).toContain(`BEFORE INSERT OR UPDATE OF ${row.columns.join(', ')}`);
      }
    });

    it('rejects a non-member in every person column of every tenant table and accepts members and the system user', async () => {
      const { rows } = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name from information_schema.columns
        where table_schema = ${a.tenant.schemaName} and column_name = any (${[...PERSON_COLUMNS]}::text[])
        order by table_name, column_name`.execute(admin);
      expect(rows.length).toBeGreaterThanOrEqual(40);
      for (const { table_name: table, column_name: column } of rows) {
        // BEFORE row triggers run before NOT NULL, CHECK and RLS checks, so a one-column insert reaches the trigger.
        await expectPgError(
          rolledBack(db.app, { orgId: a.tenant.id, userId: memberA }, (trx) =>
            sql`insert into ${sql.id(a.tenant.schemaName, table)} (${sql.id(column)}) values (${memberB})`.execute(trx),
          ),
          '23503',
          new RegExp(`User ${memberB} in column ${column} is not a member of organisation ${a.tenant.id}`),
        );
        for (const allowed of [memberA, both, SYSTEM_USER]) {
          const outcome = await rolledBack(db.app, { orgId: a.tenant.id, userId: memberA }, (trx) =>
            sql`insert into ${sql.id(a.tenant.schemaName, table)} (${sql.id(column)}) values (${allowed})`.execute(trx),
          ).then(
            () => 'inserted',
            (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`,
          );
          expect(outcome, `${table}.${column} with ${allowed}`).not.toMatch(/is not a member/);
        }
      }
    });

    it('checks updates of a person column too, and no longer counts a deleted membership', async () => {
      await expectPgError(
        rolledBack(db.app, { orgId: a.tenant.id, schema: a.tenant.schemaName }, (trx) => trx.updateTable('risk').set({ owner_user_id: memberB }).execute()),
        '23503',
        /is not a member/,
      );
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.updateTable('platform.org_membership').set({ deleted_at: new Date() }).where('user_id', '=', both).where('organization_id', '=', a.tenant.id).execute(),
      );
      await expectPgError(
        rolledBack(db.app, { orgId: a.tenant.id, schema: a.tenant.schemaName }, (trx) => trx.updateTable('risk').set({ owner_user_id: both }).execute()),
        '23503',
        /is not a member/,
      );
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.updateTable('platform.org_membership').set({ deleted_at: null }).where('user_id', '=', both).where('organization_id', '=', a.tenant.id).execute(),
      );
    });
  });

  describe('platform tables', () => {
    it('show organisation-scoped rows of the session organisation (and user) only, all rows with platform scope', async () => {
      const scoped = { orgId: a.tenant.id, userId: both };
      const read = (scope: Parameters<typeof inScope>[1]) =>
        inScope(db.app, scope, async (trx) => ({
          membership: (await trx.selectFrom('platform.org_membership').select(['organization_id', 'user_id']).execute()).map((r) => `${r.organization_id}/${r.user_id}`).sort(),
          providers: (await trx.selectFrom('platform.identity_provider').select('organization_id').execute()).map((r) => r.organization_id),
          domains: (await trx.selectFrom('platform.verified_domain').select('organization_id').execute()).map((r) => r.organization_id),
          invitations: (await trx.selectFrom('platform.invitation').select('organization_id').execute()).map((r) => r.organization_id),
          licences: (await trx.selectFrom('platform.licence').select('organization_id').execute()).map((r) => r.organization_id),
          keys: (await trx.selectFrom('platform.tenant_key').select('organization_id').execute()).map((r) => r.organization_id),
          audit: [...new Set((await trx.selectFrom('platform.audit_log').select('organization_id').execute()).map((r) => r.organization_id))],
          idempotency: (await trx.selectFrom('platform.idempotency_key').select('organization_id').execute()).map((r) => r.organization_id),
          sessions: (await trx.selectFrom('platform.session').select('user_id').execute()).map((r) => r.user_id).sort(),
        }));
      const own = await read(scoped);
      expect(own).toEqual({
        membership: [`${a.tenant.id}/${both}`, `${a.tenant.id}/${memberA}`, `${b.tenant.id}/${both}`].sort(),
        providers: [a.tenant.id],
        domains: [a.tenant.id],
        invitations: [a.tenant.id],
        licences: [a.tenant.id],
        keys: [a.tenant.id],
        audit: [a.tenant.id],
        idempotency: [a.tenant.id],
        sessions: [],
      });
      const asUser = await read({ orgId: a.tenant.id, userId: memberA });
      expect(asUser.sessions).toEqual([memberA]);
      const nothing = await read({});
      expect(Object.values(nothing).every((list) => list.length === 0)).toBe(true);

      const all = await read({ orgId: a.tenant.id, userId: both, platformScope: true });
      expect(all.providers.sort()).toEqual([a.tenant.id, b.tenant.id].sort());
      expect(all.licences.sort()).toEqual([a.tenant.id, b.tenant.id].sort());
      expect(all.keys.sort()).toEqual([a.tenant.id, b.tenant.id].sort());
      expect(all.sessions).toEqual([memberA, memberB].sort());
      expect(all.membership).toHaveLength(4);
      // Idempotency keys have no platform scope: they never cross organisations.
      expect(all.idempotency).toEqual([a.tenant.id]);
    });

    it('reject writes of rows of another organisation without platform scope', async () => {
      await expectPgError(
        rolledBack(db.app, { orgId: a.tenant.id, userId: memberA }, (trx) =>
          trx.insertInto('platform.verified_domain').values({ organization_id: b.tenant.id, domain: 'evil.co.id', verified_by: 'x' }).execute(),
        ),
        '42501',
      );
      await expectPgError(
        rolledBack(db.app, { orgId: a.tenant.id, userId: memberA }, (trx) =>
          trx.insertInto('platform.org_membership').values({ organization_id: b.tenant.id, user_id: memberB }).execute(),
        ),
        '42501',
        /row-level security/,
      );
    });

    it('grant mscd_app and mscd_pack_installer exactly the privileges of secure_platform_schema', async () => {
      const appExpected: Record<string, string[]> = {
        kysely_migration: ['SELECT'],
        kysely_migration_lock: [],
        organization: ['SELECT'],
        installation: ['SELECT'],
        app_user: ['SELECT', 'INSERT', 'UPDATE'],
        org_membership: ['SELECT', 'INSERT', 'UPDATE'],
        platform_role: ['SELECT'],
        verified_domain: ['SELECT'],
        identity_provider: ['SELECT', 'INSERT', 'UPDATE'],
        user_identity: ['SELECT', 'INSERT', 'UPDATE'],
        session: ['SELECT', 'INSERT', 'UPDATE'],
        mfa_factor: ['SELECT', 'INSERT', 'UPDATE'],
        mfa_recovery_code: ['SELECT', 'INSERT', 'UPDATE'],
        auth_transaction: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        saml_assertion_seen: ['SELECT', 'INSERT', 'DELETE'],
        password_reset_token: ['SELECT', 'INSERT', 'UPDATE'],
        invitation: ['SELECT', 'INSERT', 'UPDATE'],
        user_preference: ['SELECT', 'INSERT', 'UPDATE'],
        licence: ['SELECT', 'INSERT'],
        clock_mark: ['SELECT', 'UPDATE'],
        pack_install: ['SELECT'],
        pack_catalog: ['SELECT'],
        tenant_key: ['SELECT', 'INSERT'],
        audit_log: ['SELECT', 'INSERT'],
        audit_anchor: ['SELECT', 'INSERT'],
        rate_limit_bucket: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        idempotency_key: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        job_outbox: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        system_setting: ['SELECT'],
      };
      const packExpected: Record<string, string[]> = {
        pack_install: ['SELECT', 'INSERT', 'UPDATE'],
        pack_catalog: ['SELECT', 'INSERT', 'UPDATE'],
        audit_log: ['SELECT', 'INSERT'],
        installation: ['SELECT'],
      };
      const { rows } = await sql<{ relname: string; app: string[]; pack: string[] }>`
        select c.relname,
               array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                     where has_table_privilege('mscd_app', c.oid, p)) as app,
               array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                     where has_table_privilege('mscd_pack_installer', c.oid, p)) as pack
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'platform' and c.relkind in ('r', 'p') order by c.relname`.execute(admin);
      expect(Object.fromEntries(rows.map((r) => [r.relname, r.app]))).toEqual(appExpected);
      expect(Object.fromEntries(rows.map((r) => [r.relname, r.pack]).filter(([, p]) => p.length > 0))).toEqual(packExpected);

      const columns = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name from information_schema.column_privileges
        where grantee = 'mscd_app' and table_schema = 'platform' and privilege_type = 'UPDATE'
          and table_name in ('licence', 'organization') order by table_name, column_name`.execute(admin);
      expect(columns.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
        'licence.superseded_at',
        'organization.local_login',
        'organization.name',
        'organization.site_count',
        'organization.time_zone',
      ]);
    });

    it('enable forced RLS on exactly the organisation-scoped platform tables (D-31)', async () => {
      const { rows } = await sql<{ relname: string }>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'platform' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity
        order by c.relname`.execute(admin);
      expect(rows.map((r) => r.relname)).toEqual(
        ['audit_log', 'identity_provider', 'idempotency_key', 'invitation', 'licence', 'org_membership', 'session', 'tenant_key', 'verified_domain'].sort(),
      );
    });

    it('deny mscd_app writes to platform_role, pack_install, installation and licence.document', async () => {
      const scope = { orgId: a.tenant.id, userId: memberA, platformScope: true };
      const denied = [
        sql`insert into platform.platform_role (user_id, role) values (${memberA}, 'platform_operator')`,
        sql`update platform.platform_role set revoked_at = now()`,
        sql`update platform.pack_install set error = 'x'`,
        sql`update platform.installation set singleton = true`,
        sql`insert into platform.installation default values`,
        sql`update platform.licence set document = '{}'::jsonb`,
        sql`delete from platform.licence`,
        sql`delete from platform.audit_log`,
        sql`update platform.organization set slug = 'other'`,
      ];
      for (const statement of denied) {
        await expectPgError(rolledBack(db.app, scope, (trx) => statement.execute(trx)), '42501', /permission denied for table/);
      }
      // The two column grants work.
      await rolledBack(db.app, scope, async (trx) => {
        const licence = await sql`update platform.licence set superseded_at = now() where organization_id = ${a.tenant.id}`.execute(trx);
        expect(licence.numAffectedRows).toBe(1n);
        const org = await sql`update platform.organization set name = 'Renamed' where id = ${a.tenant.id}`.execute(trx);
        expect(org.numAffectedRows).toBe(1n);
      });
    });
  });

  describe('reference schema', () => {
    it('is read-only for mscd_app and writable (without DELETE) for mscd_pack_installer', async () => {
      const { rows } = await sql<{ relname: string; app: string[]; pack: string[] }>`
        select c.relname,
               array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                     where has_table_privilege('mscd_app', c.oid, p)) as app,
               array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                     where has_table_privilege('mscd_pack_installer', c.oid, p)) as pack
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'ref' and c.relkind = 'r' and c.relname not like 'kysely\\_%' order by c.relname`.execute(admin);
      expect(rows).toHaveLength(19);
      for (const row of rows) {
        expect([row.relname, row.app, row.pack]).toEqual([row.relname, ['SELECT'], ['SELECT', 'INSERT', 'UPDATE']]);
      }
      for (const statement of [
        sql`insert into ref.framework (code, name) values ('X', 'X')`,
        sql`update ref.requirement set title_short = 'x'`,
        sql`delete from ref.label`,
      ]) {
        await expectPgError(rolledBack(db.app, {}, (trx) => statement.execute(trx)), '42501', /permission denied for table/);
      }
      await rolledBack(db.packInstaller, {}, (trx) => sql`update ref.requirement set title_short = 'Changed by a pack'`.execute(trx));
    });
  });

  describe('object creation (C.2, C.3 readiness)', () => {
    it('lets nobody but the migrator create objects in public, ext, platform, ref or a tenant schema', async () => {
      for (const schema of ['public', 'ext', 'platform', 'ref', a.tenant.schemaName]) {
        for (const role of [db.app, db.packInstaller]) {
          await expectPgError(
            rolledBack(role, {}, (trx) => sql`create table ${sql.id(schema, 'intruder')} (id int)`.execute(trx)),
            '42501',
            new RegExp(`permission denied for schema ${schema}`),
          );
        }
        if (schema !== 'public') {
          await rolledBack(db.migrator, {}, (trx) => sql`create table ${sql.id(schema, 'migrator_ok')} (id int)`.execute(trx));
        }
      }
      for (const role of [db.app, db.packInstaller]) {
        await expectPgError(rolledBack(role, {}, (trx) => sql`create schema intruder`.execute(trx)), '42501', /permission denied for database/);
      }
    });

    it('passes the readiness privilege query, and fails it while PUBLIC or mscd_app holds CREATE', async () => {
      expect((await SCHEMA_CREATE_PRIVILEGE_QUERY.execute(db.app)).rows).toEqual([]);
      try {
        await sql`grant create on schema public to public`.execute(admin);
        const flagged = (await SCHEMA_CREATE_PRIVILEGE_QUERY.execute(db.app)).rows;
        expect(flagged).toContainEqual({ schema_name: 'public', role_name: 'PUBLIC' });
        expect(flagged).toContainEqual({ schema_name: 'public', role_name: 'mscd_app' });
      } finally {
        await sql`revoke create on schema public from public`.execute(admin);
      }
      try {
        await sql`grant create on schema ${sql.id(a.tenant.schemaName)} to mscd_app`.execute(admin);
        expect((await SCHEMA_CREATE_PRIVILEGE_QUERY.execute(db.app)).rows).toEqual([{ schema_name: a.tenant.schemaName, role_name: 'mscd_app' }]);
      } finally {
        await sql`revoke create on schema ${sql.id(a.tenant.schemaName)} from mscd_app`.execute(admin);
      }
      expect((await SCHEMA_CREATE_PRIVILEGE_QUERY.execute(db.app)).rows).toEqual([]);
    });
  });
});
