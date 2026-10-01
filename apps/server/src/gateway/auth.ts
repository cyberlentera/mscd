// Caller authentication of the storage gateway (build plan D.5, D.4, I.3): every `/v1` request carries
// `Authorization: Bearer <gateway token>`, and in `tls.mode: mtls` a client certificate of the installation CA with
// `CN=mscd-api` or `CN=mscd-worker`. The gateway accepts the token in `gateway.token_files[0]` and, during a
// rotation, the one in `gateway.token_files[1]`. The files are read again whenever they change on disk, so
// `mscd-server keys rotate-gateway-token` takes effect without a restart.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import { GATEWAY_CALLER_NAMES, type GatewayCallerName } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { forbidden } from './problems';

/** Tokens shorter than this are refused when read (they would be guessable). */
export const MIN_TOKEN_LENGTH = 32;

interface CachedToken {
  signature: string;
  digest: Buffer | null;
}

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Reads a token file: UTF-8, one trailing line break removed. */
export function readTokenFile(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

/** The accepted gateway tokens: current and, during a rotation, previous. */
export class GatewayTokens {
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly files: readonly string[]) {
    if (files.length === 0 || files.length > 2) throw new Error('gateway.token_files names one or two files');
  }

  /** Fails when the current token file is missing, empty or too short (checked at start). */
  assertCurrentReadable(): void {
    const digest = this.digest(this.files[0]!);
    if (!digest) throw new Error(`The gateway token file ${this.files[0]} is missing, empty or shorter than ${MIN_TOKEN_LENGTH} characters`);
  }

  /** Which configured token a presented token equals, compared in constant time; null when none. */
  match(presented: string): 'current' | 'previous' | null {
    const given = digestOf(presented);
    let result: 'current' | 'previous' | null = null;
    this.files.forEach((file, index) => {
      const expected = this.digest(file);
      // Every configured file is compared, so the time does not tell which one matched.
      if (expected && timingSafeEqual(expected, given) && result === null) result = index === 0 ? 'current' : 'previous';
    });
    return result;
  }

  private digest(file: string): Buffer | null {
    let signature: string;
    try {
      const stat = statSync(file);
      signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.cache.delete(file);
      return null; // An absent previous token file is normal outside a rotation.
    }
    const cached = this.cache.get(file);
    if (cached && cached.signature === signature) return cached.digest;
    let digest: Buffer | null = null;
    try {
      const token = readTokenFile(file);
      if (token.trim().length >= MIN_TOKEN_LENGTH) digest = digestOf(token);
    } catch {
      digest = null;
    }
    this.cache.set(file, { signature, digest });
    return digest;
  }
}

/** The bearer token of a request, or null. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * The common name of the verified client certificate (`mtls`), or null when TLS is off. Throws 403 `caller` when the
 * connection has no verified certificate or its name is not one of `mscd-api`, `mscd-worker`.
 */
export function callerName(request: FastifyRequest, tlsMode: 'mtls' | 'off'): GatewayCallerName | null {
  if (tlsMode === 'off') return null;
  const socket = request.raw.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function' || socket.authorized !== true) {
    throw forbidden('A client certificate of the installation CA is required', 'caller');
  }
  const subject = socket.getPeerCertificate().subject as { CN?: string | string[] } | undefined;
  const cn = Array.isArray(subject?.CN) ? subject.CN[0] : subject?.CN;
  if (!cn || !(GATEWAY_CALLER_NAMES as readonly string[]).includes(cn)) {
    throw forbidden('The client certificate does not name an allowed caller', 'caller');
  }
  return cn as GatewayCallerName;
}

/** Checks the bearer token (403 `token`). */
export function authenticate(request: FastifyRequest, tokens: GatewayTokens): 'current' | 'previous' {
  const token = bearerToken(request);
  const matched = token === null ? null : tokens.match(token);
  if (!matched) throw forbidden('The gateway token is missing or not valid', 'token');
  return matched;
}
