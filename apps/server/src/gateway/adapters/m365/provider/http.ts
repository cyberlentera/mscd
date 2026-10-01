// HTTP client of the provider adapters (build plan A.1 "Provider HTTP", D.5, E.4, I.1, WP-15): undici `fetch`
// against the configured base URLs, with
// - the egress policy checked before every request, redirects never followed automatically;
// - a per-request timeout combined with the caller's abort signal;
// - retries with exponential backoff and jitter: throttling answers (429, 503, and what the adapter's error parser
//   marks as throttling) are retried after `Retry-After` while the wait stays short, other 5xx answers and network
//   failures only for idempotent requests;
// - error answers read (bounded) and turned into `ProviderError` through the adapter's error parser.
// Shared by the Microsoft 365 and Google Drive adapters.
import { setTimeout as sleepFor } from 'node:timers/promises';
import { EnvHttpProxyAgent, fetch, type Dispatcher, type Response } from 'undici';
import { GatewayError } from '../../../problems';
import type { EgressPolicy } from './egress';
import { PROVIDER_LABEL, ProviderError, providerHttpError, truncate, type ProviderFailure, type ProviderName } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RetryPolicy {
  /** Attempts in total, including the first. */
  maxAttempts: number;
  /** First backoff delay; doubled per attempt. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Longest `Retry-After` the adapter waits for inside one gateway call; longer waits surface as rate-limited. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 4000, maxRetryAfterMs: 10_000 };

/** Default timeout of one request (API calls); uploads of large fragments pass their own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Error bodies are read up to this size for the problem detail. */
const ERROR_BODY_LIMIT = 64 * 1024;

const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

export interface ProviderRequest {
  method: HttpMethod;
  url: URL;
  /** `api`: must lie under a configured base URL; `issued`: a URL the provider handed out. Default `api`. */
  target?: 'api' | 'issued';
  headers?: Record<string, string>;
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** Form body (sets Content-Type). */
  form?: URLSearchParams;
  /** Raw body; must be repeatable (never a stream), so retries can send it again. */
  body?: Buffer | string;
  /** Safe to repeat after a network failure or a 5xx answer. Default: GET, PUT and DELETE. */
  idempotent?: boolean;
  /** Statuses returned to the caller instead of being turned into errors (2xx always are). */
  accept?: readonly number[];
  /** The caller's signal (the gateway call). */
  signal: AbortSignal;
  timeoutMs?: number;
  /** What the request does, for problem details ("reading item X"). */
  what?: string;
}

export interface ProviderHttpOptions {
  provider: ProviderName;
  egress: EgressPolicy;
  /** Error parser of the provider's error envelope. */
  parseError: (status: number, body: unknown) => ProviderFailure;
  userAgent: string;
  /** Default: a proxy-aware agent (HTTP_PROXY, HTTPS_PROXY, NO_PROXY) shared by the adapter. */
  dispatcher?: Dispatcher;
  retry?: Partial<RetryPolicy>;
  /** Waits between attempts (tests replace it). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

/** Seconds of a `Retry-After` header (delta seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text), 86_400);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // A body cut short still explains the status.
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return cause.code;
  return truncate((error as Error)?.message ?? 'network error', 120);
}

/** Discards a response body so the connection can be reused. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export class ProviderHttp {
  readonly provider: ProviderName;
  readonly egress: EgressPolicy;
  private readonly retry: RetryPolicy;
  private readonly dispatcher: Dispatcher;
  private readonly ownsDispatcher: boolean;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ProviderHttpOptions) {
    this.provider = options.provider;
    this.egress = options.egress;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.ownsDispatcher = options.dispatcher === undefined;
    this.dispatcher = options.dispatcher ?? new EnvHttpProxyAgent({ connect: { timeout: 10_000 }, keepAliveTimeout: 30_000 });
    this.sleep = options.sleep ?? ((ms, signal) => sleepFor(ms, undefined, { signal }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get label(): string {
    return PROVIDER_LABEL[this.provider];
  }

  /**
   * Sends a request with retries. Returns 2xx answers and the statuses in `accept`; every other answer becomes a
   * `ProviderError`. The caller reads or discards the returned body.
   */
  async send(request: ProviderRequest): Promise<Response> {
    const idempotent = request.idempotent ?? IDEMPOTENT_METHODS.has(request.method);
    const headers: Record<string, string> = { 'user-agent': this.options.userAgent, accept: 'application/json', ...request.headers };
    let body: string | Buffer | undefined = request.body;
    if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      headers['content-type'] = 'application/json';
    } else if (request.form !== undefined) {
      body = request.form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    for (let attempt = 1; ; attempt += 1) {
      this.egress.assertAllowed(request.url, request.target ?? 'api');
      if (request.signal.aborted) throw cancelled();
      // The timeout covers sending the request and waiting for the answer's headers; a body (a download) is read
      // without a deadline, bounded by the dispatcher's idle timeout and the caller's signal.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), request.timeoutMs ?? this.timeoutMs);
      const signal = AbortSignal.any([request.signal, timeout.signal]);
      let response: Response;
      try {
        response = await fetch(request.url, { method: request.method, headers, body, redirect: 'manual', signal, dispatcher: this.dispatcher });
      } catch (error) {
        if (request.signal.aborted) throw cancelled();
        if (idempotent && attempt < this.retry.maxAttempts) {
          await this.wait(this.backoff(attempt), request.signal);
          continue;
        }
        const reason = timeout.signal.aborted ? 'timed out' : describeNetworkError(error);
        throw new ProviderError(
          'unreachable',
          `${this.label} could not be reached${request.what ? ` while ${request.what}` : ''} (${reason})`,
          { provider: this.provider, status: null, code: null },
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }
      if ((response.status >= 200 && response.status < 300) || request.accept?.includes(response.status)) return response;

      const text = await readBounded(response, ERROR_BODY_LIMIT);
      const failure = this.options.parseError(response.status, parseJson(text));
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      const throttled = failure.throttled === true || response.status === 429 || response.status === 503;
      if (throttled && attempt < this.retry.maxAttempts) {
        // A throttled request was not carried out, so even a POST may be sent again; a 503 only when idempotent.
        const repeatable = idempotent || response.status === 429 || failure.throttled === true;
        const wait = retryAfter !== null ? retryAfter * 1000 : this.backoff(attempt);
        if (repeatable && wait <= this.retry.maxRetryAfterMs) {
          await this.wait(wait, request.signal);
          continue;
        }
      } else if (!throttled && response.status >= 500 && idempotent && attempt < this.retry.maxAttempts) {
        await this.wait(this.backoff(attempt), request.signal);
        continue;
      }
      throw providerHttpError(this.provider, response.status, failure, retryAfter);
    }
  }

  /** Sends a request and parses the JSON answer. */
  async json<T = unknown>(request: ProviderRequest): Promise<T> {
    const response = await this.send(request);
    return (await readJson(response, this.provider)) as T;
  }

  async close(): Promise<void> {
    if (this.ownsDispatcher) await this.dispatcher.close().catch(() => undefined);
  }

  private backoff(attempt: number): number {
    const exponential = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await this.sleep(Math.max(0, ms), signal);
    } catch {
      throw cancelled();
    }
  }
}

/** Reads a JSON answer; an empty or malformed body is an unexpected answer. */
export async function readJson(response: Response, provider: ProviderName): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('unreachable', `${PROVIDER_LABEL[provider]} sent an answer that is not JSON`, {
      provider,
      status: response.status,
      code: null,
    });
  }
}

function cancelled(): GatewayError {
  return new GatewayError('bad-request', 'The call was cancelled by the caller');
}
