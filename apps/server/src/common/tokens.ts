// Injection tokens and the interfaces behind them (build plan B.4). Modules never import another module's
// internals: they inject these tokens. WP-08 registers a default provider for each token in the module that will
// own it (deny-all permission evaluator, pass-through scope policy, permissive licence gate, minimal Me, a session
// resolver that authenticates nobody); the owning work package replaces the default inside its own folder:
//
// | Token                | Module   | Implemented by |
// |----------------------|----------|----------------|
// | SESSION_RESOLVER     | identity | WP-11          |
// | PERMISSION_EVALUATOR | authz    | WP-39          |
// | SCOPE_POLICY         | authz    | WP-39          |
// | RECORD_RESOLVER      | authz    | WP-39          |
// | MEMBERSHIP_SERVICE   | authz    | WP-39          |
// | ME_ASSEMBLER         | authz    | WP-39          |
// | LICENCE_GATE         | license  | WP-12          |
// | GATEWAY_CLIENT       | storage  | WP-13          |
// | NOTIFICATION_WRITER  | common   | WP-08          |
// | AUDIT_WRITER         | audit    | WP-08          |
// | JOB_QUEUE            | common   | WP-08 (in-memory), WP-22 (pg-boss, BullMQ) |
import type {
  ActorKind,
  AuditAction,
  AuthMethod,
  BusinessRole,
  DeployLabel,
  LicenceFeature,
  LocalLoginPolicy,
  Me,
  Messages,
  NotificationKind,
  OrganizationStatus,
  Pair,
  Permission,
  PermissionSet,
  RecordEntityType,
  RecordRef,
  RouteAuth,
  RouteDef,
  SessionState,
  StorageAdapter,
  UserKind,
} from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import type { Readable } from 'node:stream';
import type { DB } from '../db/types';

export { JOB_QUEUE } from './jobs/job-queue';
export type { JobQueue } from './jobs/job-queue';

/** A transaction opened by `withTenant` or `withPlatform` (F.10). */
export type Trx = Transaction<DB>;

/** The system user of C.1: the actor of jobs. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------------------------------------------
// Organisation and principal
// ---------------------------------------------------------------------------------------------------------------

/** An organisation as `TenantResolver` returns it (`platform.organization`, not deleted). */
export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  /** `org_<slug>` (C.1). */
  schema: string;
  status: OrganizationStatus;
  timeZone: string;
  localLogin: LocalLoginPolicy;
  demoDeployLabel: DeployLabel | null;
  siteCount: number;
  position: number;
}

export interface PrincipalUser {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  kind: UserKind;
}

/** The `platform.session` row behind a request (F.1). */
export interface PrincipalSession {
  /** Hex SHA-256 of the cookie value (`session.id_hash`). */
  idHash: string;
  state: SessionState;
  authMethod: AuthMethod;
  /** Organisation whose policy authenticated the session (D-26). */
  authOrgId: string | null;
  /** Auditor grant of a guest session (F.14). */
  authGrantId: string | null;
  identityProviderId: string | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  /** Last password or TOTP proof (F.5 re-enrolment). */
  passwordAt: Date | null;
  mfaAt: Date | null;
}

