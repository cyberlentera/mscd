// `mscd-server seed demo [--reset]` (build plan D-01, G.1 to G.8): the demo organisations, users, licences, packs and
// the sample records, written as mscd_migrator with platform scope (packs as mscd_pack_installer, D-17). Refused
// unless demo mode is on. A second run without `--reset` changes nothing and reports "already seeded"; `--reset`
// first removes the demo organisations (schemas and platform rows) and the demo users.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '@mscd/shared';
import { verifyLicence } from '@mscd/pack-tools';
import { sql, type Kysely } from 'kysely';
import { installerAuditWriter } from '../cli/packs';
import { addDays, localDate, startOfLocalDay } from '../common/dates';
import { SYSTEM_USER_ID } from '../common/tokens';
import type { MscdConfig } from '../config/mscd-config';
import { openDedicatedDatabase } from '../db/migrator';
import { TenantProvisioner } from '../db/tenant-provisioner';
import type { DB } from '../db/types';
import { FileKeyProvider } from '../modules/keys/file-key-provider';
import { hashSecret } from '../modules/identity/password-hasher';
import { compiledTrustAnchors, type TrustAnchors } from '../modules/license/trust-anchors';
import { databaseIdentity, installPacksFromDir, type PackFileResult } from '../modules/packs/install-from-dir';
import { demoPrivateKeyPem } from './demo-key';
import type { SeedKeyService } from './key-service';
import { instantOfDisplayDateTime, writeOrganisation, type OrgSeedSummary, type PreparedRepository } from './org-writer';
import { DEMO_PASSWORD, demoOrgs, demoTotpSecret, demoUsers, KEYCLOAK_ORGS, type DemoOrg, type DemoUser } from './people';
import { DEMO_PACK_IDS, loadVersionContent, SYSTEM_PACKS, type VersionContent } from './ref-data';
import { loadSampleSnapshot, textPair, type SampleOrgSnapshot, type SampleSnapshotFile } from './snapshot';

/** `platform.system_setting` key written when a seed run finished; its presence means "already seeded". */
export const SEED_MARKER_KEY = 'demo.seed';
/** Version of the seed data layout, stored in the marker. */
export const SEED_DATA_VERSION = 1;
/** Development licences of G.3 (WP-09), `LIC-DEMO-<SLUG>.json`. */
export const DEV_LICENCE_DIR = path.resolve(__dirname, '../../../../packages/pack-tools/dev-licences');
/** Time zone of every demo organisation (C.4 default). */
const DEMO_TIME_ZONE = 'Asia/Jakarta';
/** Days the seeded external auditor grant stays valid from today (G.3, F.14). */
const GRANT_DAYS = 14;
/** Install dates of the packs the sample does not show (the sample shows the newest install per system, G.5). */
const OTHER_INSTALL_DATES: Readonly<Record<string, string>> = { 'ISO9001-2015': '2023-06-01', 'ISO37001-2016': '2025-02-03' };
/** Catalogue entries of newer pack versions (G.6 PACKS): the update text the pack cards show. */
const PACK_CATALOG_SYSTEMS: Readonly<Record<string, string>> = { qms: 'ISO9001-2026', abms: 'ISO37001-2025' };
/** Repository modes of G.6 by sample location kind. */
const REPOSITORY_MODES: Readonly<Record<string, PreparedRepository['modes']>> = {
  sp: ['link', 'pass_through'],
  od: ['link'],
  gd: ['zero_transit', 'link'],
  vault: ['stored'],
};

export class SeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SeedError';
  }
}

