import { z } from 'zod';

// Deployment profile schema (build plan I.1). Strict at every level: an unknown key is an error, so a typo or a
// key from an older release never goes unnoticed. Cross-field rules (demo mode, TLS off, channel URLs) are in
// `profileRules` below; release-flavour restrictions are in `releaseFlavourIssues`.

const nonEmpty = z.string().trim().min(1, { error: 'must not be empty' });
/** A file path; relative paths are resolved against the folder of the profile file. */
const filePath = nonEmpty;
const nullableFile = filePath.nullable();
const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http or https URL' });
const port = z.int().min(1).max(65535);
const positiveInt = z.int().positive();

/** `kms.provider`: only the `file` driver exists in this build (D-09). */
function kmsSchema(prefix: string) {
  return z.strictObject({
    provider: z.literal('file', {
      error: (issue) =>
        issue.input === undefined
          ? `${prefix}.provider is required`
          : `${prefix}.provider ${String(issue.input)} is not available in this build; use file`,
    }),
    file: z.strictObject({
      path: filePath,
      previous_paths: z.array(filePath).default([]),
    }),
  });
}

const tlsSchema = z.strictObject({
  mode: z.enum(['mtls', 'off']),
  ca_file: nullableFile,
  cert_file: nullableFile,
  key_file: nullableFile,
});

const cidr = z.union([z.cidrv4(), z.cidrv6()], { error: 'must be an IPv4 or IPv6 CIDR range, for example 172.31.250.10/32' });

// Fastify 5.12 removed hop-count trust (GHSA-3m5p-2c4r-xxw2: X-Forwarded-* spoofing under hop counting),
// so proxies are trusted by address only; {hops: 0} means no proxy is trusted.
const trustProxy = z.union(
  [z.strictObject({ hops: z.literal(0) }), z.strictObject({ cidrs: z.array(cidr).min(1) })],
  { error: 'must be {hops: 0} or {cidrs: [<range>, ...]}; hop counts above 0 and true are not allowed (F.12)' },
);