/** The caller of a request, as the session resolver found it. */
export interface Principal {
  user: PrincipalUser;
  /** Current organisation (`session.organization_id`), resolved through `TenantResolver`; null for an operator without one. */
  org: TenantInfo | null;
  /** Null for principals without a session (the guest one-time code transaction of F.14). */
  session: PrincipalSession | null;
  /** `auth_transaction` id of a guest one-time code (`auth: 'guest_otp'`). */
  guestTransactionId?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Session resolution (WP-11)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Finds the caller of a request (F.7 session resolution): cookie, `platform.session` with platform scope (state and
 * expiry), current organisation (membership `active`, organisation `active`, or `offboarding` for `GET` and
 * exports only, else it throws 403 `organisation-inactive`), user (status active). For `auth: 'guest_otp'` it
 * resolves the guest binding cookie instead. Null means unauthenticated; the guard answers 401 when the route needs
 * a principal and checks the session state against the route's auth level.
 */
export interface SessionResolver {
  resolve(request: FastifyRequest, auth: RouteAuth): Promise<Principal | null>;
  /**
   * Checks that need the route and the principal and belong to session handling: the CSRF header of non-GET
   * requests with a session and the `Origin` check of public POST routes (F.2). Called by the guard for every
   * contract route after `resolve`; throws a problem error (403 `csrf`). WP-11 implements it.
   */
  verifyRequest?(request: FastifyRequest, route: RouteDef, principal: Principal | null): Promise<void>;
}
export const SESSION_RESOLVER = Symbol.for('mscd.sessionResolver');

// ---------------------------------------------------------------------------------------------------------------
// Authorisation (WP-39)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where one permission is checked (F.6, F.7): in one system (`ms` with its slug), in the organisation, installation
 * wide, or `any_ms`: the user holds the ms-scoped permission in at least one system of the organisation.
 */
export type PermissionCheckScope = 'ms' | 'org' | 'platform' | 'any_ms';

export interface PermissionTarget {
  scope: PermissionCheckScope;
  /** Management system slug when `scope` is `ms`. */
  ms?: string;
}

/** `full`, `own` (only records whose owner or holder is the user; the service checks ownership) or null (denied). */
export type PermissionDecision = 'full' | 'own' | null;

export interface PermissionEvaluator {
  /**
   * Decision for one permission. Throws `NotFoundError` when `target.ms` names no system of the principal's
   * organisation (F.7: an unknown slug is 404).
   */
  evaluate(principal: Principal, permission: Permission, target: PermissionTarget): Promise<PermissionDecision>;
  /** Permissions for `Me.permissions` and the snapshots (D.2). */
  permissionSet(principal: Principal): Promise<PermissionSet>;
  /** Business roles of the principal per system slug (`Me.rolesByMs`). */
  rolesByMs(principal: Principal): Promise<Record<string, BusinessRole[]>>;
}
export const PERMISSION_EVALUATOR = Symbol.for('mscd.permissionEvaluator');

/** What the guard decided for the request, available to services as `request.mscd.authz`. */
export interface AuthzState {
  /** Management system slug of an ms-scoped route (from `msSource`), else null. */
  ms: string | null;
  /** Every permission the guard evaluated with a grant, and how it was granted. */
  granted: ReadonlyMap<Permission, 'full' | 'own'>;
  /** True when the route's permission is granted only through own-scoped roles (F.7 `request.authz.ownOnly`). */
  ownOnly: boolean;
}

/** How reads of one system are limited for the caller (D-04, F.7, D-34). */
export type ReadScope =
  | { kind: 'full' }
  | { kind: 'own'; userId: string }
  | { kind: 'external_auditor'; userId: string }
  | { kind: 'top_management' };

/** A record as `ScopePolicy.filter` needs it. */
export interface ScopedRecord {
  ownerUserId?: string | null;
  holderUserId?: string | null;
}

export interface ScopePolicy {
  /** The read scope of `ms` for the caller; throws `ForbiddenError` when the caller may read nothing there. */
  readScope(trx: Trx, principal: Principal, ms: string, authz: AuthzState): Promise<ReadScope>;
  /** The records the scope may see (owner scoping keeps records whose owner or holder is the user). */
  filter<T extends ScopedRecord>(scope: ReadScope, records: readonly T[]): T[];
  /** F.7 `canReadObject`: the object must be referenced by a record of `ms` the caller can see. */
  canReadObject(trx: Trx, principal: Principal, ms: string, storageObjectId: string, authz: AuthzState): Promise<boolean>;
}
export const SCOPE_POLICY = Symbol.for('mscd.scopePolicy');

/** A management system as the record resolver found it. */
export interface MsRef {
  id: string;
  slug: string;
}

export interface ResolvedRecord {
  entityType: RecordEntityType;
  id: string;
  ms: MsRef;
  /** The row as stored (snake_case columns). */
  row: Record<string, unknown>;
}

export interface RecordResolver {
  /**
   * D.1 and F.7: entity type from `RECORD_ENTITY_TYPES`, row by id inside the tenant transaction, and the row must
   * belong to the system `ms` (its `management_system_id`, or an `entity_ms_link` row for shareable types). Anything
   * else, a deleted row included, is 404 `not-found`.
   */
  resolve(trx: Trx, ms: string, entityType: string, id: string, options?: { forUpdate?: boolean }): Promise<ResolvedRecord>;
  /** The system of the transaction's organisation with this slug; 404 when there is none. */
  resolveMs(trx: Trx, ms: string): Promise<MsRef>;
}
export const RECORD_RESOLVER = Symbol.for('mscd.recordResolver');

export interface MembershipOptions {
  /** Accept guest accounts (columns that allow external auditors). Default false. */
  allowGuests?: boolean;
}

export interface MembershipService {
  /** True when the user is an active member of the transaction's organisation (`app.org_id`). */
  isMember(trx: Trx, userId: string, options?: MembershipOptions): Promise<boolean>;
  /** 422 `NOT-A-MEMBER` unless `isMember`. */
  assertMember(trx: Trx, userId: string, options?: MembershipOptions): Promise<void>;
  /** The user id of a handle among the members; `none` gives null (Unassigned, BR-45); others 422 `NOT-A-MEMBER`. */
  resolveHandle(trx: Trx, handle: string, options?: MembershipOptions): Promise<string | null>;
}
export const MEMBERSHIP_SERVICE = Symbol.for('mscd.membershipService');

export interface MeAssembler {
  /** `Me` of D.2 for the caller; `csrfToken` is the session's token value (only its hash is stored, F.2). */
  assemble(principal: Principal, options: { csrfToken: string }): Promise<Me>;
}
export const ME_ASSEMBLER = Symbol.for('mscd.meAssembler');

// ---------------------------------------------------------------------------------------------------------------
// Licence (WP-12)
// ---------------------------------------------------------------------------------------------------------------

export interface LicenceGate {
  /** 403 `read-only-mode` (BR-37) when the organisation's licence is past grace. */
  assertWritable(orgId: string): Promise<void>;
  /** 422 `LIC-USERS` when another active non-guest member would exceed `max_users` (D-15). */
  assertCanAddUser(trx: Trx, orgId: string): Promise<void>;
  /** 422 `LIC-MS` when another management system would exceed `max_management_systems`. */
  assertCanAddMs(trx: Trx, orgId: string): Promise<void>;
  /** 422 `LIC-FEATURE` when the licence does not include the feature. */
  assertFeature(orgId: string, feature: LicenceFeature, trx?: Trx): Promise<void>;
  /** Whether the licence includes a storage adapter (TS 5.7). */
  isAdapterLicensed(orgId: string, adapter: StorageAdapter): Promise<boolean>;
}
export const LICENCE_GATE = Symbol.for('mscd.licenceGate');

// ---------------------------------------------------------------------------------------------------------------
// Storage gateway client (WP-13)
// ---------------------------------------------------------------------------------------------------------------

/** Client of the storage gateway protocol (D.5); bodies and results are the shared `gateway` schemas. */
export interface GatewayClient {
  /** POSTs a JSON body to one `/v1/...` endpoint and returns the parsed JSON answer (problems become errors). */
  post<T>(path: string, body: unknown, options?: { requestId?: string; signal?: AbortSignal }): Promise<T>;
  /** `PUT /v1/objects` with the `X-MSCD-Put` header value object and a streamed body. */
  putObject<T>(header: unknown, body: Readable, options?: { requestId?: string; signal?: AbortSignal }): Promise<T>;
  /** `POST /v1/stream`: the decrypted bytes with their size and detected type. */
  stream(body: unknown, options?: { requestId?: string; signal?: AbortSignal }): Promise<{ stream: Readable; size: number | null; detectedType: string }>;
}
export const GATEWAY_CLIENT = Symbol.for('mscd.gatewayClient');

// ---------------------------------------------------------------------------------------------------------------
// Audit trail and notifications (WP-08)
// ---------------------------------------------------------------------------------------------------------------

/** One audit entry (F.11). Request id, source IP, user agent and actor default to the current request. */
export interface AuditEntryInput {
  action: AuditAction;
  /** Default: the request's user (`user`, or `guest` for guest accounts), else the system user (`system`). */
  actor?: { userId: string | null; kind: ActorKind };
  /**
   * Organisation of a platform-level entry (`platform.audit_log`); default: the request's organisation. Tenant
   * entries always belong to the transaction's organisation.
   */
  organizationId?: string | null;
  /** `management_system.id` of the system the change belongs to. */
  msId?: string | null;
  /**
   * Slug of the system when only the slug is at hand (the `ms` of a request): looked up in the entry's transaction
   * when `msId` is not given. Tenant entries only; an unknown slug leaves the system empty.
   */
  msSlug?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  entityCode?: string | null;
  /**
   * Values before and after the change. When both are given only the changed keys are stored; secrets are always
   * redacted (F.11).
   */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** `<pack_id> <version>` of the active edition (two during a transition); default: looked up from `msId`. */
  edition?: string | null;
  requestId?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
}

export interface RecordedAuditEntry {
  chain: 'tenant' | 'platform';
  id: string;
  seq: string;
}

export interface AuditWriter {
  /**
   * Writes the entry in the caller's transaction: platform-level actions (F.11 prefixes) to `platform.audit_log`,
   * every other action to the tenant `audit_trail` of the transaction (opened by `withTenant`).
   */
  record(trx: Trx, entry: AuditEntryInput): Promise<RecordedAuditEntry>;
  /**
   * Writes the entry in a transaction of its own: tenant actions into the organisation `target` (default: the
   * request's organisation), platform actions with platform scope.
   */
  recordDetached(entry: AuditEntryInput, target?: { orgId: string; schema: string } | null): Promise<RecordedAuditEntry>;
}
export const AUDIT_WRITER = Symbol.for('mscd.auditWriter');

/** One in-app notification (E.6); the text is stored in both languages. */
export interface NotificationInput {
  recipientUserId: string;
  kind: NotificationKind;
  title: Pair | Messages;
  body: Pair | Messages;
  /** `management_system.id`, when the notification belongs to one system. */
  msId?: string | null;
  ref?: RecordRef | null;
  /** Sent by the daily digest instead of right away (E.6 Digest column). */
  digest?: boolean;
  /** Actor that caused it (default: the request's user, else the system user). */
  createdBy?: string | null;
}

export interface NotificationWriter {
  /**
   * Inserts a `notification` row in the caller's tenant transaction and, for non-digest notifications, queues
   * `notifications.dispatch` in the same transaction. Notifications are created only for active members of the
   * organisation (E.6): for anyone else nothing is written and the result is null.
   */
  create(trx: Trx, input: NotificationInput): Promise<string | null>;
}
export const NOTIFICATION_WRITER = Symbol.for('mscd.notificationWriter');
