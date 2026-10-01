import { ProfileError } from './load-profile';
import { ConfigError, MscdConfig, type RunMode } from './mscd-config';

/**
 * Loads the configuration for a run mode or a command. On an invalid profile it prints every validation error
 * to stderr and exits 1, before anything starts (I.1).
 */
export function loadConfigOrExit(runMode: RunMode): MscdConfig {
  try {
    return MscdConfig.load({ runMode });
  } catch (error) {
    exitOnConfigError(error);
  }
}

/** Prints configuration errors (profile, secrets) without a stack trace and exits 1; rethrows anything else. */
export function exitOnConfigError(error: unknown): never {
  if (error instanceof ProfileError) {
    process.stderr.write(error.format());
    process.exit(1);
  }
  if (error instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
