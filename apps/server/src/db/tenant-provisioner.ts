import { randomUUID } from 'node:crypto';
import { Migrator, sql, type Kysely } from 'kysely';
import { Agent, request, type Dispatcher } from 'undici';
import type { MscdConfig } from '../config/mscd-config';
import { createKysely } from './kysely';
import { MigrationFailedError, migrationsDir, MIGRATIONS_ROOT } from './migrator';
import { SqlFileMigrationProvider } from './sql-migration-provider';
import type { DB } from './types';

// Tenant provisioning (build plan C.8) and the platform operator's domain verification (D-25). Both run as
// mscd_migrator on a dedicated connection (never the application pool) with platform scope, in one transaction:
// a failure leaves no organisation row, no schema, no key and no audit entry behind.

/** Organisation slug: also the schema name suffix (`org_<slug>`), so it is restricted like the C.4 CHECK. */
export const ORG_SLUG = /^[a-z][a-z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Actor id of jobs and of commands without a signed-in user (C.1). */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/** A wrapped tenant data key as `POST /v1/keys/data-key` of the storage gateway returns it (D.5, F.11). */
export interface WrappedDataKey {
  /** SecretBox text `v1.<kekId>.<iv>.<ciphertext and tag>`, sealed with additional data `dek:<orgId>`. */
  wrappedDek: string;
  /** Id of the storage KEK that wrapped it (first 8 hex characters of its SHA-256). */
  kekId: string;
}

/** Issues the data key of a new organisation. The api never sees the key unwrapped (D-09). */
export interface DataKeyIssuer {
  issue(orgId: string): Promise<WrappedDataKey>;
}

export class TenantProvisioningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantProvisioningError';
  }
}

/** Who is recorded in `platform.audit_log` for a provisioning step. */
export interface ProvisioningActor {
  /** `operator` for the command line (default), `system` for the seed, `user` for a signed-in platform operator. */
  kind: 'operator' | 'system' | 'user';
  userId?: string | null;
  requestId?: string | null;
}

export interface CreateTenantInput {
  /** Fixed organisation id (the seed uses fixed ids so development licences bind to them, G.3); random when absent. */
  id?: string;
  slug: string;
  name: string;
  /** IANA time zone of the organisation's local dates (D-07), for example `Asia/Jakarta`. */
  timeZone: string;
  siteCount: number;
  /** Demo installs only (D-20): shows the organisation as SaaS or on-premise. */
  demoDeployLabel?: 'saas' | 'onprem' | null;
  actor?: ProvisioningActor;
}

export interface CreatedTenant {
  id: string;
  slug: string;
  schemaName: string;
  /** Tenant migrations applied to the new schema, in order. */
  migrations: string[];
  /** Id of the default `managed_vault` repository (A-41). */
  vaultRepositoryId: string;
  kekId: string;
}

export interface TenantProvisionerOptions {
  /** URL of role `mscd_migrator`. */
  connectionString: string;
  dataKeys: DataKeyIssuer;
  /** Folder holding platform/, ref/ and tenant/ (default `apps/server/migrations`). */
  migrationsRoot?: string;
}

interface CheckedInput {
  id: string;
  slug: string;
  schemaName: string;
  name: string;
  timeZone: string;
  siteCount: number;
  demoDeployLabel: 'saas' | 'onprem' | null;
  actor: ProvisioningActor;
}

/**
 * `TenantProvisioner.create` (C.8): organisation row, schema `org_<slug>`, tenant migrations, wrapped data key,
 * the default Managed Vault repository and the `tenant.created` audit entry. The data key is requested from the
 * gateway first, so an unreachable gateway fails the command before anything is written (no tenant without a
 * key); every database step then runs in one transaction.
 */
export class TenantProvisioner {
  constructor(private readonly options: TenantProvisionerOptions) {}

