// Provider call failures as gateway problems (build plan D.5, E.4, WP-15). Shared by the Microsoft 365 and Google
// Drive adapters; it lives in the m365 folder because WP-15 owns only the two adapter folders (rule R-01).
//
// Mapping of a provider answer to a gateway problem slug:
//   401 and every token endpoint refusal   -> unreachable, credentialInvalid (E.4 `detail: credential_invalid`)
//   403                                     -> forbidden (Google rate limit reasons are throttling, see below)
//   404                                     -> not-found
//   429, 503 and Google 403 rate limits     -> rate-limited with Retry-After
//   400, 409, 412, 416                      -> bad-request
//   413                                     -> too-large
//   other 5xx and network failures          -> unreachable
import type { GatewayProblemSlug } from '@mscd/shared';
import { GatewayError } from '../../../problems';

export type ProviderName = 'm365' | 'google_drive';

/** Display names used in problem details. */
export const PROVIDER_LABEL: Readonly<Record<ProviderName, string>> = {
  m365: 'Microsoft 365',
  google_drive: 'Google Drive',
};

export interface ProviderErrorInfo {
  provider: ProviderName;
  /** HTTP status of the provider answer; null for network failures and checks made before any request. */
  status: number | null;
  /** Provider error code (`itemNotFound`, `rateLimitExceeded`, `invalid_grant`, ...). */
  code: string | null;
  /** The credential was refused: token request failed or the API answered 401 with a fresh token. */
  credentialInvalid?: boolean;
  /** Seconds the provider asked to wait (rate-limited only). */
  retryAfter?: number;
}

/** A failed provider call. It is a gateway problem, so routes answer it directly. */
export class ProviderError extends GatewayError {
  constructor(
    slug: GatewayProblemSlug,
    detail: string,
    readonly info: ProviderErrorInfo,
    options?: { cause?: unknown },
  ) {
    super(slug, detail, info.retryAfter !== undefined ? { retryAfter: info.retryAfter } : {}, options);
    this.name = 'ProviderError';
  }

  get credentialInvalid(): boolean {
    return this.info.credentialInvalid === true;
  }

  get providerStatus(): number | null {
    return this.info.status;
  }
}

/** What an adapter's client reads from an error answer of its provider. */
export interface ProviderFailure {
  code: string | null;
  message: string;
  /** The answer is throttling even though its status is not 429 or 503 (Google 403 rate limit reasons). */
  throttled?: boolean;
}

/** Google API reasons that mean throttling although the status is 403 (Drive API "Resolve errors"). */
const GOOGLE_THROTTLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded']);

/**
 * Reads the error envelopes the adapters meet: OAuth token endpoints (`{error, error_description}`), Microsoft
 * Graph (`{error: {code, message}}`) and Google APIs (`{error: {code, message, errors: [{reason}]}}`).
 */
export function parseProviderError(_status: number, body: unknown): ProviderFailure {
  if (typeof body === 'string') return { code: null, message: body };
  if (body === null || typeof body !== 'object') return { code: null, message: '' };
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') {
    const description = (body as { error_description?: unknown }).error_description;
    return { code: error, message: typeof description === 'string' ? description.split(/\r?\n/)[0]! : error };
  }
  if (error !== null && typeof error === 'object') {
    const envelope = error as { code?: unknown; message?: unknown; errors?: unknown };
    const first = Array.isArray(envelope.errors) ? (envelope.errors[0] as { reason?: unknown } | undefined) : undefined;
    const reason = typeof first?.reason === 'string' ? first.reason : null;
    const code = reason ?? (typeof envelope.code === 'string' ? envelope.code : envelope.code !== undefined ? String(envelope.code) : null);
    return {
      code,
      message: typeof envelope.message === 'string' ? envelope.message : '',
      ...(reason !== null && GOOGLE_THROTTLE_REASONS.has(reason) ? { throttled: true } : {}),
    };
  }
  return { code: null, message: '' };
}

/** The gateway slug of a provider HTTP status. */
export function slugOfStatus(status: number, throttled = false): GatewayProblemSlug {
  if (throttled || status === 429 || status === 503) return 'rate-limited';
  if (status === 401) return 'unreachable';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 413) return 'too-large';
  if (status >= 500) return 'unreachable';
  return 'bad-request';
}

/** The problem of a provider error answer. */
export function providerHttpError(
  provider: ProviderName,
  status: number,
  failure: ProviderFailure,
  retryAfter: number | null,
): ProviderError {
  const slug = slugOfStatus(status, failure.throttled);
  const label = PROVIDER_LABEL[provider];
  const text = failure.message ? `: ${truncate(failure.message)}` : '';
  const detail =
    slug === 'rate-limited'
      ? `${label} is throttling requests${text}`
      : status === 401
        ? `${label} refused the credential of the repository${text}`
        : `${label} answered ${status}${text}`;
  return new ProviderError(slug, detail, {
    provider,
    status,
    code: failure.code,
    ...(status === 401 ? { credentialInvalid: true } : {}),
    ...(slug === 'rate-limited' ? { retryAfter: retryAfter ?? 1 } : {}),
  });
}

/** A credential the adapter cannot use (missing, malformed, expired or refused by the token endpoint). */
export function credentialError(provider: ProviderName, detail: string, status: number | null = null, code: string | null = null): ProviderError {
  return new ProviderError('unreachable', detail, { provider, status, code, credentialInvalid: true });
}

/** A provider answer that does not have the documented shape. */
export function unexpectedAnswer(provider: ProviderName, what: string): ProviderError {
  return new ProviderError('unreachable', `${PROVIDER_LABEL[provider]} sent an unexpected answer (${what})`, { provider, status: null, code: null });
}

/** Provider messages end up in problem details: keep them short and on one line. */
export function truncate(text: string, max = 300): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

/** True when an error is a provider failure that means "the provider has no such item". */
export function isNotFound(error: unknown): boolean {
  return error instanceof GatewayError && error.slug === 'not-found';
}