export interface SeedDemoOptions {
  /** Remove the demo organisations and users first, then seed again. */
  reset?: boolean;
  /** Data keys and credential sealing (the gateway in Compose, in process in tests). */
  keys: SeedKeyService;
  /** The sample snapshot file (default: `demo/sample-snapshot.json` next to this module or in the source tree). */
  snapshotFile?: string;
  /** Folder of the development licences (default `packages/pack-tools/dev-licences`). */
  licenceDir?: string;
  /** Trust anchors for the licences (default: the keys compiled into this build). */
  trust?: TrustAnchors;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface SeedDemoResult {
  status: 'seeded' | 'already_seeded';
  reset: boolean;
  removed: { organisations: string[]; users: number } | null;
  packs: PackFileResult[];
  users: number;
  organisations: OrgSeedSummary[];
}

interface VerifiedDemoLicence {
  document: unknown;
  sha256: string;
  keyId: string;
  licenseId: string;
  maxUsers: number;
  validFrom: string;
  validUntil: string;
}

export async function seedDemo(config: MscdConfig, options: SeedDemoOptions): Promise<SeedDemoResult> {
  const log = options.log ?? (() => undefined);
  const now = (options.now ?? (() => new Date()))();
  if (!config.demoEnabled) throw new SeedError('seed demo needs demo mode: set demo.enabled to true in the profile (D-20)');
  if (config.flavor === 'release') throw new SeedError('seed demo is not available in a release build (D-24)');
  const migratorUrl = config.databaseUrl('migrator');
  const installerUrl = config.databaseUrl('pack_installer');
  if (databaseIdentity(installerUrl) !== databaseIdentity(migratorUrl)) {
    throw new SeedError(`The pack installer URL names database ${databaseIdentity(installerUrl)}, the migrator URL ${databaseIdentity(migratorUrl)}: both must name the same database`);
  }
  const sample = loadSampleSnapshot(options.snapshotFile);
  const orgs = demoOrgs(sample.orgs);
  const users = demoUsers(sample.snapshots[sample.orgs[0]!.id]!.PEOPLE);
  const today = config.profile.demo.fixed_today ?? localDate(now, DEMO_TIME_ZONE);

  const db = openDedicatedDatabase<DB>(migratorUrl, { platformScope: true, applicationName: 'mscd-seed' });
  try {
    await assertMigrated(db);
    let removed: SeedDemoResult['removed'] = null;
    if (options.reset) {
      removed = await resetDemo(db, orgs, log);
    } else {
      const marker = await db.selectFrom('platform.system_setting').select('value').where('key', '=', SEED_MARKER_KEY).executeTakeFirst();
      if (marker) {
        log('seed demo: already seeded (run seed demo --reset to seed again)');
        return { status: 'already_seeded', reset: false, removed: null, packs: [], users: 0, organisations: [] };
      }
      await assertNothingSeeded(db, orgs);
    }

    // Packs (D-14) from packs.dir, as mscd_pack_installer.
    const report = await installPacksFromDir(config.profile.packs.dir, {
      installerUrl,
      audit: installerAuditWriter,
      actor: { userId: SYSTEM_USER_ID, kind: 'system' },
      log: (line) => log(`seed demo: ${line}`),
    });
    const failed = report.results.filter((r) => r.status === 'rejected' || r.status === 'failed');
    if (failed.length > 0) throw new SeedError(`Packs not installed: ${failed.map((r) => `${r.file} (${r.message ?? r.status})`).join(', ')}`);
    const versions = new Map<string, VersionContent>();
    const missing: string[] = [];
    for (const packId of DEMO_PACK_IDS) {
      try {
        versions.set(packId, await loadVersionContent(db, packId));
      } catch {
        missing.push(packId);
      }
    }
    if (missing.length > 0) {
      throw new SeedError(
        `The demo needs the packs ${missing.join(', ')}, which are not installed and not in ${config.profile.packs.dir}; ` +
          'run node tools/scripts/ensure-built.mjs',
      );
    }
    await recordPackDates(db, sample, config, log);

    // Licences (G.3), verified before anything is written for the organisations.
    const trust = options.trust ?? compiledTrustAnchors();
    const licences = new Map(orgs.map((org) => [org.slug, verifyDemoLicence(org, options.licenceDir ?? DEV_LICENCE_DIR, trust)]));

    // Users, TOTP factors and the platform operator role.
    const platformKeys = FileKeyProvider.fromFiles(config.profile.kms.file.path, config.profile.kms.file.previous_paths);
    const userIds = await createUsers(db, users, platformKeys, now);
    log(`seed demo: ${userIds.size} users (password ${DEMO_PASSWORD}, TOTP as tools/scripts/demo-totp.mjs prints)`);

    const keycloak = config.profile.demo.keycloak;
    const keycloakSecret = keycloak ? readKeycloakSecret(config, keycloak.client_secret_file, log) : null;
    const grantExpiresAt = grantExpiry(today, now);
    const defaultOrgOf = new Map(users.filter((u) => u.memberships.length > 0).map((u) => [u.handle, u.memberships[0]!.org as string]));
    const provisioner = new TenantProvisioner({ connectionString: migratorUrl, dataKeys: options.keys.dataKeys });
    const summaries: OrgSeedSummary[] = [];
    for (const org of orgs) {
      const created = await provisioner.create({
        id: org.id,
        slug: org.slug,
        name: org.name,
        timeZone: DEMO_TIME_ZONE,
        siteCount: org.siteCount,
        demoDeployLabel: org.demoDeployLabel,
        actor: { kind: 'system' },
      });
      log(`seed demo: ${org.slug}: organisation and schema ${created.schemaName} created (${created.migrations.length} tenant migrations)`);
      const snapshot = sample.snapshots[org.source]!;
      const tenantKey = await inPlatformScope(db, async (trx) => {
        await trx.updateTable('platform.organization').set({ position: org.position }).where('id', '=', org.id).execute();
        return trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', org.id).executeTakeFirstOrThrow();
      });
      const repositories = await prepareRepositories({
        org,
        snapshot,
        sample,
        vaultRepositoryId: created.vaultRepositoryId,
        wrappedDek: tenantKey.wrapped_dek,
        keys: options.keys,
        log,
      });
      const providers = new Map<string, { id: string; slug: string; clientSecretSealed: string }>();
      if (keycloak && keycloakSecret && KEYCLOAK_ORGS.includes(org.slug)) {
        const id = randomUUID();
        // identity_provider.slug is unique across organisations, so the second organisation's provider gets a suffix.
        const slug = org.slug === KEYCLOAK_ORGS[0] ? 'keycloak' : `keycloak-${org.slug}`;
        providers.set(org.slug, { id, slug, clientSecretSealed: await platformKeys.wrap(Buffer.from(keycloakSecret, 'utf8'), `idp:${id}`) });
      }
      const summary = await db.transaction().execute((trx) =>
        writeOrganisation(trx, {
          org,
          schema: created.schemaName,
          timeZone: DEMO_TIME_ZONE,
          snapshot,
          sample,
          users: userIds,
          demoUsers: users,
          defaultOrgOf,
          versions,
          licence: licences.get(org.slug)!,
          repositories,
          today,
          now,
          grantExpiresAt,
          keycloak: keycloak && keycloakSecret ? { issuer: keycloak.issuer, clientId: keycloak.client_id, providers } : null,
        }),
      );
      log(
        `seed demo: ${org.slug} (${org.name}): ${summary.systems} ${summary.systems === 1 ? 'system' : 'systems'}, ${summary.members} active users, ` +
          `${summary.applicabilityEntries} applicability entries, ${summary.evidence} evidence, ${summary.documents} documents, ` +
          `${summary.chainRecords} chain records, ${summary.activities} activities`,
      );
      summaries.push(summary);
    }

    await db
      .insertInto('platform.system_setting')
      .values({
        key: SEED_MARKER_KEY,
        value: JSON.stringify({ version: SEED_DATA_VERSION, seededAt: now.toISOString(), today, organisations: orgs.map((o) => o.slug), keys: options.keys.mode }),
      })
      .execute();
    log(`seed demo: done (${summaries.length} organisations, today ${today})`);
    return { status: 'seeded', reset: options.reset === true, removed, packs: report.results, users: userIds.size, organisations: summaries };
  } finally {
    await db.destroy();
  }
}

/**
 * The Keycloak client secret of `demo.keycloak` (G.3). The demo profile names the Compose secret path, which a seed run
 * on a developer machine cannot read; then the provider is left out and the run says so, instead of failing.
 */
function readKeycloakSecret(config: MscdConfig, file: string, log: (line: string) => void): string | null {
  try {
    return config.readSecretFile(file, 'demo.keycloak.client_secret_file');
  } catch (error) {
    log(`seed demo: demo.keycloak is set, but ${(error as Error).message}; the Keycloak provider is not created`);
    return null;
  }
}

/** Runs `fn` in a transaction with transaction-local platform scope (F.10). */
async function inPlatformScope<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
    return fn(trx);
  });
}