  async create(input: CreateTenantInput): Promise<CreatedTenant> {
    const checked = checkCreateInput(input);
    const migrator = createKysely<DB>({ connectionString: this.options.connectionString, max: 1, applicationName: 'mscd-tenant-create' });
    try {
      await assertSlugFree(migrator, checked);

      let key: WrappedDataKey;
      try {
        key = checkWrappedKey(await this.options.dataKeys.issue(checked.id));
      } catch (error) {
        throw new TenantProvisioningError(`No data key for organisation ${checked.slug}: ${messageOf(error)}`, { cause: error });
      }

      return await inTransaction(migrator, async (conn) => {
        await sql`select set_config('app.platform_scope', 'on', true)`.execute(conn);
        await assertTimeZoneKnown(conn, checked.timeZone);
        await assertSlugFree(conn, checked);

        // 1. Organisation row (the schema's RLS policies bind to its id, so it comes first).
        await conn
          .insertInto('platform.organization')
          .values({
            id: checked.id,
            slug: checked.slug,
            name: checked.name,
            schema_name: checked.schemaName,
            time_zone: checked.timeZone,
            site_count: checked.siteCount,
            demo_deploy_label: checked.demoDeployLabel,
          })
          .execute();

        // 2. Schema, owned by the migrator like every org_* schema (C.2).
        await sql`create schema ${sql.id(checked.schemaName)} authorization mscd_migrator`.execute(conn);

        // 3. Tenant migrations, inside this transaction, with the tenant schema and ext on the search path (C.6).
        await sql`select set_config('search_path', ${`"${checked.schemaName}", ext`}, true)`.execute(conn);
        const migrations = await migrateTenantSchema(conn, checked.schemaName, this.options.migrationsRoot);

        // 4. Wrapped tenant data key.
        await conn
          .insertInto('platform.tenant_key')
          .values({ organization_id: checked.id, wrapped_dek: key.wrappedDek, kek_id: key.kekId })
          .execute();

        // 5. Default Managed Vault repository (A-41), written under the tenant's RLS policy.
        await sql`select set_config('app.org_id', ${checked.id}, true)`.execute(conn);
        const actorUserId = actorUserIdOf(checked.actor);
        const vault = await conn
          .withSchema(checked.schemaName)
          .insertInto('storage_repository')
          .values({
            slug: 'vault',
            name: 'Managed Vault',
            adapter: 'managed_vault',
            modes: ['stored'],
            config: JSON.stringify({ prefix: `tenants/${checked.id}/` }),
            created_by: actorUserId,
            updated_by: actorUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // 6. Audit entry in the platform chain.
        await writePlatformAudit(conn, checked.actor, {
          organizationId: checked.id,
          action: 'tenant.created',
          entityType: 'organization',
          entityId: checked.id,
          entityCode: checked.slug,
          after: {
            slug: checked.slug,
            name: checked.name,
            schemaName: checked.schemaName,
            timeZone: checked.timeZone,
            siteCount: checked.siteCount,
            demoDeployLabel: checked.demoDeployLabel,
            kekId: key.kekId,
            vaultRepositoryId: vault.id,
          },
        });

        return {
          id: checked.id,
          slug: checked.slug,
          schemaName: checked.schemaName,
          migrations,
          vaultRepositoryId: vault.id,
          kekId: key.kekId,
        };
      });
    } finally {
      await migrator.destroy();
    }
  }
}

export interface VerifyDomainInput {
  orgSlug: string;
  domain: string;
  /** Who verified the domain (operator name or ticket), stored in `verified_domain.verified_by`. */
  verifiedBy: string;
  actor?: ProvisioningActor;
}

export interface VerifiedDomain {
  organizationId: string;
  domain: string;
  /** False when the domain was already verified for the organisation (nothing changed). */
  created: boolean;
}

/**
 * Records an email domain as verified for an organisation (`tenant verify-domain`, D-25): JIT provisioning
 * accepts only verified domains. Idempotent; a new row writes `tenant.domain_verified` to the platform audit log.
 */
export async function verifyTenantDomain(connectionString: string, input: VerifyDomainInput): Promise<VerifiedDomain> {
  const domain = normaliseDomain(input.domain);
  const verifiedBy = input.verifiedBy.trim();
  if (verifiedBy === '' || verifiedBy.length > 150) {
    throw new TenantProvisioningError('The verifier name (--by) must have 1 to 150 characters');
  }
  const migrator = createKysely<DB>({ connectionString, max: 1, applicationName: 'mscd-tenant-verify-domain' });
  try {
    return await inTransaction(migrator, async (conn) => {
      await sql`select set_config('app.platform_scope', 'on', true)`.execute(conn);
      const org = await conn
        .selectFrom('platform.organization')
        .select(['id'])
        .where('slug', '=', input.orgSlug)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!org) throw new TenantProvisioningError(`No organisation with slug ${input.orgSlug}`);
      const inserted = await conn
        .insertInto('platform.verified_domain')
        .values({ organization_id: org.id, domain, verified_by: verifiedBy })
        .onConflict((oc) => oc.columns(['organization_id', 'domain']).doNothing())
        .returning('domain')
        .executeTakeFirst();
      if (inserted) {
        await writePlatformAudit(conn, input.actor ?? { kind: 'operator' }, {
          organizationId: org.id,
          action: 'tenant.domain_verified',
          entityType: 'verified_domain',
          entityId: null,
          entityCode: domain,
          after: { domain, verifiedBy },
        });
      }
      return { organizationId: org.id, domain, created: inserted !== undefined };
    });
  } finally {
    await migrator.destroy();
  }
}

/**
 * Lower-cases and checks an email domain: labels of letters, digits and inner hyphens (punycode for
 * international names), a top-level label of at least two letters, at most 253 characters (C.4 CHECK).
 */
export function normaliseDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  const labels = domain.split('.');
  const ok =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]!);
  if (!ok || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new TenantProvisioningError(`${JSON.stringify(value)} is not an email domain such as example.co.id`);
  }
  return domain;
}

