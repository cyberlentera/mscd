// OpenAPI 3.1 document of the route table (D.1 "Contract source", J.3). Schemas come from zod's z.toJSONSchema:
// named schemas become components; request schemas are converted in input form (defaults optional) and responses in
// output form, and a named schema whose two forms differ gets a second component `<Name>Input`. Routes marked
// `testOnly` are left out; storage gateway routes (`/v1/...`) carry their own server.
import { z } from 'zod';
import type { ZodType } from 'zod';
import { BinaryBody, INVALID_EXAMPLES_KEY, NoBody, Problem, openApiPath } from './api/common.js';
import type { RouteDef } from './api/common.js';
import { ROUTE_AREAS } from './api/routes.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface OpenApiOptions {
  /** `info.version`; the package version by default in the script. */
  version?: string;
  /** Route areas to document; the full route table by default. */
  areas?: Readonly<Record<string, readonly RouteDef[]>>;
  /** URL of the storage gateway for the `/v1` routes. */
  gatewayUrl?: string;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 302: 'Redirect', 400: 'Validation failed (problem validation)',
  401: 'Not authenticated', 403: 'Forbidden (csrf, forbidden, read-only-mode, organisation-inactive)', 404: 'Not found', 409: 'Conflict',
  412: 'Precondition failed (stale If-Match)', 413: 'Payload too large', 422: 'Business rule violated', 429: 'Rate limited', 500: 'Internal error',
  502: 'Provider unreachable', 503: 'Dependency unavailable',
};

const TEXT_TYPES = ['text/', 'application/x-ndjson', 'application/samlmetadata+xml', 'application/xml'];

function isText(mediaType: string): boolean {
  return TEXT_TYPES.some((t) => mediaType.startsWith(t));
}

/** Removes `$schema` and the invalid-example metadata, and rewrites `#/$defs/<id>` references with `rename`. */
function clean(value: Json, rename: (id: string) => string): Json {
  if (Array.isArray(value)) return value.map((v) => clean(v, rename));
  if (value === null || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '$schema' || k === INVALID_EXAMPLES_KEY) continue;
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) {
      out[k] = `#/components/schemas/${rename(v.slice('#/$defs/'.length))}`;
      continue;
    }
    out[k] = clean(v as Json, rename);
  }
  return out;
}

function stableStringify(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as Json)}`).join(',')}}`;
}

interface Converted {
  properties: JsonObject;
  defs: JsonObject;
}

/** Converts many schemas in one pass so that shared named schemas are emitted once. */
function convert(entries: Map<string, ZodType>, io: 'input' | 'output'): Converted {
  const wrapper = z.object(Object.fromEntries(entries));
  const result = z.toJSONSchema(wrapper, {
    io,
    unrepresentable: 'any',
    reused: 'inline',
    override: (ctx) => {
      if (ctx.zodSchema === (BinaryBody as unknown)) {
        for (const k of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[k];
        Object.assign(ctx.jsonSchema, { type: 'string', contentMediaType: 'application/octet-stream', description: 'Raw bytes' });
      }
    },
  }) as unknown as JsonObject;
  return { properties: (result.properties ?? {}) as JsonObject, defs: (result.$defs ?? {}) as JsonObject };
}

/** Resolves a `$ref` of a converted pass to its schema (for parameter objects that are named schemas). */
function resolve(schema: Json, defs: JsonObject): JsonObject {
  const obj = schema as JsonObject;
  const ref = obj?.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) return resolve(defs[ref.slice('#/$defs/'.length)] as Json, defs);
  return obj;
}