async function assertMigrated(db: Kysely<DB>): Promise<void> {
  const found = await sql<{ ok: boolean }>`select to_regclass('platform.system_setting') is not null and to_regclass('ref.framework_version') is not null as ok`.execute(db);
  if (!found.rows[0]?.ok) throw new SeedError('The platform and ref schemas do not exist: run "mscd-server migrate" first');
}

/** Refuses to seed over the leftovers of an interrupted run (no marker, but demo organisations or users exist). */
async function assertNothingSeeded(db: Kysely<DB>, orgs: readonly DemoOrg[]): Promise<void> {
  const existing = await db
    .selectFrom('platform.organization')
    .select('slug')
    .where((eb) => eb.or([eb('id', 'in', orgs.map((o) => o.id)), eb('slug', 'in', orgs.map((o) => o.slug))]))
    .execute();
  const demoUsersLeft = await db.selectFrom('platform.app_user').select('handle').where('is_demo', '=', true).limit(1).execute();
  if (existing.length > 0 || demoUsersLeft.length > 0) {
    const what = existing.length > 0 ? `organisations ${existing.map((o) => o.slug).join(', ')}` : 'demo users';
    throw new SeedError(`The database already holds ${what} but no finished seed: run "mscd-server seed demo --reset"`);
  }
}