// ---------------------------------------------------------------------------------------------------------------
// Data key issuers

export interface GatewayDataKeyIssuerOptions {
  /** Gateway base URL from the profile (`storage.gateway.url`), for example `https://storage-gateway:8443`. */
  url: string;
  /** Bearer token (`storage.gateway.token_file`). */
  token: string;
  /** Client certificate, key and the installation CA for `tls.mode: mtls`; absent for `off` (demo only, D.4). */
  tls?: { ca: string; cert: string; key: string };
  /** Overall timeout of the call in milliseconds (default 15 seconds). */
  timeoutMs?: number;
}

/**
 * Asks the storage gateway for a new wrapped data key (`POST /v1/keys/data-key`, D.5). Any failure (gateway
 * unreachable, refused, malformed answer) is an error: a tenant is never created without a key.
 */
export class GatewayDataKeyIssuer implements DataKeyIssuer {
  private readonly endpoint: URL;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly options: GatewayDataKeyIssuerOptions) {
    const tls = options.tls;
    const base = checkGatewayUrl(options.url, tls ? 'mtls' : 'off');
    this.endpoint = new URL(`${base.pathname.replace(/\/+$/, '')}/v1/keys/data-key`, base);
    this.dispatcher = tls ? new Agent({ connect: { ca: tls.ca, cert: tls.cert, key: tls.key } }) : undefined;
  }

  async issue(orgId: string): Promise<WrappedDataKey> {
    const timeout = this.options.timeoutMs ?? 15_000;
    let response: Dispatcher.ResponseData;
    try {
      response = await request(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ orgId }),
        dispatcher: this.dispatcher,
        headersTimeout: timeout,
        bodyTimeout: timeout,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new TenantProvisioningError(`the storage gateway at ${this.endpoint.origin} is not reachable: ${messageOf(error)}`, {
        cause: error,
      });
    }
    const text = await response.body.text();
    if (response.statusCode !== 200) {
      throw new TenantProvisioningError(
        `the storage gateway answered ${response.statusCode} to POST /v1/keys/data-key${problemSummary(text)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TenantProvisioningError('the storage gateway answered POST /v1/keys/data-key with a body that is not JSON');
    }
    const { wrappedDek, kekId } = (body ?? {}) as Partial<Record<string, unknown>>;
    if (typeof wrappedDek !== 'string' || typeof kekId !== 'string') {
      throw new TenantProvisioningError('the storage gateway answer has no wrappedDek and kekId');
    }
    return checkWrappedKey({ wrappedDek, kekId });
  }

  /** Closes the TLS agent (when one was created). */
  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}

/** The gateway issuer configured by the profile's `storage.gateway` section (api and command line side). */
export function gatewayDataKeyIssuer(config: MscdConfig): GatewayDataKeyIssuer {
  const gateway = config.profile.storage.gateway;
  // Checked before any secret is read: an http URL with mode mtls would send the token in clear text.
  checkGatewayUrl(gateway.url, gateway.tls.mode);
  const token = config.readSecretFile(gateway.token_file, 'storage.gateway.token_file');
  let tls: GatewayDataKeyIssuerOptions['tls'];
  if (gateway.tls.mode === 'mtls') {
    const file = (value: string | null, key: string) => {
      if (value === null) throw new TenantProvisioningError(`storage.gateway.tls.${key} is required with mode mtls`);
      return config.readSecretFile(value, `storage.gateway.tls.${key}`);
    };
    tls = {
      ca: file(gateway.tls.ca_file, 'ca_file'),
      cert: file(gateway.tls.cert_file, 'cert_file'),
      key: file(gateway.tls.key_file, 'key_file'),
    };
  }
  return new GatewayDataKeyIssuer({ url: gateway.url, token, tls });
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/**
 * The gateway URL must use https with `tls.mode: mtls`; plain http is allowed only with `tls.mode: off`, which the
 * profile accepts in demo mode only (D.4, D.5). Without this check an http URL with mode mtls would send the bearer
 * token in clear text and ignore the client certificate and CA.
 */
function checkGatewayUrl(url: string, mode: 'mtls' | 'off'): URL {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new TenantProvisioningError(`The storage gateway URL is not a valid URL: ${url}`);
  }
  if (base.protocol === 'https:') return base;
  if (base.protocol === 'http:') {
    if (mode === 'off') return base;
    throw new TenantProvisioningError(
      `The storage gateway URL must use https with tls mode mtls; plain http is allowed only with tls mode off (demo only, D.4): ${url}`,
    );
  }
  throw new TenantProvisioningError(`The storage gateway URL must use https or http: ${url}`);
}

function checkCreateInput(input: CreateTenantInput): CheckedInput {
  if (!ORG_SLUG.test(input.slug)) {
    throw new TenantProvisioningError(
      `Organisation slug ${JSON.stringify(input.slug)} is invalid: 2 to 40 characters, a lower-case letter first, ` +
        'then lower-case letters, digits or underscores',
    );
  }
  const id = input.id ?? randomUUID();
  if (!UUID.test(id)) throw new TenantProvisioningError(`Organisation id ${JSON.stringify(id)} is not a lower-case UUID`);
  const name = input.name.trim();
  if (name === '' || name.length > 200) throw new TenantProvisioningError('The organisation name must have 1 to 200 characters');
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
  } catch {
    throw new TenantProvisioningError(`Unknown time zone ${JSON.stringify(input.timeZone)}; use an IANA name such as Asia/Jakarta`);
  }
  if (!Number.isInteger(input.siteCount) || input.siteCount < 0 || input.siteCount > 32767) {
    throw new TenantProvisioningError('The site count must be a whole number from 0 to 32767');
  }
  const label = input.demoDeployLabel ?? null;
  if (label !== null && label !== 'saas' && label !== 'onprem') {
    throw new TenantProvisioningError('The demo deployment label must be saas or onprem');
  }
  return {
    id,
    slug: input.slug,
    schemaName: `org_${input.slug}`,
    name,
    timeZone: input.timeZone,
    siteCount: input.siteCount,
    demoDeployLabel: label,
    actor: input.actor ?? { kind: 'operator' },
  };
}

function checkWrappedKey(key: WrappedDataKey): WrappedDataKey {
  const wellFormed =
    /^[0-9a-f]{8,40}$/.test(key.kekId) && key.wrappedDek.startsWith(`v1.${key.kekId}.`) && /^[A-Za-z0-9._-]+$/.test(key.wrappedDek);
  if (!wellFormed) {
    throw new TenantProvisioningError('the wrapped data key is not a SecretBox text v1.<kekId>.<iv>.<ciphertext> (F.11)');
  }
  return key;
}

async function assertSlugFree(conn: Kysely<DB>, input: CheckedInput): Promise<void> {
  let clash: { slug: string } | undefined;
  try {
    clash = await conn
      .selectFrom('platform.organization')
      .select('slug')
      .where((eb) => eb.or([eb('slug', '=', input.slug), eb('schema_name', '=', input.schemaName), eb('id', '=', input.id)]))
      .executeTakeFirst();
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') {
      throw new TenantProvisioningError('The platform tables do not exist yet: run "mscd-server migrate" first', { cause: error });
    }
    throw error;
  }
  if (clash) {
    throw new TenantProvisioningError(
      clash.slug === input.slug
        ? `Organisation ${input.slug} already exists`
        : `Organisation id ${input.id} or schema ${input.schemaName} is already used by organisation ${clash.slug}`,
    );
  }
  const schema = await sql<{ found: boolean }>`select to_regnamespace(${input.schemaName}) is not null as found`.execute(conn);
  if (schema.rows[0]?.found) {
    throw new TenantProvisioningError(
      `Schema ${input.schemaName} already exists without an organisation row; remove it or choose another slug`,
    );
  }
}

async function assertTimeZoneKnown(conn: Kysely<DB>, timeZone: string): Promise<void> {
  const known = await sql<{ found: boolean }>`
    select exists (select 1 from pg_timezone_names where name = ${timeZone}) as found`.execute(conn);
  if (!known.rows[0]?.found) throw new TenantProvisioningError(`PostgreSQL does not know the time zone ${timeZone}`);
}

/** Applies the tenant migrations to `schema` on a connection that is already inside a transaction. */
async function migrateTenantSchema(conn: Kysely<DB>, schema: string, root = MIGRATIONS_ROOT): Promise<string[]> {
  const migrator = new Migrator({
    db: conn,
    provider: new SqlFileMigrationProvider(migrationsDir('tenant', root)),
    migrationTableSchema: schema,
    allowUnorderedMigrations: true,
    // The caller's transaction holds every step of the provisioning (and the migration lock, which is
    // transaction scoped on PostgreSQL).
    disableTransactions: true,
  });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error !== undefined) throw new MigrationFailedError('tenant', schema, results, error);
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/**
 * Runs `fn` in one transaction on one reserved connection. Kysely's `transaction()` cannot be used because the
 * Kysely Migrator needs `connection()`, which a Transaction refuses.
 */
async function inTransaction<T>(database: Kysely<DB>, fn: (conn: Kysely<DB>) => Promise<T>): Promise<T> {
  return database.connection().execute(async (conn) => {
    await sql`begin`.execute(conn);
    try {
      const result = await fn(conn);
      await sql`commit`.execute(conn);
      return result;
    } catch (error) {
      await sql`rollback`.execute(conn).catch(() => undefined);
      throw error;
    }
  });
}

interface PlatformAuditEntry {
  organizationId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityCode: string;
  after: Record<string, unknown>;
}

async function writePlatformAudit(conn: Kysely<DB>, actor: ProvisioningActor, entry: PlatformAuditEntry): Promise<void> {
  await conn
    .insertInto('platform.audit_log')
    .values({
      organization_id: entry.organizationId,
      actor_user_id: actorUserIdOf(actor),
      actor_kind: actor.kind,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      entity_code: entry.entityCode,
      after_data: JSON.stringify(entry.after),
      request_id: actor.requestId ?? null,
    })
    .execute();
}

/** The user recorded for an actor: its own id, the system user for `system`, none for an operator. */
function actorUserIdOf(actor: ProvisioningActor): string | null {
  return actor.userId ?? (actor.kind === 'system' ? SYSTEM_USER_ID : null);
}

function problemSummary(text: string): string {
  try {
    const problem = JSON.parse(text) as { title?: unknown; detail?: unknown };
    const parts = [problem.title, problem.detail].filter((p): p is string => typeof p === 'string' && p !== '');
    return parts.length > 0 ? `: ${parts.join(': ')}` : '';
  } catch {
    return '';
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const extra = cause instanceof Error && cause.message && !error.message.includes(cause.message) ? ` (${cause.message})` : '';
    return `${error.message}${extra}`;
  }
  return String(error);
}
