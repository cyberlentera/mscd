// Fixtures of the WP-12 integration tests (packs, licences, management systems): development packs built in memory
// from `packs/sources` (never from `packs/dist`, R-09), hostile archives, signed development licences, the HTTP test
// application with the pack and management system modules, and fixture rows.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ModuleMetadata } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import {
  PACK_MTIME,
  buildPackFromSource,
  readPackSource,
  readTar,
  signLicence,
  writeTar,
  type BuiltPack,
  type PackSource,
  type TarWriteEntry,
} from '@mscd/pack-tools';
import type { Kysely } from 'kysely';
import { JobHandlerRegistry } from '../../../src/common/jobs/job-handler';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { ChainedAuditWriter } from '../../../src/modules/audit/audit-writer';
import { ManagementSystemsModule } from '../../../src/modules/management-systems/management-systems.module';
import { PackInstaller, type PackInstallOutcome } from '../../../src/modules/packs/pack-installer';
import { PacksModule } from '../../../src/modules/packs/packs.module';
import { compiledTrustAnchors } from '../../../src/modules/license/trust-anchors';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { VERSION } from '../../../src/generated/build-info';
import type { FakeIdentity } from '../../setup/auth-fakes';
import type { TestDatabase } from '../../setup/test-db';
import { createIntApp, infoOf, type IntApp } from '../platform/helpers';
import { inScope } from '../db/helpers';

export const REPO_ROOT = path.resolve(__dirname, '../../../../..');
export const SOURCES_DIR = path.join(REPO_ROOT, 'packs/sources');
export const DEV_KEYS_DIR = path.join(REPO_ROOT, 'packages/pack-tools/dev-keys');
export const DEV_PACK_KEY = readFileSync(path.join(DEV_KEYS_DIR, 'pack-signing.key'));
export const DEV_LICENCE_KEY = readFileSync(path.join(DEV_KEYS_DIR, 'licence-signing.key'));

/** The six development packs (D-14) in installation order. */
export const DEV_PACK_IDS = ['ISO22301-2019', 'ISO27001-2022', 'ISO37001-2016', 'ISO37001-2025', 'ISO9001-2015', 'ISO9001-2026'] as const;
export type DevPackId = (typeof DEV_PACK_IDS)[number];

const built = new Map<string, BuiltPack>();

/** A development pack built in memory from its source folder (cached per pack). */
export function devPack(packId: DevPackId): BuiltPack {
  let pack = built.get(packId);
  if (!pack) {
    pack = buildPackFromSource(readPackSource(path.join(SOURCES_DIR, packId)), DEV_PACK_KEY);
    built.set(packId, pack);
  }
  return pack;
}

/** A pack built from a changed copy of a source folder, signed with `key` (default the development pack key). */
export function changedPack(packId: DevPackId, change: (source: MutableSource) => void, key: Buffer | string = DEV_PACK_KEY): BuiltPack {
  const source = readPackSource(path.join(SOURCES_DIR, packId));
  const mutable: MutableSource = { manifest: { ...source.manifest }, datasets: new Map(source.datasets) };
  change(mutable);
  return buildPackFromSource(mutable as PackSource, key);
}

export interface MutableSource {
  manifest: PackSource['manifest'] & Record<string, unknown>;
  datasets: Map<string, Buffer>;
}

/** Replaces text in one dataset file of a mutable source. */
export function editDataset(source: MutableSource, file: string, from: string, to: string): void {
  const text = source.datasets.get(file)?.toString('utf8');
  if (text === undefined || !text.includes(from)) throw new Error(`${file} does not contain ${from}`);
  source.datasets.set(file, Buffer.from(text.replace(from, to), 'utf8'));
}

/** The entries of a pack archive, to build hostile variants. */
export function archiveEntries(bytes: Buffer): TarWriteEntry[] {
  return readTar(gunzipSync(bytes), { maxEntries: 1000 }).map((entry) => ({ path: entry.path, data: entry.data }));
}

/** A gzipped tar of entries, as the pack format writes it (but without any check). */
export function archiveOf(entries: readonly TarWriteEntry[]): Buffer {
  return gzipSync(writeTar(entries, { mtime: PACK_MTIME }));
}

/** A tar header announcing a 201 MiB file followed by gzip members of zeros: more than 200 MB decompressed. */
export function gzipBomb(): Buffer {
  const header = writeTar([{ path: 'requirements.csv', data: Buffer.alloc(0) }], { mtime: PACK_MTIME }).subarray(0, 512);
  const zeros = gzipSync(Buffer.alloc(1024 * 1024), { level: 9 });
  return Buffer.concat([gzipSync(header), ...Array.from({ length: 201 }, () => zeros)]);
}

/** A pack installer on the test database's `mscd_pack_installer` pool with the compiled (development) trust anchors. */
export function testInstaller(installerDb: Kysely<DB>): PackInstaller {
  return new PackInstaller({
    installerDb,
    audit: new ChainedAuditWriter(new TenantScope(installerDb)),
    trust: compiledTrustAnchors(),
    serverVersion: VERSION,
  });
}

/** Installs development packs as the command line does (operator actor). */
export async function installDevPacks(db: TestDatabase, packIds: readonly DevPackId[] = DEV_PACK_IDS): Promise<PackInstallOutcome[]> {
  const installer = testInstaller(db.packInstaller);
  const outcomes: PackInstallOutcome[] = [];
  for (const id of packIds) outcomes.push(await installer.install(devPack(id).bytes, { actor: { userId: null, kind: 'operator' } }));
  return outcomes;
}

