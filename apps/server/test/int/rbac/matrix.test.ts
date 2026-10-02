// Generated RBAC tests (build plan J.5, F.6, F.7): for every route of the route table that a signed-in user calls,
// and every role of F.6, a user holding only that role calls the route with a valid input built from the schema
// examples, and the authorisation guard must deny it (403, counted by `mscd_authz_denied_total`) or admit it
// (whatever the service then answers) exactly as the matrix says. Routes whose permission depends on a request
// member (`permissionBy`) are called once per case. Every answer is also checked against the route's contract
// (J.3: declared status codes, response and problem schemas, F.13 file headers).
import { API_ROUTES, permissionCase, type RouteDef } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  ROLE_KEYS, addRoleUsers, callRoute, createFullApp, exampleInput, examplesOf, guardDenials, resetRateLimits, sessionFor,
  type Client, type FullApp, type RoleKey, type RouteInput,
} from '../contract/harness';
import { expectedAllowed } from './expectations';

/** Routes a signed-in user calls: the `session` and `any_session` routes, test-only routes left out. */
const SWEPT = API_ROUTES.filter((r) => (r.auth === 'session' || r.auth === 'any_session') && !r.testOnly && r.id !== 'auth.logout');

/** The inputs of one route: one per `permissionBy` case (a value of the member that selects the case), else one. */
function inputsOf(def: RouteDef): { label: string; member?: unknown; input: RouteInput }[] {
  if (!def.permissionBy) return [{ label: '', input: exampleInput(def, { ms: 'isms' }) }];
  const { source, member, cases } = def.permissionBy;
  const schema = source === 'path' ? def.params : source === 'body' ? def.body : def.query;
  const out: { label: string; member?: unknown; input: RouteInput }[] = [];
  const seen = new Set<string>();
  for (const example of examplesOf(schema) as Record<string, unknown>[]) {
    const value = example?.[member];
    const chosen = permissionCase(def.permissionBy, value);
    const caseKey = Object.entries(cases).find(([, c]) => c === chosen)![0];
    if (seen.has(caseKey)) continue;
    seen.add(caseKey);
    const base = exampleInput(def, { ms: 'isms' });
    const override: RouteInput =
      source === 'path' ? { params: { [member]: value } } : source === 'body' ? { body: { ...(example as object), ...('ms' in example ? { ms: 'isms' } : {}) } } : { query: { ...example } };
    out.push({ label: ` (${member} ${String(value)})`, member: value, input: exampleInput(def, { ms: 'isms', override: { ...override, params: { ...base.params, ...(override.params ?? {}) } } }) });
  }
  const missing = Object.keys(cases).filter((k) => !seen.has(k));
  if (missing.length > 0) throw new Error(`${def.id}: the schema examples cover no value of the permissionBy cases ${missing.join(', ')}`);
  return out;
}

describe('J.5 generated RBAC tests: every route and every role of F.6', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  const clients = {} as Record<RoleKey, Client>;

  beforeAll(async () => {
    full = await createFullApp(db);
    const users = await addRoleUsers(db, 'tst', 'isms');
    for (const role of ROLE_KEYS) clients[role] = await sessionFor(full, users[role].id, 'tst');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('sweeps every signed-in route', () => {
    expect(SWEPT.length).toBeGreaterThan(140);
  });

  for (const def of SWEPT) {
    it(`${def.id}: ${def.method} ${def.path}`, async () => {
      const mismatches: string[] = [];
      const violations: string[] = [];
      for (const { label, member, input } of inputsOf(def)) {
        await resetRateLimits(db);
        for (const role of ROLE_KEYS) {
          const before = await guardDenials(full, def.id);
          const call = await callRoute(clients[role], def, input);
          const denied = (await guardDenials(full, def.id)) > before;
          const expected = expectedAllowed(def, role, member);
          if (denied === expected) {
            mismatches.push(`${role}${label}: expected ${expected ? 'admitted' : 'denied'}, the guard ${denied ? 'denied' : 'admitted'} (${call.status} ${call.text.slice(0, 160)})`);
          }
          if (denied && call.status !== 403) mismatches.push(`${role}${label}: a guard denial answered ${call.status}`);
          violations.push(...call.violations.map((v) => `${role}${label}: ${v}`));
        }
      }
      expect(mismatches).toEqual([]);
      expect(violations).toEqual([]);
    });
  }
});
