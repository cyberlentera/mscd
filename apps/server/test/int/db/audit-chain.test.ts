// Audit hash chains (C.4 chain_hash and audit_canonical_text, F.11): inserts chain per table, the F.11 verification
// query finds tampering done around the application role, and both chains and the anchors are append-only.
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser, chainVerificationQuery, connect, expectPgError, inScope, rolledBack, uuid } from './helpers';

describe('audit chains (F.11)', () => {
  const db = useTestDatabase('empty');
  let admin: Kysely<DB>;
  let tenant: CreatedTenant;
  let user: string;

  beforeAll(async () => {
    admin = connect(db.urls.admin, 'mscd-test-admin');
    tenant = await createTenant(db, 'chain');
    user = await addUser(db.migrator, 'auditor.user', [tenant.id]);
  });

  afterAll(async () => {
    await admin?.destroy();
  });

  const tenantScope = () => ({ orgId: tenant.id, schema: tenant.schemaName, userId: user });

  it('numbers and links audit_trail rows and the verification query accepts the chain', async () => {
    const entries = [
      { action: 'risk.created', entity_code: 'R-01', after_data: JSON.stringify({ title: 'Data leak' }) },
      { action: 'risk.updated', entity_code: 'R-01', before_data: JSON.stringify({ title: 'Data leak' }), after_data: JSON.stringify({ title: 'Data loss' }) },
      { action: 'document.created', entity_code: 'DOC-01', source_ip: '203.0.113.7', user_agent: 'Mozilla/5.0', request_id: 'req-12345678' },
    ];
    for (const entry of entries) {
      await inScope(db.app, tenantScope(), (trx) =>
        trx.insertInto('audit_trail').values({ actor_kind: 'user', actor_user_id: user, entity_type: 'risk', entity_id: uuid(), ...entry }).execute(),
      );
    }
    await inScope(db.app, tenantScope(), async (trx) => {
      const rows = await trx.selectFrom('audit_trail').select(['seq', 'prev_hash', 'row_hash', 'organization_id']).orderBy('seq').execute();
      expect(rows.map((r) => r.seq)).toEqual(['1', '2', '3']);
      expect(rows.every((r) => r.organization_id === tenant.id && r.row_hash.length === 32)).toBe(true);
      expect(rows[0]!.prev_hash.length).toBe(0);
      expect(rows[1]!.prev_hash.equals(rows[0]!.row_hash)).toBe(true);
      expect(rows[2]!.prev_hash.equals(rows[1]!.row_hash)).toBe(true);
      expect((await chainVerificationQuery('audit_trail').execute(trx)).rows[0]).toEqual({ checked: '3', first_broken_seq: null });
    });
  });

  it('ignores a seq or hash sent by the writer: the trigger sets them', async () => {
    await inScope(db.app, tenantScope(), async (trx) => {
      // The Kysely type refuses these columns (GeneratedAlways); a raw statement shows the trigger overrides them.
      const { rows } = await sql<{ seq: string; prev_hash: Buffer }>`
        insert into audit_trail (actor_kind, action, seq, prev_hash, row_hash)
        values ('system', 'freshness.downgrade', 999, 'forged'::bytea, 'forged'::bytea)
        returning seq, prev_hash`.execute(trx);
      expect(rows[0]!.seq).toBe('4');
      expect(rows[0]!.prev_hash.toString()).not.toBe('forged');
      expect((await chainVerificationQuery('audit_trail').execute(trx)).rows[0]).toEqual({ checked: '4', first_broken_seq: null });
    });
  });

  it('chains platform.audit_log the same way', async () => {
    const before = await inScope(db.migrator, { platformScope: true }, (trx) => chainVerificationQuery('platform.audit_log').execute(trx));
    expect(before.rows[0]!.first_broken_seq).toBeNull();
    await inScope(db.app, { orgId: tenant.id, userId: user }, (trx) =>
      trx.insertInto('platform.audit_log').values({ organization_id: tenant.id, actor_kind: 'user', actor_user_id: user, action: 'auth.login' }).execute(),
    );
    const after = await inScope(db.migrator, { platformScope: true }, (trx) => chainVerificationQuery('platform.audit_log').execute(trx));
    expect(Number(after.rows[0]!.checked)).toBe(Number(before.rows[0]!.checked) + 1);
    expect(after.rows[0]!.first_broken_seq).toBeNull();
  });

  it('serialises concurrent writers into one gap-free chain', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        inScope(db.app, tenantScope(), (trx) => trx.insertInto('audit_trail').values({ actor_kind: 'user', actor_user_id: user, action: `concurrent.${i}` }).execute()),
      ),
    );
    const check = await inScope(db.app, tenantScope(), (trx) => chainVerificationQuery('audit_trail').execute(trx));
    expect(check.rows[0]).toEqual({ checked: '12', first_broken_seq: null });
  });

  it('builds canonical texts that differ when only the place of a | differs, and do not depend on the time zone', async () => {
    const id = uuid();
    const text = (action: string, entityType: string, timeZone = 'UTC') =>
      admin.transaction().execute(async (trx) => {
        await sql`select set_config('timezone', ${timeZone}, true)`.execute(trx);
        const { rows } = await sql<{ t: string; h: Buffer }>`
          select platform.audit_canonical_text(1, ${id}::uuid, '2026-09-29 10:00:00+07'::timestamptz, null, null, null, 'user',
                   ${action}, ${entityType}, null, null, null, null, null, null, '203.0.113.7'::inet, null) as t,
                 sha256(convert_to(platform.audit_canonical_text(1, ${id}::uuid, '2026-09-29 10:00:00+07'::timestamptz, null, null,
                   null, 'user', ${action}, ${entityType}, null, null, null, null, null, null, '203.0.113.7'::inet, null), 'UTF8')) as h`.execute(trx);
        return rows[0]!;
      });
    const left = await text('a|b', 'c');
    const right = await text('a', 'b|c');
    expect(left.t).not.toBe(right.t);
    expect(left.h.equals(right.h)).toBe(false);
    expect(left.t).toBe(`[1, "${id}", "2026-09-29T03:00:00.000000Z", null, null, null, "user", "a|b", "c", null, null, null, null, null, null, "203.0.113.7", null]`);
    expect((await text('a|b', 'c', 'Asia/Jakarta')).t).toBe(left.t);
    expect((await text('a|b', 'c', 'America/New_York')).t).toBe(left.t);
  });

  it('detects a row inserted by a superuser with the triggers disabled', async () => {
    const forged = sql`insert into ${sql.id(tenant.schemaName, 'audit_trail')}
        (seq, organization_id, actor_kind, action, prev_hash, row_hash)
      select max(seq) + 1, ${tenant.id}, 'user', 'risk.deleted',
             (select row_hash from ${sql.id(tenant.schemaName, 'audit_trail')} order by seq desc limit 1),
             sha256('not the canonical text'::bytea)
      from ${sql.id(tenant.schemaName, 'audit_trail')}`;
    await admin.transaction().execute(async (trx) => {
      await sql`alter table ${sql.id(tenant.schemaName, 'audit_trail')} disable trigger user`.execute(trx);
      await forged.execute(trx);
      await sql`alter table ${sql.id(tenant.schemaName, 'audit_trail')} enable trigger user`.execute(trx);
    });
    const check = await inScope(db.app, tenantScope(), (trx) => chainVerificationQuery('audit_trail').execute(trx));
    expect(check.rows[0]).toEqual({ checked: '13', first_broken_seq: '13' });
  });

  it('detects an earlier row changed by a superuser with the triggers disabled', async () => {
    await admin.transaction().execute(async (trx) => {
      await sql`alter table ${sql.id(tenant.schemaName, 'audit_trail')} disable trigger user`.execute(trx);
      await sql`update ${sql.id(tenant.schemaName, 'audit_trail')} set after_data = '{"title": "Nothing happened"}' where seq = 2`.execute(trx);
      await sql`alter table ${sql.id(tenant.schemaName, 'audit_trail')} enable trigger user`.execute(trx);
    });
    const check = await inScope(db.app, tenantScope(), (trx) => chainVerificationQuery('audit_trail').execute(trx));
    expect(check.rows[0]!.first_broken_seq).toBe('2');
  });

  describe('append-only tables (forbid_change)', () => {
    let anchorId: string;

    beforeAll(async () => {
      const anchor = await inScope(db.app, {}, (trx) =>
        trx
          .insertInto('platform.audit_anchor')
          .values({ chain: `tenant:${tenant.id}`, seq: '12', row_hash: Buffer.alloc(32), payload: JSON.stringify({ seq: 12 }), signature: 'sig', key_id: 'anchor-dev' })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      anchorId = anchor.id;
    });

    it('refuses UPDATE, DELETE and TRUNCATE of audit_trail even to the owning migrator', async () => {
      for (const statement of [
        sql`update audit_trail set action = 'changed' where seq = 1`,
        sql`delete from audit_trail where seq = 1`,
      ]) {
        await expectPgError(
          rolledBack(db.migrator, tenantScope(), (trx) => statement.execute(trx)),
          '42501',
          /(UPDATE|DELETE) on org_chain\.audit_trail is not allowed: the table is append-only/,
        );
      }
      await expectPgError(
        rolledBack(db.migrator, tenantScope(), (trx) => sql`truncate audit_trail`.execute(trx)),
        '42501',
        /TRUNCATE on org_chain\.audit_trail is not allowed/,
      );
    });

    it('refuses UPDATE and DELETE of platform.audit_anchor and changes of platform.audit_log', async () => {
      for (const [statement, pattern] of [
        [sql`update platform.audit_anchor set signature = 'forged' where id = ${anchorId}`, /UPDATE on platform\.audit_anchor is not allowed/],
        [sql`delete from platform.audit_anchor where id = ${anchorId}`, /DELETE on platform\.audit_anchor is not allowed/],
        [sql`update platform.audit_log set action = 'changed'`, /UPDATE on platform\.audit_log is not allowed/],
        [sql`delete from platform.audit_log`, /DELETE on platform\.audit_log is not allowed/],
        [sql`truncate platform.audit_log`, /TRUNCATE on platform\.audit_log is not allowed/],
      ] as const) {
        await expectPgError(rolledBack(db.migrator, { platformScope: true }, (trx) => statement.execute(trx)), '42501', pattern);
      }
      // mscd_app has no UPDATE or DELETE privilege on them in the first place.
      await expectPgError(
        rolledBack(db.app, {}, (trx) => sql`update platform.audit_anchor set signature = 'forged'`.execute(trx)),
        '42501',
        /permission denied for table audit_anchor/,
      );
    });
  });
});
