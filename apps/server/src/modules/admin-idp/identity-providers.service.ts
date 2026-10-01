// Identity provider administration (build plan D.3 "Administration", F.8, F.9, D-25, F.1). A Tenant Admin manages
// the providers of the session's organisation only: every read and write runs in that organisation's tenant
// transaction, where the forced RLS of `platform.identity_provider` (D-31) shows no other organisation's rows. The
// OIDC client secret is sealed with `platform.key` (AAD `idp:<providerId>`) and never returned. An OIDC provider is
// saved only after its discovery succeeds; JIT provisioning only when every allowed email domain is verified for the
// organisation (`platform.verified_domain`, D-25). Disabling a provider revokes the sessions signed in through it.
import { randomUUID, X509Certificate } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  FieldError,
  IdentityProviderPatch,
  IdentityProviderRequest,
  IdentityProviderTestResult,
  IdentityProviderView,
  Messages,
} from '@mscd/shared';
import type { Updateable } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { Clock } from '../../common/clock';
import { ConflictError, ForbiddenError, NotFoundError, ProblemError, ValidationError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import type { IdentityProviderTable } from '../../db/types/platform';
import { SessionService } from '../identity/session.service';
import { OidcDiscovery, DiscoveryError, DISCOVERY_FAILURE_TEXT, type OidcConnection } from '../identity/oidc/discovery';
import { SecretBox } from '../keys/secret-box';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { auditedSettings, providerView, type IdentityProviderRow } from './provider-view';

/** 422 `business-rule` of the provider administration, with a message key and both languages (D.1). */
function unprocessable(messageKey: string, messages: Messages, extras: { detail?: string; affected?: string[] } = {}): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages, ...(extras.detail ? { detail: extras.detail } : {}), ...(extras.affected ? { affected: extras.affected } : {}) });
}

function discoveryFailed(error: DiscoveryError): ProblemError {
  return unprocessable(
    'idp.discovery_failed',
    {
      en: `OpenID Connect discovery failed: ${DISCOVERY_FAILURE_TEXT[error.reason]}`,
      id: `Penemuan OpenID Connect gagal: ${DISCOVERY_ID_TEXT[error.reason]}`,
    },
    { detail: `Discovery failed (${error.reason})` },
  );
}

const DISCOVERY_ID_TEXT: Readonly<Record<DiscoveryError['reason'], string>> = {
  insecure_issuer: 'issuer harus menggunakan HTTPS',
  invalid_issuer: 'issuer bukan URL yang valid',
  unreachable: 'issuer tidak dapat dihubungi',
  timeout: 'issuer tidak menjawab tepat waktu',
  invalid_metadata: 'issuer tidak mengembalikan metadata OpenID Connect yang valid',
  issuer_mismatch: 'metadata menyebut issuer lain dari yang dikonfigurasi',
  http_error: 'issuer menjawab permintaan penemuan dengan galat',
};

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '23505';
}

/** A certificate as PEM: PEM text is kept, bare base64 DER (as in SAML metadata) is wrapped. Null when not X.509. */
export function normaliseCertificate(value: string): string | null {
  const trimmed = value.trim();
  let pem: string;
  if (trimmed.includes('-----BEGIN CERTIFICATE-----')) {
    pem = trimmed;
  } else {
    const body = trimmed.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
    pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
  }
  try {
    new X509Certificate(pem);
    return pem;
  } catch {
    return null;
  }
}

/** Normalised email domains: lower case, without duplicates, in the given order. */
function normaliseDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()))];
}

/** The settings a provider row will have, checked as a whole (C.4 checks, F.5, F.8, F.9). */
interface ProviderSettings {
  kind: 'oidc' | 'saml';
  subject_mode: 'sub' | 'entra';
  entra_tenant_id: string | null;
  oidc_scopes: string;
  require_mfa_claim: boolean;
  mfa_fallback: 'local_totp' | 'reject';
  jit_provisioning: boolean;
  allowed_email_domains: string[];
}

