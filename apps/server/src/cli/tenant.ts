import type { Command } from 'commander';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import {
  GatewayDataKeyIssuer,
  gatewayDataKeyIssuer,
  TenantProvisioner,
  TenantProvisioningError,
  verifyTenantDomain,
  type CreatedTenant,
  type DataKeyIssuer,
  type VerifiedDomain,
} from '../db/tenant-provisioner';

/** `tenant create` and `tenant verify-domain` (D-01, C.8, D-25). Both run as mscd_migrator with platform scope. */
export function register(program: Command): void {
  const tenant = program.command('tenant').description('Organisation (tenant) administration');
  tenant
    .command('create')
    .description(
      'Create an organisation with its schema, tenant migrations, data key (from the storage gateway) and Managed Vault repository',
    )
    .requiredOption('--slug <slug>', 'organisation slug (schema org_<slug>): a lower-case letter, then letters, digits or _')
    .requiredOption('--name <name>', 'display name')
    .option('--id <uuid>', 'fixed organisation id (for licences bound to it)')
    .option('--time-zone <zone>', 'IANA time zone of the organisation local dates', 'Asia/Jakarta')
    .option('--site-count <n>', 'number of sites', '1')
    .option('--demo-deploy-label <label>', 'demo installs only: show the organisation as saas or onprem (D-20)')
    .action(async (options: TenantCreateOptions) => {
      await runCommand('tenant create', async (config) => {
        const created = await tenantCreate(config, options);
        process.stdout.write(
          `tenant create: organisation ${created.slug} (${created.id}) created: schema ${created.schemaName}, ` +
            `${created.migrations.length} tenant migrations, data key ${created.kekId}, ` +
            `Managed Vault repository ${created.vaultRepositoryId}\n`,
        );
      });
    });
  tenant
    .command('verify-domain')
    .description('Record an email domain as verified for an organisation (needed for JIT provisioning, D-25)')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--domain <domain>', 'email domain')
    .requiredOption('--by <name>', 'who verified it')
    .action(async (options: TenantVerifyDomainOptions) => {
      await runCommand('tenant verify-domain', async (config) => {
        const result = await tenantVerifyDomain(config, options);
        process.stdout.write(
          result.created
            ? `tenant verify-domain: ${result.domain} is now verified for organisation ${options.org}\n`
            : `tenant verify-domain: ${result.domain} was already verified for organisation ${options.org}; nothing changed\n`,
        );
      });
    });
}

export interface TenantCreateOptions {
  slug: string;
  name: string;
  id?: string;
  timeZone?: string;
  siteCount?: string;
  demoDeployLabel?: string;
}

/**
 * `tenant create` with a loaded configuration. The data key comes from the storage gateway of the profile
 * (`storage.gateway`); `dataKeys` replaces it in tests. Throws `TenantProvisioningError` for refused input.
 */
export async function tenantCreate(config: MscdConfig, options: TenantCreateOptions, dataKeys?: DataKeyIssuer): Promise<CreatedTenant> {
  if (!/^\d{1,5}$/.test(options.siteCount ?? '1')) throw new TenantProvisioningError('--site-count must be a whole number');
  const siteCount = Number(options.siteCount ?? '1');
  const label = options.demoDeployLabel;
  if (label !== undefined) {
    if (!config.demoEnabled) throw new TenantProvisioningError('--demo-deploy-label needs demo mode (demo.enabled: true, D-20)');
    if (label !== 'saas' && label !== 'onprem') throw new TenantProvisioningError('--demo-deploy-label must be saas or onprem');
  }
  const issuer = dataKeys ?? gatewayDataKeyIssuer(config);
  try {
    return await new TenantProvisioner({ connectionString: config.databaseUrl('migrator'), dataKeys: issuer }).create({
      id: options.id,
      slug: options.slug,
      name: options.name,
      timeZone: options.timeZone ?? 'Asia/Jakarta',
      siteCount,
      demoDeployLabel: label as 'saas' | 'onprem' | undefined,
      actor: { kind: 'operator' },
    });
  } finally {
    if (issuer instanceof GatewayDataKeyIssuer && issuer !== dataKeys) await issuer.close();
  }
}

export interface TenantVerifyDomainOptions {
  org: string;
  domain: string;
  by: string;
}

/** `tenant verify-domain` with a loaded configuration. */
export async function tenantVerifyDomain(config: MscdConfig, options: TenantVerifyDomainOptions): Promise<VerifiedDomain> {
  return verifyTenantDomain(config.databaseUrl('migrator'), {
    orgSlug: options.org,
    domain: options.domain,
    verifiedBy: options.by,
    actor: { kind: 'operator' },
  });
}

/** Loads the configuration, runs the command and turns errors into one stderr line and exit code 1. */
async function runCommand(name: string, fn: (config: MscdConfig) => Promise<void>): Promise<void> {
  const config = loadConfigOrExit('cli');
  try {
    await fn(config);
  } catch (error) {
    if (error instanceof ConfigError) exitOnConfigError(error);
    process.stderr.write(`${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