/** Builds the OpenAPI 3.1 document of the route table. */
export function buildOpenApiDocument(options: OpenApiOptions = {}): JsonObject {
  const areas = options.areas ?? ROUTE_AREAS;
  const routes: { route: RouteDef; area: string; key: string }[] = [];
  for (const [area, list] of Object.entries(areas)) {
    for (const route of list) {
      if (route.testOnly) continue;
      routes.push({ route, area, key: `r${routes.length}` });
    }
  }

  // One conversion pass for request parts (input form) and one for responses (output form).
  const inputs = new Map<string, ZodType>();
  const outputs = new Map<string, ZodType>([['__problem', Problem]]);
  for (const { route, key } of routes) {
    if (route.params) inputs.set(`${key}:params`, route.params);
    if (route.query) inputs.set(`${key}:query`, route.query);
    if (route.headers) inputs.set(`${key}:headers`, route.headers);
    if (route.body && route.requestType !== 'application/octet-stream') inputs.set(`${key}:body`, route.body);
    const hasJsonBody = route.response !== NoBody && route.status !== 204 && route.status !== 302 && route.responseType === undefined;
    if (hasJsonBody) outputs.set(`${key}:response`, route.response);
  }
  const input = convert(inputs, 'input');
  const output = convert(outputs, 'output');

  // Components: output forms under their names; input forms that differ under <Name>Input.
  const components: JsonObject = {};
  const outputName = (id: string) => id;
  for (const [id, def] of Object.entries(output.defs)) components[id] = clean(def as Json, outputName);
  const inputNames = new Map<string, string>();
  for (const [id, def] of Object.entries(input.defs)) {
    const sameAsOutput = id in output.defs && stableStringify(clean(def as Json, outputName)) === stableStringify(clean(output.defs[id] as Json, outputName));
    inputNames.set(id, sameAsOutput || !(id in output.defs) ? id : `${id}Input`);
  }
  const inputName = (id: string) => inputNames.get(id) ?? id;
  for (const [id, def] of Object.entries(input.defs)) {
    const name = inputName(id);
    if (!(name in components)) components[name] = clean(def as Json, inputName);
  }

  const paths: JsonObject = {};
  for (const { route, area, key } of routes) {
    const pathKey = openApiPath(route.path);
    const pathItem = (paths[pathKey] ??= {}) as JsonObject;
    if (route.path.startsWith('/v1/')) pathItem.servers = [{ url: options.gatewayUrl ?? 'https://storage-gateway:8443', description: 'storage-gateway (internal, bearer token and mTLS)' }];

    const parameters: Json[] = [];
    const addParameters = (part: 'params' | 'query' | 'headers', location: 'path' | 'query' | 'header') => {
      const schema = input.properties[`${key}:${part}`];
      if (schema === undefined) return;
      const resolved = resolve(schema, input.defs);
      const props = (resolved.properties ?? {}) as JsonObject;
      const required = new Set((resolved.required ?? []) as string[]);
      for (const [name, propSchema] of Object.entries(props)) {
        if (location === 'header' && name.toLowerCase() === 'content-type') continue;
        parameters.push({ name, in: location, required: location === 'path' || required.has(name), schema: clean(propSchema, inputName) });
      }
    };
    addParameters('params', 'path');
    addParameters('query', 'query');
    addParameters('headers', 'header');

    const operation: JsonObject = {
      operationId: route.id,
      summary: route.summary,
      tags: [area],
      'x-owner': route.owner,
      'x-auth': route.auth,
    };
    if (route.permission) operation['x-permission'] = route.permission;
    if (route.anyOf) operation['x-any-of'] = route.anyOf.map((check) => ({ ...check }));
    if (route.allOf) operation['x-all-of'] = [...route.allOf];
    if (route.permissionBy) {
      const { source, member, cases } = route.permissionBy;
      operation['x-permission-by'] = { source, member, cases: Object.fromEntries(Object.entries(cases).map(([value, check]) => [value, { ...check }])) };
    }
    if (route.machine) operation['x-machine'] = route.machine;
    if (route.scope) operation['x-scope'] = route.scope;
    if (route.msSource) operation['x-ms-source'] = route.msSource;
    if (route.idempotent) operation['x-idempotent'] = true;
    if (route.ifMatch) operation['x-if-match'] = true;
    if (route.readOnlyAllowed) operation['x-read-only-allowed'] = true;
    if (route.file) operation['x-file'] = true;
    if (route.rateLimits) operation['x-rate-limits'] = route.rateLimits.map((l) => ({ ...l }));
    if (parameters.length) operation.parameters = parameters;

    if (route.body) {
      const mediaType = route.requestType ?? 'application/json';
      const schema = route.requestType === 'application/octet-stream'
        ? { type: 'string', contentMediaType: 'application/octet-stream' }
        : clean(input.properties[`${key}:body`] as Json, inputName);
      operation.requestBody = { required: true, content: { [mediaType]: { schema } } };
    }

    const responses: JsonObject = {};
    const status = route.status ?? 200;
    const success: JsonObject = { description: STATUS_TEXT[status] ?? 'Success' };
    if (status === 302) success.headers = { Location: { schema: { type: 'string' }, description: 'Redirect target' } };
    if (status !== 204 && status !== 302 && route.response !== NoBody) {
      if (route.responseType) {
        const schema: JsonObject = isText(route.responseType) ? { type: 'string' } : { type: 'string', contentMediaType: route.responseType };
        success.content = { [route.responseType]: { schema } };
      } else {
        success.content = { 'application/json': { schema: clean(output.properties[`${key}:response`] as Json, outputName) } };
      }
    }
    responses[String(status)] = success;
    const errorCodes = new Set<number>([400, ...(route.auth === 'public' ? [] : [401, 403]), ...route.errors]);
    for (const code of [...errorCodes].sort((a, b) => a - b)) {
      if (code === 204) {
        responses['204'] = { description: STATUS_TEXT[204] as string };
        continue;
      }
      responses[String(code)] = {
        description: STATUS_TEXT[code] ?? 'Error',
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
      };
    }
    operation.responses = responses;

    const isGet = route.method === 'GET';
    switch (route.auth) {
      case 'public': operation.security = []; break;
      case 'gateway': operation.security = [{ gatewayToken: [] }]; break;
      case 'guest_otp': operation.security = [{ guestTransaction: [] }]; break;
      default: operation.security = isGet ? [{ sessionCookie: [] }] : [{ sessionCookie: [], csrfToken: [] }];
    }
    pathItem[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'MSCD API',
      version: options.version ?? '0.0.0',
      description: 'Management System Compliance Dashboard: api routes (/api/v1) and the internal storage gateway protocol (/v1). Problems use RFC 9457 with the extension members of the build plan D.1.',
    },
    servers: [{ url: '/' }],
    tags: Object.keys(areas).filter((a) => (areas[a] ?? []).some((r) => !r.testOnly)).map((name) => ({ name })),
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-mscd_session', description: 'Session cookie (mscd_session when security.cookie_secure is false)' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Synchronizer token of the session (F.2)' },
        guestTransaction: { type: 'apiKey', in: 'cookie', name: 'mscd_guest_tx', description: 'Guest one-time code transaction (F.14)' },
        gatewayToken: { type: 'http', scheme: 'bearer', description: 'Gateway token; mTLS client certificate in mtls mode (D.5)' },
      },
    },
  };
}