/**
 * `--reset`: removes the demo organisations (their schemas and their platform rows) and the demo users with their
 * sessions, factors, identities and memberships. Audit log entries stay (append-only, F.11). Installed packs stay.
 */
export async function resetDemo(db: Kysely<DB>, orgs: readonly DemoOrg[], log: (line: string) => void = () => undefined): Promise<{ organisations: string[]; users: number }> {
  const found = await db
    .selectFrom('platform.organization')
    .select(['id', 'slug', 'schema_name'])
    .where((eb) => eb.or([eb('id', 'in', orgs.map((o) => o.id)), eb('slug', 'in', orgs.map((o) => o.slug))]))
    .execute();
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
      for (const org of found) {
        const providers = (await trx.selectFrom('platform.identity_provider').select('id').where('organization_id', '=', org.id).execute()).map((p) => p.id);
        if (providers.length > 0) {
          await trx.deleteFrom('platform.saml_assertion_seen').where('identity_provider_id', 'in', providers).execute();
          await trx.deleteFrom('platform.user_identity').where('identity_provider_id', 'in', providers).execute();
          await trx.deleteFrom('platform.auth_transaction').where('identity_provider_id', 'in', providers).execute();
          await trx.deleteFrom('platform.session').where('identity_provider_id', 'in', providers).execute();
        }
        await trx
          .deleteFrom('platform.session')
          .where((eb) => eb.or([eb('organization_id', '=', org.id), eb('auth_org_id', '=', org.id)]))
          .execute();
        await trx.deleteFrom('platform.auth_transaction').where('organization_id', '=', org.id).execute();
        await trx.deleteFrom('platform.identity_provider').where('organization_id', '=', org.id).execute();
        await trx.deleteFrom('platform.invitation').where('organization_id', '=', org.id).execute();
        await trx.deleteFrom('platform.licence').where('organization_id', '=', org.id).execute();
        await trx.deleteFrom('platform.tenant_key').where('organization_id', '=', org.id).execute();
        await trx.deleteFrom('platform.verified_domain').where('organization_id', '=', org.id).execute();
        await trx.deleteFrom('platform.org_membership').where('organization_id', '=', org.id).execute();
        // idempotency_key is visible only with the organisation's app.org_id (D-31).
        await sql`select set_config('app.org_id', ${org.id}, true)`.execute(trx);
        await trx.deleteFrom('platform.idempotency_key').where('organization_id', '=', org.id).execute();
        await sql`select set_config('app.org_id', '', true)`.execute(trx);
        await sql`drop schema if exists ${sql.id(org.schema_name)} cascade`.execute(trx);
        await trx.deleteFrom('platform.organization').where('id', '=', org.id).execute();
        log(`seed demo: removed organisation ${org.slug} and schema ${org.schema_name}`);
      }
      const demo = (await trx.selectFrom('platform.app_user').select('id').where('is_demo', '=', true).execute()).map((u) => u.id);
      if (demo.length > 0) {
        await trx.deleteFrom('platform.session').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.mfa_recovery_code').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.mfa_factor').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.user_identity').where((eb) => eb.or([eb('user_id', 'in', demo), eb('linked_by', 'in', demo)])).execute();
        await trx.deleteFrom('platform.password_reset_token').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.invitation').where((eb) => eb.or([eb('user_id', 'in', demo), eb('created_by', 'in', demo)])).execute();
        await trx.deleteFrom('platform.user_preference').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.platform_role').where((eb) => eb.or([eb('user_id', 'in', demo), eb('granted_by', 'in', demo)])).execute();
        await trx.deleteFrom('platform.auth_transaction').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.org_membership').where('user_id', 'in', demo).execute();
        await trx.deleteFrom('platform.app_user').where('id', 'in', demo).execute();
        log(`seed demo: removed ${demo.length} demo users`);
      }
      await trx.deleteFrom('platform.system_setting').where('key', '=', SEED_MARKER_KEY).execute();
      return { organisations: found.map((o) => o.slug), users: demo.length };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23503') {
      throw new SeedError(
        `--reset cannot remove the demo users: rows outside the demo organisations still refer to them (${(error as Error).message}). ` +
          'Remove those rows or reset the database',
        { cause: error },
      );
    }
    throw error;
  }
}

