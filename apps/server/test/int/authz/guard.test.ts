// The authorisation guard with real sessions and roles (build plan F.7): external auditors only on GET routes of the
// audited system, never on `GET /admin/audit-trail/verify` and `/anchors` (no system named) and never writing as a
// guest; `auditor.read` for every external auditor request with the route id and the record refs returned;
// `authz.denied` with the system id, listed in the system's full-entry view; the CSV export's `file.downloaded` entry
// with the system id.
import { Controller } from '@nestjs/common';
import { defineRoute, MsParams } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiRoute, CurrentAuthz } from '../../../src/common/api-route';
import type { AuthzState } from '../../../src/common/tokens';
import { useTestDatabase } from '../../setup/test-db';
import {
  addOrg,
  addUser,
  createAuthzApp,
  grantRole,
  resetRateLimits,
  sessionFor,
  tenantAudit,
  type AuthzApp,
  type Client,
  type Org,
  type User,
} from './helpers';

const Ok = z.object({ ok: z.literal(true) }).passthrough();
const base = { owner: 'WP-39' as const, summary: 'probe', errors: [] as number[], response: Ok };
const REF = { module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-031' } as const;
const routes = {
  read: defineRoute({ ...base, id: 'probe.read', method: 'GET', path: '/api/v1/ms/:ms/probe', auth: 'session', permission: 'ms.read', scope: 'ms', params: MsParams }),
  write: defineRoute({ ...base, id: 'probe.write', method: 'POST', path: '/api/v1/ms/:ms/probe', auth: 'session', permission: 'ms.read', scope: 'ms', params: MsParams }),
  manage: defineRoute({
    ...base, id: 'probe.manage', method: 'POST', path: '/api/v1/ms/:ms/probe/manage', auth: 'session', permission: 'applicability.manage', scope: 'ms', params: MsParams,
  }),
  sessionRead: defineRoute({ ...base, id: 'probe.session-read', method: 'GET', path: '/api/v1/probe/session', auth: 'session' }),
  sessionWrite: defineRoute({ ...base, id: 'probe.session-write', method: 'POST', path: '/api/v1/probe/session', auth: 'session' }),
};

@Controller()
class ProbeController {
  @ApiRoute(routes.read)
  read(@CurrentAuthz() authz: AuthzState) {
    return { ok: true, ownOnly: authz.ownOnly, items: [{ ref: REF, title: 'Ransomware' }], refs: { 'isms:x:R-031': REF } };
  }

  @ApiRoute(routes.write)
  write() {
    return { ok: true };
  }

  @ApiRoute(routes.manage)
  manage() {
    return { ok: true };
  }

  @ApiRoute(routes.sessionRead)
  sessionRead() {
    return { ok: true };
  }

  @ApiRoute(routes.sessionWrite)
  sessionWrite() {
    return { ok: true };
  }
}

describe('WP-39 authorisation guard (F.7)', () => {
  const db = useTestDatabase('empty');
  let ctx: AuthzApp;
  let ndt: Org;
  let mm: User;
  let owner: User;
  let auditor: User;
  let auditorClient: Client;

  beforeAll(async () => {
    ndt = await addOrg(db, 'ndt', ['isms', 'qms']);
    mm = await addUser(db, 'mm', [{ org: ndt }]);
    owner = await addUser(db, 'owner', [{ org: ndt }]);
    auditor = await addUser(db, 'ext.auditor', [{ org: ndt }], { kind: 'guest' });
    await grantRole(db, ndt, mm, 'isms', 'ms_manager');
    await grantRole(db, ndt, owner, 'isms', 'domain_owner');
    await grantRole(db, ndt, auditor, 'isms', 'external_auditor');
    ctx = await createAuthzApp(db, { controllers: [ProbeController] });
    auditorClient = await sessionFor(ctx, auditor, { org: ndt, authMethod: 'guest' });
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('admits an external auditor on GET routes of the audited system and writes auditor.read with the refs returned', async () => {
    const response = await auditorClient.get('/api/v1/ms/isms/probe');
    expect(response.statusCode).toBe(200);
    const entries = await tenantAudit(db, ndt, 'auditor.read');
    const entry = entries.at(-1)!;
    expect(entry).toMatchObject({ actor_user_id: auditor.id, actor_kind: 'guest', management_system_id: ndt.systems.isms, entity_type: 'route', entity_code: 'probe.read' });
    expect(entry.after_data).toMatchObject({
      routeId: 'probe.read',
      ms: 'isms',
      outcome: 'ok',
      params: { ms: 'isms' },
      refCount: 1,
      refs: [{ entityType: 'risk', id: REF.id, entityCode: 'R-031' }],
    });
    // Another system of the organisation: no role there.
    expect((await auditorClient.get('/api/v1/ms/qms/probe')).statusCode).toBe(403);
    // Other users' reads are not auditor reads.
    const before = (await tenantAudit(db, ndt, 'auditor.read')).length;
    const manager = await sessionFor(ctx, mm, { org: ndt });
    expect((await manager.get('/api/v1/ms/isms/probe')).statusCode).toBe(200);
    expect(await tenantAudit(db, ndt, 'auditor.read')).toHaveLength(before);
  });

  it('refuses every write of an external auditor, also where the permission alone would admit it (F.7)', async () => {
    const response = await auditorClient.post('/api/v1/ms/isms/probe');
    expect(response.statusCode).toBe(403);
    expect(response.json().type).toBe('https://mscd.cyberlentera.com/problems/forbidden');
    const denied = (await tenantAudit(db, ndt, 'authz.denied')).filter((e) => e.entity_code === 'probe.write');
    expect(denied.at(-1)).toMatchObject({ actor_user_id: auditor.id, management_system_id: ndt.systems.isms });
    // A guest never writes on business routes, even without a permission check.
    expect((await auditorClient.post('/api/v1/probe/session')).statusCode).toBe(403);
    // Reads of auth-only business routes are auditor reads too.
    expect((await auditorClient.get('/api/v1/probe/session')).statusCode).toBe(200);
    expect((await tenantAudit(db, ndt, 'auditor.read')).at(-1)).toMatchObject({ entity_code: 'probe.session-read', management_system_id: null });
    // The user's own session routes stay available.
    expect((await auditorClient.put('/api/v1/me/preferences', { lang: 'id' })).statusCode).toBe(204);
    // A non-guest member writes where the permission admits it.
    const manager = await sessionFor(ctx, mm, { org: ndt });
    expect((await manager.post('/api/v1/ms/isms/probe')).statusCode).toBe(200);
  });

  it('keeps external auditors out of the audit trail routes that name no system, and in the audited system only', async () => {
    expect((await auditorClient.get('/api/v1/admin/audit-trail/verify')).statusCode).toBe(403);
    expect((await auditorClient.get('/api/v1/admin/audit-trail/anchors')).statusCode).toBe(403);
    expect((await auditorClient.get('/api/v1/admin/audit-trail')).statusCode).toBe(403);
    const own = await auditorClient.get('/api/v1/admin/audit-trail?ms=isms');
    expect(own.statusCode).toBe(200);
    expect((await auditorClient.get('/api/v1/admin/audit-trail?ms=qms')).statusCode).toBe(403);
    expect((await tenantAudit(db, ndt, 'auditor.read')).at(-1)).toMatchObject({ entity_code: 'audit-trail.list', management_system_id: ndt.systems.isms });
    // The MS Manager passes the same routes through the any_ms check.
    const manager = await sessionFor(ctx, mm, { org: ndt });
    expect((await manager.get('/api/v1/admin/audit-trail/verify')).statusCode).toBe(200);
    expect((await manager.get('/api/v1/admin/audit-trail/anchors')).statusCode).toBe(200);
  });

  it('stops admitting an auditor whose grant has expired', async () => {
    const late = await addUser(db, 'late.auditor', [{ org: ndt }], { kind: 'guest' });
    await grantRole(db, ndt, late, 'isms', 'external_auditor', { validUntil: new Date(ctx.clock.now().getTime() + 60_000) });
    const client = await sessionFor(ctx, late, { org: ndt, authMethod: 'guest' });
    expect((await client.get('/api/v1/ms/isms/probe')).statusCode).toBe(200);
    ctx.clock.advance(120_000);
    expect((await client.get('/api/v1/ms/isms/probe')).statusCode).toBe(403);
  });

  it('writes authz.denied with the system id, listed in the system view, and the export file.downloaded entry likewise (F.11)', async () => {
    const client = await sessionFor(ctx, owner, { org: ndt });
    expect((await client.post('/api/v1/ms/isms/probe/manage')).statusCode).toBe(403);
    const denied = (await tenantAudit(db, ndt, 'authz.denied')).filter((e) => e.entity_code === 'probe.manage');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor_user_id: owner.id, management_system_id: ndt.systems.isms });
    expect(denied[0]!.after_data).toEqual({ routeId: 'probe.manage', permissions: ['applicability.manage'], ms: 'isms' });

    const manager = await sessionFor(ctx, mm, { org: ndt });
    const view = await manager.get('/api/v1/admin/audit-trail?ms=isms');
    expect(view.statusCode).toBe(200);
    const actions = (view.json() as { items: { action: string; entityCode?: string | null }[] }).items.map((i) => `${i.action}:${i.entityCode ?? ''}`);
    expect(actions).toContain('authz.denied:probe.manage');

    const exported = await manager.get('/api/v1/admin/audit-trail/export?ms=isms&format=csv');
    expect(exported.statusCode).toBe(200);
    const downloads = await tenantAudit(db, ndt, 'file.downloaded');
    expect(downloads.at(-1)).toMatchObject({ actor_user_id: mm.id, management_system_id: ndt.systems.isms, entity_type: 'audit_trail' });
    // An unknown system is 404 before anything is written.
    expect((await manager.get('/api/v1/admin/audit-trail/export?ms=nope&format=csv')).statusCode).toBe(404);
  });

  it('marks own-only grants for the services (F.7 ownOnly)', async () => {
    const client = await sessionFor(ctx, owner, { org: ndt });
    const own = await client.get('/api/v1/ms/isms/probe');
    expect(own.statusCode).toBe(200);
    expect(own.json().ownOnly).toBe(true);
    const manager = await sessionFor(ctx, mm, { org: ndt });
    expect((await manager.get('/api/v1/ms/isms/probe')).json().ownOnly).toBe(false);
    expect((await client.get('/api/v1/ms/qms/probe')).statusCode).toBe(403);
    expect((await client.get('/api/v1/ms/nope/probe')).statusCode).toBe(404);
  });
});
