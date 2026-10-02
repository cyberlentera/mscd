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

/** The values a schema member may take when it is an enumeration (zod `enum` options), else []. */
function enumValues(schema: unknown, member: string): string[] {
  const shape = (schema as { shape?: Record<string, { options?: unknown[] }> } | undefined)?.shape;
  const options = shape?.[member]?.options;
  return Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : [];
}

/** True when the input names a system where the route reads one (F.7: an ms check without a system fails). */
function namesSystem(def: RouteDef, input: RouteInput): boolean {
  const source = def.msSource ?? (/:ms(\/|$)/.test(def.path) ? 'path' : undefined);
  if (!source) return false;
  const holder = (source === 'path' ? input.params : source === 'body' ? input.body : input.query) as { ms?: unknown } | undefined;
  return typeof holder?.ms === 'string' && holder.ms !== '';
}

interface Case {
  label: string;
  member?: unknown;
  input: RouteInput;
}

/**
 * The inputs of one route: one per `permissionBy` case (a value of the member that selects the case); for routes that
 * read the system from the body or the query, one with and one without `ms` when the schema allows both; else one.
 */
function inputsOf(def: RouteDef): Case[] {
  if (def.permissionBy) {
    const { source, member, cases } = def.permissionBy;
    const schema = source === 'path' ? def.params : source === 'body' ? def.body : def.query;
    const values = new Map<string, unknown>();
    for (const example of examplesOf(schema) as Record<string, unknown>[]) {
      const value = example?.[member];
      const caseKey = Object.entries(cases).find(([, c]) => c === permissionCase(def.permissionBy!, value))![0];
      if (!values.has(caseKey)) values.set(caseKey, source === 'path' ? value : example);
    }
    for (const caseKey of Object.keys(cases)) {
      if (values.has(caseKey) || source !== 'path') continue;
      const value = caseKey === '*' ? enumValues(schema, member).find((v) => !Object.hasOwn(cases, v)) : caseKey;
      if (value !== undefined) values.set(caseKey, value);
    }
    const missing = Object.keys(cases).filter((k) => !values.has(k));
    if (missing.length > 0) throw new Error(`${def.id}: no input selects the permissionBy cases ${missing.join(', ')}`);
    return [...values.entries()].map(([caseKey, value]) => {
      if (source === 'path') {
        return { label: ` (${member} ${String(value)}, case ${caseKey})`, member: value, input: exampleInput(def, { ms: 'isms', override: { params: { [member]: value } } }) };
      }
      const example = value as Record<string, unknown>;
      const body = 'ms' in example ? { ...example, ms: 'isms' } : example;
      return {
        label: ` (${member} ${String(example[member])}, case ${caseKey})`,
        member: example[member],
        input: exampleInput(def, { ms: 'isms', override: source === 'body' ? { body } : { query: body } }),
      };
    });
  }
  const base = exampleInput(def, { ms: 'isms' });
  if (def.msSource !== 'body' && def.msSource !== 'query') return [{ label: '', input: base }];
  const schema = def.msSource === 'body' ? def.body : def.query;
  const holder = ((def.msSource === 'body' ? base.body : base.query) ?? {}) as Record<string, unknown>;
  const { ms: _ms, ...without } = holder;
  const out: Case[] = [];
  const withMs = { ...holder, ms: 'isms' };
  if (schema?.safeParse(withMs).success) out.push({ label: ' (with ms)', input: { ...base, ...(def.msSource === 'body' ? { body: withMs } : { query: withMs }) } });
  if (schema?.safeParse(without).success) out.push({ label: ' (without ms)', input: { ...base, ...(def.msSource === 'body' ? { body: without } : { query: without }) } });
  return out.length > 0 ? out : [{ label: '', input: base }];
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
          const expected = expectedAllowed(def, role, member, namesSystem(def, input));
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
