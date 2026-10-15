// Common contract pieces (build plan D.1, D.2): primitives, problem details, command results, pages, record refs
// and the route definition type every area file uses.
import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  IdentityProviderIcon, IdentityProviderKind, PROBLEM_TYPE_BASE, Permission, PermissionScope, RECORD_KEY_KINDS, RuleId,
} from '../enums.js';
import type { MachineEntity } from '../machines.js';

// ---------------------------------------------------------------------------------------------------------------
// Schema ids and examples
// ---------------------------------------------------------------------------------------------------------------

/** Metadata key that holds examples a schema must reject; stripped from the OpenAPI document. */
export const INVALID_EXAMPLES_KEY = 'x-invalid-examples';

/**
 * Hand-written examples of a schema: values it must accept and values it must reject. They are checked at run time
 * by `test/schemas.test.ts` (typing them would forbid the `as const` fixtures that the composite examples reuse).
 */
export interface SchemaExamples {
  valid: readonly unknown[];
  invalid: readonly unknown[];
}

/**
 * Registers a schema under its export name (the OpenAPI component name) with a description and examples. Every
 * exported schema of `@mscd/shared` that is not an enumeration carries examples; `test/schemas.test.ts` parses each
 * valid example and checks that each invalid one is rejected.
 */
export function named<T extends ZodType>(id: string, schema: T, description: string, examples: SchemaExamples): T {
  return schema.meta({ id, description, examples: [...examples.valid], [INVALID_EXAMPLES_KEY]: [...examples.invalid] });
}

// ---------------------------------------------------------------------------------------------------------------
// Primitives (UI 0, D.2)
// ---------------------------------------------------------------------------------------------------------------

export const Pair = named('Pair', z.tuple([z.string(), z.string()]), 'Text pair [English, Indonesian]; the controller picks one with li()', {
  valid: [['Risk', 'Risiko'], ['', '']],
  invalid: [['Risk'], 'Risk', ['a', 'b', 'c'], [1, 2]],
});
export type Pair = z.infer<typeof Pair>;

export const Text = named('Text', z.union([z.string(), Pair]), 'Display text: one string, or an [English, Indonesian] pair the controller renders with li()', {
  valid: ['Certified 14 Mar 2025', ['Certified 14 Mar 2025', 'Tersertifikasi 14 Mar 2025']],
  invalid: [null, ['only one'], 3],
});
export type Text = z.infer<typeof Text>;

export const IsoDate = named('IsoDate', z.iso.date(), 'Local date of the organisation, YYYY-MM-DD (D.1)', {
  valid: ['2026-09-29', '2028-02-29'],
  invalid: ['2026-9-29', '2026-02-30', '2026-09-29T00:00:00Z', ''],
});
export type IsoDate = z.infer<typeof IsoDate>;

export const IsoDateOrEmpty = named('IsoDateOrEmpty', z.union([IsoDate, z.literal('')]), 'A local date, or an empty string when the record has none (UI 1.6 appr)', {
  valid: ['2026-09-24', ''],
  invalid: [null, '24 Sep 2026'],
});
export type IsoDateOrEmpty = z.infer<typeof IsoDateOrEmpty>;

export const Instant = named('Instant', z.iso.datetime(), 'Instant in ISO 8601 UTC with a Z suffix (D.1)', {
  valid: ['2026-09-29T06:00:00Z', '2026-09-29T06:00:00.123Z'],
  invalid: ['2026-09-29', '2026-09-29T06:00:00+07:00', 'yesterday'],
});
export type Instant = z.infer<typeof Instant>;

export const Uuid = named('Uuid', z.guid(), 'Record id (uuid)', {
  valid: ['8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', '00000000-0000-0000-0000-000000000001'],
  invalid: ['8a1f2d3c', 'R-031', ''],
});
export type Uuid = z.infer<typeof Uuid>;

export const MsId = named('MsId', z.string().regex(/^[a-z][a-z0-9-]{1,19}$/), 'Management system slug, for example isms (management_system.slug)', {
  valid: ['isms', 'qms-2'],
  invalid: ['ISMS', '1sms', 'i', 'a'.repeat(21)],
});
export type MsId = z.infer<typeof MsId>;