/** Install dates of the packs (G.4 `PACKS[]`) and the catalogue entries of newer versions (G.6 `PACKS`). */
async function recordPackDates(db: Kysely<DB>, sample: SampleSnapshotFile, config: MscdConfig, log: (line: string) => void): Promise<void> {
  const packs = sample.snapshots[sample.orgs[0]!.id]!.PACKS;
  const dates = new Map<string, string>(Object.entries(OTHER_INSTALL_DATES));
  for (const [system, card] of Object.entries(packs)) {
    const ids = SYSTEM_PACKS[system];
    if (!ids) continue;
    const date = isoOfShortDate(card.installed);
    // The card shows the newest install of the editions the system uses (G.5): the target edition, else the active one.
    dates.set(ids.target ?? ids.active, date);
    if (!dates.has(ids.active)) dates.set(ids.active, date);
  }
  await inPlatformScope(db, async (trx) => {
    for (const [packId, date] of dates) {
      const at = new Date(startOfLocalDay(date, DEMO_TIME_ZONE).getTime() + 9 * 3_600_000);
      await trx.updateTable('platform.pack_install').set({ installed_at: at }).where('pack_id', '=', packId).where('status', '=', 'installed').execute();
      await trx.updateTable('ref.framework_version').set({ installed_at: at }).where('pack_id', '=', packId).execute();
    }
    for (const [system, packId] of Object.entries(PACK_CATALOG_SYSTEMS)) {
      const update = packs[system]?.update;
      if (!update) continue;
      const [en, id] = textPair(update);
      const version = en.split(':')[0]!.trim();
      const note = (text: string) => text.slice(text.indexOf(':') + 1).trim();
      await trx
        .insertInto('platform.pack_catalog')
        .values({ pack_id: packId, pack_version: version, channel: config.profile.packs.channel, note_en: note(en), note_id: note(id) })
        .onConflict((oc) => oc.columns(['pack_id', 'pack_version']).doUpdateSet({ note_en: note(en), note_id: note(id) }))
        .execute();
    }
  });
  log(`seed demo: pack install dates and ${Object.keys(PACK_CATALOG_SYSTEMS).length} pack catalogue entries recorded`);
}

