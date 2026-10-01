// The identity calls of the web follow the shared route table (packages/shared, WP-05): same method and path, and
// the auth level that decides whether a 401 means "the session ended" (H.4).
import { describe, expect, it } from 'vitest';
import { AUTH_ROUTES } from '../../src/auth/api';
import { ApiClient } from '../../src/data/api/ApiClient';
import { routeById } from '../../../../packages/shared/src/api/routes';
import { fakeFetch, problem } from './helpers';

const SHARED_IDS: Record<keyof typeof AUTH_ROUTES, string> = {
  profile: 'system.profile',
  me: 'me.get',
  switchOrg: 'me.switch-org',
  providers: 'auth.providers',
  login: 'auth.login',
  mfaVerify: 'auth.mfa.verify',
  enrolStart: 'auth.mfa.enrol.start',
  enrolConfirm: 'auth.mfa.enrol.confirm',
  logout: 'auth.logout',
  resetRequest: 'auth.password.reset-request',
  reset: 'auth.password.reset',
  invitationAccept: 'auth.invitation.accept',
  guestStart: 'auth.guest.start',
  guestLogin: 'auth.guest.login',
  guestVerify: 'auth.guest.verify',
};

describe('identity routes', () => {
  it('match the method and path of the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(AUTH_ROUTES) as [keyof typeof AUTH_ROUTES, readonly [string, string]][]) {
      const def = routeById(SHARED_IDS[name]);
      expect(def, SHARED_IDS[name]).toBeDefined();
      expect([method, path]).toEqual([def?.method, def?.path]);
    }
  });

  it('a 401 of a shared route tells the session listeners exactly for the session auth levels', async () => {
    for (const id of Object.values(SHARED_IDS)) {
      const def = routeById(id);
      if (!def) throw new Error(`no shared route ${id}`);
      const { fetch } = fakeFetch({ [`${def.method} ${def.path}`]: problem(401, 'unauthenticated') });
      const client = new ApiClient({ fetch });
      let told = false;
      let signedOut = false;
      client.onUnauthenticated(() => {
        told = true;
      });
      client.onSignedOut(() => {
        signedOut = true;
      });
      await client.call(def, {});
      // A 401 of the sign-out route means nobody is signed in any more: a sign-out, not an ended session.
      const logout = id === 'auth.logout';
      expect([id, told, signedOut]).toEqual([id, !logout && (def.auth === 'session' || def.auth === 'any_session'), logout]);
    }
  });
});
