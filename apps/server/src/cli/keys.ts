// Key and token administration (build plan D-01, D-09, F.11, D.5):
//
//   keys generate --out <dir> [--force]   platform.key, storage.key (32 random bytes, base64), gateway.token and the
//                                         Ed25519 pair audit-anchor.key / audit-anchor.pub; secrets mode 0400
//   keys rewrap [--storage] [--platform]  re-wraps tenant data keys (platform.tenant_key) under the current
//                                         storage.key and re-seals the secrets sealed with platform.key (TOTP
//                                         secrets, IdP client secrets, PKCE verifiers) under the current
//                                         platform.key; previous keys come from `previous_paths` of the profile
//   keys rotate-gateway-token             writes a new current token and keeps the old one as previous until the
//                                         next rotation (`gateway.token_files`, or --current and --previous)
//
// Repository credentials need no re-sealing on a storage.key rotation: they are sealed with the tenant data key,
// which a rotation re-wraps but does not change (D-08).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { sql, type Kysely } from 'kysely';
import { ProfileError } from '../config/load-profile';
import { ConfigError, DATABASE_URL_ENV, MscdConfig } from '../config/mscd-config';
import { openDedicatedDatabase } from '../db/migrator';
import type { DB } from '../db/types';
import { DataKeyService } from '../gateway/crypto/data-keys';
import { FileKeyProvider, kekIdOf } from '../modules/keys/file-key-provider';
import { anchorKeyId } from '../modules/audit/anchors';
import { MIN_TOKEN_LENGTH } from '../gateway/auth';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** A new gateway token: 32 random bytes, base64url (43 characters). */
export function newGatewayToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Writes a file atomically (temporary file in the same folder, then rename) with the given mode. */
export function writeFileAtomic(file: string, content: string, mode: number): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, content, { mode, flag: 'wx' });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

export interface GeneratedKeys {
  dir: string;
  files: string[];
  platformKekId: string;
  storageKekId: string;
  anchorKeyId: string;
}

/** `keys generate`: the five files of F.11 in `outDir`. Existing files are kept unless `force`. */
export function generateKeys(outDir: string, options: { force?: boolean } = {}): GeneratedKeys {
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = ['platform.key', 'storage.key', 'gateway.token', 'audit-anchor.key', 'audit-anchor.pub'];
  const existing = names.filter((name) => existsSync(path.join(dir, name)));
  if (existing.length > 0 && !options.force) {
    throw new ConfigError(`${existing.join(', ')} already exist in ${dir}; use --force to replace them`);
  }
  const platformKey = randomBytes(32);
  const storageKey = randomBytes(32);
  const anchor = generateKeyPairSync('ed25519');
  const anchorPrivate = anchor.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const anchorPublic = anchor.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileAtomic(path.join(dir, 'platform.key'), `${platformKey.toString('base64')}\n`, 0o400);
  writeFileAtomic(path.join(dir, 'storage.key'), `${storageKey.toString('base64')}\n`, 0o400);
  writeFileAtomic(path.join(dir, 'gateway.token'), `${newGatewayToken()}\n`, 0o400);
  writeFileAtomic(path.join(dir, 'audit-anchor.key'), anchorPrivate, 0o400);
  writeFileAtomic(path.join(dir, 'audit-anchor.pub'), anchorPublic, 0o444);
  const result = {
    dir,
    files: names.map((name) => path.join(dir, name)),
    platformKekId: kekIdOf(platformKey),
    storageKekId: kekIdOf(storageKey),
    anchorKeyId: anchorKeyId(anchor.publicKey),
  };
  platformKey.fill(0);
  storageKey.fill(0);
  return result;
}

/**
 * `keys rotate-gateway-token`: the current token moves to the previous file and a new token becomes current. The
 * gateway accepts both until the next rotation (D.5); the api and worker read the current file on every call.
 */
