// Egress policy of the provider adapters (build plan I.1, D.5, WP-15). The adapters send requests only to the
// provider base URLs of the deployment profile (`gateway.providers`), and a base URL other than the provider's
// default is accepted only when its host is in `network.egress_allowlist` or demo mode is on. URLs the provider
// hands out (upload sessions, copy monitors, download links, resumable upload sessions) are followed only when
// they point to a configured base URL's origin, to the provider's own hosts when the default endpoint is used, or
// to an allow-listed host; every other target is refused before a connection is opened.
import { ConfigError } from '../../../../config/mscd-config';
import { GatewayError } from '../../../problems';

export interface EgressEndpoint {
  /** Profile key, for messages (`gateway.providers.m365.graph_base_url`). */
  setting: string;
  url: string;
  /** The provider's default URL; any other value needs an allow-listed host or demo mode (I.1). */
  defaultUrl: string;
  /**
   * Hosts the provider hands out URLs on when this endpoint is the default (exact host names, or `.suffix` for
   * every host under a domain).
   */
  issuedHosts?: readonly string[];
}

export interface EgressPolicyInput {
  endpoints: readonly EgressEndpoint[];
  /** `network.egress_allowlist`: host names, `host:port`, or `*.domain` for every host under a domain. */
  allowlist: readonly string[];
  demo: boolean;
}

/** A request target the policy refuses. */
export class EgressRefusedError extends GatewayError {
  constructor(readonly target: string) {
    super('forbidden', `Requests to ${target} are not allowed: only the configured provider endpoints and network.egress_allowlist hosts (I.1)`);
    this.name = 'EgressRefusedError';
  }
}

interface Base {
  origin: string;
  /** Path prefix without a trailing slash ('' for the origin). */
  path: string;
}

function normalise(url: string): string {
  return url.replace(/\/+$/, '');
}

function hostMatches(pattern: string, url: URL): boolean {
  const entry = pattern.trim().toLowerCase();
  if (entry === '') return false;
  const host = url.hostname.toLowerCase();
  if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
  if (entry.startsWith('.')) return host.endsWith(entry);
  return entry.includes(':') && !entry.startsWith('[') ? entry === url.host.toLowerCase() : entry === host;
}

export class EgressPolicy {
  private readonly bases: Base[];
  private readonly issuedHosts: string[];

  private constructor(
    bases: Base[],
    issuedHosts: string[],
    private readonly allowlist: readonly string[],
    private readonly demo: boolean,
  ) {
    this.bases = bases;
    this.issuedHosts = issuedHosts;
  }

  /**
   * Builds the policy of one adapter. A configured base URL that is not the provider default is refused (as at
   * gateway start, I.1) unless its host is allow-listed or demo mode is on.
   */
  static create(input: EgressPolicyInput): EgressPolicy {
    const bases: Base[] = [];
    const issued: string[] = [];
    for (const endpoint of input.endpoints) {
      let url: URL;
      try {
        url = new URL(endpoint.url);
      } catch {
        throw new ConfigError(`${endpoint.setting} ${endpoint.url} is not a URL`);
      }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
        throw new ConfigError(`${endpoint.setting} ${endpoint.url} must be an http(s) URL without credentials, query or fragment`);
      }
      const isDefault = normalise(endpoint.url) === normalise(endpoint.defaultUrl);
      if (!isDefault && !input.demo && !input.allowlist.some((entry) => hostMatches(entry, url))) {
        throw new ConfigError(
          `${endpoint.setting} ${endpoint.url} is not the provider's default; add ${url.hostname} to network.egress_allowlist to use it (I.1)`,
        );
      }
      if (url.protocol === 'http:' && !input.demo) {
        throw new ConfigError(`${endpoint.setting} ${endpoint.url} uses plain HTTP, which only demo mode allows`);
      }
      bases.push({ origin: url.origin, path: normalise(url.pathname) });
      if (isDefault) issued.push(...(endpoint.issuedHosts ?? []));
    }
    return new EgressPolicy(bases, issued, input.allowlist, input.demo);
  }

  /** Throws unless a request to `url` is allowed. `api` targets must lie under a configured base URL. */
  assertAllowed(url: URL, target: 'api' | 'issued'): void {
    if (this.allows(url, target)) return;
    throw new EgressRefusedError(url.origin);
  }

  allows(url: URL, target: 'api' | 'issued'): boolean {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password) return false;
    if (target === 'api') {
      return this.bases.some(
        (base) => url.origin === base.origin && (base.path === '' || url.pathname === base.path || url.pathname.startsWith(`${base.path}/`)),
      );
    }
    if (this.bases.some((base) => url.origin === base.origin)) return true;
    if (url.protocol !== 'https:' && !this.demo) return false;
    if (url.port !== '' && url.port !== '443' && !this.allowlist.some((entry) => hostMatches(entry, url))) return false;
    return this.issuedHosts.some((entry) => hostMatches(entry, url)) || this.allowlist.some((entry) => hostMatches(entry, url));
  }
}
