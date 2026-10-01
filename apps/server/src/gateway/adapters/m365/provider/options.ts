// Options shared by the Microsoft 365 and Google Drive adapters (WP-15). Production uses the defaults; tests
// replace the HTTP dispatcher (an undici MockAgent), the clock, the waits and the upload chunk size.
import { setTimeout as sleepFor } from 'node:timers/promises';
import type { Dispatcher } from 'undici';
import { VERSION } from '../../../../generated/build-info';
import { GatewayError } from '../../../problems';
import type { RetryPolicy } from './http';
import type { TokenCache } from './token-cache';

/** Pass-through uploads up to this size use one request; larger ones an upload session (D.5). */
export const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export interface CopyPollOptions {
  initialMs: number;
  maxMs: number;
  timeoutMs: number;
}

export const DEFAULT_COPY_POLL: CopyPollOptions = { initialMs: 250, maxMs: 5000, timeoutMs: 120_000 };

/** Timeout of one upload request (a fragment of several MiB) or download. */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000;

export interface ProviderAdapterOptions {
  /** HTTP dispatcher of every provider request; default a proxy-aware undici agent. */
  dispatcher?: Dispatcher;
  retry?: Partial<RetryPolicy>;
  /** Waits between retries and copy polls. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Fragment size of upload sessions; a multiple of 320 KiB (Microsoft 365) or 256 KiB (Google Drive). */
  uploadChunkBytes?: number;
  copyPoll?: Partial<CopyPollOptions>;
  /** Token cache (one per adapter by default). */
  tokenCache?: TokenCache;
}

/** `User-Agent` of provider requests; Microsoft asks ISVs to decorate traffic as `ISV|Company|App/Version`. */
export const USER_AGENT = `ISV|CyberLentera|MSCD-StorageGateway/${VERSION}`;

/** A chunk size option checked against the provider's multiple. */
export function chunkSize(value: number | undefined, fallback: number, multiple: number, label: string): number {
  const size = value ?? fallback;
  if (!Number.isSafeInteger(size) || size <= 0 || size % multiple !== 0) {
    throw new Error(`${label} upload chunks must be a positive multiple of ${multiple} bytes`);
  }
  return size;
}

/** Waits `ms`; a cancelled call ends the wait with a `bad-request` problem. */
export async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleepFor(Math.max(0, ms), undefined, { signal });
  } catch {
    throw new GatewayError('bad-request', 'The call was cancelled by the caller');
  }
}
