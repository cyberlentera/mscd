// Identity cases that span several modules (build plan J.5 "Identity", D-25, D-26, F.1, F.4, F.8, F.14), on the full
// api application and the demo organisations `ndt` and `tst`, which `rina` both belongs to:
// - a session pinned to `tst` through a provider of `tst` cannot switch to `ndt` (409 reauth-required), and a local
//   session cannot switch to an organisation whose local sign-in is disabled;
// - an invitation is redeemed once; a second use and an invitation of another organisation fail;
// - a guest access link works once, and after the grant is revoked neither the link nor a returning guest's code
//   request opens anything.
// The OIDC and SAML paths that need an identity provider (invitations only through the inviting organisation's
// providers, a provider of organisation A refused for organisation B) are covered with Keycloak in `test/int/sso`.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newGuestLinkToken } from '../../../src/modules/identity/guest/guest-tokens';
import { sha256 } from '../../../src/modules/identity/tokens';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import type { TestingModule } from '@nestjs/testing';
import { SessionService } from '../../../src/modules/identity/session.service';
import { totpAt } from '../../../src/modules/identity/totp';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { addFactor, addProvider } from '../identity/helpers';
import {
  addFixtureUser, anonymous, APP_ORIGIN, COOKIE, createFullApp, demoSession, ORG_IDS, rowsIn, sessionFor, userIdOf, type FullApp,
} from '../contract/harness';

const REAUTH = 'https://mscd.cyberlentera.com/problems/reauth-required';

