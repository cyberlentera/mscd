// Area `admin-idp` (owner from wave 6: WP-16): identity providers of the organisation (D.2 `IdentityProviderRequest`,
// D.3 "Administration", F.5, F.8, F.9). Secrets are write-only: views never contain them.
import { z } from 'zod';
import { IdentityProviderIcon, IdentityProviderKind, MfaFallback, SubjectMode } from '../enums.js';
import { IdParams, Instant, ProviderSlug, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

const Domain = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/).max(253);
const HttpUrl = z.url({ protocol: /^https?$/ });

const oidcConfigShape = {
  issuer: HttpUrl,
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(1024),
  scopes: z.string().regex(/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/).max(500),
  subjectMode: SubjectMode,
  entraTenantId: Uuid.optional(),
};
const samlConfigShape = {
  entryPoint: HttpUrl,
  idpIssuer: z.string().min(1).max(500),
  idpCerts: z.array(z.string().min(1).max(16384)).min(1),
  spEntityId: z.string().min(1).max(500),
  mfaAuthnContexts: z.array(z.string().min(1).max(200)),
};

const providerShape = {
  slug: ProviderSlug,
  kind: IdentityProviderKind,
  displayName: z.string().trim().min(1).max(100),
  icon: IdentityProviderIcon,
  oidc: z.strictObject(oidcConfigShape).optional(),
  saml: z.strictObject(samlConfigShape).optional(),
  requireMfaClaim: z.boolean().default(true),
  acceptedAmr: z.array(z.string().regex(/^[a-z]{2,20}$/)).optional(),
  mfaFallback: MfaFallback.default('local_totp'),
  jitProvisioning: z.boolean().default(false),
  allowedEmailDomains: z.array(Domain).default([]),
};

type ProviderInput = {
  kind?: 'oidc' | 'saml';
  oidc?: { subjectMode?: string; entraTenantId?: string } | undefined;
  saml?: unknown;
  requireMfaClaim?: boolean;
  mfaFallback?: string;
  jitProvisioning?: boolean;
  allowedEmailDomains?: readonly string[];
};

/** Cross-field rules of C.4 `identity_provider` and F.5. */
function providerIssues(p: ProviderInput, ctx: z.RefinementCtx, complete: boolean): void {
  if (complete && p.kind === 'oidc' && (!p.oidc || p.saml)) ctx.addIssue({ code: 'custom', path: ['oidc'], message: 'oidc providers need oidc settings and no saml settings' });
  if (complete && p.kind === 'saml' && (!p.saml || p.oidc)) ctx.addIssue({ code: 'custom', path: ['saml'], message: 'saml providers need saml settings and no oidc settings' });
  if (p.oidc?.subjectMode === 'entra' && !p.oidc.entraTenantId) ctx.addIssue({ code: 'custom', path: ['oidc', 'entraTenantId'], message: 'subjectMode entra needs entraTenantId' });
  if (p.requireMfaClaim === false && p.mfaFallback === 'reject') ctx.addIssue({ code: 'custom', path: ['mfaFallback'], message: 'requireMfaClaim false is allowed only with mfaFallback local_totp (F.5)' });
  if (p.jitProvisioning === true && p.allowedEmailDomains !== undefined && p.allowedEmailDomains.length === 0) ctx.addIssue({ code: 'custom', path: ['allowedEmailDomains'], message: 'JIT provisioning needs allowed email domains' });
  if (p.jitProvisioning === true && p.kind === 'saml') ctx.addIssue({ code: 'custom', path: ['jitProvisioning'], message: 'SAML assertions never prove email_verified, so SAML JIT is not offered (F.9)' });
}

const EXAMPLE_OIDC_REQUEST = {
  slug: 'keycloak', kind: 'oidc', displayName: 'Sign in with Keycloak', icon: 'generic',
  oidc: { issuer: 'https://sso.example.co.id/realms/mscd', clientId: 'mscd', clientSecret: 'example-client-secret', scopes: 'openid email profile', subjectMode: 'sub' },
  requireMfaClaim: true, mfaFallback: 'local_totp', jitProvisioning: false, allowedEmailDomains: [],
} as const;

