// The route table against build plan D.1, D.3 and D.5: every endpoint is present once, with a valid owner,
// permission, machine and path parameter schema.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_ROUTES, GATEWAY_ROUTES, MACHINES, PERMISSION_MATRIX, RECORD_ENTITY_TYPES, ROUTE_AREAS, WORK_PACKAGE_IDS, NoBody,
  machinePermissions, pathParamNames, routeArea, routeById, routes,
} from '../src/index.js';
import type { MachineEntity, Permission, RouteDef } from '../src/index.js';
import { fastifyPath, planApiEndpoints, planGatewayEndpoints, planWorkPackages } from './helpers.js';

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

function objectKeys(schema: z.ZodType | undefined): string[] {
  if (!schema) return [];
  if (!(schema instanceof z.ZodObject)) throw new Error('not an object schema');
  return Object.keys(schema.shape).sort();
}

function hasMember(schema: z.ZodType | undefined, member: string): boolean {
  if (!schema) return false;
  if (schema instanceof z.ZodObject) return member in schema.shape;
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) {
    return (schema.options as z.ZodType[]).every((o) => hasMember(o, member));
  }
  if (schema instanceof z.ZodPipe) return hasMember(schema.in as z.ZodType, member);
  return false;
}

describe('route table against the plan', () => {
  const planApi = planApiEndpoints().map((e) => ({ method: e.method, path: fastifyPath(e.path, '/api/v1') }));
  const planGateway = planGatewayEndpoints();

  it('reads the D.3 and D.5 tables', () => {
    expect(planApi.length).toBeGreaterThan(150);
    expect(planGateway.length).toBe(16);
  });

  it('has every D.3 endpoint, with the parameter names of the plan', () => {
    const have = new Set(API_ROUTES.map(key));
    expect(planApi.map(key).filter((k) => !have.has(k))).toEqual([]);
  });

  it('has every D.5 gateway endpoint', () => {
    const have = new Set(GATEWAY_ROUTES.map(key));
    expect(planGateway.map(key).filter((k) => !have.has(k))).toEqual([]);
  });

  it('has no endpoint the plan does not list', () => {
    const plan = new Set([...planApi, ...planGateway].map(key));
    expect(routes.map(key).filter((k) => !plan.has(k))).toEqual([]);
  });

  it('names an existing work package as owner of every route', () => {
    const planned = new Set(planWorkPackages());
    expect(planned.size).toBe(WORK_PACKAGE_IDS.length);
    for (const r of routes) {
      expect(WORK_PACKAGE_IDS, r.id).toContain(r.owner);
      expect(planned.has(r.owner), `${r.id} owner ${r.owner}`).toBe(true);
    }
  });
});

