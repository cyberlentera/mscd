// OIDC discovery through `openid-client` (build plan F.8 step 1): the provider's metadata is fetched from
// `<issuer>/.well-known/openid-configuration`, its `issuer` must equal the configured one, and the resulting client
// configuration is cached for one hour per provider. Any change of the provider row (issuer, client, secret, or any
// other column through `updated_at`) gives a new cache key, so an edited provider is discovered again at once, also
// on other api replicas. With `identity.oidc.allow_insecure_http` (demo and test profiles only) plain-HTTP issuers
// such as the test Keycloak are accepted; otherwise the issuer and every endpoint must use HTTPS.
import { Injectable, Logger } from '@nestjs/common';
import * as oidc from 'openid-client';
import { MscdConfig } from '../../../config/mscd-config';
import { Clock } from '../../../common/clock';
import { SecretBox } from '../../keys/secret-box';

/** Discovery results are kept this long (F.8 step 1). */
export const DISCOVERY_CACHE_MS = 60 * 60_000;

/** Timeout of every request to the identity provider, in seconds. */
export const PROVIDER_TIMEOUT_SECONDS = 10;

/** Most providers kept in the discovery cache. */
const CACHE_LIMIT = 500;

/** Why a discovery failed, in words safe to show to a Tenant Admin (no response bodies). */
export type DiscoveryFailureReason = 'insecure_issuer' | 'invalid_issuer' | 'unreachable' | 'timeout' | 'invalid_metadata' | 'issuer_mismatch' | 'http_error';

export const DISCOVERY_FAILURE_TEXT: Readonly<Record<DiscoveryFailureReason, string>> = {
  insecure_issuer: 'The issuer must use HTTPS',
  invalid_issuer: 'The issuer is not a valid URL',
  unreachable: 'The issuer could not be reached',
  timeout: 'The issuer did not answer in time',
  invalid_metadata: 'The issuer did not return valid OpenID Connect metadata',
  issuer_mismatch: 'The metadata names another issuer than the one configured',
  http_error: 'The issuer answered the discovery request with an error',
};

export class DiscoveryError extends Error {
  constructor(
    readonly reason: DiscoveryFailureReason,
    options?: { cause?: unknown },
  ) {
    super(DISCOVERY_FAILURE_TEXT[reason], options);
    this.name = 'DiscoveryError';
  }
}

/** The OIDC columns of `platform.identity_provider` that discovery needs. */
export interface OidcProviderSettings {
  id: string;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_sealed: string | null;
  updated_at: Date;
}

/** Connection settings of a provider that is not stored yet (admin create and update checks). */
export interface OidcConnection {
  issuer: string;
  clientId: string;
  /** Plain client secret; null for a public client (PKCE only). */
  clientSecret: string | null;
}

/** Endpoints of a discovered provider, as the admin test reports them. */
export interface DiscoveredEndpoints {
  issuer: string;
  endpoints: Record<string, string>;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Maps an `openid-client` or network error to a reason that is safe to report. */
export function discoveryFailureReason(error: unknown): DiscoveryFailureReason {
  if (error instanceof DiscoveryError) return error.reason;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = errorCode(current);
    const name = (current as { name?: unknown }).name;
    if (code === 'OAUTH_HTTP_REQUEST_FORBIDDEN' || code === 'OAUTH_REQUEST_PROTOCOL_FORBIDDEN') return 'insecure_issuer';
    if (code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED') return 'issuer_mismatch';
    if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') return 'http_error';
    if (code === 'OAUTH_RESPONSE_IS_NOT_JSON' || code === 'OAUTH_PARSE_ERROR' || code === 'OAUTH_INVALID_RESPONSE' || code === 'OAUTH_INVALID_SERVER_METADATA') {
      return 'invalid_metadata';
    }
    if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof TypeError) return 'unreachable';
  return 'invalid_metadata';
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  configuration: Promise<oidc.Configuration>;
}

@Injectable()
export class OidcDiscovery {
  private readonly logger = new Logger('OidcDiscovery');
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: MscdConfig,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
  ) {}

