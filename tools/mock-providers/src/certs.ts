import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';

// Certificates for the Microsoft identity mock. An app registration trusts an X.509 certificate; a client
// assertion names it by its SHA-256 thumbprint (`x5t#S256`, base64url of the DER encoding) or, in the older form,
// its SHA-1 thumbprint (`x5t`). Node can parse certificates but not create them, so `createSelfSignedCertificate`
// encodes a minimal self-signed RSA certificate in DER by hand. Tests and the self-test create key material at
// run time; no private key is stored in this package (rule R-11).

export interface CertificateInfo {
  /** base64url SHA-256 thumbprint of the DER encoding (`x5t#S256`). */
  thumbprintSha256: string;
  /** base64url SHA-1 thumbprint of the DER encoding (`x5t`). */
  thumbprintSha1: string;
  notBefore: Date;
  notAfter: Date;
  subject: string;
  publicKey: KeyObject;
}

export interface SelfSignedCertificate {
  certificatePem: string;
  privateKeyPem: string;
  publicKeyPem: string;
  thumbprintSha256: string;
  thumbprintSha1: string;
  notBefore: Date;
  notAfter: Date;
}

export interface SelfSignedCertificateOptions {
  commonName?: string;
  /** Validity start; default one hour ago. */
  notBefore?: Date;
  /** Validity in days from `notBefore`; default 365. */
  days?: number;
  /** RSA modulus length; default 2048. */
  modulusLength?: number;
  /** Use this RSA private key instead of generating one. */
  privateKeyPem?: string;
}

/** Parses an X.509 certificate in PEM form and returns its thumbprints, validity and public key. */
export function inspectCertificate(certificatePem: string): CertificateInfo {
  const certificate = new X509Certificate(certificatePem);
  return {
    thumbprintSha256: createHash('sha256').update(certificate.raw).digest('base64url'),
    thumbprintSha1: createHash('sha1').update(certificate.raw).digest('base64url'),
    notBefore: new Date(certificate.validFrom),
    notAfter: new Date(certificate.validTo),
    subject: certificate.subject,
    publicKey: certificate.publicKey,
  };
}

/** Creates an RSA key pair and a self-signed certificate (sha256WithRSAEncryption) for it. */
export function createSelfSignedCertificate(options: SelfSignedCertificateOptions = {}): SelfSignedCertificate {
  const privateKey = options.privateKeyPem
    ? createPrivateKey(options.privateKeyPem)
    : generateKeyPairSync('rsa', { modulusLength: options.modulusLength ?? 2048 }).privateKey;
  const publicKey = createPublicKey(privateKey);
  const notBefore = options.notBefore ?? new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + (options.days ?? 365) * 24 * 60 * 60 * 1000);
  const name = derSequence(
    derSet(derSequence(derOid('2.5.4.3'), derUtf8(options.commonName ?? 'mscd-mock-providers'))),
  );
  const algorithm = derSequence(derOid('1.2.840.113549.1.1.11'), DER_NULL);
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const basicConstraints = derSequence(
    derOid('2.5.29.19'),
    derTag(0x01, Buffer.from([0xff])),
    derTag(0x04, derSequence()),
  );
  const tbs = derSequence(
    derTag(0xa0, derInteger(Buffer.from([2]))),
    derInteger(serial),
    algorithm,
    name,
    derSequence(derTime(notBefore), derTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    derTag(0xa3, derSequence(basicConstraints)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = derSequence(tbs, algorithm, derTag(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certificatePem = toPem('CERTIFICATE', der);
  const info = inspectCertificate(certificatePem);
  return {
    certificatePem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    thumbprintSha256: info.thumbprintSha256,
    thumbprintSha1: info.thumbprintSha1,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
  };
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derSequence(...parts: Buffer[]): Buffer {
  return derTag(0x30, ...parts);
}

function derSet(...parts: Buffer[]): Buffer {
  return derTag(0x31, ...parts);
}

const DER_NULL = Buffer.from([0x05, 0x00]);

function derInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  return derTag(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) {
      encoded.unshift((rest & 0x7f) | 0x80);
    }
    bytes.push(...encoded);
  }
  return derTag(0x06, Buffer.from(bytes));
}

function derUtf8(text: string): Buffer {
  return derTag(0x0c, Buffer.from(text, 'utf8'));
}

function derTime(date: Date): Buffer {
  const iso = date.toISOString();
  const compact = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  // RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050.
  return date.getUTCFullYear() < 2050
    ? derTag(0x17, Buffer.from(compact.slice(2), 'ascii'))
    : derTag(0x18, Buffer.from(compact, 'ascii'));
}