export const IdentityProviderRequest = named(
  'IdentityProviderRequest',
  z.strictObject(providerShape).superRefine((p, ctx) => providerIssues(p, ctx, true)),
  'POST /admin/identity-providers body (D.2); the client secret is sealed with platform.key and never returned',
  {
    valid: [
      EXAMPLE_OIDC_REQUEST,
      {
        slug: 'entra', kind: 'oidc', displayName: 'Sign in with Microsoft', icon: 'microsoft',
        oidc: { issuer: 'https://login.microsoftonline.com/6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c/v2.0', clientId: 'app-id', clientSecret: 's', scopes: 'openid email profile', subjectMode: 'entra', entraTenantId: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' },
        jitProvisioning: true, allowedEmailDomains: ['nusantaradigital.co.id'],
      },
      {
        slug: 'adfs', kind: 'saml', displayName: 'Sign in with AD FS', icon: 'generic',
        saml: { entryPoint: 'https://adfs.example.co.id/adfs/ls/', idpIssuer: 'http://adfs.example.co.id/adfs/services/trust', idpCerts: ['MIIC...'], spEntityId: 'https://mscd.example.internal/api/v1/auth/saml/adfs/metadata', mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'] },
      },
    ],
    invalid: [
      { ...EXAMPLE_OIDC_REQUEST, oidc: undefined },
      { ...EXAMPLE_OIDC_REQUEST, oidc: { ...EXAMPLE_OIDC_REQUEST.oidc, subjectMode: 'entra' } },
      { ...EXAMPLE_OIDC_REQUEST, requireMfaClaim: false, mfaFallback: 'reject' },
      { ...EXAMPLE_OIDC_REQUEST, jitProvisioning: true, allowedEmailDomains: [] },
    ],
  },
);
export type IdentityProviderRequest = z.infer<typeof IdentityProviderRequest>;

export const IdentityProviderPatch = named(
  'IdentityProviderPatch',
  z.strictObject({
    displayName: providerShape.displayName.optional(),
    icon: IdentityProviderIcon.optional(),
    enabled: z.boolean().optional(),
    oidc: z.strictObject(oidcConfigShape).partial().optional(),
    saml: z.strictObject(samlConfigShape).partial().optional(),
    requireMfaClaim: z.boolean().optional(),
    acceptedAmr: providerShape.acceptedAmr,
    mfaFallback: MfaFallback.optional(),
    jitProvisioning: z.boolean().optional(),
    allowedEmailDomains: z.array(Domain).optional(),
  }).superRefine((p, ctx) => {
    if (Object.values(p).every((v) => v === undefined)) ctx.addIssue({ code: 'custom', message: 'Give at least one field' });
    providerIssues(p, ctx, false);
  }),
  'PATCH /admin/identity-providers/{id} body; disabling a provider revokes its sessions (F.1)',
  {
    valid: [{ enabled: false }, { oidc: { clientSecret: 'rotated-secret' } }, { jitProvisioning: true, allowedEmailDomains: ['nusantaradigital.co.id'] }],
    invalid: [{}, { slug: 'other' }, { requireMfaClaim: false, mfaFallback: 'reject' }],
  },
);
export type IdentityProviderPatch = z.infer<typeof IdentityProviderPatch>;

const EXAMPLE_PROVIDER_VIEW = {
  id: '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b', slug: 'keycloak', kind: 'oidc', displayName: 'Sign in with Keycloak', icon: 'generic', enabled: true,
  oidc: { issuer: 'https://sso.example.co.id/realms/mscd', clientId: 'mscd', scopes: 'openid email profile', subjectMode: 'sub', clientSecretSet: true },
  requireMfaClaim: true, acceptedAmr: ['pwd', 'otp', 'hwk', 'swk', 'fpt', 'face', 'pin', 'sms', 'mca'], mfaFallback: 'local_totp',
  jitProvisioning: false, allowedEmailDomains: [], createdAt: '2026-09-01T03:00:00Z', updatedAt: '2026-09-01T03:00:00Z',
} as const;

export const IdentityProviderView = named(
  'IdentityProviderView',
  z.object({
    id: Uuid,
    slug: ProviderSlug,
    kind: IdentityProviderKind,
    displayName: z.string(),
    icon: IdentityProviderIcon,
    enabled: z.boolean(),
    oidc: z.object({ issuer: z.string(), clientId: z.string(), scopes: z.string(), subjectMode: SubjectMode, entraTenantId: Uuid.optional(), clientSecretSet: z.boolean() }).optional(),
    saml: z.object({ entryPoint: z.string(), idpIssuer: z.string(), idpCertCount: z.int().min(0), spEntityId: z.string(), mfaAuthnContexts: z.array(z.string()) }).optional(),
    requireMfaClaim: z.boolean(),
    acceptedAmr: z.array(z.string()),
    mfaFallback: MfaFallback,
    jitProvisioning: z.boolean(),
    allowedEmailDomains: z.array(z.string()),
    createdAt: Instant,
    updatedAt: Instant,
  }),
  'Identity provider of the organisation without its secrets',
  { valid: [EXAMPLE_PROVIDER_VIEW], invalid: [{ ...EXAMPLE_PROVIDER_VIEW, kind: 'ldap' }, { ...EXAMPLE_PROVIDER_VIEW, enabled: undefined }] },
);
export type IdentityProviderView = z.infer<typeof IdentityProviderView>;

export const IdentityProviderTestResult = named(
  'IdentityProviderTestResult',
  z.object({ ok: z.boolean(), issuer: z.string(), endpoints: z.record(z.string(), z.string()) }),
  'Result of a discovery test of a provider',
  {
    valid: [{ ok: true, issuer: 'https://sso.example.co.id/realms/mscd', endpoints: { authorization: 'https://sso.example.co.id/realms/mscd/protocol/openid-connect/auth' } }],
    invalid: [{ ok: true, issuer: 'x' }],
  },
);
export type IdentityProviderTestResult = z.infer<typeof IdentityProviderTestResult>;

export const adminIdpListRoute = defineRoute({
  id: 'admin.idp.list',
  owner: 'WP-16',
  method: 'GET',
  path: '/api/v1/admin/identity-providers',
  summary: "Identity providers of the session's organisation (secrets omitted)",
  auth: 'session',
  permission: 'idp.manage',
  scope: 'org',
  response: z.array(IdentityProviderView),
  errors: [],
});

export const adminIdpCreateRoute = defineRoute({
  id: 'admin.idp.create',
  owner: 'WP-16',
  method: 'POST',
  path: '/api/v1/admin/identity-providers',
  summary: 'Add an OIDC or SAML identity provider (JIT only with verified domains)',
  auth: 'session',
  permission: 'idp.manage',
  scope: 'org',
  body: IdentityProviderRequest,
  response: IdentityProviderView,
  status: 201,
  errors: [409, 422],
  idempotent: true,
});

export const adminIdpUpdateRoute = defineRoute({
  id: 'admin.idp.update',
  owner: 'WP-16',
  method: 'PATCH',
  path: '/api/v1/admin/identity-providers/:id',
  summary: 'Change an identity provider; disabling it revokes its sessions',
  auth: 'session',
  permission: 'idp.manage',
  scope: 'org',
  params: IdParams,
  body: IdentityProviderPatch,
  response: IdentityProviderView,
  errors: [404, 422],
});

export const adminIdpTestRoute = defineRoute({
  id: 'admin.idp.test',
  owner: 'WP-16',
  method: 'POST',
  path: '/api/v1/admin/identity-providers/:id/test',
  summary: 'Run discovery against the provider and report its endpoints',
  auth: 'session',
  permission: 'idp.manage',
  scope: 'org',
  params: IdParams,
  response: IdentityProviderTestResult,
  errors: [404],
});

export const routes: RouteDef[] = [adminIdpListRoute, adminIdpCreateRoute, adminIdpUpdateRoute, adminIdpTestRoute];
