// The default providers of WP-08 against PostgreSQL: NotificationWriter (E.6), the record resolver and membership
// service without roles (D.1, F.7), the minimal Me, the keys module on platform.key, and the system profile route on
// the shared contract.
import { SystemProfile, Me } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import { NotAMemberError, NotFoundError } from '../../../src/common/problems';
import {
  AUDIT_WRITER,
  ME_ASSEMBLER,
  MEMBERSHIP_SERVICE,
  NOTIFICATION_WRITER,
  RECORD_RESOLVER,
  type AuditWriter,
  type MeAssembler,
  type MembershipService,
  type NotificationWriter,
  type RecordResolver,
  type Trx,
} from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { fakePrincipal } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, addUser, inScope } from '../db/helpers';
import { createIntApp, infoOf, type IntApp } from './helpers';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';

describe('WP-08 default providers', () => {
  const db = useTestDatabase('empty');
  let ndt: CreatedTenant;
  let bsd: CreatedTenant;
  let ctx: IntApp;
  let scope: TenantScope;
  let queue: InMemoryJobQueue;
  let isms: string;
  let qms: string;
  let users: Record<string, string>;

  const inNdt = <T>(fn: (trx: Trx) => Promise<T>): Promise<T> => scope.withTenant({ orgId: ndt.id, schema: ndt.schemaName, userId: SYSTEM_USER }, fn);

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt');
    bsd = await createTenant(db, 'bsd');
    const fw = await addFramework(db.migrator);
    isms = await addManagementSystem(db.migrator, ndt, fw.versionId, 'isms');
    qms = await addManagementSystem(db.migrator, ndt, fw.versionId, 'qms');
    users = {
      rina: await addUser(db.migrator, 'rina', [ndt.id]),
      budi: await addUser(db.migrator, 'budi', [bsd.id]),
      gone: await addUser(db.migrator, 'gone', [ndt.id]),
    };
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.updateTable('platform.org_membership').set({ status: 'disabled' }).where('user_id', '=', users.gone!).execute(),
    );
    queue = new InMemoryJobQueue({ autoRun: false });
    ctx = await createIntApp(db, {}, { overrides: (b) => b.overrideProvider(JOB_QUEUE).useValue(queue) });
    scope = ctx.moduleRef.get(TenantScope);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('creates notifications for members only and queues the dispatch after commit (E.6)', async () => {
    const writer = ctx.moduleRef.get<NotificationWriter>(NOTIFICATION_WRITER);
    const ref = { module: 'audit' as const, entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-031' };
    const id = await inNdt(async (trx) => {
      const created = await writer.create(trx, {
        recipientUserId: users.rina!,
        kind: 'reminder',
        title: ['Reminder', 'Pengingat'],
        body: { en: 'Review R-031', id: 'Tinjau R-031' },
        msId: isms,
        ref,
      });
      expect(queue.waitingJobs()).toHaveLength(0);
      return created;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(queue.waitingJobs('notifications.dispatch').map((j) => [j.env.orgId, j.env.payload])).toEqual([[ndt.id, { notificationIds: [id] }]]);
    const row = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
      trx.selectFrom('notification').selectAll().where('id', '=', id!).executeTakeFirstOrThrow(),
    );
    expect(row).toMatchObject({
      recipient_user_id: users.rina,
      management_system_id: isms,
      kind: 'reminder',
      title_en: 'Reminder',
      title_id: 'Pengingat',
      body_en: 'Review R-031',
      body_id: 'Tinjau R-031',
      entity_ref: ref,
      email_status: 'pending',
      digest: false,
      created_by: SYSTEM_USER,
    });

    const digest = await inNdt((trx) =>
      writer.create(trx, { recipientUserId: users.rina!, kind: 'evidence_aging', title: ['a', 'a'], body: ['b', 'b'], digest: true }),
    );
    expect(digest).not.toBeNull();
    expect(queue.waitingJobs('notifications.dispatch')).toHaveLength(1);

    expect(await inNdt((trx) => writer.create(trx, { recipientUserId: users.budi!, kind: 'reminder', title: ['a', 'a'], body: ['b', 'b'] }))).toBeNull();
    expect(await inNdt((trx) => writer.create(trx, { recipientUserId: users.gone!, kind: 'reminder', title: ['a', 'a'], body: ['b', 'b'] }))).toBeNull();

    await expect(
      inNdt(async (trx) => {
        await writer.create(trx, { recipientUserId: users.rina!, kind: 'reminder', title: ['x', 'x'], body: ['y', 'y'] });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(queue.waitingJobs('notifications.dispatch')).toHaveLength(1);
  });

  it('resolves members and handles among active members of the organisation (F.7)', async () => {
    const members = ctx.moduleRef.get<MembershipService>(MEMBERSHIP_SERVICE);
    await inNdt(async (trx) => {
      expect(await members.isMember(trx, users.rina!)).toBe(true);
      expect(await members.isMember(trx, users.budi!)).toBe(false);
      expect(await members.isMember(trx, users.gone!)).toBe(false);
      expect(await members.isMember(trx, 'not-a-uuid')).toBe(false);
      await expect(members.assertMember(trx, users.budi!)).rejects.toBeInstanceOf(NotAMemberError);
      expect(await members.resolveHandle(trx, 'rina')).toBe(users.rina);
      expect(await members.resolveHandle(trx, 'none')).toBeNull();
      await expect(members.resolveHandle(trx, 'budi')).rejects.toMatchObject({ extras: { rule: 'NOT-A-MEMBER' } });
      await expect(members.resolveHandle(trx, 'Not A Handle')).rejects.toBeInstanceOf(NotAMemberError);
    });
  });

  it('resolves records only inside the system of the request (D.1, F.7)', async () => {
    const resolver = ctx.moduleRef.get<RecordResolver>(RECORD_RESOLVER);
    const ids = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, async (trx) => {
      const risk = await trx
        .insertInto('risk')
        .values({ code: 'R-1', title: 'Shared risk', owner_user_id: users.rina!, risk_profile_code: 'default' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'risk', entity_id: risk.id, management_system_id: isms, is_primary: true }).execute();
      const treatment = await trx
        .insertInto('risk_treatment')
        .values({ risk_id: risk.id, management_system_id: qms, code: 'T-1', title: 'Treatment', owner_user_id: users.rina! })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { risk: risk.id, treatment: treatment.id };
    });
    await inNdt(async (trx) => {
      const risk = await resolver.resolve(trx, 'isms', 'risk', ids.risk);
      expect(risk).toMatchObject({ entityType: 'risk', id: ids.risk, ms: { id: isms, slug: 'isms' }, row: { code: 'R-1' } });
      await expect(resolver.resolve(trx, 'qms', 'risk', ids.risk)).rejects.toBeInstanceOf(NotFoundError);
      expect((await resolver.resolve(trx, 'qms', 'risk_treatment', ids.treatment, { forUpdate: true })).row.code).toBe('T-1');
      await expect(resolver.resolve(trx, 'isms', 'risk_treatment', ids.treatment)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'isms', 'platform_role', ids.risk)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'isms', 'risk', 'R-1')).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'nope', 'risk', ids.risk)).rejects.toBeInstanceOf(NotFoundError);
    });
    await scope.withTenant({ orgId: bsd.id, schema: bsd.schemaName, userId: SYSTEM_USER }, async (trx) => {
      await expect(resolver.resolve(trx, 'isms', 'risk', ids.risk)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('keeps platform scope off after writing a platform audit entry inside a tenant transaction', async () => {
    const audit = ctx.moduleRef.get<AuditWriter>(AUDIT_WRITER);
    const scopeAfter = await inNdt(async (trx) => {
      await audit.record(trx, { action: 'membership.updated', entityType: 'org_membership' });
      const { rows } = await sql<{ s: string }>`select coalesce(current_setting('app.platform_scope', true), '') as s`.execute(trx);
      return rows[0]!.s;
    });
    expect(scopeAfter).toBe('');
  });

  it('assembles a minimal Me that matches the contract', async () => {
    const me = await ctx.moduleRef.get<MeAssembler>(ME_ASSEMBLER).assemble(
      fakePrincipal({ user: { id: users.rina!, handle: 'rina', displayName: 'Rina' }, org: infoOf(ndt) }),
      { csrfToken: 'b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1' },
    );
    expect(Me.safeParse(me).success).toBe(true);
    expect(me).toMatchObject({ org: { slug: 'ndt' }, orgs: [{ id: 'ndt', ms: [], deploy: 'onprem' }], permissions: { org: [], ms: {} } });
  });

  it('opens the development platform key and serves the system profile from the shared route', async () => {
    const box = ctx.moduleRef.get(SecretBox);
    const sealed = await box.seal('secret', { purpose: 'idp', providerId: 'p-1' });
    expect(await box.openText(sealed, { purpose: 'idp', providerId: 'p-1' })).toBe('secret');
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/profile' });
    expect(response.statusCode).toBe(200);
    expect(SystemProfile.safeParse(response.json()).success).toBe(true);
  });
});
