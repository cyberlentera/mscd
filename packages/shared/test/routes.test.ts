// The route table against build plan D.1, D.3 and D.5: every endpoint is present once, with a valid owner,
// permission, machine and path parameter schema.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_ROUTES, EXPORT_KINDS, ExportRequest, GATEWAY_ROUTES, MACHINES, PERMISSION_MATRIX, RECORD_ENTITY_TYPES, REGISTER_KINDS,
  ROUTE_AREAS, WORK_PACKAGE_IDS, NoBody, evaluatePermission, evaluatePermissionInAnySystem, machinePermissions, pathParamNames,
  permissionCase, routeArea, routeById, routes, transitionsFor,
} from '../src/index.js';
import type { MachineEntity, Permission, PermissionCheckScope, RouteDef } from '../src/index.js';
import { fastifyPath, planApiEndpoints, planGatewayEndpoints, planWorkPackages } from './helpers.js';

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

function objectKeys(schema: z.ZodType | undefined): string[] {
  if (!schema) return [];
  if (!(schema instanceof z.ZodObject)) throw new Error('not an object schema');
  return Object.keys(schema.shape).sort();
}

/** Schema of one member of an object schema (through pipes; the first option of a union). */
function memberSchema(schema: z.ZodType | undefined, member: string): z.ZodType | undefined {
  if (!schema) return undefined;
  if (schema instanceof z.ZodObject) return schema.shape[member] as z.ZodType | undefined;
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) return memberSchema((schema.options as z.ZodType[])[0], member);
  if (schema instanceof z.ZodPipe) return memberSchema(schema.in as z.ZodType, member);
  return undefined;
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

  it('lists 403 on public non-GET routes, which check Origin (F.2)', () => {
    const checked = routes.filter((r) => r.auth === 'public' && r.method !== 'GET' && !r.csrfExempt);
    expect(checked.length).toBeGreaterThanOrEqual(8);
    for (const r of checked) expect(r.errors, r.id).toContain(403);
  });

  it('lists 429 on every route with route-specific rate limits', () => {
    for (const r of routes.filter((x) => x.rateLimits)) {
      expect(r.errors, r.id).toContain(429);
      expect(r.rateLimits?.length, r.id).toBeGreaterThan(0);
    }
  });

  it('limits exports, evidence packs and link health runs to 10 per user and hour (F.3)', () => {
    const limited = ['exports.create', 'exports.soa', 'exports.documents', 'audit-trail.export', 'evidence-packs.build', 'link-health.run'];
    for (const id of limited) expect(routeById(id).rateLimits, id).toContainEqual({ key: 'user', max: 10, windowSeconds: 3600 });
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

  const checkScopeOk = (p: Permission, scope: PermissionCheckScope) => {
    const g = PERMISSION_MATRIX[p];
    if (scope === 'any_ms') return g.scope === 'ms';
    return scope === g.scope || (g.tenancy !== undefined && (scope === 'org' || scope === 'platform'));
  };

  it('uses permissions of the F.6 matrix with their scope', () => {
    for (const r of routes) {
      if (r.permission) {
        expect(PERMISSION_MATRIX[r.permission], `${r.id} ${r.permission}`).toBeDefined();
        expect(grantScopeOk(r, r.permission), `${r.id} scope ${r.scope}`).toBe(true);
      }
      for (const p of r.allOf ?? []) {
        expect(PERMISSION_MATRIX[p], `${r.id} allOf ${p}`).toBeDefined();
        expect(grantScopeOk(r, p), `${r.id} allOf ${p} scope ${r.scope}`).toBe(true);
      }
      if (r.allOf) expect(r.permission, `${r.id} allOf adds to permission`).toBeDefined();
      if (r.permission || r.machine) expect(r.scope, `${r.id} needs a scope`).toBeDefined();
    }
  });

  it('checks each anyOf alternative at a scope the matrix allows', () => {
    const anyOfRoutes = routes.filter((r) => r.anyOf);
    expect(anyOfRoutes.map((r) => r.id).sort()).toEqual([
      'admin.users.reset-mfa', 'audit-trail.anchors', 'audit-trail.list', 'audit-trail.verify', 'storage.browse', 'storage.upload-intents.create',
    ]);
    for (const r of anyOfRoutes) {
      const checks = r.anyOf as NonNullable<RouteDef['anyOf']>;
      expect(checks.length, r.id).toBeGreaterThanOrEqual(2);
      expect(r.permission ?? r.scope ?? r.permissionBy ?? r.machine, `${r.id} keeps its checks in the alternatives`).toBeUndefined();
      const keys = checks.map((c) => `${c.permission}@${c.scope}`);
      expect(new Set(keys).size, `${r.id} distinct alternatives`).toBe(keys.length);
      for (const c of checks) {
        expect(PERMISSION_MATRIX[c.permission], `${r.id} anyOf ${c.permission}`).toBeDefined();
        expect(checkScopeOk(c.permission, c.scope), `${r.id} anyOf ${c.permission} at ${c.scope}`).toBe(true);
      }
      const msChecks = checks.some((c) => c.scope === 'ms');
      expect(Boolean(r.msSource), `${r.id} msSource exactly when an alternative is ms-scoped`).toBe(msChecks);
    }
  });

  it('lets the D.3 holders through the audit trail routes and keeps external auditors to the audited system (F.7)', () => {
    expect(routeById('audit-trail.list').anyOf).toEqual([
      { permission: 'audit_trail.read', scope: 'ms' },
      { permission: 'audit_trail.metadata.read', scope: 'org' },
    ]);
    expect(routeById('audit-trail.list').msSource).toBe('query');
    for (const id of ['audit-trail.verify', 'audit-trail.anchors']) {
      expect(routeById(id).anyOf, id).toEqual([
        { permission: 'audit_trail.read', scope: 'any_ms' },
        { permission: 'audit_trail.metadata.read', scope: 'org' },
      ]);
      expect(routeById(id).msSource, id).toBeUndefined();
    }
    const base = { tenancy: 'single', msRoles: [], anyMsRoles: [], orgRoles: [], platformRoles: [] } as const;
    // An org-scope check sees no business roles (RoleContext), so a system role passes only an ms or any_ms check.
    const passes = (id: string, ctx: Parameters<typeof evaluatePermission>[1], inMs: Parameters<typeof evaluatePermission>[1]) =>
      (routeById(id).anyOf ?? []).some((c) => {
        if (c.scope === 'any_ms') return evaluatePermissionInAnySystem(c.permission, ctx) !== null;
        if (c.scope === 'ms') return evaluatePermission(c.permission, inMs) !== null;
        return evaluatePermission(c.permission, ctx) !== null;
      });
    // F.7: an external auditor passes only GET routes that name a system (the audited one, checked by WP-39), on top
    // of the permission check.
    const namesSystem = (id: string) => Boolean(routeById(id).msSource) || /:ms(\/|$)/.test(routeById(id).path);
    const auditorPasses = (id: string, ctx: Parameters<typeof evaluatePermission>[1], inMs: Parameters<typeof evaluatePermission>[1]) =>
      routeById(id).method === 'GET' && namesSystem(id) && passes(id, ctx, inMs);
    const manager = { ...base, anyMsRoles: ['ms_manager'] } as const;
    const externalAuditor = { ...base, anyMsRoles: ['external_auditor'] } as const;
    const tenantAdmin = { ...base, orgRoles: ['tenant_admin'] } as const;
    const domainOwner = { ...base, anyMsRoles: ['domain_owner'] } as const;
    for (const id of ['audit-trail.verify', 'audit-trail.anchors']) {
      expect(passes(id, manager, base), `${id} MS Manager`).toBe(true);
      expect(passes(id, tenantAdmin, base), `${id} Tenant Admin`).toBe(true);
      expect(passes(id, domainOwner, base), `${id} Domain Owner`).toBe(false);
      // The any_ms alternative alone would admit the auditor; the route names no system, so F.7 denies them.
      expect(namesSystem(id), `${id} names no system`).toBe(false);
      expect(auditorPasses(id, externalAuditor, base), `${id} external auditor`).toBe(false);
    }
    expect(passes('audit-trail.list', manager, { ...manager, msRoles: ['ms_manager'] }), 'MS Manager of the query system').toBe(true);
    expect(passes('audit-trail.list', manager, manager), 'MS Manager of another system').toBe(false);
    expect(passes('audit-trail.list', tenantAdmin, tenantAdmin), 'Tenant Admin').toBe(true);
    const auditorInMs = { ...externalAuditor, msRoles: ['external_auditor'] } as const;
    expect(auditorPasses('audit-trail.list', externalAuditor, auditorInMs), 'external auditor in the audited query system').toBe(true);
    expect(auditorPasses('audit-trail.list', externalAuditor, externalAuditor), 'external auditor in another system').toBe(false);
  });

  it('resets the second factor with user.manage in the organisation or ops.users.manage on the platform (D.3)', () => {
    expect(routeById('admin.users.reset-mfa').anyOf).toEqual([
      { permission: 'user.manage', scope: 'org' },
      { permission: 'ops.users.manage', scope: 'platform' },
    ]);
  });

  it('names a permission per member value on permissionBy routes', () => {
    const byRoutes = routes.filter((r) => r.permissionBy);
    expect(byRoutes.map((r) => r.id).sort()).toEqual(['exports.create', 'registers.create', 'registers.update']);
    for (const r of byRoutes) {
      const by = r.permissionBy as NonNullable<RouteDef['permissionBy']>;
      expect(r.permission ?? r.anyOf ?? r.allOf ?? r.machine ?? r.scope, `${r.id} keeps its checks in the cases`).toBeUndefined();
      const member = by.source === 'path' ? memberSchema(r.params, by.member) : memberSchema(by.source === 'body' ? r.body : r.query, by.member);
      expect(member, `${r.id} ${by.source}.${by.member}`).toBeDefined();
      if (by.source === 'path') expect(pathParamNames(r.path), r.id).toContain(by.member);
      expect(by.cases['*'], `${r.id} default case`).toBeDefined();
      for (const [value, check] of Object.entries(by.cases)) {
        expect(PERMISSION_MATRIX[check.permission], `${r.id} ${value}`).toBeDefined();
        expect(checkScopeOk(check.permission, check.scope), `${r.id} ${value} ${check.permission} at ${check.scope}`).toBe(true);
        if (value !== '*') expect(member?.safeParse(value).success, `${r.id} case ${value} is a valid ${by.member}`).toBe(true);
      }
      const msCases = Object.values(by.cases).some((c) => c.scope === 'ms');
      expect(Boolean(r.msSource), `${r.id} msSource exactly when a case is ms-scoped`).toBe(msCases);
    }
  });

  it('checks risk.manage on risks and register.manage on the other registers (D.3)', () => {
    for (const id of ['registers.create', 'registers.update']) {
      const by = routeById(id).permissionBy as NonNullable<RouteDef['permissionBy']>;
      for (const kind of REGISTER_KINDS) {
        expect(permissionCase(by, kind), `${id} ${kind}`).toEqual({ permission: kind === 'risks' ? 'risk.manage' : 'register.manage', scope: 'ms' });
      }
    }
    // A Domain Owner holds register.manage (own) and no risk.manage (F.6), so the risks case denies them.
    const domainOwner = { tenancy: 'single', msRoles: ['domain_owner'], anyMsRoles: ['domain_owner'], orgRoles: [], platformRoles: [] } as const;
    const by = routeById('registers.create').permissionBy as NonNullable<RouteDef['permissionBy']>;
    expect(evaluatePermission(permissionCase(by, 'risks').permission, domainOwner)).toBeNull();
    expect(evaluatePermission(permissionCase(by, 'assets').permission, domainOwner)).toBe('own');
  });

  it('checks exports per type: the portfolio board in any system, the audit trail and the rest in the body system (D.3)', () => {
    const by = routeById('exports.create').permissionBy as NonNullable<RouteDef['permissionBy']>;
    expect(by).toMatchObject({ source: 'body', member: 'type' });
    for (const kind of EXPORT_KINDS) {
      const check = permissionCase(by, kind);
      if (kind === 'portfolio_board') expect(check).toEqual({ permission: 'export.run', scope: 'any_ms' });
      else if (kind === 'audit_trail') expect(check).toEqual({ permission: 'audit_trail.read', scope: 'ms' });
      else expect(check, kind).toEqual({ permission: 'export.run', scope: 'ms' });
      // The body names a system exactly for the ms-scoped cases.
      const format = kind === 'audit_trail' ? 'csv' : kind === 'soa' || kind === 'document_register' ? 'xlsx' : 'pdf';
      expect(ExportRequest.safeParse({ type: kind, ms: 'isms', format }).success, `${kind} with ms`).toBe(check.scope === 'ms');
      expect(ExportRequest.safeParse({ type: kind, format }).success, `${kind} without ms`).toBe(check.scope === 'any_ms');
    }
    expect(permissionCase(by, 'unknown')).toBe(by.cases['*']);
    expect(permissionCase(by, '*')).toBe(by.cases['*']);
    expect(permissionCase(by, 'toString')).toBe(by.cases['*']);
  });

  it('needs ms.admin and pack.activate to create a management system (D.3)', () => {
    const r = routeById('admin.ms.create');
    expect([r.permission, ...(r.allOf ?? [])]).toEqual(['ms.admin', 'pack.activate']);
    expect(r.scope).toBe('org');
  });

  it('keeps public, gateway and guest routes free of permissions', () => {
    for (const r of routes.filter((x) => ['public', 'gateway', 'guest_otp', 'mfa_pending', 'enrolment'].includes(x.auth))) {
      expect(r.permission ?? r.anyOf ?? r.allOf ?? r.permissionBy ?? r.machine, r.id).toBeUndefined();
    }
  });

  it('names C.13 machines whose permissions the route accepts', () => {
    const machineRoutes = routes.filter((r) => r.machine);
    expect(machineRoutes.length).toBeGreaterThanOrEqual(10);
    for (const r of machineRoutes) {
      const machine = r.machine as MachineEntity;
      expect(MACHINES[machine], r.id).toBeDefined();
      // What the guard accepts: the route permission, or else every permission of the rows this route performs.
      const accepted = r.permission ? [r.permission] : machinePermissions(machine);
      const performed = MACHINES[machine].transitions.filter((t) => !t.via && t.permission).map((t) => t.permission as Permission);
      expect(new Set(accepted), `${r.id} accepts exactly the permissions of its rows`).toEqual(new Set(performed));
      expect(r.method, r.id).not.toBe('GET');
    }
  });

  it('performs the ms.admin rows of a management system through PATCH /admin/management-systems/{id} (D.3)', () => {
    const e = 'management_system.status';
    const viaPatch = MACHINES[e].transitions.filter((t) => t.via === 'admin.ms.update');
    expect(viaPatch.map((t) => `${t.from}>${t.to}`).sort()).toEqual([
      'certified>archived', 'implementing>archived', 'setup>archived', 'setup>implementing', 'transitioning>archived',
    ]);
    for (const t of viaPatch) expect(t.permission).toBe('ms.admin');
    // The PATCH body offers exactly the targets of these rows.
    const status = memberSchema(routeById('admin.ms.update').body, 'status');
    for (const to of new Set(viaPatch.map((t) => t.to))) expect(status?.safeParse(to).success, to).toBe(true);
    for (const t of MACHINES[e].transitions.filter((x) => !viaPatch.includes(x) && x.from !== null)) {
      expect(status?.safeParse(t.to).success, `${t.from} to ${t.to} is not a PATCH target`).toBe(false);
    }
    expect(machinePermissions(e)).toEqual(['ms.transition']);
    expect(transitionsFor(e, 'setup', 'implementing').every((t) => t.via === 'admin.ms.update')).toBe(true);
  });

  it('routes every transition reachable only through a dedicated route to an existing route', () => {
    for (const machine of Object.values(MACHINES)) {
      for (const t of machine.transitions.filter((x) => x.via)) {
        const r = routeById(t.via as string);
        expect(r.permission, `${t.via}`).toBe(t.permission);
        expect(r.allOf ?? [], `${t.via} allOf`).toEqual(t.allOf ?? []);
      }
    }
  });

  it('reads the system of ms-scoped routes from one place (F.7)', () => {
    for (const r of routes) {
      const hasMsParam = pathParamNames(r.path).includes('ms');
      const msChecked = r.scope === 'ms' || Boolean(r.anyOf?.some((c) => c.scope === 'ms'));
      if (r.msSource === 'path' || (hasMsParam && msChecked)) {
        expect(hasMsParam, r.id).toBe(true);
        expect(r.msSource, r.id).toBe('path');
      }
      if (r.msSource === 'body') expect(hasMember(r.body, 'ms'), `${r.id} body.ms`).toBe(true);
      if (r.msSource === 'query') expect(hasMember(r.query, 'ms'), `${r.id} query.ms`).toBe(true);
      if (msChecked) expect(r.msSource, `${r.id} ms scope without msSource`).toBeDefined();
      if (r.msSource && !r.permissionBy) expect(msChecked, `${r.id} msSource without an ms check`).toBe(true);
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