  /** True when plain-HTTP issuers are accepted (`identity.oidc.allow_insecure_http`, demo and test only). */
  get allowInsecureHttp(): boolean {
    return this.config.profile.identity.oidc.allow_insecure_http;
  }

  /**
   * The client configuration of a stored provider: from the cache when it was discovered within the last hour with
   * the same settings, else discovered now. A failed discovery is not cached.
   */
  async configurationFor(provider: OidcProviderSettings): Promise<oidc.Configuration> {
    const key = [provider.oidc_issuer, provider.oidc_client_id, provider.oidc_client_secret_sealed ?? '', provider.updated_at.getTime()].join('\n');
    const now = this.clock.now().getTime();
    const cached = this.cache.get(provider.id);
    if (cached && cached.key === key && cached.expiresAt > now) return cached.configuration;
    const configuration = (async () => {
      if (!provider.oidc_issuer || !provider.oidc_client_id) throw new DiscoveryError('invalid_issuer');
      const secret = provider.oidc_client_secret_sealed
        ? await this.secrets.openText(provider.oidc_client_secret_sealed, { purpose: 'idp', providerId: provider.id })
        : null;
      return this.discover({ issuer: provider.oidc_issuer, clientId: provider.oidc_client_id, clientSecret: secret });
    })();
    this.remember(provider.id, { key, expiresAt: now + DISCOVERY_CACHE_MS, configuration });
    try {
      return await configuration;
    } catch (error) {
      if (this.cache.get(provider.id)?.configuration === configuration) this.cache.delete(provider.id);
      throw error;
    }
  }

  /** Discovers a provider now, without the cache. Throws `DiscoveryError`. */
  async discover(connection: OidcConnection): Promise<oidc.Configuration> {
    let issuer: URL;
    try {
      issuer = new URL(connection.issuer);
    } catch (error) {
      throw new DiscoveryError('invalid_issuer', { cause: error });
    }
    if (issuer.protocol !== 'https:' && issuer.protocol !== 'http:') throw new DiscoveryError('invalid_issuer');
    if (issuer.username || issuer.password || issuer.hash) throw new DiscoveryError('invalid_issuer');
    if (issuer.protocol === 'http:' && !this.allowInsecureHttp) throw new DiscoveryError('insecure_issuer');
    const clientAuth = connection.clientSecret ? oidc.ClientSecretPost(connection.clientSecret) : oidc.None();
    try {
      return await oidc.discovery(issuer, connection.clientId, connection.clientSecret ? { client_secret: connection.clientSecret } : undefined, clientAuth, {
        timeout: PROVIDER_TIMEOUT_SECONDS,
        ...(this.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : {}),
      });
    } catch (error) {
      const reason = discoveryFailureReason(error);
      this.logger.warn(`OIDC discovery of ${issuer.origin} failed: ${reason}`);
      throw new DiscoveryError(reason, { cause: error });
    }
  }

  /** The issuer and endpoints of a discovered configuration (admin test, D.3). */
  endpointsOf(configuration: oidc.Configuration): DiscoveredEndpoints {
    const metadata = configuration.serverMetadata();
    const endpoints: Record<string, string> = {};
    const add = (name: string, value: unknown) => {
      if (typeof value === 'string' && value !== '') endpoints[name] = value;
    };
    add('authorization', metadata.authorization_endpoint);
    add('token', metadata.token_endpoint);
    add('userinfo', metadata.userinfo_endpoint);
    add('jwks', metadata.jwks_uri);
    add('endSession', metadata.end_session_endpoint);
    return { issuer: metadata.issuer, endpoints };
  }

  /** Forgets a provider's cached configuration (after an admin change). */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  /** Forgets every cached configuration (test reset). */
  clear(): void {
    this.cache.clear();
  }

  private remember(providerId: string, entry: CacheEntry): void {
    if (!this.cache.has(providerId) && this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(providerId);
    this.cache.set(providerId, entry);
  }
}