// -------------------------------------------------------------------------------------------------------------------
// Licences
// -------------------------------------------------------------------------------------------------------------------

/** The unsigned fields of a test licence bound to an organisation, with the G.3 entitlements unless overridden. */
export function licenceFields(organizationId: string | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    license_id: 'LIC-TEST-0001',
    organization: 'Test organisation',
    valid_from: '2026-04-01',
    valid_until: '2027-03-31',
    grace_days: 30,
    frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'],
    max_management_systems: 10,
    max_users: 150,
    storage_adapters: ['managed_vault', 'm365', 'google_drive', 'smb'],
    features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...overrides,
  };
  for (const [name, value] of Object.entries(doc)) if (value === undefined) delete doc[name];
  return doc;
}

/** A signed test licence (development licence key unless `key` is given). */
export function devLicence(organizationId: string | null, overrides: Record<string, unknown> = {}, key: Buffer | string = DEV_LICENCE_KEY): Record<string, unknown> {
  return signLicence(licenceFields(organizationId, overrides), key);
}

// -------------------------------------------------------------------------------------------------------------------
// Application and rows
// -------------------------------------------------------------------------------------------------------------------

export interface PackApp extends IntApp {
  queue: InMemoryJobQueue;
  /** Starts workers for every job handler (once) and runs queued jobs until the queue is idle. */
  runJobs(): Promise<void>;
}

/** The HTTP application with the WP-08 core modules, the licence module and the pack and management system modules. */
export async function createPackApp(
  db: TestDatabase,
  options: {
    identities: Record<string, FakeIdentity>;
    env?: Record<string, string>;
    tenancy?: 'single' | 'multi';
    overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
    metadata?: ModuleMetadata;
  },
): Promise<PackApp> {
  const env = { ...(options.tenancy === 'multi' ? { MSCD__TENANCY__MODE: 'multi' } : {}), ...(options.env ?? {}) };
  const ctx = await createIntApp(
    db,
    { ...(options.metadata ?? {}), imports: [PacksModule, ManagementSystemsModule, ...(options.metadata?.imports ?? [])] },
    { auth: { identities: options.identities, tenancy: options.tenancy ?? 'single' }, env, overrides: options.overrides },
  );
  const queue = ctx.moduleRef.get<InMemoryJobQueue>(JOB_QUEUE);
  let workers = false;
  return {
    ...ctx,
    queue,
    async runJobs() {
      if (!workers) {
        await ctx.moduleRef.get(JobHandlerRegistry).registerAll(queue);
        workers = true;
      }
      await queue.drain();
    },
  };
}

/** A user with active memberships and optional admin roles (migrator with platform scope). */
export async function addMember(
  db: TestDatabase,
  handle: string,
  orgId: string,
  adminRoles: ('tenant_admin' | 'storage_admin')[] = [],
): Promise<string> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const user = await trx
      .insertInto('platform.app_user')
      .values({ handle, email: `${handle}@test.invalid`, display_name: handle })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('platform.org_membership').values({ organization_id: orgId, user_id: user.id, admin_roles: adminRoles }).execute();
    return user.id;
  });
}

/** A business role of a user in a system (written as the migrator in the tenant schema). */
export async function grantRole(db: TestDatabase, tenant: CreatedTenant, msId: string, userId: string, role: 'ms_manager' | 'domain_owner' = 'ms_manager'): Promise<void> {
  await inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
    await trx.insertInto('user_ms_role').values({ user_id: userId, management_system_id: msId, role, is_primary: role === 'ms_manager' }).execute();
  });
}

/** Fake identities of one organisation: Tenant Admin, MS Manager of `ms`, Domain Owner, Top Management. */
export function orgIdentities(tenant: CreatedTenant, users: { ta: string; mm: string; do?: string; tm?: string }, ms: string[] = ['isms', 'qms', 'bcms', 'abms']) {
  const org = infoOf(tenant);
  const identities: Record<string, FakeIdentity> = {
    [`ta@${tenant.slug}`]: { user: { id: users.ta, handle: `ta-${tenant.slug}` }, org, orgRoles: ['tenant_admin'], knownMs: ms },
    [`mm@${tenant.slug}`]: { user: { id: users.mm, handle: `mm-${tenant.slug}` }, org, rolesByMs: Object.fromEntries(ms.map((m) => [m, ['ms_manager']])), knownMs: ms },
  };
  if (users.do) identities[`do@${tenant.slug}`] = { user: { id: users.do, handle: `do-${tenant.slug}` }, org, rolesByMs: { isms: ['domain_owner'] }, knownMs: ms };
  if (users.tm) identities[`tm@${tenant.slug}`] = { user: { id: users.tm, handle: `tm-${tenant.slug}` }, org, rolesByMs: { isms: ['top_management'] }, knownMs: ms };
  return identities;
}

/** Multipart body of a pack import (`bundle` file field plus optional extra fields). */
export function importForm(bundle: Buffer, extra: Record<string, string> = {}): { payload: Buffer; contentType: string } {
  const boundary = 'mscd-pack-import-boundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(extra)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.pack"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bundle,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