export const STORAGE_ADAPTERS = ['managed_vault', 'm365', 'google_drive'] as const;
export const IDENTITY_PROVIDER_KINDS = ['local', 'oidc', 'saml'] as const;
export const CHANNELS = ['offline', 'online', 'managed'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const profileSchema = z.strictObject({
  tenancy: z.strictObject({
    mode: z.enum(['single', 'multi']),
    isolation: z.enum(['database', 'schema']),
  }),
  license: z.strictObject({
    validation: z.enum(['offline', 'online']),
  }),
  updates: z.strictObject({
    channel: z.enum(CHANNELS),
  }),
  packs: z.strictObject({
    channel: z.enum(CHANNELS),
    dir: filePath,
    channel_url: httpUrl.nullable(),
  }),
  telemetry: z.strictObject({
    enabled: z.boolean(),
    otlp_endpoint: httpUrl.nullable(),
  }),
  kms: kmsSchema('kms'),
  identity: z.strictObject({
    providers: z.array(z.enum(IDENTITY_PROVIDER_KINDS)).min(1),
    local: z.strictObject({ mfa_required: z.boolean() }),
    oidc: z.strictObject({ allow_insecure_http: z.boolean() }),
    session: z.strictObject({
      idle_minutes: positiveInt,
      absolute_hours: positiveInt,
      remember_hours: positiveInt,
      guest_idle_minutes: positiveInt,
      guest_absolute_hours: positiveInt,
    }),
  }),
  mail: z.strictObject({
    transport: z.literal('smtp'),
    from: nonEmpty,
    smtp: z.strictObject({
      host: nonEmpty,
      port,
      secure: z.boolean(),
      user: nonEmpty.nullable(),
      password_file: nullableFile,
    }),
  }),
  storage: z.strictObject({
    adapters: z.strictObject({ enabled: z.array(z.enum(STORAGE_ADAPTERS)).min(1) }),
    max_upload_bytes: positiveInt,
    gateway: z.strictObject({
      url: httpUrl,
      token_file: filePath,
      tls: tlsSchema,
    }),
  }),
  network: z.strictObject({
    egress_allowlist: z.array(nonEmpty),
  }),
  jobs: z.strictObject({
    driver: z.enum(['pgboss', 'bullmq']),
    schedules_enabled: z.boolean(),
    bullmq: z.strictObject({ url: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' }).nullable() }),
  }),
  http: z.strictObject({
    port,
    public_url: httpUrl,
    trust_proxy: trustProxy,
  }),
  security: z.strictObject({
    cookie_secure: z.boolean(),
  }),
  database: z.strictObject({
    url_file: nullableFile,
    migrator_url_file: nullableFile.default(null),
    pack_installer_url_file: nullableFile,
    admin_url_file: nullableFile.default(null),
    pool_max: z.int().min(1).max(200),
  }),
  audit: z.strictObject({
    anchor_key_file: nullableFile,
  }),
  observability: z.strictObject({
    log_level: z.enum(LOG_LEVELS),
    /** Port of the separate metrics listener; null disables it. */
    metrics_port: port.nullable(),
  }),
  demo: z.strictObject({
    enabled: z.boolean(),
    acknowledge_insecure: z.boolean(),
    fixed_today: z.iso.date({ error: 'must be a date YYYY-MM-DD' }).nullable(),
    personas: z.boolean(),
    keycloak: z
      .strictObject({
        issuer: httpUrl,
        client_id: nonEmpty,
        client_secret_file: filePath,
      })
      .nullable(),
  }),
  /** Development flavour only (I.1); release builds reject every key of this section. */
  test: z
    .strictObject({
      endpoints_enabled: z.boolean(),
      template_database: z
        .string()
        .regex(/^[a-z_][a-z0-9_]{0,62}$/, { error: 'must be a plain database name' })
        .nullable(),
      admin_database_url_file: nullableFile,
    })
    .optional(),
  gateway: z.strictObject({
    port,
    token_files: z.array(filePath).min(1).max(2),
    kms: kmsSchema('gateway.kms'),
    tls: tlsSchema,
    vault: z.strictObject({
      endpoint: httpUrl,
      region: nonEmpty,
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, { error: 'must be a valid S3 bucket name' }),
      force_path_style: z.boolean(),
      access_key_file: filePath,
      secret_key_file: filePath,
    }),
    providers: z.strictObject({
      m365: z.strictObject({ graph_base_url: httpUrl, login_base_url: httpUrl }),
      google: z.strictObject({ api_base_url: httpUrl, token_url: httpUrl }),
    }),
  }),
});

export type Profile = z.output<typeof profileSchema>;
export type ProfileInput = z.input<typeof profileSchema>;

export interface ProfileIssue {
  /** Dotted key path, for example `kms.provider`. */
  path: string;
  message: string;
}

/** Cross-field rules that hold in every build flavour. */
export function profileRules(profile: Profile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const demo = profile.demo.enabled;
  if (demo && !profile.demo.acknowledge_insecure) {
    issues.push({
      path: 'demo.acknowledge_insecure',
      message: 'demo mode is refused unless demo.acknowledge_insecure is true (D-20)',
    });
  }
  const demoOnly: [boolean, string][] = [
    [profile.demo.fixed_today !== null, 'demo.fixed_today'],
    [profile.demo.personas, 'demo.personas'],
    [profile.demo.keycloak !== null, 'demo.keycloak'],
    [profile.identity.oidc.allow_insecure_http, 'identity.oidc.allow_insecure_http'],
  ];
  for (const [set, path] of demoOnly) {
    if (set && !demo) issues.push({ path, message: `${path} needs demo.enabled: true (D-20)` });
  }
  if (profile.gateway.tls.mode === 'off' && !demo) {
    issues.push({ path: 'gateway.tls.mode', message: 'gateway.tls.mode off needs demo.enabled: true (D.4)' });
  }
  if (profile.storage.gateway.tls.mode === 'off' && !demo) {
    issues.push({ path: 'storage.gateway.tls.mode', message: 'storage.gateway.tls.mode off needs demo.enabled: true (D.4)' });
  }
  for (const [tls, prefix] of [
    [profile.gateway.tls, 'gateway.tls'],
    [profile.storage.gateway.tls, 'storage.gateway.tls'],
  ] as const) {
    if (tls.mode === 'mtls') {
      for (const key of ['ca_file', 'cert_file', 'key_file'] as const) {
        if (tls[key] === null) issues.push({ path: `${prefix}.${key}`, message: `${prefix}.${key} is required with mode mtls` });
      }
    }
  }
  if (profile.packs.channel === 'online' && profile.packs.channel_url === null) {
    issues.push({ path: 'packs.channel_url', message: 'packs.channel_url is required with channel online' });
  }
  if (profile.telemetry.enabled && profile.telemetry.otlp_endpoint === null) {
    issues.push({ path: 'telemetry.otlp_endpoint', message: 'telemetry.otlp_endpoint is required when telemetry is enabled' });
  }
  if (profile.jobs.driver === 'bullmq' && profile.jobs.bullmq.url === null) {
    issues.push({ path: 'jobs.bullmq.url', message: 'jobs.bullmq.url is required with driver bullmq' });
  }
  if (profile.test?.endpoints_enabled && !demo) {
    issues.push({ path: 'test.endpoints_enabled', message: 'test.endpoints_enabled needs demo.enabled: true (D.3 Test support)' });
  }
  return issues;
}

/** Restrictions of release-flavour builds (I.1, D-20, D-24). */
export function releaseFlavourIssues(profile: Profile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const refuse = (path: string, what: string) =>
    issues.push({ path, message: `${what} is refused in a release build (I.1)` });
  if (profile.demo.enabled) refuse('demo.enabled', 'demo mode');
  if (profile.test !== undefined) {
    for (const key of Object.keys(profile.test)) refuse(`test.${key}`, `test.${key}`);
  }
  if (profile.identity.oidc.allow_insecure_http) {
    refuse('identity.oidc.allow_insecure_http', 'identity.oidc.allow_insecure_http: true');
  }
  if (profile.gateway.tls.mode === 'off') refuse('gateway.tls.mode', 'gateway.tls.mode: off');
  if (profile.storage.gateway.tls.mode === 'off') refuse('storage.gateway.tls.mode', 'storage.gateway.tls.mode: off');
  return issues;
}

/** Keys of older profiles that are refused with a specific message instead of "unknown key". */
export const REMOVED_KEYS: Readonly<Record<string, string>> = {
  'license.trusted_keys': 'trusted keys are compiled into the build (D-16)',
  'packs.trusted_keys': 'trusted keys are compiled into the build (D-16)',
};
