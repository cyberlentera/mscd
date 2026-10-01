// The OpenAPI 3.1 document generated from the route table (D.1 "Contract source").
import { describe, expect, it } from 'vitest';
import { ROUTE_AREAS, buildOpenApiDocument, openApiPath, pathParamNames, routes } from '../src/index.js';

type Obj = Record<string, unknown>;
const doc = buildOpenApiDocument({ version: '9.9.9' }) as Obj;
const paths = doc.paths as Record<string, Obj>;
const schemas = (doc.components as Obj).schemas as Record<string, Obj>;
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

function operation(method: string, path: string): Obj | undefined {
  return paths[openApiPath(path)]?.[method.toLowerCase()] as Obj | undefined;
}

function walk(value: unknown, visit: (key: string, v: unknown) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

describe('buildOpenApiDocument', () => {
  it('is OpenAPI 3.1 with more than 130 paths', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect((doc.info as Obj).version).toBe('9.9.9');
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(130);
  });

  it('documents every route except the test support routes', () => {
    const documented = routes.filter((r) => !r.testOnly);
    for (const r of documented) {
      const op = operation(r.method, r.path);
      expect(op, `${r.method} ${r.path}`).toBeDefined();
      expect(op?.operationId).toBe(r.id);
      expect(op?.['x-owner']).toBe(r.owner);
      if (r.permission) expect(op?.['x-permission']).toBe(r.permission);
    }
    for (const r of routes.filter((x) => x.testOnly)) expect(operation(r.method, r.path), r.id).toBeUndefined();
    const count = Object.values(paths).reduce((n, item) => n + Object.keys(item).filter((k) => METHODS.includes(k)).length, 0);
    expect(count).toBe(documented.length);
  });

  it('has unique operation ids', () => {
    const ids: string[] = [];
    for (const item of Object.values(paths)) for (const m of METHODS) if (item[m]) ids.push((item[m] as Obj).operationId as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares every path parameter as required', () => {
    for (const r of routes.filter((x) => !x.testOnly)) {
      const params = ((operation(r.method, r.path)?.parameters ?? []) as Obj[]).filter((p) => p.in === 'path');
      expect(params.map((p) => p.name).sort(), r.id).toEqual(pathParamNames(r.path).sort());
      for (const p of params) expect(p.required, `${r.id} ${String(p.name)}`).toBe(true);
    }
  });

  it('documents request bodies and problem responses', () => {
    for (const r of routes.filter((x) => !x.testOnly)) {
      const op = operation(r.method, r.path) as Obj;
      if (r.body) expect(op.requestBody, r.id).toBeDefined();
      else expect(op.requestBody, r.id).toBeUndefined();
      const responses = op.responses as Record<string, Obj>;
      expect(responses[String(r.status ?? 200)], r.id).toBeDefined();
      expect(responses['400'], r.id).toBeDefined();
      if (r.auth !== 'public') expect(responses['401'], r.id).toBeDefined();
      for (const status of r.errors) expect(responses[String(status)], `${r.id} ${status}`).toBeDefined();
    }
  });

  it('marks security per authentication level and gives gateway paths their own server', () => {
    for (const r of routes.filter((x) => !x.testOnly)) {
      const op = operation(r.method, r.path) as Obj;
      const security = op.security as Obj[];
      if (r.auth === 'public') expect(security).toEqual([]);
      else if (r.auth === 'gateway') expect(security).toEqual([{ gatewayToken: [] }]);
      else if (r.method !== 'GET' && r.auth !== 'guest_otp') expect(Object.keys(security[0] ?? {})).toContain('csrfToken');
      const item = paths[openApiPath(r.path)] as Obj;
      expect(Boolean(item.servers), r.id).toBe(r.path.startsWith('/v1/'));
    }
    const schemes = (doc.components as Obj).securitySchemes as Obj;
    expect(Object.keys(schemes).sort()).toEqual(['csrfToken', 'gatewayToken', 'guestTransaction', 'sessionCookie']);
  });

  it('resolves every reference to a component schema', () => {
    const missing = new Set<string>();
    walk(doc, (k, v) => {
      if (k !== '$ref') return;
      const ref = String(v);
      if (!ref.startsWith('#/components/schemas/') || !(ref.slice('#/components/schemas/'.length) in schemas)) missing.add(ref);
    });
    expect([...missing]).toEqual([]);
    expect(schemas.Problem).toBeDefined();
    expect(schemas.CommandResult).toBeDefined();
  });

  it('carries no zod internals or invalid examples', () => {
    walk(doc, (k) => {
      expect(['$schema', '$defs', 'x-invalid-examples', '~standard']).not.toContain(k);
    });
    const text = JSON.stringify(doc);
    expect(text).not.toContain('#/$defs/');
  });

  it('names components after the exported schemas', () => {
    for (const name of Object.keys(schemas)) expect(name, name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    expect(schemas.ApplicabilityTransitionRequest).toBeDefined();
    expect(schemas.UiOrgSnapshot).toBeDefined();
    expect(schemas.UiMsSnapshot).toBeDefined();
  });

  it('documents a subset of the areas on request', () => {
    const partial = buildOpenApiDocument({ areas: { system: ROUTE_AREAS.system ?? [] } }) as Obj;
    expect(Object.keys(partial.paths as Obj)).toEqual(['/api/v1/system/profile']);
    expect(partial.tags).toEqual([{ name: 'system' }]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument({ version: '9.9.9' }))).toBe(JSON.stringify(doc));
  });
});