export const PersonId = named('PersonId', z.string().regex(/^[a-z][a-z0-9._-]{1,39}$/), 'User handle; none means Unassigned (BR-45)', {
  valid: ['rina', 'tenant.admin', 'none', 'staff01'],
  invalid: ['Rina', '', 'r', 'rina kusuma'],
});
export type PersonId = z.infer<typeof PersonId>;

export const Handle = named('Handle', PersonId.refine((h) => h !== 'none', { message: 'none is not a user' }), 'User handle (platform.app_user.handle); none is not allowed', {
  valid: ['rina', 'ext.auditor'],
  invalid: ['none', 'Rina', ''],
});
export type Handle = z.infer<typeof Handle>;

export const OrgSlug = named('OrgSlug', z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), 'Organisation slug (platform.organization.slug)', {
  valid: ['ndt', 'bank_sentosa'],
  invalid: ['NDT', 'n', 'nd-t'],
});
export type OrgSlug = z.infer<typeof OrgSlug>;

export const RepositorySlug = named('RepositorySlug', z.string().regex(/^[a-z][a-z0-9-]{1,19}$/), 'Storage repository slug (storage_repository.slug)', {
  valid: ['vault', 'sp', 'gd-bcms'],
  invalid: ['Vault', 'v', 'sp_1'],
});
export type RepositorySlug = z.infer<typeof RepositorySlug>;

export const ProviderSlug = named('ProviderSlug', z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), 'Identity provider slug (platform.identity_provider.slug)', {
  valid: ['keycloak', 'entra-id'],
  invalid: ['Keycloak', 'k', 'entra_id'],
});
export type ProviderSlug = z.infer<typeof ProviderSlug>;

/** True when the text contains a C0 control character (U+0000 to U+001F) or DEL (U+007F). */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export const Code = named(
  'Code',
  z.string().min(1).max(30).regex(/^\S(?:.*\S)?$/).refine((v) => !hasControlCharacter(v), { message: 'Control characters are not allowed' }),
  'Business id of a record (code, doc_code, evidence_code, catalogue item or requirement code): 1 to 30 printable characters without leading or trailing space',
  { valid: ['R-031', 'A.5.23', 'Cl. 8.7', 'EV-0313', '9.3.2 c)'], invalid: ['', ' R-031', 'R-031 ', 'a'.repeat(31), 'R\n31'] },
);
export type Code = z.infer<typeof Code>;

export const FreqId = named('FreqId', z.string().regex(/^[a-z][a-z0-9_]{0,19}$/), 'Evidence frequency code from the pack (ref.evidence_frequency_rule.code, A-43)', {
  valid: ['monthly', 'event', 'semi'],
  invalid: ['Monthly', '', '1d'],
});
export type FreqId = z.infer<typeof FreqId>;

export const StageKey = named('StageKey', z.string().regex(/^[a-z][a-z0-9_]{0,19}$/), 'Chain stage key (ref.traceability_chain_def.stage_key)', {
  valid: ['risk', 'soa', 'drisk'],
  invalid: ['Risk', '', 'risk-1'],
});
export type StageKey = z.infer<typeof StageKey>;

const RECORD_KEY_RE = new RegExp(`^[a-z][a-z0-9-]{1,19}:(?:${RECORD_KEY_KINDS.join('|')}):\\S(?:.*\\S)?$`);
export const RecordKey = named('RecordKey', z.string().max(160).regex(RECORD_KEY_RE), 'Record key <ms>:<kind>:<business id> (UI 0, G.5)', {
  valid: ['isms:req:A.5.23', 'isms:x:R-031', 'qms:act:4.5', 'isms:task:8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b'],
  invalid: ['isms:foo:A.5.23', 'A.5.23', 'isms:req:', 'ISMS:req:A.5.23'],
});
export type RecordKey = z.infer<typeof RecordKey>;

