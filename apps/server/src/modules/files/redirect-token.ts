// Redirect tokens of `GET /storage/objects/{id}/redirect?t=` (build plan D.3): an HMAC with a key derived from
// `platform.key` (SecretBox purpose `redirect`, D-09) over the user, organisation, system, object and expiry, valid
// for 5 minutes. The token is `<base64url payload>.<hex MAC>`; it names no provider URL.
import { Injectable } from '@nestjs/common';
import { SecretBox } from '../keys/secret-box';

export const REDIRECT_TOKEN_TTL_MS = 5 * 60 * 1000;
const PURPOSE = 'storage-redirect';

export interface RedirectClaims {
  /** User the token was issued to. */
  u: string;
  /** Organisation. */
  g: string;
  /** System slug the object was opened for. */
  m: string;
  /** Storage object id. */
  o: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

@Injectable()
export class RedirectTokens {
  constructor(private readonly box: SecretBox) {}

  issue(claims: Omit<RedirectClaims, 'e'>, now: Date): { token: string; expiresAt: Date } {
    const expiresAt = new Date(now.getTime() + REDIRECT_TOKEN_TTL_MS);
    const payload = Buffer.from(JSON.stringify({ ...claims, e: expiresAt.getTime() }), 'utf8').toString('base64url');
    return { token: `${payload}.${this.box.mac(PURPOSE, payload)}`, expiresAt };
  }

  /** The claims of a token with a valid MAC that has not expired; null otherwise. */
  verify(token: string, now: Date): RedirectClaims | null {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    if (!this.box.verifyMac(PURPOSE, payload, token.slice(dot + 1))) return null;
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const c = claims as Partial<RedirectClaims>;
    if (typeof c.u !== 'string' || typeof c.g !== 'string' || typeof c.m !== 'string' || typeof c.o !== 'string' || typeof c.e !== 'number') return null;
    if (c.e <= now.getTime()) return null;
    return c as RedirectClaims;
  }
}
