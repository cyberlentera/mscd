// The admin view of an identity provider (D.2 `IdentityProviderView`): every setting except the secrets. The OIDC
// client secret is only reported as set or not; SAML certificates only by their number.
import type { IdentityProviderView } from '@mscd/shared';
import type { Selectable } from 'kysely';
import type { IdentityProviderTable } from '../../db/types/platform';

export type IdentityProviderRow = Selectable<IdentityProviderTable>;

export function providerView(row: IdentityProviderRow): IdentityProviderView {
  const view: IdentityProviderView = {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    displayName: row.display_name,
    icon: row.icon,
    enabled: row.enabled,
    requireMfaClaim: row.require_mfa_claim,
    acceptedAmr: [...row.accepted_amr],
    mfaFallback: row.mfa_fallback,
    jitProvisioning: row.jit_provisioning,
    allowedEmailDomains: [...row.allowed_email_domains],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (row.kind === 'oidc') {
    view.oidc = {
      issuer: row.oidc_issuer ?? '',
      clientId: row.oidc_client_id ?? '',
      scopes: row.oidc_scopes,
      subjectMode: row.subject_mode,
      ...(row.entra_tenant_id ? { entraTenantId: row.entra_tenant_id } : {}),
      clientSecretSet: row.oidc_client_secret_sealed !== null,
    };
  } else {
    view.saml = {
      entryPoint: row.saml_entry_point ?? '',
      idpIssuer: row.saml_idp_issuer ?? '',
      idpCertCount: row.saml_idp_certs?.length ?? 0,
      spEntityId: row.saml_sp_entity_id ?? '',
      mfaAuthnContexts: [...row.saml_mfa_authn_contexts],
    };
  }
  return view;
}

/** The settings of a provider as audit entries record them (no secrets; the writer stores changed keys only). */
export function auditedSettings(row: IdentityProviderRow): Record<string, unknown> {
  return {
    slug: row.slug,
    kind: row.kind,
    displayName: row.display_name,
    icon: row.icon,
    enabled: row.enabled,
    issuer: row.oidc_issuer,
    clientId: row.oidc_client_id,
    clientSecretSet: row.oidc_client_secret_sealed !== null,
    scopes: row.kind === 'oidc' ? row.oidc_scopes : null,
    subjectMode: row.subject_mode,
    entraTenantId: row.entra_tenant_id,
    samlEntryPoint: row.saml_entry_point,
    samlIdpIssuer: row.saml_idp_issuer,
    samlIdpCertCount: row.saml_idp_certs?.length ?? null,
    samlSpEntityId: row.saml_sp_entity_id,
    samlMfaAuthnContexts: row.kind === 'saml' ? row.saml_mfa_authn_contexts : null,
    requireMfaClaim: row.require_mfa_claim,
    acceptedAmr: row.accepted_amr,
    mfaFallback: row.mfa_fallback,
    jitProvisioning: row.jit_provisioning,
    allowedEmailDomains: row.allowed_email_domains,
  };
}
