// Repository OAuth consent (build plan F.8 "Repository OAuth consent", D.5 `credentials/oauth-exchange`). A Tenant
// or Storage Admin starts the consent for a Google Drive repository whose credential is a delegated OAuth client;
// the browser comes back to the callback with `code` and `state`. The `repo_oauth` transaction stores only hashes of
// the state and of a browser binding cookie, and the PKCE verifier sealed with `platform.key` (`pkce:<id>`). The
// callback consumes the transaction only when the same signed-in user, organisation, binding cookie and an
// unexpired transaction match; anything else changes nothing.
import { createHash, randomBytes } from 'node:crypto';

/** Cookie of the browser binding (HttpOnly, SameSite=Lax, 10 minutes, callback path only). */
export const REPO_OAUTH_COOKIE = 'mscd_repo_tx';
export const REPO_OAUTH_COOKIE_PATH = '/api/v1/admin/storage/repositories/oauth/';
export const REPO_OAUTH_CALLBACK_PATH = '/api/v1/admin/storage/repositories/oauth/callback';
export const REPO_OAUTH_TTL_SECONDS = 600;
/** D.5: a refresh token with the `drive.file` scope. */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** URL-safe random value of 32 bytes (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a value, as stored in `auth_transaction.state_hash` and `browser_binding_hash`. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** RFC 7636 S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Google's authorisation endpoint for the profile's token URL: Google's own endpoint for Google's token URL, else
 * the same origin as the token URL (the mock providers serve `/o/oauth2/v2/auth` next to `/token`).
 */
export function googleAuthorizationUrl(tokenUrl: string): string {
  if (tokenUrl.replace(/\/+$/, '') === GOOGLE_TOKEN_URL) return GOOGLE_AUTHORIZATION_URL;
  return new URL('/o/oauth2/v2/auth', tokenUrl).toString();
}

/** The consent URL of a Google Drive OAuth client (offline access, forced consent so a refresh token is issued). */
export function googleConsentUrl(input: { tokenUrl: string; clientId: string; redirectUri: string; state: string; verifier: string }): string {
  const url = new URL(googleAuthorizationUrl(input.tokenUrl));
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_DRIVE_FILE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: input.state,
    code_challenge: pkceChallenge(input.verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** The callback URL registered with the OAuth client: `<http.public_url>/api/v1/admin/storage/repositories/oauth/callback`. */
export function repoOAuthRedirectUri(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${REPO_OAUTH_CALLBACK_PATH}`;
}
