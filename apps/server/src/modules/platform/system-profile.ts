import type { SystemProfile } from '@mscd/shared';
import type { MscdConfig } from '../../config/mscd-config';
import { REVISION, VERSION } from '../../generated/build-info';

export type { SystemProfile } from '@mscd/shared';

/**
 * Builds the public system profile (D.2 `SystemProfile`, I.1) from configuration only; it never contains a path,
 * URL or secret.
 */
export function buildSystemProfile(config: MscdConfig): SystemProfile {
  const p = config.profile;
  return {
    version: VERSION,
    revision: REVISION,
    deploy: config.deploy,
    capabilities: {
      licenseValidation: p.license.validation,
      updatesChannel: p.updates.channel,
      packsChannel: p.packs.channel,
      telemetry: p.telemetry.enabled,
      identityProviders: [...p.identity.providers],
      storageAdapters: [...p.storage.adapters.enabled],
      mailTransport: p.mail.transport,
      jobsDriver: p.jobs.driver,
    },
    demo: {
      enabled: p.demo.enabled,
      personas: p.demo.enabled && p.demo.personas,
      ...(p.demo.enabled && p.demo.fixed_today ? { fixedToday: p.demo.fixed_today } : {}),
    },
    login: { mfaEnforced: p.identity.local.mfa_required },
  };
}