export const Messages = named('Messages', z.object({ en: z.string(), id: z.string() }), 'A message in English and Indonesian', {
  valid: [{ en: 'Owner required', id: 'Pemilik wajib diisi' }],
  invalid: [{ en: 'Owner required' }, ['Owner required', 'Pemilik wajib diisi']],
});
export type Messages = z.infer<typeof Messages>;

/** Number of bytes of a string in UTF-8 (lone surrogates count as the 3 bytes of U+FFFD). */
export function utf8ByteLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Hex colour of a management system (`management_system.color`). */
export const Color = named('Color', z.string().regex(/^#[0-9a-fA-F]{6}$/), 'CSS colour #rrggbb', {
  valid: ['#e8731a', '#3A6FD8'],
  invalid: ['e8731a', '#e87', 'orange'],
});
export type Color = z.infer<typeof Color>;

// ---------------------------------------------------------------------------------------------------------------
// Records, problems and results (D.2)
// ---------------------------------------------------------------------------------------------------------------

export const RECORD_MODULES = ['implementation', 'audit', 'surveillance', 'storage', 'admin'] as const;
export const RecordModule = z.enum(RECORD_MODULES).meta({ id: 'RecordModule', description: 'Module of a record ref (ARCHITECTURE 13)' });
export type RecordModule = z.infer<typeof RecordModule>;

export const EntityTypeName = named('EntityTypeName', z.string().regex(/^[a-z][a-z_]{1,39}$/), 'Table name of a record (for example risk or applicability_entry)', {
  valid: ['risk', 'applicability_entry', 'task'],
  invalid: ['Risk', 'risk-treatment', ''],
});
export type EntityTypeName = z.infer<typeof EntityTypeName>;

