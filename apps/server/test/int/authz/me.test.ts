// The routes of the session user (build plan D.3, D-26, D-20): `PUT /me/org` across organisations with local, OIDC
// and guest sessions (409 `reauth-required` with the accepted methods, 404 for a non-member, a new session id on
// success), `POST /me/memberships/{org}/accept` with the licence user limit, and the demo persona switch.
import { Me } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  addOrg,
  addProvider,
  addUser,
  createAuthzApp,
  grantRole,
  platformAudit,
  resetRateLimits,
  sessionFor,
  setLocalLogin,
  type AuthzApp,
  type Org,
  type User,
} from './helpers';

describe('WP-39 session user routes (D-26, D-20)', () => {
  const db = useTestDatabase('empty');
  let ctx: AuthzApp;
  let ndt: Org;
  let bsd: Org;
  let rmn: Org;
  let rina: User;
  let bagus: User;
  let maya: User;
  let hendra: User;
  let plain: User;
  let ndtProvider: string;

  beforeAll(async () => {
    ndt = await addOrg(db, 'ndt', ['isms', 'qms']);
    bsd = await addOrg(db, 'bsd', ['isms']);
    rmn = await addOrg(db, 'rmn', ['isms']);
    rina = await addUser(db, 'rina', [{ org: ndt, adminRoles: ['tenant_admin'] }, { org: bsd }, { org: rmn, status: 'invited' }], { isDemo: true });
    bagus = await addUser(db, 'bagus', [{ org: ndt }, { org: bsd }], { isDemo: true });
    maya = await addUser(db, 'maya', [{ org: ndt }], { isDemo: true });
    hendra = await addUser(db, 'hendra', [{ org: ndt }], { isDemo: true });
    plain = await addUser(db, 'plain', [{ org: ndt }]);
    await grantRole(db, ndt, rina, 'isms', 'ms_manager');
    await grantRole(db, bsd, rina, 'isms', 'internal_auditor');
    await grantRole(db, ndt, bagus, 'isms', 'domain_owner');
    await grantRole(db, ndt, maya, 'isms', 'internal_auditor');
    await grantRole(db, ndt, hendra, 'isms', 'top_management');
    ndtProvider = await addProvider(db, ndt, 'keycloak-ndt');
    await addProvider(db, bsd, 'keycloak-bsd');
    ctx = await createAuthzApp(db);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
    await setLocalLogin(db, ctx, bsd, 'allowed');
  });

  it('switches a local session to another organisation that allows local sign-in, with a new session id', async () => {
    const client = await sessionFor(ctx, rina, { org: ndt });
    const oldCookie = client.session!;
    const response = await client.put('/api/v1/me/org', { org: 'bsd' });
    expect(response.statusCode).toBe(200);
    const me = response.json() as Me;
    expect(Me.safeParse(me).success).toBe(true);
    expect(me.org?.slug).toBe('bsd');
    expect(me.rolesByMs).toEqual({ isms: ['internal_auditor'] });
    expect(me.uiRoleByMs).toEqual({ isms: 'auditor' });
    expect(me.adminRoles).toEqual([]);
    expect(client.session).not.toBe(oldCookie);
    expect(me.csrfToken).toBe(client.csrfToken);
    // The old cookie is dead (F.1 rotation); the new one works.
    const stale = await sessionFor(ctx, rina, { org: ndt });
    stale.cookies.set('mscd_session', oldCookie);
    expect((await stale.get('/api/v1/me')).statusCode).toBe(401);
    expect(((await client.get('/api/v1/me')).json() as Me).org?.slug).toBe('bsd');
    const audit = (await platformAudit(db, 'auth.org_switched')).at(-1)!;
    expect(audit).toMatchObject({ organization_id: bsd.tenant.id, actor_user_id: rina.id, entity_id: rina.id });
    expect(audit.after_data).toMatchObject({ from: 'ndt', to: 'bsd', method: 'local' });
  });

  it('answers 409 reauth-required with the accepted methods when the organisation refuses local sign-in for the user', async () => {
    await setLocalLogin(db, ctx, bsd, 'disabled');
    const client = await sessionFor(ctx, rina, { org: ndt });
    const cookie = client.session;
    const response = await client.put('/api/v1/me/org', { org: 'bsd' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: 'https://mscd.cyberlentera.com/problems/reauth-required',
      methods: { local: false, providers: [{ slug: 'keycloak-bsd', kind: 'oidc', label: 'Sign in with keycloak-bsd' }] },
    });
    expect(client.session).toBe(cookie);
    expect(((await client.get('/api/v1/me')).json() as Me).org?.slug).toBe('ndt');

    // admins_only: rina holds no admin role in bsd, but does in ndt.
    await setLocalLogin(db, ctx, bsd, 'admins_only');
    expect((await client.put('/api/v1/me/org', { org: 'bsd' })).statusCode).toBe(409);
    await setLocalLogin(db, ctx, ndt, 'admins_only');
    const inBsd = await sessionFor(ctx, rina, { org: bsd });
    expect((await inBsd.put('/api/v1/me/org', { org: 'ndt' })).statusCode).toBe(200);
    await setLocalLogin(db, ctx, ndt, 'allowed');
  });

  it('accepts an OIDC session only in the organisation of its provider (D-26)', async () => {
    const client = await sessionFor(ctx, rina, { org: ndt, authOrg: ndt, authMethod: 'oidc', identityProviderId: ndtProvider });
    const refused = await client.put('/api/v1/me/org', { org: 'bsd' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().methods).toEqual({ local: true, providers: [{ slug: 'keycloak-bsd', kind: 'oidc', label: 'Sign in with keycloak-bsd', icon: 'generic' }] });
    // Back to the provider's organisation from elsewhere is accepted.
    const elsewhere = await sessionFor(ctx, rina, { org: bsd, authOrg: ndt, authMethod: 'oidc', identityProviderId: ndtProvider });
    const back = await elsewhere.put('/api/v1/me/org', { org: 'ndt' });
    expect(back.statusCode).toBe(200);
    expect((back.json() as Me).session.authMethod).toBe('oidc');
  });

  it('keeps a guest session in the organisation of its grant', async () => {
    const guest = await addUser(db, 'guest.one', [{ org: ndt }, { org: bsd }], { kind: 'guest' });
    await grantRole(db, ndt, guest, 'isms', 'external_auditor');
    const client = await sessionFor(ctx, guest, { org: ndt, authMethod: 'guest' });
    const refused = await client.put('/api/v1/me/org', { org: 'bsd' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().methods).toMatchObject({ local: false });
    expect((await client.put('/api/v1/me/org', { org: 'rmn' })).statusCode).toBe(404);
    expect((await client.put('/api/v1/me/org', { org: 'ndt' })).statusCode).toBe(200);
  });

  it('answers 404 for an organisation the user is not an active member of, and 403 for an inactive one', async () => {
    const client = await sessionFor(ctx, rina, { org: ndt });
    expect((await client.put('/api/v1/me/org', { org: 'rmn' })).statusCode).toBe(404);
    expect((await client.put('/api/v1/me/org', { org: 'zzz' })).statusCode).toBe(404);
    const other = await sessionFor(ctx, plain, { org: ndt });
    expect((await other.put('/api/v1/me/org', { org: 'bsd' })).statusCode).toBe(404);
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ status: 'suspended' }).where('id', '=', bsd.tenant.id).execute());
    ctx.moduleRef.get(TenantResolver).invalidate(bsd.tenant.id);
    const suspended = await client.put('/api/v1/me/org', { org: 'bsd' });
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json().type).toBe('https://mscd.cyberlentera.com/problems/organisation-inactive');
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ status: 'active' }).where('id', '=', bsd.tenant.id).execute());
    ctx.moduleRef.get(TenantResolver).invalidate(bsd.tenant.id);
  });

  it('accepts an invited membership once, within the licence user limit (D-15)', async () => {
    const client = await sessionFor(ctx, rina, { org: ndt });
    ctx.licence.userLimitReached = true;
    const limited = await client.post('/api/v1/me/memberships/rmn/accept');
    expect(limited.statusCode).toBe(422);
    expect(limited.json().rule).toBe('LIC-USERS');
    ctx.licence.userLimitReached = false;
    const accepted = await client.post('/api/v1/me/memberships/rmn/accept');
    expect(accepted.statusCode).toBe(200);
    const me = accepted.json() as Me;
    expect(me.org?.slug).toBe('ndt');
    expect(me.orgs.map((o) => o.id)).toContain('rmn');
    expect(ctx.licence.userChecks).toContain(rmn.tenant.id);
    expect((await client.post('/api/v1/me/memberships/rmn/accept')).statusCode).toBe(404);
    expect((await client.post('/api/v1/me/memberships/bsd/accept')).statusCode).toBe(404);
    const audit = (await platformAudit(db, 'membership.updated')).at(-1)!;
    expect(audit).toMatchObject({ organization_id: rmn.tenant.id, entity_id: rina.id });
    expect(audit.after_data).toMatchObject({ status: 'active', accepted: true });
    // The new membership is switchable now.
    expect((await client.put('/api/v1/me/org', { org: 'rmn' })).statusCode).toBe(200);
  });

  it('lists the demo personas for a demo user and switches persona with a new session (D-20)', async () => {
    const client = await sessionFor(ctx, rina, { org: ndt });
    const me = (await client.get('/api/v1/me')).json() as Me;
    expect(me.personas).toEqual({
      manager: { who: 'rina', label: ['MS Manager', 'Manajer SM'] },
      owner: { who: 'bagus', label: ['Domain Owner', 'Pemilik Domain'] },
      auditor: { who: 'maya', label: ['Internal Auditor', 'Auditor Internal'] },
      top: { who: 'hendra', label: ['Top Management', 'Manajemen Puncak'] },
    });
    const old = client.session;
    const switched = await client.post('/api/v1/auth/demo/persona', { role: 'owner' });
    expect(switched.statusCode).toBe(200);
    const persona = switched.json() as Me;
    expect(Me.safeParse(persona).success).toBe(true);
    expect(persona.user.handle).toBe('bagus');
    expect(persona.uiRoleByMs).toEqual({ isms: 'owner' });
    expect(persona.session.authMethod).toBe('demo');
    expect(client.session).not.toBe(old);
    expect(((await client.get('/api/v1/me')).json() as Me).user.handle).toBe('bagus');
    expect((await platformAudit(db, 'auth.persona_switch')).at(-1)!.after_data).toMatchObject({ role: 'owner', from: 'rina', to: 'bagus' });
    // A user that is not a demo user gets no personas and cannot switch.
    const other = await sessionFor(ctx, plain, { org: ndt });
    expect(((await other.get('/api/v1/me')).json() as Me).personas).toBeUndefined();
    expect((await other.post('/api/v1/auth/demo/persona', { role: 'manager' })).statusCode).toBe(403);
    // A persona who is not a member of the current organisation: 404.
    const inBsd = await sessionFor(ctx, bagus, { org: bsd });
    expect((await inBsd.post('/api/v1/auth/demo/persona', { role: 'top' })).statusCode).toBe(404);
  });

  it('answers 404 to the persona switch when demo personas are off', async () => {
    const off = await createAuthzApp(db, { env: { MSCD__DEMO__PERSONAS: 'false' } });
    try {
      const client = await sessionFor(off, rina, { org: ndt });
      expect((await client.post('/api/v1/auth/demo/persona', { role: 'owner' })).statusCode).toBe(404);
      expect(((await client.get('/api/v1/me')).json() as Me).personas).toBeUndefined();
    } finally {
      await off.close();
    }
    void maya;
    void hendra;
  });
});
