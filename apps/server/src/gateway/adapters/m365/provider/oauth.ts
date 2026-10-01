// Token endpoint calls of the provider adapters (WP-15): a form POST to an OAuth 2.0 token endpoint, the answer
// read as `{access_token, expires_in, refresh_token?, scope?}`, and every refusal of the endpoint (a 4xx answer
// other than throttling: `invalid_client`, `invalid_grant`, `unauthorized_client`, ...) reported as an invalid
// credential, which the link health check records as `credential_invalid` (E.4) and test-connection as `revoked`.
import { z } from 'zod';
import { PROVIDER_LABEL, ProviderError, credentialError, unexpectedAnswer, truncate } from './errors';
import type { ProviderHttp } from './http';
import type { IssuedToken } from './token-cache';

const TokenAnswer = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/)]).optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export interface TokenAnswer extends IssuedToken {
  refreshToken?: string;
  scope?: string;
}

/** Lifetime assumed when a token endpoint does not say (`expires_in` is recommended, not required). */
const DEFAULT_LIFETIME_SECONDS = 3600;

/** Token requests run on their own: concurrent calls share them, so one caller going away must not cancel them. */
const NEVER = new AbortController().signal;

export async function requestToken(
  http: ProviderHttp,
  url: URL,
  form: URLSearchParams,
  options: { idempotent: boolean; headers?: Record<string, string> },
): Promise<TokenAnswer> {
  let body: unknown;
  try {
    body = await http.json({ method: 'POST', url, form, signal: NEVER, idempotent: options.idempotent, headers: options.headers, what: 'requesting an access token' });
  } catch (error) {
    if (error instanceof ProviderError && error.slug !== 'rate-limited' && error.info.status !== null && error.info.status >= 400 && error.info.status < 500) {
      const reason = error.info.code ? ` (${error.info.code})` : '';
      throw credentialError(
        http.provider,
        `${PROVIDER_LABEL[http.provider]} refused the repository credential${reason}: ${truncate(error.message, 200)}`,
        error.info.status,
        error.info.code,
      );
    }
    throw error;
  }
  const parsed = TokenAnswer.safeParse(body);
  if (!parsed.success) throw unexpectedAnswer(http.provider, 'token answer without access_token');
  const expires = parsed.data.expires_in === undefined ? DEFAULT_LIFETIME_SECONDS : Number(parsed.data.expires_in);
  return {
    accessToken: parsed.data.access_token,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : DEFAULT_LIFETIME_SECONDS,
    ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
    ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
  };
}

/** The `roles` claim of a JWT access token (Microsoft app-only tokens); empty for opaque tokens. */
export function tokenRoles(accessToken: string): string[] {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return [];
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { roles?: unknown; scp?: unknown };
    const roles = Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === 'string') : [];
    const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean) : [];
    return [...roles, ...scopes].slice(0, 20);
  } catch {
    return [];
  }
}
