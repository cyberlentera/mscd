// Area `test-support` (owner from wave 11: WP-27): test-profile-only endpoints (D.3 "Test support"). Mounted only when
// the profile has demo.enabled and test.endpoints_enabled; release builds refuse both keys. Every call logs at warn.
import { z } from 'zod';
import { Handle, OrgSlug, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { Me } from './me.js';

export const TestResetResponse = named('TestResetResponse', z.object({ ok: z.literal(true), durationMs: z.int().min(0) }), 'Answer of POST /test/reset', {
  valid: [{ ok: true, durationMs: 412 }],
  invalid: [{ ok: false, durationMs: 1 }],
});
export type TestResetResponse = z.infer<typeof TestResetResponse>;

export const TestSessionRequest = named('TestSessionRequest', z.strictObject({ handle: Handle, org: OrgSlug.optional() }), 'POST /test/session body: a user and an organisation (default the user default)', {
  valid: [{ handle: 'rina' }, { handle: 'bagus', org: 'bsd' }],
  invalid: [{}, { handle: 'none' }],
});
export type TestSessionRequest = z.infer<typeof TestSessionRequest>;

export const testResetRoute = defineRoute({
  id: 'test.reset',
  owner: 'WP-27',
  method: 'POST',
  path: '/api/v1/test/reset',
  summary: 'Recreate the database from the template, reset the mock providers and clear in-memory caches',
  auth: 'public',
  response: TestResetResponse,
  errors: [403],
  testOnly: true,
  readOnlyAllowed: true,
});

export const testSessionRoute = defineRoute({
  id: 'test.session',
  owner: 'WP-27',
  method: 'POST',
  path: '/api/v1/test/session',
  summary: 'Mint an active session (auth_method test, no MFA) for a user',
  auth: 'public',
  body: TestSessionRequest,
  response: Me,
  errors: [403, 404],
  testOnly: true,
  readOnlyAllowed: true,
});

export const routes: RouteDef[] = [testResetRoute, testSessionRoute];