describe('J.5 identity across organisations, invitations and guests', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let rinaId: string;

  const setLocalLogin = async (org: keyof typeof ORG_IDS, policy: 'allowed' | 'admins_only' | 'disabled') => {
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ local_login: policy }).where('id', '=', ORG_IDS[org]).execute());
    full.get<TenantResolver>(TenantResolver).invalidate(ORG_IDS[org]);
  };

  beforeAll(async () => {
    full = await createFullApp(db);
    rinaId = await userIdOf(db, 'rina');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('keeps a session signed in through a provider of tst out of ndt (409 reauth-required), while a local session may switch', async () => {
    const providerId = await addProvider(db, ORG_IDS.tst, 'wp30-tst-idp', 'TST IdP');
    const viaIdp = await sessionFor(full, rinaId, 'tst', { authMethod: 'oidc', identityProviderId: providerId });
    const refused = await viaIdp.put('/api/v1/me/org', { org: 'ndt' });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body).toMatchObject({ type: REAUTH });
    // The session stays in tst and keeps working there.
    expect((await viaIdp.get<{ org: { slug: string } }>('/api/v1/me')).status).toBe(200);
    expect((await viaIdp.get('/api/v1/ui/ms/isms')).status).toBe(200);
    // A local session of the same user may switch (both organisations allow local sign-in).
    const local = await sessionFor(full, rinaId, 'tst');
    expect((await local.put('/api/v1/me/org', { org: 'ndt' })).status).toBe(200);
  });

  it('refuses a local session the switch into an organisation whose local sign-in is disabled', async () => {
    await setLocalLogin('ndt', 'disabled');
    try {
      const local = await sessionFor(full, rinaId, 'tst');
      const refused = await local.put('/api/v1/me/org', { org: 'ndt' });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body).toMatchObject({ type: REAUTH });
    } finally {
      await setLocalLogin('ndt', 'allowed');
    }
  });

  it('audits the provider and the subject when an OIDC sign-in ends at the local TOTP step (F.8 step 5)', async () => {
    const providerId = await addProvider(db, ORG_IDS.tst, 'wp30-tst-totp', 'TST IdP with local TOTP');
    const user = await addFixtureUser(db, 'tst', 'wp30-sso-totp', { business: [{ ms: 'isms', role: 'top_management' }] });
    const secret = await addFactor(db, full.app as unknown as TestingModule, user.id);
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.user_identity').values({ identity_provider_id: providerId, subject: 'kc-subject-wp30', user_id: user.id, link_method: 'admin', last_login_at: new Date() }).execute(),
    );
    // The session the OIDC callback creates when the amr claim proves no MFA (F.5 `local_totp`).
    const issued = await full.get<TenantScope>(TenantScope).withTenant({ orgId: ORG_IDS.tst, schema: 'org_tst', userId: user.id }, (trx) =>
      full.get<SessionService>(SessionService).create(trx, {
        userId: user.id, organizationId: ORG_IDS.tst, authOrgId: ORG_IDS.tst, state: 'mfa_pending', authMethod: 'oidc', identityProviderId: providerId,
        authGrantId: null, amr: ['pwd'], passwordAt: null, mfaAt: null,
      }),
    );
    const verified = await full.app.inject({
      method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { code: totpAt(secret, Date.now()) },
      headers: { origin: APP_ORIGIN, cookie: `${COOKIE}=${issued.cookieValue}`, 'x-csrf-token': issued.csrfToken },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const [login] = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select(['after_data']).where('action', '=', 'auth.login').where('entity_id', '=', user.id).orderBy('seq', 'desc').limit(1).execute(),
    );
    expect(login!.after_data).toMatchObject({ method: 'oidc', secondFactor: 'totp', identityProviderId: providerId, provider: 'wp30-tst-totp', subject: 'kc-subject-wp30', amr: ['pwd'] });
  });

  it('redeems an invitation once; a second use fails and changes nothing', async () => {
    const token = randomBytes(32).toString('base64url');
    const email = 'wp30-invitee@wp30.test';
    const userId = await inScope(db.migrator, { platformScope: true }, async (trx) => {
      const user = await trx.insertInto('platform.app_user').values({ handle: 'wp30-invitee', email, display_name: 'WP-30 invitee', status: 'invited' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('platform.org_membership').values({ organization_id: ORG_IDS.tst, user_id: user.id, admin_roles: [], status: 'invited', is_default: true }).execute();
      const creator = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', 'rina').executeTakeFirstOrThrow();
      await trx.insertInto('platform.invitation').values({
        token_hash: sha256(token), organization_id: ORG_IDS.tst, user_id: user.id, email, created_by: creator.id, expires_at: new Date(Date.now() + 3_600_000),
      }).execute();
      return user.id;
    });
    const accept = (password: string) => anonymous(full).post('/api/v1/auth/invitations/accept', { token, password });
    const first = await accept('a much longer passphrase one');
    expect(first.status, first.text).toBe(200);
    const usedAt = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.invitation').select('used_at').where('user_id', '=', userId).executeTakeFirstOrThrow(),
    );
    expect(usedAt.used_at).not.toBeNull();
    const hashBefore = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.app_user').select('password_hash').where('id', '=', userId).executeTakeFirstOrThrow(),
    );
    const second = await accept('another much longer passphrase');
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    const hashAfter = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.app_user').select('password_hash').where('id', '=', userId).executeTakeFirstOrThrow(),
    );
    expect(hashAfter.password_hash).toEqual(hashBefore.password_hash);
  });

  it('opens a guest access link once, and nothing after the grant is revoked', async () => {
    const guestId = await userIdOf(db, 'ext.auditor');
    const [grant] = await rowsIn<{ id: string; email: string }>(db, 'tst', sql`select id, email from auditor_access_grant where user_id = ${guestId} and revoked_at is null`);
    const token = newGuestLinkToken(ORG_IDS.tst);
    const setLink = () => rowsIn(db, 'tst', sql`update auditor_access_grant set token_hash = ${sha256(token)}, link_used_at = null where id = ${grant!.id}`);
    const transactions = async () =>
      (await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.selectFrom('platform.auth_transaction').select((eb) => eb.fn.countAll<string>().as('n')).where('kind', '=', 'guest_otp').executeTakeFirstOrThrow(),
      )).n;
    const guestClient = anonymous(full);

    await setLink();
    const opened = await guestClient.post('/api/v1/auth/guest/start', { token });
    expect(opened.status, opened.text).toBeLessThan(300);
    const afterFirst = Number(await transactions());
    expect(afterFirst).toBeGreaterThan(0);
    // The link works once.
    const reused = await guestClient.post('/api/v1/auth/guest/start', { token });
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(Number(await transactions())).toBe(afterFirst);

    // Revoked: a fresh link and a returning guest's code request open nothing.
    await setLink();
    const rina = await demoSession(full, db, 'rina', 'tst');
    expect((await rina.post(`/api/v1/ms/isms/auditor-access/${grant!.id}/revoke`, {})).status).toBe(200);
    const pendingAfterRevoke = Number(await transactions());
    const afterRevoke = await guestClient.post('/api/v1/auth/guest/start', { token });
    expect(afterRevoke.status).toBeGreaterThanOrEqual(400);
    const login = await guestClient.post('/api/v1/auth/guest/login', { email: grant!.email });
    expect(login.status).toBeLessThan(500);
    expect(Number(await transactions())).toBe(pendingAfterRevoke);
  });
});