export const RecordRef = named(
  'RecordRef',
  z.object({
    module: RecordModule,
    entityType: EntityTypeName,
    id: Uuid,
    code: z.string(),
    etag: z.string().optional(),
  }),
  'Stable reference to a record: business code for display, uuid for commands, weak ETag for If-Match (A-21, D.1)',
  {
    valid: [
      { module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-031', etag: 'W/"1790000000000"' },
      { module: 'implementation', entityType: 'applicability_entry', id: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c', code: 'A.5.23' },
    ],
    invalid: [{ module: 'audit', entityType: 'risk', id: 'R-031', code: 'R-031' }, { module: 'other', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-031' }],
  },
);
export type RecordRef = z.infer<typeof RecordRef>;

export const Warning = named('Warning', z.object({ rule: RuleId, messages: Messages }), 'Warn-and-allow rule result (D.1 Warnings)', {
  valid: [{ rule: 'BR-41', messages: { en: 'Holder has 12 open items', id: 'Pemegang memiliki 12 item terbuka' } }],
  invalid: [{ rule: 'BR-99', messages: { en: 'x', id: 'x' } }, { rule: 'BR-41', message: ['a', 'b'] }],
});
export type Warning = z.infer<typeof Warning>;

export const FieldError = named('FieldError', z.object({ path: z.string(), message: z.string() }), 'One validation error: dotted path and message', {
  valid: [{ path: 'body.to', message: 'Invalid option' }],
  invalid: [{ path: ['body', 'to'], message: 'Invalid option' }],
});
export type FieldError = z.infer<typeof FieldError>;

export const ReauthMethods = named(
  'ReauthMethods',
  z.object({
    local: z.boolean(),
    providers: z.array(z.object({ slug: ProviderSlug, kind: IdentityProviderKind, label: z.string(), icon: IdentityProviderIcon.optional() })),
  }),
  'Sign-in methods an organisation accepts (D-26 reauth-required, F.4 auth.sso_required)',
  {
    valid: [{ local: false, providers: [{ slug: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak' }] }, { local: true, providers: [] }],
    invalid: [{ local: 'yes', providers: [] }, { local: true }],
  },
);
export type ReauthMethods = z.infer<typeof ReauthMethods>;

export const Problem = named(
  'Problem',
  z.object({
    type: z.string().regex(new RegExp(`^${PROBLEM_TYPE_BASE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[a-z][a-z-]*$`)),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    rule: RuleId.optional(),
    messageKey: z.string().optional(),
    messages: Messages.optional(),
    ref: z.union([RecordRef, z.string()]).optional(),
    errors: z.array(FieldError).optional(),
    requestId: z.string(),
    retryAfter: z.int().min(0).optional(),
    affected: z.array(z.string()).optional(),
    methods: ReauthMethods.optional(),
  }),
  'RFC 9457 problem details (application/problem+json) with the D.1 extension members',
  {
    valid: [
      {
        type: 'https://mscd.cyberlentera.com/problems/business-rule', title: 'Business rule violated', status: 422, rule: 'BR-01',
        messages: { en: 'No valid evidence in the current period', id: 'Tidak ada evidence valid pada periode berjalan' },
        requestId: '5f0c2a8e-6b1d-4c3e-9f7a-2b8c4d6e8f01',
      },
      {
        type: 'https://mscd.cyberlentera.com/problems/validation', title: 'Invalid request', status: 400,
        errors: [{ path: 'body.to', message: 'Invalid option' }], requestId: 'req-12345678',
      },
      {
        type: 'https://mscd.cyberlentera.com/problems/reauth-required', title: 'Sign in again', status: 409, requestId: 'req-12345678',
        methods: { local: false, providers: [{ slug: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak' }] },
      },
    ],
    invalid: [
      { type: 'about:blank', title: 'x', status: 400, requestId: 'r' },
      { type: 'https://mscd.cyberlentera.com/problems/validation', title: 'x', status: 200, requestId: 'r' },
      { type: 'https://mscd.cyberlentera.com/problems/validation', title: 'x', status: 400 },
    ],
  },
);
export type Problem = z.infer<typeof Problem>;

const commandResultShape = {
  ok: z.literal(true),
  changed: z.array(MsId),
  count: z.int().min(0).optional(),
  message: Pair.optional(),
  warnings: z.array(Warning).optional(),
  redirectUrl: z.string().optional(),
  downloadUrl: z.string().optional(),
  taskId: Uuid.optional(),
  ref: RecordRef.optional(),
  data: z.unknown().optional(),
};

export const CommandResult = named(
  'CommandResult',
  z.object(commandResultShape),
  'Result of a mutation: systems whose bundles must be reloaded, counts, messages, warnings and links (D.2)',
  {
    valid: [
      { ok: true, changed: ['isms'] },
      { ok: true, changed: ['isms'], count: 8, message: ['Reminders sent to 8 holders', 'Pengingat dikirim ke 8 pemegang'] },
      { ok: true, changed: [], taskId: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', warnings: [{ rule: 'BR-30', messages: { en: 'Personal repository', id: 'Repositori pribadi' } }] },
    ],
    invalid: [{ ok: false, changed: [] }, { ok: true }, { ok: true, changed: ['ISMS'] }],
  },
);
export type CommandResult = z.infer<typeof CommandResult>;

/** `CommandResult` whose `data` member has the given schema (D.2 routes that return `data.*`). */
export function commandResultWith<T extends ZodType>(data: T) {
  return z.object({ ...commandResultShape, data });
}

/** `Page<T>` (D.2): one page of a list, as `pageOf(item)` parses it. */
export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

/** Schema of `Page<T>` (D.2) for an item schema: one page of a list. */
export function pageOf<T extends ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.int().min(1),
    pageSize: z.int().min(1).max(200),
    total: z.int().min(0),
  });
}

/** The default and maximum page size (D.1 Lists). */
export const MAX_PAGE_SIZE = 200;

/** Query members of every list route (D.1 Lists): `page` (1-based) and `pageSize` (default and maximum 200). */
export const pageQueryShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(MAX_PAGE_SIZE),
};

export const PageQuery = named('PageQuery', z.strictObject(pageQueryShape), 'Paging query of every list route (D.1)', {
  valid: [{}, { page: '2', pageSize: '50' }, { page: 1 }],
  invalid: [{ page: '0' }, { pageSize: '201' }, { sort: 'title' }],
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Boolean query value: `true` or `false` (also `1` and `0`). */
export const QueryBoolean = named('QueryBoolean', z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'), 'Boolean query parameter: true, false, 1 or 0', {
  valid: ['true', '0'],
  invalid: ['yes', true, ''],
});

/** Permissions of the session user, organisation-wide and per system (D.2 `Me.permissions`). */
export const PermissionSet = named(
  'PermissionSet',
  z.object({ org: z.array(Permission), ms: z.record(MsId, z.array(Permission)) }),
  'Permissions of the session user: organisation and platform scope, and per system (F.6)',
  {
    valid: [{ org: ['storage.repository.read', 'pack.read'], ms: { isms: ['ms.read', 'applicability.verify'], qms: ['ms.read'] } }],
    invalid: [{ org: ['fly'], ms: {} }, { org: [] }],
  },
);
export type PermissionSet = z.infer<typeof PermissionSet>;

// ---------------------------------------------------------------------------------------------------------------
// Bodies and parameters shared by many routes
// ---------------------------------------------------------------------------------------------------------------

/** Response or request without a body (204 and 302 answers, POST commands without input). */
export const NoBody = named('NoBody', z.undefined(), 'No body', { valid: [undefined], invalid: [{}, null, ''] });

/** Empty JSON object body, for commands that take no input. */
export const EmptyBody = named('EmptyBody', z.strictObject({}), 'Empty JSON object', { valid: [{}], invalid: [{ x: 1 }, null] });
export type EmptyBody = z.infer<typeof EmptyBody>;

/** Raw bytes: streamed uploads and file responses (RouteDef.requestType and responseType say the media type). */
export const BinaryBody = named(
  'BinaryBody',
  z.custom<Uint8Array | AsyncIterable<Uint8Array> | { getReader(): unknown }>(
    (v) => v instanceof Uint8Array || (typeof v === 'object' && v !== null && (Symbol.asyncIterator in v || 'getReader' in v)),
  ),
  'Raw bytes (application/octet-stream or the media type the route names)',
  { valid: [new Uint8Array([1, 2, 3])], invalid: ['bytes', 42, null] },
);

export const MsParams = named('MsParams', z.strictObject({ ms: MsId }), 'Path parameters {ms}', {
  valid: [{ ms: 'isms' }],
  invalid: [{ ms: 'ISMS' }, {}],
});
export type MsParams = z.infer<typeof MsParams>;

export const MsRecordParams = named('MsRecordParams', z.strictObject({ ms: MsId, id: Uuid }), 'Path parameters {ms} and {id}', {
  valid: [{ ms: 'isms', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }],
  invalid: [{ ms: 'isms', id: 'R-031' }, { id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }],
});
export type MsRecordParams = z.infer<typeof MsRecordParams>;

export const IdParams = named('IdParams', z.strictObject({ id: Uuid }), 'Path parameter {id}', {
  valid: [{ id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }],
  invalid: [{ id: 'abc' }, {}],
});
export type IdParams = z.infer<typeof IdParams>;

/** Optional reason or note of a command (D.2 `{reason?}` bodies). */
export const ReasonBody = named('ReasonBody', z.strictObject({ reason: z.string().trim().min(1).max(500).optional() }), 'Optional reason of a command', {
  valid: [{}, { reason: 'Linked by mistake' }],
  invalid: [{ reason: '' }, { note: 'x' }],
});
export type ReasonBody = z.infer<typeof ReasonBody>;

/** Required reason (10 to 500 characters), as soft delete and target removal ask for (D.2 `SoftDeleteRequest`). */
export const RequiredReason = named('RequiredReason', z.string().trim().min(10).max(500), 'Reason of a destructive command, 10 to 500 characters', {
  valid: ['Duplicate of R-014, merged', 'x'.repeat(500)],
  invalid: ['too short', '', 'x'.repeat(501)],
});

// ---------------------------------------------------------------------------------------------------------------
// Route definitions (D.1)
// ---------------------------------------------------------------------------------------------------------------

/** Work packages of the build plan (K.2); `RouteDef.owner` names one of them. */
export const WORK_PACKAGE_IDS = Array.from({ length: 39 }, (_, i) => `WP-${String(i + 1).padStart(2, '0')}` as const);

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Authentication a route needs (D.1, F.1, D.5):
 * - `public`: no session; non-GET public routes check `Origin` instead of the CSRF header (F.2), unless `csrfExempt`.
 * - `session`: an `active` session.
 * - `any_session`: a session in any state (logout).
 * - `mfa_pending`: a session in state `mfa_pending` (second factor).
 * - `enrolment`: a session in state `mfa_enrolment`, or an `active` session (re-enrolment, F.5).
 * - `guest_otp`: the guest binding cookie `mscd_guest_tx` of an open one-time code transaction (F.14).
 * - `gateway`: storage gateway call with the gateway bearer token and, in `mtls` mode, a client certificate (D.5).
 */
export const ROUTE_AUTH_LEVELS = ['public', 'session', 'any_session', 'mfa_pending', 'enrolment', 'guest_otp', 'gateway'] as const;
export type RouteAuth = (typeof ROUTE_AUTH_LEVELS)[number];

/** Keys of route-specific rate limits (F.3). */
export const RATE_LIMIT_KEYS = ['ip', 'email', 'session', 'user', 'org', 'grant', 'token'] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];

/** One fixed-window rate limit of a route (F.3). */
export interface RateLimitDef {
  key: RateLimitKey;
  max: number;
  windowSeconds: number;
}

/** Limits for every authenticated api request (F.3), applied besides route-specific limits. */
export const DEFAULT_RATE_LIMITS: readonly RateLimitDef[] = [
  { key: 'user', max: 600, windowSeconds: 60 },
  { key: 'org', max: 6000, windowSeconds: 60 },
];

export type SuccessStatus = 200 | 201 | 202 | 204 | 302;

/**
 * Where one check of `RouteDef.anyOf` or `RouteDef.permissionBy` is made: `ms` in the system of the request (read from
 * `msSource`), `org` or `platform` as the matrix row says, or `any_ms`: the user holds the ms-scoped permission in at
 * least one system of the organisation (D.3 "in at least one system of the organisation"; no system is read from the
 * request).
 */
export const PERMISSION_CHECK_SCOPES = ['ms', 'org', 'platform', 'any_ms'] as const;
export type PermissionCheckScope = (typeof PERMISSION_CHECK_SCOPES)[number];

/** One permission check: the F.6 permission and where it is checked. */
export interface PermissionCheck {
  permission: Permission;
  scope: PermissionCheckScope;
}

/**
 * Permission chosen by the value of one request member (D.3 rows such as "risks: `risk.manage`; others:
 * `register.manage` (own)"). The guard reads the member after validating it with the route's schema, takes the case
 * of its value (or the `*` case) and checks that permission at that scope; own-scoped grants go to `ScopePolicy` as
 * for `permission`.
 */
export interface PermissionByMember {
  /** Where the member is read: a path parameter, or a member of the body or the query. */
  source: 'path' | 'body' | 'query';
  member: string;
  /** Check per member value; `*` covers every value not listed. */
  cases: Readonly<Record<string, PermissionCheck>> & { readonly '*': PermissionCheck };
}

/** The check of a `permissionBy` route for one member value (the `*` case when the value has no case of its own). */
export function permissionCase(by: PermissionByMember, value: unknown): PermissionCheck {
  return (typeof value === 'string' && value !== '*' && Object.hasOwn(by.cases, value) ? by.cases[value] : undefined) ?? by.cases['*'];
}

/**
 * One route of the contract (D.1). The server's `@ApiRoute(def)` mounts method and path, validates params, query,
 * headers and body with the schemas, checks `auth` and the permission, and validates responses in the development
 * and test profiles (WP-08). Fields after `file` are additions of WP-05 (handoff note).
 */
export interface RouteDef {
  /** Unique id, `<area>.<action>`, for example `applicability.transition`. */
  id: string;
  /** The work package that implements the route (contract and RBAC tests read it). */
  owner: `WP-${string}`;
  method: HttpMethod;
  /** Fastify path with `:param` segments; `/api/v1/...`, or `/v1/...` for storage gateway routes. */
  path: string;
  auth: RouteAuth;
  /** F.6 permission the guard checks; omitted for auth-only routes. */
  permission?: Permission;
  /** Where the permission is checked. */
  scope?: PermissionScope;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  response: ZodType;
  /**
   * Status codes the route may answer besides 400 (every route) and 401 and 403 (implied for every route that is not
   * public; listed where D.3 names a specific case, such as a wrong second-factor code). Public non-GET routes list
   * 403 for the `Origin` check (F.2) unless they are `csrfExempt`; routes with `rateLimits` list 429.
   */
  errors: readonly number[];
  /** Accepts `Idempotency-Key` (D.1). */
  idempotent?: boolean;
  /** Allowed in BR-37 read-only mode (D.1). */
  readOnlyAllowed?: boolean;
  /** Mounted only when the profile enables test endpoints (D.3 Test support). */
  testOnly?: boolean;
  /** Returns bytes through `FileResponder` (F.13). */
  file?: boolean;
  /** One-line description for the OpenAPI document. */
  summary: string;
  /**
   * Alternative checks (D.3 "A or B"): the guard passes when one of them passes, and the service applies the rule of
   * `summary` to what the user holds. Each alternative carries its own permission and scope, because the alternatives
   * of one route can have different matrix scopes (for example `audit_trail.read` in a system or
   * `audit_trail.metadata.read` in the organisation). An `ms` alternative is checked in the system named by
   * `msSource` and fails when the request names no system. Replaces `permission` and `scope`; `msSource` is set
   * exactly when an alternative is ms-scoped.
   */
  anyOf?: readonly PermissionCheck[];
  /**
   * Permissions the user needs besides `permission`, each checked at the route's `scope` (D.3 "A and B", for example
   * `ms.admin` and `pack.activate` to create a management system).
   */
  allOf?: readonly Permission[];
  /**
   * Permission that depends on a request member (D.3 rows that name a permission per kind or type). Replaces
   * `permission`, `anyOf` and `scope`: each case carries its permission and scope; `msSource` says where the system of
   * the `ms` cases comes from.
   */
  permissionBy?: PermissionByMember;
  /** C.13 machine whose transition rows decide the permission of each request (transition routes). */
  machine?: MachineEntity;
  /** Where an ms-scoped route reads the system: the `:ms` path parameter, or the `ms` member of body or query (F.7). */
  msSource?: 'path' | 'body' | 'query';
  /** Request headers the route reads (for example `X-MSCD-Put` of the gateway upload). */
  headers?: ZodType;
  /** Success status (default 200; 201 creations, 202 queued jobs, 204 no content, 302 redirects). */
  status?: SuccessStatus;
  /** Accepts `If-Match` with the record's weak ETag; a stale value answers 412 (D.1 Concurrency). */
  ifMatch?: boolean;
  /** Media type of the request body when it is not JSON. */
  requestType?: 'application/octet-stream' | 'multipart/form-data' | 'application/x-www-form-urlencoded';
  /** Media type of the success response when it is not JSON. */
  responseType?: string;
  /** Public POST that checks neither the CSRF header nor `Origin` (the SAML ACS, F.2, F.9). */
  csrfExempt?: boolean;
  /** Route-specific rate limits (F.3), applied besides `DEFAULT_RATE_LIMITS`. */
  rateLimits?: readonly RateLimitDef[];
}

/** Identity helper that keeps the literal schema types of a route definition. */
export function defineRoute<T extends RouteDef>(def: T): T {
  return def;
}

/** Path parameter names of a Fastify path, in order (`/ms/:ms/x/:id` gives `['ms', 'id']`). */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1] as string);
}

/** OpenAPI form of a Fastify path (`:id` becomes `{id}`). */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
}