/** `02 Feb 2026` to `2026-02-02`. */
function isoOfShortDate(text: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text);
  const month = match ? months.indexOf(match[2]!) + 1 : 0;
  if (!match || month === 0) throw new SeedError(`Not a sample date: ${text}`);
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}`;
}

/** Reads and verifies the development licence of an organisation (D-15): trusted key, signature, bound to its id. */
export function verifyDemoLicence(org: DemoOrg, dir: string, trust: TrustAnchors): VerifiedDemoLicence {
  const file = path.join(dir, `LIC-DEMO-${org.slug.toUpperCase()}.json`);
  let document: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new SeedError(`Cannot read the development licence ${file}: ${(error as Error).message}`, { cause: error });
  }
  let verified;
  try {
    verified = verifyLicence(document, trust.keys, { rejectKeyIds: trust.rejectKeyIds });
  } catch (error) {
    throw new SeedError(`The development licence ${file} does not verify: ${(error as Error).message}`, { cause: error });
  }
  if (verified.binding.kind !== 'organization' || verified.binding.id !== org.id) {
    throw new SeedError(`The development licence ${file} is not bound to organisation ${org.slug} (${org.id})`);
  }
  return {
    document,
    sha256: createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex'),
    keyId: verified.keyId,
    licenseId: verified.document.license_id,
    maxUsers: verified.document.max_users,
    validFrom: verified.document.valid_from,
    validUntil: verified.document.valid_until,
  };
}

/** Users (G.3) with their password hashes, TOTP factors and the platform operator role, in one transaction. */
async function createUsers(db: Kysely<DB>, users: readonly DemoUser[], platformKeys: FileKeyProvider, now: Date): Promise<Map<string, string>> {
  const ids = new Map(users.map((u) => [u.handle, randomUUID()]));
  const hashes = new Map(await Promise.all(users.filter((u) => u.password).map(async (u) => [u.handle, await hashSecret(DEMO_PASSWORD)] as const)));
  const factors = await Promise.all(
    users
      .filter((u) => u.totp)
      .map(async (u) => ({
        user_id: ids.get(u.handle)!,
        kind: 'totp' as const,
        secret_sealed: await platformKeys.wrap(demoTotpSecret(u.handle), `mfa:${ids.get(u.handle)!}`),
        label: 'Authenticator app',
        confirmed_at: now,
      })),
  );
  await inPlatformScope(db, async (trx) => {
    for (let i = 0; i < users.length; i += 200) {
      await trx
        .insertInto('platform.app_user')
        .values(
          users.slice(i, i + 200).map((u) => ({
            id: ids.get(u.handle)!,
            handle: u.handle,
            email: u.email,
            display_name: u.displayName,
            job_title: u.jobTitle,
            kind: u.kind,
            status: 'active' as const,
            password_hash: hashes.get(u.handle) ?? null,
            password_changed_at: hashes.has(u.handle) ? now : null,
            mfa_required: true,
            is_demo: true,
          })),
        )
        .execute();
    }
    if (factors.length > 0) await trx.insertInto('platform.mfa_factor').values(factors).execute();
    const operators = users.filter((u) => u.platformOperator).map((u) => ({ user_id: ids.get(u.handle)!, role: 'platform_operator' as const, granted_at: now }));
    if (operators.length > 0) await trx.insertInto('platform.platform_role').values(operators).execute();
  });
  return ids;
}

/** Expiry of the seeded auditor grant: the end of the day 14 days after today (the later of demo and real today). */
function grantExpiry(today: string, now: Date): Date {
  const realToday = localDate(now, DEMO_TIME_ZONE);
  const base = realToday > today ? realToday : today;
  return new Date(startOfLocalDay(addDays(base, GRANT_DAYS + 1), DEMO_TIME_ZONE).getTime() - 1000);
}

interface RepositoryInput {
  org: DemoOrg;
  snapshot: SampleOrgSnapshot;
  sample: SampleSnapshotFile;
  vaultRepositoryId: string;
  wrappedDek: string;
  keys: SeedKeyService;
  log: (line: string) => void;
}

/**
 * The organisation's repositories (G.6 REPOS, LOC; G.8): the Managed Vault of the provisioning updated, the provider
 * repositories with configurations that point at the mock drives, and their credentials sealed by the key service
 * before the transaction (D-08).
 */
async function prepareRepositories(input: RepositoryInput): Promise<PreparedRepository[]> {
  const { org, snapshot, sample } = input;
  const storage = sample.storage;
  const repos = snapshot.REPOS;
  const result: PreparedRepository[] = [];
  let m365Key: string | null = null;
  const positions = new Map(repos.map((r, i) => [r.id, i]));
  const slugs = [...repos.map((r) => r.id), ...(repos.some((r) => r.id === 'vault') ? [] : ['vault'])];
  for (const slug of slugs) {
    const repo = repos.find((r) => r.id === slug);
    const loc = snapshot.LOC[slug];
    const display: Record<string, unknown> = {};
    if (repo) display.configSummary = repo.tenant;
    if (loc && repo && loc[0] !== repo.name) display.locName = loc[0];
    const lastCheckedAt = repo ? instantOfDisplayDateTime(repo.last, DEMO_TIME_ZONE) : instantOfDisplayDateTime('29 Sep 2026 06:00', DEMO_TIME_ZONE);
    const common = {
      slug,
      ownershipType: repo?.ownershipType ?? ('organizational' as const),
      messages: repo?.msg ? textPair(repo.msg) : null,
      display,
      lastCheckedAt,
      position: positions.get(slug) ?? repos.length,
    };
    if (slug === 'vault') {
      result.push({
        ...common,
        id: input.vaultRepositoryId,
        name: repo?.name ?? 'Managed Vault',
        adapter: 'managed_vault',
        modes: REPOSITORY_MODES.vault!,
        config: { prefix: `tenants/${org.id}/` },
        connectionStatus: 'ok',
        connectionStatusSince: lastCheckedAt,
        existing: true,
        credential: null,
      });
      continue;
    }
    if (!repo) continue;
    const drive = storage.drives[slug];
    const modes = REPOSITORY_MODES[slug];
    if (!drive || !modes) throw new SeedError(`No storage layout for repository ${slug}`);
    const roots = Object.fromEntries(Object.entries(drive.roots).filter(([system]) => org.systems.includes(system)));
    const id = randomUUID();
    const revoked = repo.status === 'bad';
    const since = revoked ? instantOfDisplayDateTime('27 Sep 2026 06:00', DEMO_TIME_ZONE) : lastCheckedAt;
    let config: Record<string, unknown>;
    let credential: PreparedRepository['credential'];
    const tenant = { orgId: org.id, wrappedDek: input.wrappedDek };
    if (drive.adapter === 'm365') {
      config = { siteId: drive.siteId, driveId: drive.driveId, rootFolderId: drive.rootFolderId, roots };
      m365Key ??= demoPrivateKeyPem(storage.m365.keyLabel, storage.m365.certificatePem);
      const secret = { tenantId: storage.m365.tenantId, clientId: storage.m365.clientId, certificatePem: storage.m365.certificatePem, privateKeyPem: m365Key };
      const sealed = await input.keys.seal({ tenant, repository: { id, slug, adapter: 'm365', modes, config }, kind: 'm365_certificate', secret });
      credential = { ref: `demo-${org.slug}-${slug}`, kind: 'm365_certificate', ...sealed, externalAccount: null, expiresAt: new Date(storage.m365.notAfter) };
    } else {
      config = { driveId: drive.driveId, rootFolderId: drive.rootFolderId, roots, oauthClientId: storage.google.clientId };
      // The delegated token expired (G.8); the gateway seals refresh tokens only in the consent flow, so through the
      // gateway the seed can store the OAuth client alone (the repository then asks for reauthorisation).
      const secret: Record<string, unknown> = { clientId: storage.google.clientId, clientSecret: storage.google.clientSecret };
      if (input.keys.sealsRefreshTokens) secret.refreshToken = storage.google.refreshToken;
      else input.log(`seed demo: ${org.slug}/${slug}: sealed the OAuth client without the expired delegated token (gateway key service)`);
      const sealed = await input.keys.seal({ tenant, repository: { id, slug, adapter: 'google_drive', modes, config }, kind: 'oauth_refresh_token', secret });
      credential = { ref: `demo-${org.slug}-${slug}`, kind: 'oauth_refresh_token', ...sealed, externalAccount: storage.google.account.email, expiresAt: null };
    }
    result.push({
      ...common,
      id,
      name: repo.name,
      adapter: drive.adapter,
      modes,
      config,
      connectionStatus: revoked ? 'revoked' : 'ok',
      connectionStatusSince: since,
      existing: false,
      credential,
    });
  }
  return result;
}
