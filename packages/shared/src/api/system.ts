// Area `system` (owner from wave 4: WP-08): the public system profile (D.2 `SystemProfile`, I.1).
import { z } from 'zod';
import { DeployLabel, PackCatalogChannel } from '../enums.js';
import { IsoDate, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

const EXAMPLE_PROFILE = {
  version: '1.0.0',
  revision: 'f087dc8',
  deploy: 'onprem',
  capabilities: {
    licenseValidation: 'offline', updatesChannel: 'offline', packsChannel: 'offline', telemetry: false,
    identityProviders: ['local', 'oidc', 'saml'], storageAdapters: ['managed_vault', 'm365', 'google_drive'], mailTransport: 'smtp', jobsDriver: 'pgboss',
  },
  demo: { enabled: false, personas: false },
  login: { mfaEnforced: true },
} as const;

export const SystemProfile = named(
  'SystemProfile',
  z.object({
    version: z.string(),
    revision: z.string(),
    deploy: DeployLabel,
    capabilities: z.object({
      licenseValidation: z.enum(['offline', 'online']),
      updatesChannel: PackCatalogChannel,
      packsChannel: PackCatalogChannel,
      telemetry: z.boolean(),
      identityProviders: z.array(z.enum(['local', 'oidc', 'saml'])),
      storageAdapters: z.array(z.enum(['managed_vault', 'm365', 'google_drive'])),
      mailTransport: z.literal('smtp'),
      jobsDriver: z.enum(['pgboss', 'bullmq']),
    }),
    demo: z.object({ enabled: z.boolean(), personas: z.boolean(), fixedToday: IsoDate.optional() }),
    login: z.object({ regionLabel: z.string().optional(), mfaEnforced: z.boolean() }),
  }),
  'Public description of the installation: version, deployment label (onprem when license.validation is offline), capabilities, demo flags and login hints (D.2, I.1)',
  {
    valid: [EXAMPLE_PROFILE, { ...EXAMPLE_PROFILE, deploy: 'saas', demo: { enabled: true, personas: true, fixedToday: '2026-09-29' }, login: { regionLabel: 'Jakarta', mfaEnforced: true } }],
    invalid: [{ ...EXAMPLE_PROFILE, deploy: 'cloud' }, { ...EXAMPLE_PROFILE, capabilities: { ...EXAMPLE_PROFILE.capabilities, mailTransport: 'ses' } }, { version: '1.0.0' }],
  },
);
export type SystemProfile = z.infer<typeof SystemProfile>;

export const systemProfileRoute = defineRoute({
  id: 'system.profile',
  owner: 'WP-08',
  method: 'GET',
  path: '/api/v1/system/profile',
  summary: 'Public system profile: version, deployment label, capabilities, demo flags',
  auth: 'public',
  response: SystemProfile,
  errors: [],
});

export const routes: RouteDef[] = [systemProfileRoute];
