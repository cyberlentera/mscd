// The certificate credential of a Microsoft 365 repository (build plan D.2 `RepositoryCredential`, TS 5.2): an
// app registration in Microsoft Entra ID (`tenantId`, `clientId`) authenticated with a certificate, never a client
// secret. The gateway opens it per call (D-08); it is checked here before any token request: the certificate and
// the RSA key must parse and belong together, and an expired certificate is reported as an invalid credential.
import { X509Certificate, createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { RepositoryCredential } from '@mscd/shared';
import type { OpenedCredential } from '../../crypto/credentials';
import { forbidden } from '../../problems';
import { credentialError } from './provider/errors';
import { tokenCacheKey } from './provider/token-cache';

export interface M365Credential {
  ref: string;
  tenantId: string;
  clientId: string;
  key: KeyObject;
  /** base64url SHA-256 of the certificate in DER form, sent as `x5t#S256`. */
  thumbprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  /** Token cache key: endpoint, app and a hash of the key material. */
  cacheKey: string;
}

/** The credential of a call, checked; `forbidden` when it is missing or of another kind. */
export function readM365Credential(credential: OpenedCredential | null, tokenEndpointBase: string): M365Credential {
  if (!credential) throw forbidden('The repository has no credential; add the certificate credential first', 'credential-missing');
  if (credential.kind !== 'm365_certificate') {
    throw forbidden(`A ${credential.kind} credential cannot be used with a Microsoft 365 repository`, 'credential-kind');
  }
  const parsed = RepositoryCredential.safeParse({ kind: credential.kind, secret: credential.secret });
  if (!parsed.success || parsed.data.kind !== 'm365_certificate') {
    throw credentialError('m365', 'The certificate credential of the repository is incomplete (tenantId, clientId, certificatePem and privateKeyPem are needed)');
  }
  const secret = parsed.data.secret;
  let certificate: X509Certificate;
  let key: KeyObject;
  try {
    certificate = new X509Certificate(secret.certificatePem);
  } catch {
    throw credentialError('m365', 'The certificate of the repository credential cannot be read');
  }
  try {
    key = createPrivateKey(secret.privateKeyPem);
  } catch {
    throw credentialError('m365', 'The private key of the repository credential cannot be read');
  }
  if (key.asymmetricKeyType !== 'rsa') throw credentialError('m365', 'The certificate credential needs an RSA key (RS256 client assertions)');
  if (!certificate.checkPrivateKey(key)) throw credentialError('m365', 'The private key of the repository credential does not belong to its certificate');
  const thumbprintSha256 = createHash('sha256').update(certificate.raw).digest('base64url');
  const keyDigest = createHash('sha256').update(secret.privateKeyPem).digest('hex');
  return {
    ref: credential.ref,
    tenantId: secret.tenantId,
    clientId: secret.clientId,
    key,
    thumbprintSha256,
    notBefore: new Date(certificate.validFrom),
    notAfter: new Date(certificate.validTo),
    cacheKey: tokenCacheKey('m365_certificate', tokenEndpointBase, secret.tenantId.toLowerCase(), secret.clientId, thumbprintSha256, keyDigest),
  };
}