function settingsProblems(s: ProviderSettings): FieldError[] {
  const problems: FieldError[] = [];
  if (s.kind === 'oidc' && !s.oidc_scopes.split(' ').includes('openid')) problems.push({ path: 'body.oidc.scopes', message: 'The scopes must include openid' });
  if (s.subject_mode === 'entra' && !s.entra_tenant_id) problems.push({ path: 'body.oidc.entraTenantId', message: 'subjectMode entra needs entraTenantId' });
  if (!s.require_mfa_claim && s.mfa_fallback !== 'local_totp') {
    problems.push({ path: 'body.mfaFallback', message: 'requireMfaClaim false is allowed only with mfaFallback local_totp (F.5)' });
  }
  if (s.jit_provisioning && s.kind === 'saml') problems.push({ path: 'body.jitProvisioning', message: 'SAML assertions never prove email_verified, so SAML JIT is not offered (F.9)' });
  if (s.jit_provisioning && s.allowed_email_domains.length === 0) problems.push({ path: 'body.allowedEmailDomains', message: 'JIT provisioning needs allowed email domains' });
  return problems;
}

@Injectable()
export class IdentityProvidersService {
  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    private readonly sessions: SessionService,
    private readonly discovery: OidcDiscovery,
  ) {}

  /** `GET /admin/identity-providers`: the organisation's providers, secrets omitted. */
  async list(principal: Principal): Promise<IdentityProviderView[]> {
    const orgId = this.orgOf(principal);
    const rows = await this.scope.withTenant(tenantContextOf(principal), (trx) =>
      trx
        .selectFrom('platform.identity_provider')
        .selectAll()
        .where('organization_id', '=', orgId)
        .where('deleted_at', 'is', null)
        .orderBy('display_name')
        .orderBy('slug')
        .execute(),
    );
    return rows.map(providerView);
  }

  /** `POST /admin/identity-providers` (201). */
  async create(principal: Principal, body: IdentityProviderRequest): Promise<IdentityProviderView> {
    const orgId = this.orgOf(principal);
    this.assertKindEnabled(body.kind);
    const settings: ProviderSettings = {
      kind: body.kind,
      subject_mode: body.oidc?.subjectMode ?? 'sub',
      entra_tenant_id: body.oidc?.entraTenantId?.toLowerCase() ?? null,
      oidc_scopes: body.oidc?.scopes ?? 'openid email profile',
      require_mfa_claim: body.requireMfaClaim,
      mfa_fallback: body.mfaFallback,
      jit_provisioning: body.jitProvisioning,
      allowed_email_domains: normaliseDomains(body.allowedEmailDomains),
    };
    const problems = settingsProblems(settings);
    const certs = body.kind === 'saml' && body.saml ? this.certificates(body.saml.idpCerts, problems) : null;
    if (problems.length > 0) throw new ValidationError(problems, 'The identity provider settings are not valid');
    if (body.kind === 'oidc' && body.oidc) {
      await this.checkDiscovery({ issuer: body.oidc.issuer, clientId: body.oidc.clientId, clientSecret: body.oidc.clientSecret });
    }

    const id = randomUUID();
    const sealed = body.kind === 'oidc' && body.oidc ? await this.secrets.seal(body.oidc.clientSecret, { purpose: 'idp', providerId: id }) : null;
    const now = this.clock.now();
    try {
      const row = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
        await this.assertJitDomainsVerified(trx, orgId, settings);
        const inserted = await trx
          .insertInto('platform.identity_provider')
          .values({
            id,
            organization_id: orgId,
            slug: body.slug,
            kind: body.kind,
            display_name: body.displayName,
            icon: body.icon,
            enabled: true,
            oidc_issuer: body.oidc?.issuer ?? null,
            oidc_client_id: body.oidc?.clientId ?? null,
            oidc_client_secret_sealed: sealed,
            oidc_scopes: settings.oidc_scopes,
            subject_mode: settings.subject_mode,
            entra_tenant_id: settings.entra_tenant_id,
            saml_entry_point: body.saml?.entryPoint ?? null,
            saml_idp_issuer: body.saml?.idpIssuer ?? null,
            saml_idp_certs: certs,
            saml_sp_entity_id: body.saml?.spEntityId ?? null,
            ...(body.saml ? { saml_mfa_authn_contexts: body.saml.mfaAuthnContexts } : {}),
            require_mfa_claim: settings.require_mfa_claim,
            ...(body.acceptedAmr ? { accepted_amr: [...new Set(body.acceptedAmr)] } : {}),
            mfa_fallback: settings.mfa_fallback,
            jit_provisioning: settings.jit_provisioning,
            allowed_email_domains: settings.allowed_email_domains,
            created_at: now,
            updated_at: now,
            created_by: principal.user.id,
            updated_by: principal.user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          action: 'idp.created',
          organizationId: orgId,
          entityType: 'identity_provider',
          entityId: inserted.id,
          entityCode: inserted.slug,
          after: auditedSettings(inserted),
        });
        return inserted;
      });
      return providerView(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('The slug is already used by another identity provider', { messageKey: 'idp.slug_taken' });
      throw error;
    }
  }

  /**
   * `PATCH /admin/identity-providers/{id}`: changes the given settings, checks the result as a whole, runs discovery
   * again when the OIDC connection changed, and revokes the provider's sessions when it is disabled (F.1).
   */
  async update(principal: Principal, id: string, patch: IdentityProviderPatch): Promise<IdentityProviderView> {
    const orgId = this.orgOf(principal);
    const current = await this.scope.withTenant(tenantContextOf(principal), (trx) => this.row(trx, orgId, id, false));
    if (current.kind === 'oidc' && patch.saml) throw new ValidationError([{ path: 'body.saml', message: 'An OIDC provider has no SAML settings' }]);
    if (current.kind === 'saml' && patch.oidc) throw new ValidationError([{ path: 'body.oidc', message: 'A SAML provider has no OIDC settings' }]);

    const changes: Updateable<IdentityProviderTable> = {};
    if (patch.displayName !== undefined) changes.display_name = patch.displayName;
    if (patch.icon !== undefined) changes.icon = patch.icon;
    if (patch.enabled !== undefined) changes.enabled = patch.enabled;
    if (patch.requireMfaClaim !== undefined) changes.require_mfa_claim = patch.requireMfaClaim;
    if (patch.acceptedAmr !== undefined) changes.accepted_amr = [...new Set(patch.acceptedAmr)];
    if (patch.mfaFallback !== undefined) changes.mfa_fallback = patch.mfaFallback;
    if (patch.jitProvisioning !== undefined) changes.jit_provisioning = patch.jitProvisioning;
    if (patch.allowedEmailDomains !== undefined) changes.allowed_email_domains = normaliseDomains(patch.allowedEmailDomains);
    const oidc = patch.oidc;
    if (oidc) {
      if (oidc.issuer !== undefined) changes.oidc_issuer = oidc.issuer;
      if (oidc.clientId !== undefined) changes.oidc_client_id = oidc.clientId;
      if (oidc.scopes !== undefined) changes.oidc_scopes = oidc.scopes;
      if (oidc.subjectMode !== undefined) changes.subject_mode = oidc.subjectMode;
      if (oidc.entraTenantId !== undefined) changes.entra_tenant_id = oidc.entraTenantId.toLowerCase();
      if (oidc.subjectMode === 'sub' && oidc.entraTenantId === undefined) changes.entra_tenant_id = null;
    }
    const problems: FieldError[] = [];
    const saml = patch.saml;
    if (saml) {
      if (saml.entryPoint !== undefined) changes.saml_entry_point = saml.entryPoint;
      if (saml.idpIssuer !== undefined) changes.saml_idp_issuer = saml.idpIssuer;
      if (saml.idpCerts !== undefined) changes.saml_idp_certs = this.certificates(saml.idpCerts, problems);
      if (saml.spEntityId !== undefined) changes.saml_sp_entity_id = saml.spEntityId;
      if (saml.mfaAuthnContexts !== undefined) changes.saml_mfa_authn_contexts = saml.mfaAuthnContexts;
    }
    const merged: ProviderSettings = {
      kind: current.kind,
      subject_mode: (changes.subject_mode as ProviderSettings['subject_mode'] | undefined) ?? current.subject_mode,
      entra_tenant_id: changes.entra_tenant_id !== undefined ? (changes.entra_tenant_id as string | null) : current.entra_tenant_id,
      oidc_scopes: (changes.oidc_scopes as string | undefined) ?? current.oidc_scopes,
      require_mfa_claim: (changes.require_mfa_claim as boolean | undefined) ?? current.require_mfa_claim,
      mfa_fallback: (changes.mfa_fallback as ProviderSettings['mfa_fallback'] | undefined) ?? current.mfa_fallback,
      jit_provisioning: (changes.jit_provisioning as boolean | undefined) ?? current.jit_provisioning,
      allowed_email_domains: (changes.allowed_email_domains as string[] | undefined) ?? current.allowed_email_domains,
    };
    problems.push(...settingsProblems(merged));
    if (problems.length > 0) throw new ValidationError(problems, 'The identity provider settings are not valid');

    // A changed OIDC connection must work before it is saved; the secret is checked as it will be stored.
    const connectionChanged = Boolean(oidc && (oidc.issuer !== undefined || oidc.clientId !== undefined || oidc.clientSecret !== undefined));
    if (current.kind === 'oidc' && connectionChanged) {
      const clientSecret =
        oidc?.clientSecret ??
        (current.oidc_client_secret_sealed ? await this.secrets.openText(current.oidc_client_secret_sealed, { purpose: 'idp', providerId: current.id }) : null);
      await this.checkDiscovery({ issuer: (changes.oidc_issuer as string | undefined) ?? current.oidc_issuer ?? '', clientId: (changes.oidc_client_id as string | undefined) ?? current.oidc_client_id ?? '', clientSecret });
    }
    if (oidc?.clientSecret !== undefined) changes.oidc_client_secret_sealed = await this.secrets.seal(oidc.clientSecret, { purpose: 'idp', providerId: current.id });

    const row = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const locked = await this.row(trx, orgId, id, true);
      // The checks above ran on the version read first; a change made meanwhile must be looked at again.
      if (locked.updated_at.getTime() !== current.updated_at.getTime()) {
        throw new ConflictError('The identity provider was changed meanwhile; reload it and try again', { messageKey: 'idp.changed' });
      }
      if (merged.jit_provisioning && (changes.jit_provisioning !== undefined || changes.allowed_email_domains !== undefined)) {
        await this.assertJitDomainsVerified(trx, orgId, merged);
      }
      const updated = await trx
        .updateTable('platform.identity_provider')
        .set({ ...changes, updated_by: principal.user.id })
        .where('id', '=', locked.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const disabled = locked.enabled && !updated.enabled;
      const revoked = disabled ? await this.sessions.revokeProviderSessions(trx, updated.id, 'idp_disabled') : 0;
      await this.audit.record(trx, {
        action: 'idp.updated',
        organizationId: orgId,
        entityType: 'identity_provider',
        entityId: updated.id,
        entityCode: updated.slug,
        before: auditedSettings(locked),
        after: {
          ...auditedSettings(updated),
          ...(oidc?.clientSecret !== undefined ? { clientSecretReplaced: true } : {}),
          ...(disabled ? { sessionsRevoked: revoked } : {}),
        },
      });
      return updated;
    });
    this.discovery.invalidate(row.id);
    return providerView(row);
  }

  /** `POST /admin/identity-providers/{id}/test`: discovery now (OIDC), or the SAML endpoints and certificates. */
  async test(principal: Principal, id: string): Promise<IdentityProviderTestResult> {
    const orgId = this.orgOf(principal);
    const row = await this.scope.withTenant(tenantContextOf(principal), (trx) => this.row(trx, orgId, id, false));
    if (row.kind === 'saml') return this.testSaml(row);
    const issuer = row.oidc_issuer ?? '';
    try {
      const clientSecret = row.oidc_client_secret_sealed ? await this.secrets.openText(row.oidc_client_secret_sealed, { purpose: 'idp', providerId: row.id }) : null;
      const configuration = await this.discovery.discover({ issuer, clientId: row.oidc_client_id ?? '', clientSecret });
      const found = this.discovery.endpointsOf(configuration);
      return { ok: true, issuer: found.issuer, endpoints: found.endpoints };
    } catch (error) {
      if (error instanceof DiscoveryError) return { ok: false, issuer, endpoints: {}, message: DISCOVERY_FAILURE_TEXT[error.reason] };
      throw error;
    }
  }

  private testSaml(row: IdentityProviderRow): IdentityProviderTestResult {
    const endpoints: Record<string, string> = {};
    if (row.saml_entry_point) endpoints.singleSignOn = row.saml_entry_point;
    endpoints.serviceProviderMetadata = `${this.config.profile.http.public_url.replace(/\/+$/, '')}/api/v1/auth/saml/${encodeURIComponent(row.slug)}/metadata`;
    const now = this.clock.now().getTime();
    const certs = row.saml_idp_certs ?? [];
    let message: string | undefined;
    for (const [index, pem] of certs.entries()) {
      try {
        const cert = new X509Certificate(pem);
        if (Date.parse(cert.validTo) <= now) message ??= `Certificate ${index + 1} expired on ${new Date(cert.validTo).toISOString().slice(0, 10)}`;
        else if (Date.parse(cert.validFrom) > now) message ??= `Certificate ${index + 1} is not valid before ${new Date(cert.validFrom).toISOString().slice(0, 10)}`;
      } catch {
        message ??= `Certificate ${index + 1} is not a valid X.509 certificate`;
      }
    }
    if (certs.length === 0) message ??= 'No signing certificate is configured';
    return { ok: message === undefined, issuer: row.saml_idp_issuer ?? '', endpoints, ...(message ? { message } : {}) };
  }

  // ------------------------------------------------------------------------------------------------------- helpers

  private orgOf(principal: Principal): string {
    if (!principal.org) throw new ForbiddenError('Identity providers belong to an organisation; this session has none');
    return principal.org.id;
  }

  private assertKindEnabled(kind: 'oidc' | 'saml'): void {
    if (!(this.config.profile.identity.providers as readonly string[]).includes(kind)) {
      throw unprocessable('idp.kind_disabled', {
        en: `This installation does not offer ${kind.toUpperCase()} sign-in`,
        id: `Instalasi ini tidak menawarkan proses masuk ${kind.toUpperCase()}`,
      });
    }
  }

  private async checkDiscovery(connection: OidcConnection): Promise<void> {
    try {
      await this.discovery.discover(connection);
    } catch (error) {
      if (error instanceof DiscoveryError) throw discoveryFailed(error);
      throw error;
    }
  }

  /** D-25: JIT only when every allowed email domain is verified for the organisation by the platform operator. */
  private async assertJitDomainsVerified(trx: Trx, orgId: string, settings: ProviderSettings): Promise<void> {
    if (!settings.jit_provisioning) return;
    const domains = settings.allowed_email_domains;
    const verified = await trx
      .selectFrom('platform.verified_domain')
      .select('domain')
      .where('organization_id', '=', orgId)
      .where('domain', 'in', domains)
      .execute();
    const have = new Set(verified.map((v) => v.domain));
    const missing = domains.filter((d) => !have.has(d));
    if (missing.length > 0) {
      throw unprocessable(
        'idp.jit_domain_unverified',
        {
          en: `JIT provisioning needs verified domains; not verified for this organisation: ${missing.join(', ')}`,
          id: `Penyediaan JIT memerlukan domain terverifikasi; belum terverifikasi untuk organisasi ini: ${missing.join(', ')}`,
        },
        { affected: missing },
      );
    }
  }

  /** The SAML signing certificates as PEM; adds a problem for each one that is not an X.509 certificate. */
  private certificates(values: readonly string[], problems: FieldError[]): string[] {
    const pems: string[] = [];
    values.forEach((value, index) => {
      const pem = normaliseCertificate(value);
      if (pem) pems.push(pem);
      else problems.push({ path: `body.saml.idpCerts.${index}`, message: 'Not an X.509 certificate (PEM or base64 DER)' });
    });
    return pems;
  }

  private async row(trx: Trx, orgId: string, id: string, forUpdate: boolean): Promise<IdentityProviderRow> {
    let query = trx
      .selectFrom('platform.identity_provider')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null);
    if (forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown identity provider');
    return row;
  }
}
