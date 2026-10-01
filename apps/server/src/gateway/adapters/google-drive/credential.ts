// Credentials of a Google Drive repository (build plan D.2 `RepositoryCredential`, TS 5.2, F.8): a service account
// that is a member of the Shared Drive (`google_service_account`: client email and private key), or a delegated
// OAuth refresh token obtained through the repository consent flow (`oauth_refresh_token`: OAuth client id and
// secret plus the refresh token the gateway sealed after the code exchange). The gateway opens them per call
// (D-08) and checks them here before any token request.
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { RepositoryCredential } from '@mscd/shared';
import { z } from 'zod';
import type { OpenedCredential } from '../../crypto/credentials';
import { forbidden } from '../../problems';
import { credentialError } from '../m365/provider/errors';
import { tokenCacheKey } from '../m365/provider/token-cache';

export type GoogleCredential =
  | { kind: 'service_account'; ref: string; clientEmail: string; key: KeyObject; cacheKey: string }
  | { kind: 'refresh_token'; ref: string; clientId: string; clientSecret: string; refreshToken: string; cacheKey: string };

/** The secret of an `oauth_refresh_token` credential once the consent flow sealed it. */
export const RefreshTokenSecret = z.strictObject({
  clientId: z.string().min(1).max(300),
  clientSecret: z.string().min(1).max(1024),
  refreshToken: z.string().min(1).max(4096),
});
export type RefreshTokenSecret = z.infer<typeof RefreshTokenSecret>;

/** The OAuth client of an `oauth_refresh_token` credential before consent (`{clientId, clientSecret}`). */
export function readOAuthClient(credential: OpenedCredential | null): { clientId: string; clientSecret: string } {
  if (!credential) throw forbidden('The repository has no OAuth client credential; add one before the consent', 'credential-missing');
  if (credential.kind !== 'oauth_refresh_token') {
    throw forbidden(`A ${credential.kind} credential cannot be used for the Google consent flow`, 'credential-kind');
  }
  const { refreshToken: _ignored, ...client } = credential.secret;
  const parsed = RepositoryCredential.safeParse({ kind: credential.kind, secret: client });
  if (!parsed.success || parsed.data.kind !== 'oauth_refresh_token') {
    throw credentialError('google_drive', 'The OAuth client credential of the repository is incomplete (clientId and clientSecret are needed)');
  }
  return parsed.data.secret;
}

/** The credential of a call, checked; `forbidden` when it is missing or of another kind. */
export function readGoogleCredential(credential: OpenedCredential | null, tokenUrl: string): GoogleCredential {
  if (!credential) throw forbidden('The repository has no credential; add a service account or complete the Google consent first', 'credential-missing');
  if (credential.kind === 'google_service_account') {
    const parsed = RepositoryCredential.safeParse({ kind: credential.kind, secret: credential.secret });
    if (!parsed.success || parsed.data.kind !== 'google_service_account') {
      throw credentialError('google_drive', 'The service account credential of the repository is incomplete (clientEmail and privateKeyPem are needed)');
    }
    let key: KeyObject;
    try {
      key = createPrivateKey(parsed.data.secret.privateKeyPem);
    } catch {
      throw credentialError('google_drive', 'The private key of the service account credential cannot be read');
    }
    if (key.asymmetricKeyType !== 'rsa') throw credentialError('google_drive', 'The service account credential needs an RSA key (RS256)');
    const keyDigest = createHash('sha256').update(parsed.data.secret.privateKeyPem).digest('hex');
    return {
      kind: 'service_account',
      ref: credential.ref,
      clientEmail: parsed.data.secret.clientEmail,
      key,
      cacheKey: tokenCacheKey('google_service_account', tokenUrl, parsed.data.secret.clientEmail.toLowerCase(), keyDigest),
    };
  }
  if (credential.kind === 'oauth_refresh_token') {
    const parsed = RefreshTokenSecret.safeParse(credential.secret);
    if (!parsed.success) {
      if (credential.secret.refreshToken === undefined) {
        throw forbidden('The delegated credential of the repository has no refresh token yet; complete the Google consent', 'credential-missing');
      }
      throw credentialError('google_drive', 'The delegated credential of the repository is incomplete (clientId, clientSecret and refreshToken are needed)');
    }
    return { kind: 'refresh_token', ref: credential.ref, ...parsed.data, cacheKey: refreshTokenCacheKey(parsed.data, tokenUrl) };
  }
  throw forbidden(`A ${credential.kind} credential cannot be used with a Google Drive repository`, 'credential-kind');
}

/** Cache key of a refresh token credential that is about to be sealed (consent flow). */
export function refreshTokenCacheKey(secret: RefreshTokenSecret, tokenUrl: string): string {
  const digest = createHash('sha256').update(`${secret.clientSecret}\n${secret.refreshToken}`).digest('hex');
  return tokenCacheKey('oauth_refresh_token', tokenUrl, secret.clientId, digest);
}
