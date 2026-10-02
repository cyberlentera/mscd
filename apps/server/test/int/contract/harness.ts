// Harness of the WP-30 suites (build plan J.3, J.5): the full api application of run mode `api` (every module of
// `API_FEATURE_MODULES`) on a copy of the demo template, users that hold exactly one role of F.6, sessions written
// through `SessionService`, request inputs built from the hand-written schema examples of the route table, and
// `callRoute`, which sends one contract route and checks the answer against its `RouteDef`: the status must be the
// success status or one the route declares (400 for every route, 401 and 403 for every route that is not public),
// a JSON success body must parse with `def.response`, an error body with `Problem`, and file routes carry the F.13
// headers.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  Problem, type BusinessRole, type OrgRole, type RouteDef,
} from '@mscd/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql, type Transaction } from 'kysely';
import type { ZodType } from 'zod';
import { ApiModule } from '../../../src/app/api.module';
import type { DB } from '../../../src/db/types';
import { NO_ORGANISATION } from '../../../src/modules/authz/authz-infra';
import { SessionService } from '../../../src/modules/identity/session.service';
import { createHttpApplication } from '../../../src/modules/platform/http-app';
import { MetricsService } from '../../../src/modules/platform/metrics';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';

export const COOKIE = 'mscd_session';
export const APP_ORIGIN = 'http://localhost:4174';

/** Fixed ids of the demo organisations (G.3). */
export const ORG_IDS = {
  ndt: '00000000-0000-4000-8000-00000000a001',
  bsd: '00000000-0000-4000-8000-00000000a002',
  rmn: '00000000-0000-4000-8000-00000000a003',
  tst: '00000000-0000-4000-8000-00000000a004',
} as const;
export type DemoOrg = keyof typeof ORG_IDS;

// ---------------------------------------------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------------------------------------------

export interface FullApp {
  app: NestFastifyApplication;
  /** `METHOD path` of every route Fastify registered (HEAD routes left out). */
  mounted: ReadonlySet<string>;
  get<T>(token: Parameters<INestApplication['get']>[0]): T;
  close(): Promise<void>;
}

/**
 * The api application exactly as `mscd-server api` builds it (`ApiModule`, `createHttpApplication`), on the test
 * profile (demo mode, `demo.fixed_today` 2026-09-29) and this test database. Mail goes to a closed port (sending
 * fails after commit and is logged), the storage gateway to the profile's address (no gateway runs: calls answer 502
 * or 503 unless a suite starts one).
 */
