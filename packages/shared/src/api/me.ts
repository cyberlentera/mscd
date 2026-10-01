// Area `me` (owner from wave 6: WP-39): the session user, organisation switch (D-26), memberships, preferences and
// the demo persona switch (D-20).
import { z } from 'zod';
import { AuthMethod, BusinessRole, OrgRole, PlatformRole, UiRole } from '../enums.js';
import { Organisation } from '../ui/records.js';
import { RolesMap } from '../ui/snapshot.js';
import { EXAMPLE_ME } from '../examples.js';
import { Handle, Instant, MsId, NoBody, OrgSlug, PermissionSet, Uuid, defineRoute, named, utf8ByteLength } from './common.js';
import type { RouteDef } from './common.js';


export const MeUser = named(
  'MeUser',
  z.object({ id: Uuid, handle: Handle, email: z.email(), displayName: z.string(), jobTitle: z.string().nullable() }),
  'The session user (D.2 Me.user)',
  { valid: [EXAMPLE_ME.user, { ...EXAMPLE_ME.user, jobTitle: null }], invalid: [{ ...EXAMPLE_ME.user, email: 'rina' }, { ...EXAMPLE_ME.user, handle: 'none' }] },
);
export type MeUser = z.infer<typeof MeUser>;

export const MeOrg = named(
  'MeOrg',
  z.object({ id: Uuid, slug: OrgSlug, name: z.string() }),
  'Current organisation of the session',
  { valid: [EXAMPLE_ME.org], invalid: [{ id: 'ndt', slug: 'ndt', name: 'x' }] },
);
export type MeOrg = z.infer<typeof MeOrg>;

export const MeSession = named(
  'MeSession',
  z.object({ authMethod: AuthMethod, idleExpiresAt: Instant, absoluteExpiresAt: Instant }),
  'How the session was authenticated and when it expires (F.1)',
  { valid: [EXAMPLE_ME.session], invalid: [{ ...EXAMPLE_ME.session, authMethod: 'password' }] },
);
export type MeSession = z.infer<typeof MeSession>;

export const Me = named(
  'Me',
  z.object({
    user: MeUser,
    org: MeOrg.nullable(),
    orgs: z.array(Organisation),
    rolesByMs: z.record(MsId, z.array(BusinessRole)),
    uiRoleByMs: z.record(MsId, UiRole),
    adminRoles: z.array(OrgRole),
    platformRoles: z.array(PlatformRole),
    permissions: PermissionSet,
    csrfToken: z.string().min(16),
    session: MeSession,
    personas: RolesMap.optional(),
    preferences: z.record(z.string(), z.unknown()),
  }),
  'Session user, current organisation, roles and permissions per system, CSRF token and preferences (D.2). org is null only for a platform operator without a membership',
  {
    valid: [
      EXAMPLE_ME,
      { ...EXAMPLE_ME, personas: { manager: { who: 'rina', label: ['MS Manager', 'Manajer SM'] }, owner: { who: 'bagus', label: ['Domain Owner', 'Pemilik Domain'] } } },
      { ...EXAMPLE_ME, org: null, orgs: [], rolesByMs: {}, uiRoleByMs: {}, adminRoles: [], platformRoles: ['platform_operator'], permissions: { org: ['ops.read'], ms: {} } },
    ],
    invalid: [{ ...EXAMPLE_ME, uiRoleByMs: { isms: 'admin' } }, { ...EXAMPLE_ME, csrfToken: undefined }, { ...EXAMPLE_ME, rolesByMs: { isms: ['manager'] } }],
  },
);
export type Me = z.infer<typeof Me>;

export const SwitchOrgRequest = named('SwitchOrgRequest', z.strictObject({ org: OrgSlug }), 'PUT /me/org body; 409 reauth-required carries the accepted methods (D-26)', {
  valid: [{ org: 'bsd' }],
  invalid: [{ org: 'BSD' }, {}, { org: 'bsd', ms: 'isms' }],
});
export type SwitchOrgRequest = z.infer<typeof SwitchOrgRequest>;

export const DemoPersonaRequest = named('DemoPersonaRequest', z.strictObject({ role: UiRole }), 'POST /auth/demo/persona body (demo mode, D-20)', {
  valid: [{ role: 'owner' }],
  invalid: [{ role: 'admin' }, {}],
});
export type DemoPersonaRequest = z.infer<typeof DemoPersonaRequest>;

/** Most bytes the preferences document may have (D.3: 16 KiB). */
export const MAX_PREFERENCES_BYTES = 16 * 1024;

export const PreferencesBody = named(
  'PreferencesBody',
  z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,59}$/), z.unknown()).refine(
    (v) => utf8ByteLength(JSON.stringify(v)) <= MAX_PREFERENCES_BYTES,
    { message: 'Preferences must not exceed 16 KiB' },
  ),
  'PUT /me/preferences body: preference keys (at most 60 characters) to JSON values, at most 16 KiB in all',
  {
    valid: [{ lang: 'id', density: 'compact' }, {}],
    invalid: [{ 'bad key': 1 }, { blob: 'x'.repeat(MAX_PREFERENCES_BYTES) }],
  },
);
export type PreferencesBody = z.infer<typeof PreferencesBody>;

export const MembershipParams = named('MembershipParams', z.strictObject({ org: OrgSlug }), 'Path parameter {org}', {
  valid: [{ org: 'bsd' }],
  invalid: [{ org: 'B' }],
});

export const meGetRoute = defineRoute({
  id: 'me.get',
  owner: 'WP-39',
  method: 'GET',
  path: '/api/v1/me',
  summary: 'Session user with roles, UI role and permissions per system',
  auth: 'session',
  response: Me,
  errors: [],
});

export const meSwitchOrgRoute = defineRoute({
  id: 'me.switch-org',
  owner: 'WP-39',
  method: 'PUT',
  path: '/api/v1/me/org',
  summary: 'Switch the current organisation; 409 reauth-required when it does not accept the session authentication (D-26)',
  auth: 'session',
  body: SwitchOrgRequest,
  response: Me,
  errors: [404, 409],
  readOnlyAllowed: true,
});

export const meAcceptMembershipRoute = defineRoute({
  id: 'me.membership.accept',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/me/memberships/:org/accept',
  summary: 'Accept an invited membership of another organisation',
  auth: 'session',
  params: MembershipParams,
  response: Me,
  errors: [404],
});

export const mePreferencesRoute = defineRoute({
  id: 'me.preferences',
  owner: 'WP-11',
  method: 'PUT',
  path: '/api/v1/me/preferences',
  summary: 'Store the preferences of the session user (at most 16 KiB)',
  auth: 'session',
  body: PreferencesBody,
  response: NoBody,
  status: 204,
  errors: [413],
  readOnlyAllowed: true,
});

export const authDemoPersonaRoute = defineRoute({
  id: 'auth.demo-persona',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/auth/demo/persona',
  summary: 'Demo mode: switch to the persona of a UI role; answers 404 when demo mode is off (D-20)',
  auth: 'session',
  body: DemoPersonaRequest,
  response: Me,
  errors: [404],
  readOnlyAllowed: true,
});

export const routes: RouteDef[] = [meGetRoute, meSwitchOrgRoute, meAcceptMembershipRoute, mePreferencesRoute, authDemoPersonaRoute];
