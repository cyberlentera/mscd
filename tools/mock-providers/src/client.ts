import { createPrivateKey, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { inspectCertificate } from './certs.js';

// Client-side helpers for tests and the self-test: the assertions an adapter sends to the token endpoints. The
// storage adapters build their own (WP-15); these exist so tests can obtain tokens without an adapter.

export interface M365AssertionInput {
  clientId: string;
  certificatePem: string;
  privateKeyPem: string;
  /** The token endpoint URL, for example http://127.0.0.1:4310/<tenant>/oauth2/v2.0/token */
  audience: string;
  lifetimeSeconds?: number;
  algorithm?: 'RS256' | 'PS256';
}

/** A certificate client assertion as Entra ID expects it (header x5t#S256, iss = sub = client id, jti). */
export async function createM365ClientAssertion(input: M365AssertionInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: input.algorithm ?? 'RS256', typ: 'JWT', 'x5t#S256': inspectCertificate(input.certificatePem).thumbprintSha256 })
    .setIssuer(input.clientId)
    .setSubject(input.clientId)
    .setAudience(input.audience)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + (input.lifetimeSeconds ?? 300))
    .sign(createPrivateKey(input.privateKeyPem));
}

export interface GoogleAssertionInput {
  clientEmail: string;
  privateKeyPem: string;
  /** private_key_id of the key file; sent as `kid`. */
  keyId?: string;
  /** The token endpoint URL. */
  audience: string;
  scope: string;
  /** Domain-wide delegation: the user to act as. */
  subject?: string;
  lifetimeSeconds?: number;
}

/** A service account JWT for the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant. */
export async function createGoogleServiceAccountAssertion(input: GoogleAssertionInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ scope: input.scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(input.keyId ? { kid: input.keyId } : {}) })
    .setIssuer(input.clientEmail)
    .setAudience(input.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + (input.lifetimeSeconds ?? 3600));
  if (input.subject) jwt.setSubject(input.subject);
  return jwt.sign(createPrivateKey(input.privateKeyPem));
}
