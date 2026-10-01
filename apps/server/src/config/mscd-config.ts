import { readFileSync } from 'node:fs';
import { BUILD_FLAVOR, type BuildFlavor } from '../generated/build-info';
import { loadProfile, type Env } from './load-profile';
import type { Profile } from './profile.schema';

export type RunMode = 'api' | 'worker' | 'storage-gateway' | 'migrate' | 'cli';

/** Database roles of C.2, and the administrator used only by `db bootstrap`. */
export type DatabaseRole = 'app' | 'migrator' | 'pack_installer' | 'admin';

/**
 * Shorthand environment variables (I.1). They win over the profile's `*_file` entries. Each also has a `_FILE`
 * form (for example `MSCD_DATABASE_URL_FILE`) that names a file holding the value.
 */
export const DATABASE_URL_ENV: Readonly<Record<DatabaseRole, string>> = {
  app: 'MSCD_DATABASE_URL',
  migrator: 'MSCD_DATABASE_MIGRATOR_URL',
  pack_installer: 'MSCD_DATABASE_PACK_URL',
  admin: 'MSCD_DATABASE_ADMIN_URL',
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The validated deployment profile of this process plus secret access. Secret files are read when a module
 * asks for them (never cached), so each run mode needs only its own secrets and rotated files are picked up.
 */
export class MscdConfig {
  readonly profile: Profile;
  /** Absolute path of the profile file. */
  readonly profileFile: string;
  readonly flavor: BuildFlavor;
  readonly runMode: RunMode;
  readonly env: Env;

  constructor(init: { profile: Profile; profileFile: string; flavor: BuildFlavor; runMode: RunMode; env: Env }) {
    this.profile = init.profile;
    this.profileFile = init.profileFile;
    this.flavor = init.flavor;
    this.runMode = init.runMode;
    this.env = init.env;
  }

  /** Loads and validates the profile named by `MSCD_PROFILE_FILE` (throws `ProfileError`). */
  static load(options: { runMode: RunMode; env?: Env; flavor?: BuildFlavor; cwd?: string }): MscdConfig {
    const env = options.env ?? process.env;
    const flavor = options.flavor ?? BUILD_FLAVOR;
    const { profile, file } = loadProfile({ env, flavor, cwd: options.cwd });
    return new MscdConfig({ profile, profileFile: file, flavor, runMode: options.runMode, env });
  }

  /** `onprem` when licences are validated offline, else `saas` (a presentation label, I.1). */
  get deploy(): 'saas' | 'onprem' {
    return this.profile.license.validation === 'offline' ? 'onprem' : 'saas';
  }

  get demoEnabled(): boolean {
    return this.profile.demo.enabled;
  }

  /** Reads a secret file: UTF-8, one trailing line break removed, must not be empty. */
  readSecretFile(file: string, what = 'secret'): string {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new ConfigError(`Cannot read the ${what} file ${file}: ${(error as Error).message}`);
    }
    const value = text.replace(/\r?\n$/, '');
    if (value.trim() === '') throw new ConfigError(`The ${what} file ${file} is empty`);
    return value;
  }

  /** Value of `NAME`, or the content of the file named by `NAME_FILE`; undefined when neither is set. */
  envSecret(name: string): string | undefined {
    const direct = this.env[name];
    const file = this.env[`${name}_FILE`];
    if (direct !== undefined && direct !== '' && file !== undefined && file !== '') {
      throw new ConfigError(`Set either ${name} or ${name}_FILE, not both`);
    }
    if (direct !== undefined && direct !== '') return direct;
    if (file !== undefined && file !== '') return this.readSecretFile(file, name);
    return undefined;
  }

  /** Connection URL of a database role: the shorthand variable wins over the profile's file (I.1). */
  databaseUrl(role: DatabaseRole): string {
    const variable = DATABASE_URL_ENV[role];
    const fromEnv = this.envSecret(variable);
    if (fromEnv !== undefined) return fromEnv;
    const db = this.profile.database;
    const file = {
      app: db.url_file,
      migrator: db.migrator_url_file,
      pack_installer: db.pack_installer_url_file,
      admin: db.admin_url_file,
    }[role];
    const key = { app: 'url_file', migrator: 'migrator_url_file', pack_installer: 'pack_installer_url_file', admin: 'admin_url_file' }[role];
    if (file === null) {
      throw new ConfigError(`No database URL for role ${role}: set ${variable} (or ${variable}_FILE) or database.${key} in the profile`);
    }
    return this.readSecretFile(file, `database.${key}`);
  }
}
