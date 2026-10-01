// Access tokens for Google Drive (build plan D.5, F.8, WP-15): a service account JWT (`urn:ietf:params:oauth:
// grant-type:jwt-bearer`, RS256, `iss` = the service account, `aud` = the token endpoint, scope
// `https://www.googleapis.com/auth/drive`, one hour), or the `refresh_token` grant of a delegated credential.
// Tokens are cached until five minutes before they expire. The authorization code exchange of the repository
// consent flow (`credentials/oauth-exchange`) also runs here.
import { SignJWT } from 'jose';
import type { ProviderHttp } from '../m365/provider/http';
import { requestToken, type TokenAnswer } from '../m365/provider/oauth';
import type { TokenCache } from '../m365/provider/token-cache';
import type { GoogleCredential } from './credential';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ASSERTION_LIFETIME_SECONDS = 3600;

export class GoogleTokens {
  constructor(
    private readonly http: ProviderHttp,
    readonly tokenUrl: string,
    private readonly cache: TokenCache,
    private readonly now: () => Date,
  ) {}

  /** A Drive access token for the credential (cached). */
  token(credential: GoogleCredential): Promise<string> {
    return this.cache.get(credential.cacheKey, () => this.issue(credential));
  }

  /** Forgets a token the API refused. */
  invalidate(credential: GoogleCredential, token: string): void {
    this.cache.invalidate(credential.cacheKey, token);
  }

  /** Stores a token obtained otherwise (the code exchange) under a credential's cache key. */
  remember(cacheKey: string, answer: TokenAnswer): void {
    this.cache.put(cacheKey, answer);
  }

  /** Exchanges an authorization code (PKCE) for tokens with the repository's OAuth client. */
  exchangeCode(client: { clientId: string; clientSecret: string }, code: string, redirectUri: string, codeVerifier: string): Promise<TokenAnswer> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    // A code works once: never repeated after a network failure.
    return requestToken(this.http, new URL(this.tokenUrl), form, { idempotent: false });
  }

  private async issue(credential: GoogleCredential): Promise<TokenAnswer> {
    if (credential.kind === 'refresh_token') {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
      });
      return requestToken(this.http, new URL(this.tokenUrl), form, { idempotent: true });
    }
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const assertion = await new SignJWT({ scope: DRIVE_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(credential.clientEmail)
      .setAudience(this.tokenUrl)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .sign(credential.key);
    const form = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion });
    return requestToken(this.http, new URL(this.tokenUrl), form, { idempotent: true });
  }
}