describe('route table structure', () => {
  it('has unique ids and unique method and path pairs', () => {
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
    expect(new Set(routes.map(key)).size).toBe(routes.length);
  });

  it('uses dotted lower-case ids', () => {
    for (const r of routes) expect(r.id, r.id).toMatch(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/);
  });

  it('puts api routes under /api/v1 and gateway routes under /v1', () => {
    expect(API_ROUTES.length + GATEWAY_ROUTES.length).toBe(routes.length);
    for (const r of routes) {
      if (r.auth === 'gateway') expect(r.path, r.id).toMatch(/^\/v1\//);
      else expect(r.path, r.id).toMatch(/^\/api\/v1\//);
      expect(r.path, r.id).toMatch(/^(\/[a-z0-9.-]+|\/:[A-Za-z]+)+$/);
    }
    for (const r of ROUTE_AREAS.gateway ?? []) expect(r.auth).toBe('gateway');
  });

  it('keeps every route in exactly one area', () => {
    for (const r of routes) expect(typeof routeArea(r)).toBe('string');
    expect(routeById('applicability.transition').path).toBe('/api/v1/ms/:ms/applicability/:id/transitions');
    expect(() => routeById('no.such-route')).toThrow();
  });

  it('marks only the test support routes testOnly', () => {
    for (const [area, list] of Object.entries(ROUTE_AREAS)) {
      for (const r of list) {
        expect(Boolean(r.testOnly), r.id).toBe(area === 'test-support');
        if (r.testOnly) expect(r.path).toMatch(/^\/api\/v1\/test\//);
      }
    }
  });

  it('has a summary, a response schema and only error statuses the generator does not add', () => {
    for (const r of routes) {
      expect(r.summary.length, r.id).toBeGreaterThan(5);
      expect(r.response, r.id).toBeInstanceOf(z.ZodType);
      for (const status of r.errors) {
        expect(status, r.id).not.toBe(400);
        expect(status >= 204 && status < 600, `${r.id} ${status}`).toBe(true);
      }
    }
  });

  it('sends bodies only on non-GET routes and marks idempotency on POST only', () => {
    for (const r of routes) {
      if (r.method === 'GET') expect(r.body, r.id).toBeUndefined();
      if (r.idempotent) expect(r.method, r.id).toBe('POST');
      if (r.status === 201) expect(r.method, r.id).toBe('POST');
      if (r.status === 204 || r.status === 302) expect(r.response === NoBody || r.status === 302, r.id).toBe(true);
    }
  });

  it('returns file bytes with a declared media type', () => {
    for (const r of routes.filter((x) => x.file)) expect(r.responseType, r.id).toBeTruthy();
  });

  it('exempts only the SAML assertion consumer from CSRF', () => {
    expect(routes.filter((r) => r.csrfExempt).map((r) => r.id)).toEqual(['auth.saml.acs']);
  });
});

describe('path parameters', () => {
  it('match the params schema of every route', () => {
    for (const r of routes) {
      const names = pathParamNames(r.path).sort();
      if (!names.length) {
        expect(r.params, `${r.id} declares params without path parameters`).toBeUndefined();
        continue;
      }
      expect(objectKeys(r.params), r.id).toEqual(names);
    }
  });

  it('use the system slug for {ms}', () => {
    for (const r of routes.filter((x) => pathParamNames(x.path).includes('ms'))) {
      const params = r.params as z.ZodObject;
      expect(params.shape.ms?.safeParse('isms').success, r.id).toBe(true);
      expect(params.shape.ms?.safeParse('ISMS').success, r.id).toBe(false);
    }
  });

  it('accept exactly RECORD_ENTITY_TYPES for {entityType}', () => {
    const withEntityType = routes.filter((r) => pathParamNames(r.path).includes('entityType'));
    expect(withEntityType.length).toBeGreaterThanOrEqual(3);
    for (const r of withEntityType) {
      const schema = (r.params as z.ZodObject).shape.entityType as z.ZodType;
      for (const t of RECORD_ENTITY_TYPES) expect(schema.safeParse(t).success, `${r.id} ${t}`).toBe(true);
      for (const t of ['user_account', 'organization', 'storage_credential', 'Document', '']) expect(schema.safeParse(t).success, `${r.id} ${t}`).toBe(false);
    }
  });

  it('lists the 26 record entity types of D.1', () => {
    expect(RECORD_ENTITY_TYPES).toHaveLength(26);
    expect(new Set(RECORD_ENTITY_TYPES).size).toBe(26);
  });
});

describe('authorisation metadata', () => {
  const grantScopeOk = (r: RouteDef, p: Permission) => {
    const g = PERMISSION_MATRIX[p];
    return r.scope === g.scope || (g.tenancy !== undefined && (r.scope === 'org' || r.scope === 'platform'));
  };

  it('uses permissions of the F.6 matrix with their scope', () => {
    for (const r of routes) {
      if (r.permission) {
        expect(PERMISSION_MATRIX[r.permission], `${r.id} ${r.permission}`).toBeDefined();
        expect(grantScopeOk(r, r.permission), `${r.id} scope ${r.scope}`).toBe(true);
      }
      for (const p of r.anyOf ?? []) expect(PERMISSION_MATRIX[p], `${r.id} anyOf ${p}`).toBeDefined();
      if (r.anyOf) expect(r.anyOf.length, r.id).toBeGreaterThanOrEqual(2);
      if (r.permission || r.anyOf || r.machine) expect(r.scope, `${r.id} needs a scope`).toBeDefined();
    }
  });

  it('keeps public, gateway and guest routes free of permissions', () => {
    for (const r of routes.filter((x) => ['public', 'gateway', 'guest_otp', 'mfa_pending', 'enrolment'].includes(x.auth))) {
      expect(r.permission ?? r.anyOf ?? r.machine, r.id).toBeUndefined();
    }
  });

  it('names C.13 machines whose permissions the route accepts', () => {
    const machineRoutes = routes.filter((r) => r.machine);
    expect(machineRoutes.length).toBeGreaterThanOrEqual(10);
    for (const r of machineRoutes) {
      const machine = r.machine as MachineEntity;
      expect(MACHINES[machine], r.id).toBeDefined();
      if (r.permission) expect(machinePermissions(machine), r.id).toContain(r.permission);
      expect(r.method, r.id).not.toBe('GET');
    }
  });

  it('routes every transition reachable only through a dedicated route to an existing route', () => {
    for (const machine of Object.values(MACHINES)) {
      for (const t of machine.transitions.filter((x) => x.via)) {
        const r = routeById(t.via as string);
        expect(r.permission, `${t.via}`).toBe(t.permission);
      }
    }
  });

  it('reads the system of ms-scoped routes from one place (F.7)', () => {
    for (const r of routes) {
      const hasMsParam = pathParamNames(r.path).includes('ms');
      if (r.msSource === 'path' || (hasMsParam && r.scope === 'ms')) {
        expect(hasMsParam, r.id).toBe(true);
        expect(r.msSource, r.id).toBe('path');
      }
      if (r.msSource === 'body') expect(hasMember(r.body, 'ms'), `${r.id} body.ms`).toBe(true);
      if (r.msSource === 'query') expect(hasMember(r.query, 'ms'), `${r.id} query.ms`).toBe(true);
      if (r.scope === 'ms' && !r.anyOf) expect(r.msSource, `${r.id} ms scope without msSource`).toBeDefined();
      // EvidenceTargetRequest.ms names the target system of the mapping, not the system of the check (D.2).
      if (hasMsParam && r.msSource && r.id !== 'evidence.targets.create') {
        expect(hasMember(r.body, 'ms') || hasMember(r.query, 'ms'), `${r.id} has ms twice`).toBe(false);
      }
    }
  });

  it('allows only reads, auth, preferences, exports and the licence installation in read-only mode (D.1, BR-37, A-40)', () => {
    const allowed = new Set(['me.switch-org', 'me.preferences', 'admin.license.put', 'exports.create', 'test.reset', 'test.session']);
    for (const r of routes.filter((x) => x.readOnlyAllowed)) {
      expect(r.method === 'GET' || r.path.startsWith('/api/v1/auth/') || allowed.has(r.id), r.id).toBe(true);
    }
    expect(routeById('admin.license.put').readOnlyAllowed).toBe(true);
    expect(routeById('auth.logout').readOnlyAllowed).toBe(true);
  });
});
