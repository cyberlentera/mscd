// Access tokens for Microsoft Graph (build plan D.5, WP-15): the client credentials grant of the Microsoft
// identity platform with a certificate client assertion, a JWT signed RS256 whose header names the certificate by
// its SHA-256 thumbprint (`x5t#S256`), with `iss` = `sub` = the client id, `aud` = the token endpoint, a `jti` and
// a ten-minute lifetime. Scope `https://graph.microsoft.com/.default`. Tokens are cached until five minutes before
// they expire.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { M365Credential } from './credential';
import { credentialError } from './provider/errors';
import type { ProviderHttp } from './provider/http';
import { requestToken } from './provider/oauth';
import type { TokenCache } from './provider/token-cache';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_LIFETIME_SECONDS = 600;

export class EntraTokens {
  constructor(
    private readonly http: ProviderHttp,
    private readonly loginBaseUrl: string,
    private readonly cache: TokenCache,
    private readonly now: () => Date,
  ) {}

  /** `<login base>/<tenant>/oauth2/v2.0/token` */
  tokenUrl(tenantId: string): URL {
    return new URL(`${this.loginBaseUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`);
  }

  /** A Graph access token for the credential (cached). */
  async token(credential: M365Credential): Promise<string> {
    const now = this.now();
    if (credential.notAfter.getTime() <= now.getTime()) {
      throw credentialError('m365', `The certificate of the repository credential expired on ${credential.notAfter.toISOString()}`);
    }
    if (credential.notBefore.getTime() > now.getTime()) {
      throw credentialError('m365', `The certificate of the repository credential is valid only from ${credential.notBefore.toISOString()}`);
    }
    return this.cache.get(credential.cacheKey, () => this.issue(credential));
  }

  /** Forgets a token the API refused. */
  invalidate(credential: M365Credential, token: string): void {
    this.cache.invalidate(credential.cacheKey, token);
  }

  private async issue(credential: M365Credential) {
    const url = this.tokenUrl(credential.tenantId);
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', 'x5t#S256': credential.thumbprintSha256 })
      .setIssuer(credential.clientId)
      .setSubject(credential.clientId)
      .setAudience(url.href)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .sign(credential.key);
    const form = new URLSearchParams({
      client_id: credential.clientId,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    });
    // Not repeated after a network failure: an assertion is meant to be used once.
    return requestToken(this.http, url, form, { idempotent: false });
  }
}