export function rotateGatewayToken(currentFile: string, previousFile: string): { current: string; previous: string } {
  if (path.resolve(currentFile) === path.resolve(previousFile)) throw new ConfigError('The current and previous token files must differ');
  let old: string;
  try {
    old = readFileSync(currentFile, 'utf8').replace(/\r?\n$/, '');
  } catch (error) {
    throw new ConfigError(`Cannot read the current gateway token ${currentFile}: ${(error as Error).message}`);
  }
  if (old.trim().length < MIN_TOKEN_LENGTH) throw new ConfigError(`The current gateway token in ${currentFile} is too short to keep`);
  writeFileAtomic(previousFile, `${old}\n`, 0o400);
  writeFileAtomic(currentFile, `${newGatewayToken()}\n`, 0o400);
  return { current: path.resolve(currentFile), previous: path.resolve(previousFile) };
}

export interface RewrapReport {
  tenantKeys: { checked: number; rewrapped: number };
  platformSecrets: { checked: number; resealed: number };
}

/** Platform scope for the rest of the transaction (F.10): `tenant_key` and `identity_provider` are organisation scoped. */
async function platformScope(trx: Kysely<DB>): Promise<void> {
  await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
}

/** Re-wraps every tenant data key not wrapped with the current storage.key (platform scope, as the migrator). */
export async function rewrapTenantKeys(migrator: Kysely<DB>, storageKeys: FileKeyProvider): Promise<RewrapReport['tenantKeys']> {
  const service = new DataKeyService(storageKeys);
  return migrator.transaction().execute(async (trx) => {
    await platformScope(trx);
    const rows = await trx.selectFrom('platform.tenant_key').select(['organization_id', 'wrapped_dek']).forUpdate().execute();
    let rewrapped = 0;
    for (const row of rows) {
      const next = await service.rewrap(row.organization_id, row.wrapped_dek);
      if (!next) continue;
      await trx
        .updateTable('platform.tenant_key')
        .set({ wrapped_dek: next.wrappedDek, kek_id: next.kekId, rotated_at: sql<Date>`now()` })
        .where('organization_id', '=', row.organization_id)
        .execute();
      rewrapped += 1;
    }
    return { checked: rows.length, rewrapped };
  });
}

