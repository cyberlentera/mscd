import type { MscdConfig } from '../../config/mscd-config';
import { REVISION, VERSION } from '../../generated/build-info';

/**
 * `GET /api/v1/system/profile` response (build plan D.2 `SystemProfile`). Local type until WP-05 publishes the
 * zod schema in `@mscd/shared` and WP-08 wires the route to it.
 */
export interface SystemProfile {
  version: string;
  revision: string;
  deploy: 'saas' | 'onprem';
  capabilities: {
    licenseValidation: 'offline' | 'online';
    updatesChannel: 'offline' | 'online' | 'managed';
    packsChannel: 'offline' | 'online' | 'managed';
    telemetry: boolean;
    identityProviders: ('local' | 'oidc' | 'saml')[];
    storageAdapters: ('managed_vault' | 'm365' | 'google_drive')[];
    mailTransport: 'smtp';
    jobsDriver: 'pgboss' | 'bullmq';
  };
  demo: { enabled: boolean; personas: boolean; fixedToday?: string };
  login: { regionLabel?: string; mfaEnforced: boolean };
}

/** Builds the public system profile from configuration only; it never contains a path, URL or secret. */
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
