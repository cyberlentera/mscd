import { Global, Module, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Command } from 'commander';
import { ConfigModule } from '../config/config.module';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { ProblemError } from '../common/problems';
import { DatabaseModule } from '../db/database.module';
import { AuditModule } from '../modules/audit/audit.module';
import { AuthzModule } from '../modules/authz/authz.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { InvitationService, type CreatedInvitation, type InvitedUser } from '../modules/identity/invitation.service';
import { KeysModule } from '../modules/keys/keys.module';
import { LicenseModule } from '../modules/license/license.module';
import { MetricsService } from '../modules/platform/metrics';
import { ReadinessService } from '../modules/platform/readiness.service';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { TenantScope } from '../modules/tenancy/tenant-scope';

/** `admin create-user` (D-01): a user with an invited membership and a one-time invitation link (F.4, D-15). */
export function register(program: Command): void {
  const admin = program.command('admin').description('User administration from the command line');
  admin
    .command('create-user')
    .description('Create a user and an invited membership of an organisation and print a one-time invitation link (valid 72 hours)')
    .requiredOption('--email <email>', 'email address of the user')
    .option('--name <name>', 'display name (default: the part of the email before @)')
    .option('--tenant-admin', 'grant the tenant_admin organisation role')
    .option('--org <slug>', 'organisation slug (default: the only organisation)')
    .action(async (options: CreateUserOptions) => {
      const config = loadConfigOrExit('cli');
      try {
        const result = await adminCreateUser(config, options);
        process.stdout.write(
          `admin create-user: ${result.newAccount ? 'created user' : 'invited existing user'} ${result.handle} (${result.email}) ` +
            `to organisation ${result.orgSlug}${options.tenantAdmin ? ' as tenant_admin' : ''}\n` +
            `Invitation link (single use, valid until ${result.expiresAt.toISOString()}):\n${result.link}\n` +
            (result.newAccount ? '' : 'The account already exists: accepting asks for its current password if it has one; the password is not replaced.\n'),
        );
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`admin create-user failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
}

export interface CreateUserOptions {
  email: string;
  name?: string;
  tenantAdmin?: boolean;
  org?: string;
}

export interface CreateUserResult extends Omit<InvitedUser, 'invitation'>, CreatedInvitation {
  orgSlug: string;
}

/** The message of a refusal: problem details carry the reason in their messages or detail. */
function describeError(error: unknown): string {
  if (error instanceof ProblemError) {
    const reason = error.extras.messages?.en ?? error.extras.detail ?? error.message;
    const fields = error.extras.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    return `${error.extras.rule ? `${error.extras.rule}: ` : ''}${reason}${fields ? ` (${fields})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Readiness and metrics services the database module expects, without the HTTP and metrics listeners. */
@Global()
@Module({ providers: [ReadinessService, MetricsService], exports: [ReadinessService, MetricsService] })
class CliPlatformModule {}

/**
 * The modules a command needs to create users: database, tenancy (with the common services, whose notification
 * writer needs the membership service of authz), audit, keys, identity and the licence gate.
 */
@Module({})
class AdminCliModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: AdminCliModule,
      imports: [
        ConfigModule.forRoot(config),
        CliPlatformModule,
        DatabaseModule,
        TenancyModule,
        AuditModule,
        KeysModule,
        AuthzModule,
        IdentityModule,
        LicenseModule,
      ],
    };
  }
}

/** A Nest application context for user administration commands (run mode `cli`, no listeners). */
export async function createAdminContext(config: MscdConfig): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AdminCliModule.forRoot(config), { logger: ['error'], abortOnError: false });
}

/**
 * `admin create-user` with a loaded configuration: creates the user (or invites an existing account) with an
 * `invited` membership, after `LicenceGate.assertCanAddUser`, and returns the invitation link. The operator gets a
 * link also for an account that is already active (`linkForActiveAccount`, for example a person who left every
 * organisation and cannot sign in to accept a membership); such a link is accepted with the account's current
 * password, which it never replaces. `context` replaces the application context the command builds (tests).
 */
export async function adminCreateUser(config: MscdConfig, options: CreateUserOptions, context?: INestApplicationContext): Promise<CreateUserResult> {
  const app = context ?? (await createAdminContext(config));
  try {
    const scope = app.get(TenantScope, { strict: false });
    const invitations = app.get(InvitationService, { strict: false });
    const org = await scope.withPlatform(
      async (trx) => {
        const query = trx.selectFrom('platform.organization').select(['id', 'slug']).where('deleted_at', 'is', null);
        if (options.org) {
          const found = await query.where('slug', '=', options.org).executeTakeFirst();
          if (!found) throw new Error(`No organisation with slug ${options.org}`);
          return found;
        }
        const all = await query.orderBy('slug').limit(2).execute();
        if (all.length !== 1) {
          throw new Error(all.length === 0 ? 'No organisation exists yet; run "mscd-server tenant create" first' : 'Several organisations exist; name one with --org <slug>');
        }
        return all[0]!;
      },
      { scope: 'cli' },
    );
    const invited = await scope.withPlatform(
      (trx) =>
        invitations.inviteUser(trx, {
          orgId: org.id,
          email: options.email,
          displayName: options.name ?? null,
          adminRoles: options.tenantAdmin ? ['tenant_admin'] : [],
          actor: { userId: null, kind: 'operator' },
          linkForActiveAccount: true,
        }),
      { scope: 'cli', orgId: org.id },
    );
    const { invitation, ...user } = invited;
    if (!invitation) throw new Error('No invitation link was issued');
    return { ...user, ...invitation, orgSlug: org.slug };
  } finally {
    if (!context) await app.close();
  }
}