export async function createFullApp(db: TestDatabase, env: Record<string, string> = {}): Promise<FullApp> {
  const config = db.config({ MSCD__MAIL__SMTP__PORT: '9', ...env });
  const app = await createHttpApplication(ApiModule.forRoot(config), config);
  const mounted = new Set<string>();
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  fastify.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) if (method !== 'HEAD') mounted.add(`${method} ${route.url}`);
  });
  await app.init();
  await fastify.ready();
  return {
    app,
    mounted,
    get: <T>(token: Parameters<INestApplication['get']>[0]) => app.get(token) as T,
    close: () => app.close(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture users and sessions
// ---------------------------------------------------------------------------------------------------------------

/** The roles of F.6: business roles per system, organisation roles and the platform role. */
export const ROLE_KEYS = ['MM', 'PO', 'DO', 'RO', 'IA', 'TM', 'EA', 'CI', 'TA', 'SA', 'OP'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const BUSINESS_ROLE: Readonly<Partial<Record<RoleKey, BusinessRole>>> = {
  MM: 'ms_manager', PO: 'programme_owner', DO: 'domain_owner', RO: 'risk_owner', IA: 'internal_auditor', TM: 'top_management',
  EA: 'external_auditor', CI: 'compliance_investigator',
};
export const ORG_ROLE: Readonly<Partial<Record<RoleKey, OrgRole>>> = { TA: 'tenant_admin', SA: 'storage_admin' };

export interface FixtureUser {
  id: string;
  handle: string;
  email: string;
}

/** Runs `fn` as the migrator inside an organisation's schema. */
export function inOrg<T>(db: TestDatabase, org: DemoOrg, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(db.migrator, { orgId: ORG_IDS[org], schema: `org_${org}` }, fn);
}

/** Rows of a query run as the migrator inside an organisation's schema. */
export async function rowsIn<T>(db: TestDatabase, org: DemoOrg, query: ReturnType<typeof sql<T>>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** A demo user's id by handle. */
export async function userIdOf(db: TestDatabase, handle: string): Promise<string> {
  const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** Id of a system by slug. */
export async function msIdOf(db: TestDatabase, org: DemoOrg, ms: string): Promise<string> {
  const [row] = await rowsIn<{ id: string }>(db, org, sql`select id from management_system where slug = ${ms} and deleted_at is null`);
  if (!row) throw new Error(`No system ${ms} in ${org}`);
  return row.id;
}

/**
 * A person with an active membership in `org` and exactly the given roles: business roles in the named systems,
 * organisation roles in the membership, and optionally the platform operator role.
 */
export async function addFixtureUser(
  db: TestDatabase,
  org: DemoOrg,
  handle: string,
  roles: { business?: { ms: string; role: BusinessRole; validUntil?: Date | null }[]; org?: OrgRole[]; platformOperator?: boolean; kind?: 'person' | 'guest' },
): Promise<FixtureUser> {
  const email = `${handle}@wp30.test`;
  const id = await inScope(db.migrator, { platformScope: true }, async (trx) => {
    const user = await trx
      .insertInto('platform.app_user')
      .values({ handle, email, display_name: `WP-30 ${handle}`, kind: roles.kind ?? 'person', is_demo: false, status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('platform.org_membership')
      .values({ organization_id: ORG_IDS[org], user_id: user.id, admin_roles: roles.org ?? [], status: 'active', is_default: true })
      .execute();
    if (roles.platformOperator) await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator' }).execute();
    return user.id;
  });
  for (const grant of roles.business ?? []) {
    const msId = await msIdOf(db, org, grant.ms);
    const validUntil = grant.validUntil !== undefined ? grant.validUntil : grant.role === 'external_auditor' ? new Date(Date.now() + 14 * 86_400_000) : null;
    await inOrg(db, org, (trx) =>
      trx
        .insertInto('user_ms_role')
        .values({ user_id: id, management_system_id: msId, role: grant.role, approval_status: 'active', valid_until: validUntil, is_primary: false })
        .execute(),
    );
  }
  return { id, handle, email };
}

/** One user per F.6 role in `org`: business roles in `ms`, organisation roles, and the platform operator (a member without roles). */
export async function addRoleUsers(db: TestDatabase, org: DemoOrg, ms: string, prefix = 'wp30'): Promise<Record<RoleKey, FixtureUser>> {
  const out = {} as Record<RoleKey, FixtureUser>;
  for (const key of ROLE_KEYS) {
    const handle = `${prefix}-${key.toLowerCase()}`;
    const business = BUSINESS_ROLE[key];
    const orgRole = ORG_ROLE[key];
    out[key] = await addFixtureUser(db, org, handle, {
      ...(business ? { business: [{ ms, role: business }] } : {}),
      ...(orgRole ? { org: [orgRole] } : {}),
      ...(key === 'OP' ? { platformOperator: true } : {}),
    });
  }
  return out;
}

export interface SessionOptions {
  authMethod?: 'local' | 'oidc' | 'saml' | 'guest' | 'demo' | 'test';
  authGrantId?: string | null;
  identityProviderId?: string | null;
  authOrg?: DemoOrg | null;
}

/** A client signed in as `userId` in `org` with a session written through `SessionService` (no sign-in flow). */
export async function sessionFor(full: FullApp, userId: string, org: DemoOrg | null, options: SessionOptions = {}): Promise<Client> {
  const sessions = full.get<SessionService>(SessionService);
  const scope = full.get<TenantScope>(TenantScope);
  const orgId = org ? ORG_IDS[org] : null;
  const authOrgId = options.authOrg === undefined ? orgId : options.authOrg ? ORG_IDS[options.authOrg] : null;
  const context = org ? { orgId: orgId!, schema: `org_${org}`, userId } : { ...NO_ORGANISATION, userId };
  const issued = await scope.withTenant(context, (trx) => {
    const now = new Date();
    return sessions.create(trx, {
      userId,
      organizationId: orgId,
      authOrgId,
      state: 'active',
      authMethod: options.authMethod ?? 'local',
      identityProviderId: options.identityProviderId ?? null,
      authGrantId: options.authGrantId ?? null,
      passwordAt: now,
      mfaAt: now,
    });
  });
  return new Client(full.app, issued.cookieValue, issued.csrfToken);
}

/** A client of a demo user by handle in a demo organisation. */
export async function demoSession(full: FullApp, db: TestDatabase, handle: string, org: DemoOrg, options: SessionOptions = {}): Promise<Client> {
  return sessionFor(full, await userIdOf(db, handle), org, options);
}

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------

export interface Reply<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: LightMyRequestResponse['headers'];
  raw: LightMyRequestResponse;
}

/** A browser-like client with one session cookie and its CSRF token (sent on every non-GET request with `Origin`). */
export class Client {
  constructor(
    readonly app: NestFastifyApplication,
    readonly cookie: string | null,
    readonly csrf: string | null,
  ) {}

  async request<T = unknown>(method: string, url: string, options: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = `${COOKIE}=${this.cookie}`;
    if (method !== 'GET') {
      headers.origin = APP_ORIGIN;
      if (this.csrf && options.csrf !== false) headers['x-csrf-token'] = this.csrf;
    }
    Object.assign(headers, options.headers ?? {});
    const init: InjectOptions = { method: method as InjectOptions['method'], url, headers };
    if (options.body !== undefined) init.payload = options.body as InjectOptions['payload'];
    const raw = await this.app.inject(init);
    return { status: raw.statusCode, body: parseBody(raw) as T, text: raw.body, headers: raw.headers, raw };
  }

  get<T = unknown>(url: string, headers?: Record<string, string>) {
    return this.request<T>('GET', url, { ...(headers ? { headers } : {}) });
  }

  post<T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', url, { body, ...(headers ? { headers } : {}) });
  }

  patch<T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('PATCH', url, { body, ...(headers ? { headers } : {}) });
  }

  put<T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('PUT', url, { body, ...(headers ? { headers } : {}) });
  }
}

/** A client without a session (public routes). */
export function anonymous(full: FullApp): Client {
  return new Client(full.app, null, null);
}

function parseBody(raw: LightMyRequestResponse): unknown {
  const type = String(raw.headers['content-type'] ?? '');
  if (raw.body === '' || !/json/.test(type)) return undefined;
  try {
    return raw.json();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Route inputs from the schema examples
// ---------------------------------------------------------------------------------------------------------------

export interface RouteInput {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The hand-written valid examples of a schema (`named(...)`, D.1). */
export function examplesOf(schema: ZodType | undefined): unknown[] {
  if (!schema) return [];
  const meta = (schema as unknown as { meta(): { examples?: unknown[] } | undefined }).meta();
  return [...(meta?.examples ?? [])];
}

function firstExample(schema: ZodType | undefined): unknown {
  const [first] = examplesOf(schema);
  return first === undefined ? undefined : structuredClone(first);
}

/**
 * A valid input of a route: the first example of each schema, with `ms` set to the given system wherever the route
 * reads one (path, body or query) and every `id`-like path parameter replaced by a fresh UUID unless `ids` names it.
 */
export function exampleInput(def: RouteDef, options: { ms?: string; ids?: Record<string, string>; override?: RouteInput } = {}): RouteInput {
  const params = (firstExample(def.params) as Record<string, unknown> | undefined) ?? {};
  const query = firstExample(def.query) as Record<string, unknown> | undefined;
  let body = firstExample(def.body);
  const headers = firstExample(def.headers) as Record<string, string> | undefined;
  for (const name of Object.keys(params)) {
    if (options.ids && name in options.ids) params[name] = options.ids[name];
    else if (UUID.test(String(params[name]))) params[name] = randomUUID();
  }
  if (options.ms) {
    if ('ms' in params) params.ms = options.ms;
    if (def.msSource === 'body' && body && typeof body === 'object' && 'ms' in (body as object)) body = { ...(body as object), ms: options.ms };
    if (def.msSource === 'query' && query && 'ms' in query) query.ms = options.ms;
  }
  const input: RouteInput = { params };
  if (query !== undefined) input.query = query;
  if (body !== undefined) input.body = body;
  if (headers !== undefined) input.headers = headers;
  const o = options.override ?? {};
  return {
    params: { ...input.params, ...(o.params ?? {}) },
    ...(input.query !== undefined || o.query ? { query: { ...(input.query ?? {}), ...(o.query ?? {}) } } : {}),
    ...(o.body !== undefined ? { body: o.body } : input.body !== undefined ? { body: input.body } : {}),
    ...(input.headers || o.headers ? { headers: { ...(input.headers ?? {}), ...(o.headers ?? {}) } } : {}),
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The URL of a route for an input (path parameters encoded, the query as search parameters). */
export function urlOf(def: RouteDef, input: RouteInput): string {
  const path = def.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, name: string) => {
    const value = input.params?.[name];
    if (value === undefined) throw new Error(`${def.id}: no value for path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) search.append(key, String(v));
    else search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

const MULTIPART_BOUNDARY = 'wp30boundary7MA4YWxkTrZu0gW';

/** The request body and content type of a route's input (JSON, raw bytes, multipart or a form). */
function payloadOf(def: RouteDef, input: RouteInput): { body?: unknown; headers: Record<string, string> } {
  if (def.requestType === 'application/octet-stream') {
    return { body: Buffer.from(typeof input.body === 'string' ? input.body : 'wp-30 probe bytes\n'), headers: { 'content-type': 'application/octet-stream' } };
  }
  if (def.requestType === 'multipart/form-data') {
    const fields = input.body && typeof input.body === 'object' ? Object.entries(input.body as Record<string, unknown>).filter(([, v]) => typeof v === 'string') : [];
    const parts = fields.map(([k, v]) => `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`);
    parts.push(`--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="probe.pack"\r\nContent-Type: application/octet-stream\r\n\r\nnot a pack\r\n`);
    return { body: `${parts.join('')}--${MULTIPART_BOUNDARY}--\r\n`, headers: { 'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` } };
  }
  if (def.requestType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(Object.entries((input.body as Record<string, string>) ?? {}));
    return { body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  }
  if (input.body === undefined) return { headers: {} };
  return { body: input.body, headers: { 'content-type': 'application/json' } };
}

// ---------------------------------------------------------------------------------------------------------------
// callRoute (J.3)
// ---------------------------------------------------------------------------------------------------------------

/** F.13 headers of every file response. */
export const FILE_HEADERS = {
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
} as const;

export interface RouteCall<T = unknown> extends Reply<T> {
  /** Contract violations of this answer (empty when it fits the `RouteDef`). */
  violations: string[];
}

/** Status codes a route may answer (J.3): its success status, 400, 401 and 403 unless public, and `errors`. */
export function allowedStatuses(def: RouteDef): Set<number> {
  const allowed = new Set<number>([def.status ?? 200, 400, ...def.errors]);
  if (def.auth !== 'public') {
    allowed.add(401);
    allowed.add(403);
  }
  return allowed;
}

/**
 * Sends one contract route as `client` and checks the answer against the route's definition. Violations are
 * returned, not thrown, so a sweep can report every route at once; `expectContract` throws them.
 */
export async function callRoute<T = unknown>(client: Client, def: RouteDef, input: RouteInput, extraHeaders: Record<string, string> = {}): Promise<RouteCall<T>> {
  const payload = payloadOf(def, input);
  const reply = await client.request<T>(def.method, urlOf(def, input), {
    ...(payload.body !== undefined ? { body: payload.body } : {}),
    headers: { ...payload.headers, ...(input.headers ?? {}), ...extraHeaders },
  });
  return { ...reply, violations: contractViolations(def, reply) };
}

/** What is wrong with an answer of `def` (J.3). */
export function contractViolations(def: RouteDef, reply: Reply): string[] {
  const out: string[] = [];
  const allowed = allowedStatuses(def);
  const tag = `${def.id} answered ${reply.status}`;
  if (!allowed.has(reply.status)) out.push(`${tag}, not in [${[...allowed].sort().join(', ')}]: ${reply.text.slice(0, 300)}`);
  const type = String(reply.headers['content-type'] ?? '');
  const success = reply.status < 400;
  if (!success) {
    if (!type.startsWith('application/problem+json')) out.push(`${tag} with content type ${type || '(none)'}, not application/problem+json`);
    else {
      const parsed = Problem.safeParse(reply.body);
      if (!parsed.success) out.push(`${tag}: the problem body does not parse: ${parsed.error.message.slice(0, 300)}`);
      else if (parsed.data.status !== reply.status) out.push(`${tag}: the problem says status ${parsed.data.status}`);
    }
    return out;
  }
  if (reply.status === 204 || reply.status === 302) return out;
  const expectedType = def.responseType ?? 'application/json';
  if (!type.startsWith(expectedType) && !(expectedType === 'application/octet-stream' && def.file)) {
    out.push(`${tag} with content type ${type || '(none)'}, expected ${expectedType}`);
  }
  if (!def.responseType) {
    const parsed = def.response.safeParse(reply.body);
    if (!parsed.success) out.push(`${tag}: the body does not parse with the route's response schema: ${parsed.error.message.slice(0, 400)}`);
  }
  if (def.file) {
    for (const [name, value] of Object.entries(FILE_HEADERS)) {
      if (String(reply.headers[name] ?? '') !== value) out.push(`${tag}: header ${name} is ${String(reply.headers[name])}, expected ${value}`);
    }
    if (!/^(attachment|inline); filename="[^"]*"; filename\*=UTF-8''/.test(String(reply.headers['content-disposition'] ?? ''))) {
      out.push(`${tag}: Content-Disposition is ${String(reply.headers['content-disposition'])}`);
    }
  }
  return out;
}

/** Throws the violations of a call (single-route tests). */
export function expectContract(call: RouteCall): void {
  if (call.violations.length > 0) throw new Error(call.violations.join('\n'));
}

// ---------------------------------------------------------------------------------------------------------------
// Guard decisions
// ---------------------------------------------------------------------------------------------------------------

/**
 * Denials of the authorisation guard per route id, from the `mscd_authz_denied_total` counter (F.7). A service that
 * answers 403 itself (an own-scoped grant on someone else's record) does not count.
 */
export async function guardDenials(full: FullApp, routeId: string): Promise<number> {
  const metric = full.get<MetricsService>(MetricsService).registry.getSingleMetric('mscd_authz_denied_total');
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.filter((v) => v.labels.route === routeId).reduce((n, v) => n + v.value, 0);
}

/** Forgets the rate-limit buckets (F.3), so a sweep that calls a route as many users is not throttled. */
export async function resetRateLimits(db: TestDatabase): Promise<void> {
  await sql`delete from platform.rate_limit_bucket`.execute(db.migrator);
}
