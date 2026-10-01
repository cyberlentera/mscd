// Storage routing (A-37, BR-38, A-50, D.3 routing routes): precedence of `RoutingService.resolve`, one active rule
// per scope, BR-38 confirmation and second-Tenant-Admin approval for restricted files in the SaaS Managed Vault,
// the four-eyes flow for a Tenant Admin who is MS Manager of the system, and the single-admin behaviour.
import { CommandResult, RoutingRuleView } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LICENCE_GATE } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { RoutingService } from '../../../src/modules/storage/routing.service';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenantScope, systemContextOf } from '../../../src/modules/tenancy/tenant-scope';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, inScope } from '../db/helpers';
import { createIntApp, infoOf, type IntApp } from '../platform/helpers';
import { addStorageUsers, storageLicenceGate } from './helpers';

describe('storage routing rules (A-37, BR-38, A-50)', () => {
  const db = useTestDatabase('empty');
  let ctx: IntApp;
  let ndt: CreatedTenant;
  let tst: CreatedTenant;
  let systems: Record<string, string>;
  let soloSystems: Record<string, string>;

  const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method, url, headers: { [FAKE_PRINCIPAL_HEADER]: who }, ...(payload ? { payload } : {}) });
  const rules = async (who = 'ta2') => (await call(who, 'GET', '/api/v1/admin/storage/routing-rules')).json<RoutingRuleView[]>().map((r) => RoutingRuleView.parse(r));
  const resolve = (tenant: CreatedTenant, msId: string, classification: 'public' | 'internal' | 'confidential' | 'restricted' | null, objectKind: 'document' | 'evidence' | null = null) =>
    ctx.moduleRef
      .get(TenantScope)
      .withTenant(systemContextOf({ id: tenant.id, schema: tenant.schemaName }), (trx) => ctx.moduleRef.get(RoutingService).resolve(trx, { msId, classification, objectKind }))
      .then((decision) => [decision.repository.slug, decision.mode, decision.ruleId !== null] as const);

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt', { demoDeployLabel: 'saas' });
    tst = await createTenant(db, 'tst', { demoDeployLabel: 'saas' });
    const fw = await addFramework(db.migrator);
    systems = { isms: await addManagementSystem(db.migrator, ndt, fw.versionId, 'isms'), qms: await addManagementSystem(db.migrator, ndt, fw.versionId, 'qms') };
    soloSystems = { isms: await addManagementSystem(db.migrator, tst, fw.versionId, 'isms') };
    // A SharePoint repository of ndt (a row written directly: the repository routes are tested elsewhere).
    await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
      trx
        .insertInto('storage_repository')
        .values({ slug: 'sp', name: 'SharePoint Online', adapter: 'm365', modes: ['link', 'pass_through'], config: JSON.stringify({ driveId: 'd' }), position: 1 })
        .execute(),
    );
    const ndtInfo = { ...infoOf(ndt), demoDeployLabel: 'saas' as const };
    const tstInfo = { ...infoOf(tst), demoDeployLabel: 'saas' as const };
    const main = await addStorageUsers(
      db,
      ndt,
      systems,
      {
        ta1: { handle: 'ta.one', orgRoles: ['tenant_admin'], rolesByMs: { isms: ['ms_manager'] } },
        ta2: { handle: 'ta.two', orgRoles: ['tenant_admin'] },
        sa: { handle: 'sa.one', orgRoles: ['storage_admin'] },
        mm: { handle: 'mm.qms', rolesByMs: { qms: ['ms_manager'] } },
      },
      ndtInfo,
    );
    const solo = await addStorageUsers(db, tst, soloSystems, { solo: { handle: 'solo.admin', orgRoles: ['tenant_admin'], rolesByMs: { isms: ['ms_manager'] } } }, tstInfo);
    ctx = await createIntApp(
      db,
      { imports: [StorageModule] },
      {
        auth: { identities: { ...main.identities, ...solo.identities } },
        overrides: (builder) => builder.overrideProvider(LICENCE_GATE).useValue(storageLicenceGate()),
      },
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('routes to the default repository of the system without rules', async () => {
    expect(await rules()).toEqual([]);
    expect(await resolve(ndt, systems.isms!, 'internal', 'evidence')).toEqual(['vault', 'stored', false]);
  });

  it('applies the most specific active rule: system, then classification, then object kind (A-37)', async () => {
    const isms = await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', repository: 'sp', mode: 'link', priority: 50, note: 'Default link' });
    expect(isms.statusCode).toBe(201);
    expect(CommandResult.parse(isms.json())).toMatchObject({ changed: ['isms'], data: { approvalStatus: 'active' } });
    const orgWide = await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { classification: 'confidential', repository: 'sp', mode: 'pass_through', priority: 10 });
    expect(CommandResult.parse(orgWide.json()).changed).toEqual(['isms', 'qms']);
    const documents = await call('sa', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', classification: 'restricted', objectKind: 'document', repository: 'sp', mode: 'pass_through', priority: 5 });
    expect(documents.statusCode).toBe(201);

    expect(await resolve(ndt, systems.isms!, 'internal', 'evidence')).toEqual(['sp', 'link', true]);
    expect(await resolve(ndt, systems.isms!, 'confidential', 'evidence')).toEqual(['sp', 'link', true]);
    expect(await resolve(ndt, systems.qms!, 'confidential', 'evidence')).toEqual(['sp', 'pass_through', true]);
    expect(await resolve(ndt, systems.qms!, 'internal', 'evidence')).toEqual(['vault', 'stored', false]);
    expect(await resolve(ndt, systems.isms!, 'restricted', 'document')).toEqual(['sp', 'pass_through', true]);
    expect(await resolve(ndt, systems.isms!, 'restricted', 'evidence')).toEqual(['sp', 'link', true]);

    // A mode the repository does not offer, an unknown repository or system.
    expect((await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'qms', repository: 'sp', mode: 'zero_transit', priority: 1 })).statusCode).toBe(422);
    expect((await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'qms', repository: 'gd', mode: 'link', priority: 1 })).statusCode).toBe(404);
    expect((await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'bcms', repository: 'sp', mode: 'link', priority: 1 })).statusCode).toBe(404);
    // Only Tenant and Storage Admins manage routing.
    expect((await call('mm', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'qms', repository: 'sp', mode: 'link', priority: 1 })).statusCode).toBe(403);
    expect((await call('mm', 'GET', '/api/v1/admin/storage/routing-rules')).statusCode).toBe(200);
  });

  it('keeps one active rule per scope: a new rule supersedes the old one', async () => {
    const replaced = await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', repository: 'sp', mode: 'pass_through', priority: 40 });
    expect(replaced.statusCode).toBe(201);
    const list = await rules();
    const ismsDefault = list.filter((r) => r.ms === 'isms' && r.classification === null && r.objectKind === null);
    expect(ismsDefault.map((r) => [r.mode, r.approvalStatus]).sort()).toEqual([
      ['link', 'superseded'],
      ['pass_through', 'active'],
    ]);
    expect(await resolve(ndt, systems.isms!, 'internal')).toEqual(['sp', 'pass_through', true]);
  });

  it('asks for confirmation and a second Tenant Admin before restricted files go to the SaaS vault (BR-38)', async () => {
    const qmsRestricted = await call('ta2', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'qms', classification: 'restricted', repository: 'sp', mode: 'link', priority: 30 });
    expect(qmsRestricted.statusCode).toBe(201);

    const unconfirmed = await call('ta1', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'qms', classification: 'restricted', repository: 'vault', mode: 'stored', priority: 1 });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      type: expect.stringMatching(/confirmation-required$/),
      rule: 'BR-38',
      affected: ['QMS'],
      messages: { en: "Restricted files will be stored in the provider's cloud. This change needs a second approval." },
    });
    const confirmed = await call('ta1', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'qms', classification: 'restricted', repository: 'vault', mode: 'stored', priority: 1, confirm: true });
    expect(confirmed.statusCode).toBe(201);
    const result = CommandResult.parse(confirmed.json());
    expect(result).toMatchObject({ changed: [], data: { approvalStatus: 'pending_approval', rule: 'BR-38' }, message: ['Routing change waiting for approval by another Tenant Admin', expect.any(String)] });
    const id = (result.data as { id: string }).id;
    // Pending changes do not route.
    expect(await resolve(ndt, systems.qms!, 'restricted')).toEqual(['sp', 'link', true]);

    const self = await call('ta1', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`);
    expect(self.statusCode).toBe(422);
    expect(self.json()).toMatchObject({ rule: 'BR-38', messageKey: 'storage.routing.same_person' });
    expect((await call('sa', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`)).statusCode).toBe(403);
    const approved = await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(CommandResult.parse(approved.json())).toMatchObject({ changed: ['qms'], data: { approvalStatus: 'active' } });
    expect(await resolve(ndt, systems.qms!, 'restricted')).toEqual(['vault', 'stored', true]);
    const rule = (await rules()).find((r) => r.id === id)!;
    expect(rule).toMatchObject({ approvalStatus: 'active', requestedBy: 'ta.one', approvedBy: 'ta.two' });
    expect((await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`)).statusCode).toBe(409);

    const audit = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
      trx.selectFrom('audit_trail').select(['action', 'after_data']).where('entity_id', '=', id).orderBy('seq').execute(),
    );
    expect(audit.map((a) => a.action)).toEqual(['storage.routing.requested', 'storage.routing.approved']);
    expect(audit[0]!.after_data).toMatchObject({ approvalStatus: 'pending_approval', br38: true });
  });

  it('needs another Tenant Admin when a Tenant Admin changes the routing of a system they manage (four-eyes)', async () => {
    const requested = await call('ta1', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', classification: 'internal', repository: 'sp', mode: 'link', priority: 20 });
    expect(requested.statusCode).toBe(201);
    const result = CommandResult.parse(requested.json());
    expect(result.data).toMatchObject({ approvalStatus: 'pending_approval' });
    const id = (result.data as { id: string }).id;
    expect(await resolve(ndt, systems.isms!, 'internal')).toEqual(['sp', 'pass_through', true]);
    const self = await call('ta1', 'POST', `/api/v1/admin/storage/routing-rules/${id}/reject`);
    expect(self.statusCode).toBe(422);
    expect(self.json()).not.toHaveProperty('rule');
    const rejected = await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${id}/reject`);
    expect(CommandResult.parse(rejected.json()).data).toMatchObject({ approvalStatus: 'rejected' });
    expect((await rules()).find((r) => r.id === id)?.approvalStatus).toBe('rejected');

    // A change to an active rule waits as a new row while the old rule keeps routing.
    const active = (await rules()).find((r) => r.ms === 'isms' && r.classification === null && r.objectKind === null && r.approvalStatus === 'active')!;
    const patched = await call('ta1', 'PATCH', `/api/v1/admin/storage/routing-rules/${active.id}`, { mode: 'link' });
    expect(patched.statusCode).toBe(200);
    const pendingId = (CommandResult.parse(patched.json()).data as { id: string }).id;
    expect(pendingId).not.toBe(active.id);
    expect(await resolve(ndt, systems.isms!, 'public')).toEqual(['sp', 'pass_through', true]);
    expect((await call('ta1', 'PATCH', `/api/v1/admin/storage/routing-rules/${active.id}`, { classification: 'public' })).statusCode).toBe(409);
    await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${pendingId}/approve`);
    expect(await resolve(ndt, systems.isms!, 'public')).toEqual(['sp', 'link', true]);
    expect((await rules()).find((r) => r.id === active.id)?.approvalStatus).toBe('superseded');
    // A Tenant Admin who does not manage the system changes it at once.
    const direct = await call('ta2', 'PATCH', `/api/v1/admin/storage/routing-rules/${pendingId}`, { priority: 33, note: 'Reviewed' });
    expect(CommandResult.parse(direct.json()).data).toMatchObject({ id: pendingId, approvalStatus: 'active' });
  });

  it('activates a pending four-eyes change only through approval, never through a PATCH by someone else', async () => {
    const requested = await call('ta1', 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', classification: 'internal', repository: 'sp', mode: 'link', priority: 20 });
    expect(requested.statusCode).toBe(201);
    const id = (CommandResult.parse(requested.json()).data as { id: string; approvalStatus: string }).id;
    expect(CommandResult.parse(requested.json()).data).toMatchObject({ approvalStatus: 'pending_approval' });
    const before = await resolve(ndt, systems.isms!, 'internal');

    // A Storage Admin cannot approve, and a PATCH does not activate the change either; nor does one by the other Tenant Admin.
    expect((await call('sa', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`)).statusCode).toBe(403);
    for (const who of ['sa', 'ta2']) {
      const patched = await call(who, 'PATCH', `/api/v1/admin/storage/routing-rules/${id}`, { note: 'ok' });
      expect(patched.statusCode).toBe(409);
      expect(patched.json()).toMatchObject({ type: expect.stringMatching(/conflict$/), messageKey: 'storage.routing.pending' });
    }
    expect((await rules()).find((r) => r.id === id)).toMatchObject({ approvalStatus: 'pending_approval', requestedBy: 'ta.one', approvedBy: null, note: null });
    expect(await resolve(ndt, systems.isms!, 'internal')).toEqual(before);

    // The requester may still edit the request; it stays pending because the same approval check runs for them.
    // The edit is a new row and supersedes the version the approvers may have loaded.
    const edited = await call('ta1', 'PATCH', `/api/v1/admin/storage/routing-rules/${id}`, { mode: 'pass_through', note: 'Edited' });
    expect(edited.statusCode).toBe(200);
    const editedId = (CommandResult.parse(edited.json()).data as { id: string }).id;
    expect(editedId).not.toBe(id);
    expect(CommandResult.parse(edited.json())).toMatchObject({ changed: [], data: { id: editedId, approvalStatus: 'pending_approval' } });
    expect((await rules()).find((r) => r.id === id)).toMatchObject({ mode: 'link', note: null, approvalStatus: 'superseded', approvedBy: null });
    expect((await rules()).find((r) => r.id === editedId)).toMatchObject({ mode: 'pass_through', note: 'Edited', approvalStatus: 'pending_approval', requestedBy: 'ta.one', approvedBy: null });
    expect(await resolve(ndt, systems.isms!, 'internal')).toEqual(before);
    const audit = async (entityId: string) =>
      inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
        trx.selectFrom('audit_trail').select(['action', 'after_data']).where('entity_id', '=', entityId).orderBy('seq').execute(),
      );
    expect((await audit(id)).map((a) => a.action)).toEqual(['storage.routing.requested']);
    expect(await audit(editedId)).toEqual([{ action: 'storage.routing.requested', after_data: expect.objectContaining({ replaces: id, note: 'Edited' }) }]);

    // An approver who loaded the earlier version cannot approve it, and nobody edits it any more.
    const stale = await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ type: expect.stringMatching(/conflict$/), messageKey: 'storage.routing.superseded' });
    expect((await call('ta1', 'PATCH', `/api/v1/admin/storage/routing-rules/${id}`, { note: 'Again' })).statusCode).toBe(409);
    expect(await resolve(ndt, systems.isms!, 'internal')).toEqual(before);

    const approved = await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${editedId}/approve`);
    expect(approved.statusCode).toBe(200);
    expect((await rules()).find((r) => r.id === editedId)).toMatchObject({ approvalStatus: 'active', requestedBy: 'ta.one', approvedBy: 'ta.two' });
    expect(await resolve(ndt, systems.isms!, 'internal')).toEqual(['sp', 'pass_through', true]);
    expect((await audit(editedId)).map((a) => a.action)).toEqual(['storage.routing.requested', 'storage.routing.approved']);
    expect((await rules()).find((r) => r.id === id)?.approvalStatus).toBe('superseded');
  });

  it('never loses an approval to a concurrent edit by the requester, and never approves a version edited meanwhile', async () => {
    for (let round = 0; round < 6; round += 1) {
      const requested = await call('ta1', 'POST', '/api/v1/admin/storage/routing-rules', {
        ms: 'isms', classification: 'confidential', objectKind: 'evidence', repository: 'sp', mode: 'link', priority: 40, note: `Round ${round}`,
      });
      expect(requested.statusCode).toBe(201);
      const id = (CommandResult.parse(requested.json()).data as { id: string }).id;
      const [edit, approve] = await Promise.all([
        call('ta1', 'PATCH', `/api/v1/admin/storage/routing-rules/${id}`, { note: `Round ${round} edited` }),
        call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${id}/approve`),
      ]);
      expect(edit.statusCode).toBe(200);
      const editedId = (CommandResult.parse(edit.json()).data as { id: string; approvalStatus: string }).id;
      expect(editedId).not.toBe(id);
      expect(CommandResult.parse(edit.json()).data).toMatchObject({ approvalStatus: 'pending_approval' });
      const all = await rules();
      const original = all.find((r) => r.id === id)!;
      expect(all.find((r) => r.id === editedId)).toMatchObject({ note: `Round ${round} edited`, approvalStatus: 'pending_approval', approvedBy: null });
      const actions = (
        await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) =>
          trx.selectFrom('audit_trail').select('action').where('entity_id', '=', id).orderBy('seq').execute(),
        )
      ).map((a) => a.action);
      if (approve.statusCode === 200) {
        // The approval came first: it stays in force, and the edit waits as a new request.
        expect(original).toMatchObject({ note: `Round ${round}`, approvalStatus: 'active', approvedBy: 'ta.two' });
        expect(actions).toEqual(['storage.routing.requested', 'storage.routing.approved']);
      } else {
        // The edit came first: the approver's version is gone, so nothing was approved.
        expect(approve.statusCode).toBe(409);
        expect(approve.json()).toMatchObject({ messageKey: 'storage.routing.superseded' });
        expect(original).toMatchObject({ note: `Round ${round}`, approvalStatus: 'superseded', approvedBy: null });
        expect(actions).toEqual(['storage.routing.requested']);
      }
      const active = all.filter((r) => r.ms === 'isms' && r.classification === 'confidential' && r.objectKind === 'evidence' && r.approvalStatus === 'active');
      expect(active.length).toBeLessThanOrEqual(1);
      // Clean up: the second Tenant Admin rejects the edited request.
      expect((await call('ta2', 'POST', `/api/v1/admin/storage/routing-rules/${editedId}/reject`)).statusCode).toBe(200);
    }
  });

  it('with a single Tenant Admin: four-eyes changes apply with an audit entry, BR-38 changes cannot be activated (A-50)', async () => {
    const solo = (method: 'POST', url: string, payload: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: { [FAKE_PRINCIPAL_HEADER]: 'solo' }, payload });
    const internal = await solo('POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', classification: 'internal', repository: 'vault', mode: 'stored', priority: 10 });
    expect(internal.statusCode).toBe(201);
    const id = (CommandResult.parse(internal.json()).data as { id: string }).id;
    expect(CommandResult.parse(internal.json()).data).toMatchObject({ approvalStatus: 'active' });
    const audit = await inScope(db.migrator, { orgId: tst.id, schema: tst.schemaName }, (trx) =>
      trx.selectFrom('audit_trail').select(['action', 'after_data']).where('entity_id', '=', id).orderBy('seq').execute(),
    );
    expect(audit.map((a) => a.action)).toEqual(['storage.routing.requested', 'storage.routing.approved']);
    expect(audit[1]!.after_data).toEqual({ approval: 'single_tenant_admin' });

    const restricted = await solo('POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', classification: 'restricted', repository: 'vault', mode: 'stored', priority: 1, confirm: true });
    expect(restricted.statusCode).toBe(201);
    const result = CommandResult.parse(restricted.json());
    expect(result.data).toMatchObject({ approvalStatus: 'pending_approval' });
    expect(result.message![0]).toMatch(/only one, so the change cannot be activated yet/);
    expect(await resolve(tst, soloSystems.isms!, 'restricted')).toEqual(['vault', 'stored', false]);
  });
});