/** Re-seals the secrets sealed with platform.key (F.11 bindings `mfa:`, `idp:`, `pkce:`) under the current key. */
export async function resealPlatformSecrets(migrator: Kysely<DB>, platformKeys: FileKeyProvider): Promise<RewrapReport['platformSecrets']> {
  return migrator.transaction().execute(async (trx) => {
    await platformScope(trx);
    let checked = 0;
    let resealed = 0;
    const reseal = async (sealed: string, aad: string): Promise<string | null> => {
      checked += 1;
      if (!platformKeys.needsRewrap(sealed)) return null;
      const plain = await platformKeys.unwrap(sealed, aad);
      try {
        resealed += 1;
        return await platformKeys.wrap(plain, aad);
      } finally {
        plain.fill(0);
      }
    };
    const factors = await trx.selectFrom('platform.mfa_factor').select(['id', 'user_id', 'secret_sealed']).forUpdate().execute();
    for (const factor of factors) {
      const next = await reseal(factor.secret_sealed, `mfa:${factor.user_id}`);
      if (next) await trx.updateTable('platform.mfa_factor').set({ secret_sealed: next }).where('id', '=', factor.id).execute();
    }
    const providers = await trx
      .selectFrom('platform.identity_provider')
      .select(['id', 'oidc_client_secret_sealed'])
      .where('oidc_client_secret_sealed', 'is not', null)
      .forUpdate()
      .execute();
    for (const provider of providers) {
      const next = await reseal(provider.oidc_client_secret_sealed!, `idp:${provider.id}`);
      if (next) await trx.updateTable('platform.identity_provider').set({ oidc_client_secret_sealed: next }).where('id', '=', provider.id).execute();
    }
    const transactions = await trx
      .selectFrom('platform.auth_transaction')
      .select(['id', 'code_verifier_sealed'])
      .where('code_verifier_sealed', 'is not', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .forUpdate()
      .execute();
    for (const transaction of transactions) {
      const next = await reseal(transaction.code_verifier_sealed!, `pkce:${transaction.id}`);
      if (next) await trx.updateTable('platform.auth_transaction').set({ code_verifier_sealed: next }).where('id', '=', transaction.id).execute();
    }
    return { checked, resealed };
  });
}

function loadConfig(): MscdConfig {
  try {
    return MscdConfig.load({ runMode: 'cli' });
  } catch (error) {
    if (error instanceof ProfileError) throw new ConfigError(error.format().trim());
    throw error;
  }
}

/** `keys rewrap`: needs the migrator URL and the key files (current and previous) of the kinds it re-wraps. */
export async function runRewrap(options: { storage?: boolean; platform?: boolean }, config: MscdConfig = loadConfig()): Promise<RewrapReport> {
  const both = !options.storage && !options.platform;
  let url: string;
  try {
    url = config.databaseUrl('migrator');
  } catch (error) {
    throw new ConfigError(`${(error as Error).message} (keys rewrap writes as the migrator, ${DATABASE_URL_ENV.migrator})`);
  }
  const report: RewrapReport = { tenantKeys: { checked: 0, rewrapped: 0 }, platformSecrets: { checked: 0, resealed: 0 } };
  const migrator = openDedicatedDatabase<DB>(url, { platformScope: true, applicationName: 'mscd-keys-rewrap' });
  try {
    if (both || options.storage) {
      const kms = config.profile.gateway.kms.file;
      report.tenantKeys = await rewrapTenantKeys(migrator, FileKeyProvider.fromFiles(kms.path, kms.previous_paths));
    }
    if (both || options.platform) {
      const kms = config.profile.kms.file;
      report.platformSecrets = await resealPlatformSecrets(migrator, FileKeyProvider.fromFiles(kms.path, kms.previous_paths));
    }
  } finally {
    await migrator.destroy();
  }
  return report;
}

function fail(io: CliIo, error: unknown): never {
  io.err(`mscd-server keys: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** `keys generate`, `keys rewrap` and `keys rotate-gateway-token` (D-01, F.11, D.5). */
export function register(program: Command, io: CliIo = processIo): void {
  const keys = program.command('keys').description('Key and token administration');
  keys
    .command('generate')
    .description('Write platform.key, storage.key, gateway.token, audit-anchor.key and audit-anchor.pub')
    .requiredOption('--out <dir>', 'output directory')
    .option('--force', 'replace files that already exist')
    .action((options: { out: string; force?: boolean }) => {
      try {
        const result = generateKeys(options.out, { force: options.force });
        io.out(`Wrote ${result.files.length} files to ${result.dir}`);
        io.out(`platform.key ${result.platformKekId}, storage.key ${result.storageKekId}, audit anchor key ${result.anchorKeyId}`);
      } catch (error) {
        fail(io, error);
      }
    });
  keys
    .command('rewrap')
    .description('Re-wrap tenant data keys and re-seal secrets under the current key-encryption key')
    .option('--storage', 'only tenant data keys (storage.key, gateway.kms in the profile)')
    .option('--platform', 'only secrets sealed with platform.key (kms in the profile)')
    .action(async (options: { storage?: boolean; platform?: boolean }) => {
      try {
        const report = await runRewrap(options);
        io.out(`Tenant data keys: ${report.tenantKeys.rewrapped} of ${report.tenantKeys.checked} re-wrapped`);
        io.out(`Platform secrets: ${report.platformSecrets.resealed} of ${report.platformSecrets.checked} re-sealed`);
      } catch (error) {
        fail(io, error);
      }
    });
  keys
    .command('rotate-gateway-token')
    .description('Write a new current gateway token and keep the old one as previous until the next rotation')
    .option('--current <file>', 'current token file (default: gateway.token_files[0] of the profile)')
    .option('--previous <file>', 'previous token file (default: gateway.token_files[1] of the profile)')
    .action((options: { current?: string; previous?: string }) => {
      try {
        let { current, previous } = options;
        if (!current || !previous) {
          const files = loadConfig().profile.gateway.token_files;
          if (files.length < 2) throw new ConfigError('gateway.token_files names one file; add the previous token file or pass --current and --previous');
          current ??= files[0]!;
          previous ??= files[1]!;
        }
        const result = rotateGatewayToken(current, previous);
        io.out(`New gateway token in ${result.current}; the old token in ${result.previous} stays valid until the next rotation`);
      } catch (error) {
        fail(io, error);
      }
    });
}
