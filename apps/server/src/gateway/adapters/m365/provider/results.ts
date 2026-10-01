// Results the provider adapters build from failures (build plan D.5, E.4, TS 5.7, WP-15): the `stat` outcome of a
// failed check, and the `test-connection` status of a failed connection test. Both never throw for provider
// states; programming errors and bad requests still do.
import type { OwnershipType, StatResult, TestConnectionResponse } from '@mscd/shared';
import { GatewayError } from '../../../problems';
import { PROVIDER_LABEL, ProviderError, type ProviderName } from './errors';

/** True for the problems that mean the repository credential cannot be used. */
export function isCredentialProblem(error: unknown): boolean {
  if (error instanceof ProviderError && error.credentialInvalid) return true;
  return error instanceof GatewayError && error.slug === 'forbidden' && (error.extras.reason === 'credential-missing' || error.extras.reason === 'credential-kind');
}

/**
 * The `stat` outcome of a failed check (E.4): missing items are `not_found`, items outside the repository root are
 * `forbidden` (the gateway refuses to read them), credential problems are `unreachable` with
 * `detail: credential_invalid`, throttling is `rate_limited` with the provider's `Retry-After`.
 */
export function statFailure(error: unknown): StatResult {
  if (!(error instanceof GatewayError)) throw error;
  if (isCredentialProblem(error)) return { outcome: 'unreachable', detail: 'credential_invalid', pinnedVersionAvailable: false };
  switch (error.slug) {
    case 'not-found':
      return { outcome: 'not_found', pinnedVersionAvailable: false };
    case 'forbidden':
    case 'outside-root':
      return { outcome: 'forbidden', pinnedVersionAvailable: false };
    case 'rate-limited':
      return { outcome: 'rate_limited', pinnedVersionAvailable: false, retryAfterSeconds: Math.max(0, Math.ceil(error.extras.retryAfter ?? 1)) };
    case 'unreachable':
      return { outcome: 'unreachable', pinnedVersionAvailable: false };
    default:
      throw error;
  }
}

type ConnectionResult = Omit<TestConnectionResponse, 'latencyMs'>;

/** The `test-connection` answer of a failed test (TS 5.7): refused credentials are `revoked`, throttling `degraded`. */
export function connectionFailure(
  error: unknown,
  provider: ProviderName,
  ownership: OwnershipType,
  credentialExpiresAt?: string,
): ConnectionResult {
  if (!(error instanceof GatewayError)) throw error;
  const label = PROVIDER_LABEL[provider];
  const detail = error.message;
  const base = { permissions: [] as string[], ownership, ...(credentialExpiresAt ? { credentialExpiresAt } : {}) };
  if (error.slug === 'forbidden' && error.extras.reason === 'credential-missing') {
    return { ...base, status: 'failed', message: { en: detail, id: 'Kredensial repositori belum diatur atau belum lengkap' } };
  }
  if (isCredentialProblem(error)) {
    return { ...base, status: 'revoked', message: { en: `The repository credential cannot be used: ${detail}`, id: `Kredensial repositori tidak dapat digunakan: ${detail}` } };
  }
  switch (error.slug) {
    case 'rate-limited':
      return { ...base, status: 'degraded', message: { en: `${label} is throttling requests; the test will be repeated`, id: `${label} sedang membatasi permintaan; pengujian akan diulang` } };
    case 'forbidden':
    case 'outside-root':
      return { ...base, status: 'failed', message: { en: `Access denied: ${detail}`, id: `Akses ditolak: ${detail}` } };
    case 'not-found':
      return { ...base, status: 'failed', message: { en: `Not found: ${detail}`, id: `Tidak ditemukan: ${detail}` } };
    case 'unreachable':
      return { ...base, status: 'failed', message: { en: `${label} cannot be reached: ${detail}`, id: `${label} tidak dapat dijangkau: ${detail}` } };
    default:
      return { ...base, status: 'failed', message: { en: `Connection test failed: ${detail}`, id: `Uji koneksi gagal: ${detail}` } };
  }
}
