// Client of the storage gateway protocol for the api and the worker (build plan D.5, D-09): undici with the
// gateway token and, with `storage.gateway.tls.mode: mtls`, an agent that presents the run mode's client
// certificate (`CN=mscd-api` or `CN=mscd-worker`) and trusts only the installation CA. The URL must use https with
// mtls; plain http is accepted only with mode off (demo). Secret files are read when the first call needs them and
// the token on every call, so a rotated token (`keys rotate-gateway-token`) is used at once.
import { Readable } from 'node:stream';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { GATEWAY_PROBLEM_STATUS, GATEWAY_PROBLEM_SLUGS, type GatewayProblemReason, type GatewayProblemSlug, type ProblemSlug } from '@mscd/shared';
import { Agent, request, type Dispatcher } from 'undici';
import { ConfigError, MscdConfig } from '../../config/mscd-config';
import { currentRequestId } from '../../common/request-context';
import { ProblemError } from '../../common/problems';
import type { GatewayClient } from '../../common/tokens';

/** How the api answers when the gateway refuses a call (the gateway slug is kept on the error). */
const API_SLUG: Readonly<Record<GatewayProblemSlug, ProblemSlug>> = {
  'bad-request': 'internal',
  'not-found': 'not-found',
  'forbidden': 'forbidden',
  'outside-root': 'business-rule',
  'unreachable': 'dependency-unavailable',
  'rate-limited': 'rate-limited',
  'unsupported': 'business-rule',
  'too-large': 'payload-too-large',
  'internal': 'dependency-unavailable',
};

/** A problem answered by the gateway. `gatewaySlug` and `reason` say why; the api status follows `API_SLUG`. */
export class GatewayProblemError extends ProblemError {
  constructor(
    readonly gatewaySlug: GatewayProblemSlug,
    readonly gatewayStatus: number,
    readonly gatewayDetail: string | undefined,
    readonly reason: GatewayProblemReason | undefined,
    retryAfter: number | undefined,
  ) {
    super(API_SLUG[gatewaySlug], {
      detail: gatewayDetail ? `Storage gateway: ${gatewayDetail}` : `Storage gateway answered ${gatewaySlug}`,
      messageKey: `storage.gateway.${gatewaySlug}`,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
  }
}

/** The gateway cannot be reached (connection refused, TLS failure, timeout): 503 `dependency-unavailable`. */
export class GatewayUnavailableError extends ProblemError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super('dependency-unavailable', { detail: `Storage gateway unavailable: ${detail}`, messageKey: 'storage.gateway.unavailable' }, options);
  }
}

export interface GatewayEndpoint {
  url: string;
  tlsMode: 'mtls' | 'off';
}

/** The gateway base URL, checked against the TLS mode (an http URL with mtls would send the token in clear text). */
export function checkGatewayEndpoint(endpoint: GatewayEndpoint): URL {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new ConfigError(`storage.gateway.url ${endpoint.url} is not a URL`);
  }
  if (endpoint.tlsMode === 'mtls' && url.protocol !== 'https:') {
    throw new ConfigError('storage.gateway.url must use https with storage.gateway.tls.mode mtls');
  }
  if (endpoint.tlsMode === 'off' && url.protocol !== 'http:') {
    throw new ConfigError('storage.gateway.url must use http with storage.gateway.tls.mode off');
  }
  return url;
}

interface CallOptions {
  requestId?: string;
  signal?: AbortSignal;
}

const JSON_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 300_000;

/** Parses the problem document of a failed gateway answer. */
function problemOf(status: number, text: string): GatewayProblemError {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Not a problem document: fall back to the status.
  }
  const type = typeof body.type === 'string' ? body.type : '';
  const fromType = type.slice(type.lastIndexOf('/') + 1);
  const slug: GatewayProblemSlug = (GATEWAY_PROBLEM_SLUGS as readonly string[]).includes(fromType)
    ? (fromType as GatewayProblemSlug)
    : ((Object.entries(GATEWAY_PROBLEM_STATUS).find(([, code]) => code === status)?.[0] as GatewayProblemSlug | undefined) ?? 'internal');
  const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : undefined;
  const reason = typeof body.reason === 'string' ? (body.reason as GatewayProblemReason) : undefined;
  const detail = typeof body.detail === 'string' ? body.detail : undefined;
  return new GatewayProblemError(slug, status, detail, reason, retryAfter);
}

/** `GATEWAY_CLIENT` of the api and worker. */
@Injectable()
export class HttpGatewayClient implements GatewayClient, OnApplicationShutdown {
  private base: URL | null = null;
  private dispatcher: Dispatcher | undefined;
  private prepared = false;

  constructor(private readonly config: MscdConfig) {}

  async post<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
    const response = await this.call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: JSON_TIMEOUT_MS,
      ...options,
    });
    return (await response.body.json()) as T;
  }

  async putObject<T>(header: unknown, body: Readable, options: CallOptions = {}): Promise<T> {
    const response = await this.call('/v1/objects', {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-mscd-put': Buffer.from(JSON.stringify(header), 'utf8').toString('base64'),
      },
      body,
      timeoutMs: STREAM_TIMEOUT_MS,
      ...options,
    });
    return (await response.body.json()) as T;
  }

  async stream(body: unknown, options: CallOptions = {}): Promise<{ stream: Readable; size: number | null; detectedType: string }> {
    const response = await this.call('/v1/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: STREAM_TIMEOUT_MS,
      ...options,
    });
    const length = Number(response.headers['content-length']);
    const type = response.headers['x-mscd-detected-type'];
    return {
      stream: response.body as unknown as Readable,
      size: Number.isSafeInteger(length) && length >= 0 ? length : null,
      detectedType: typeof type === 'string' && type !== '' ? type : 'application/octet-stream',
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher?.close().catch(() => undefined);
    this.dispatcher = undefined;
    this.prepared = false;
  }

  /** Base URL and TLS agent, made on the first call (the api starts without reading the gateway secrets). */
  private prepare(): URL {
    if (this.prepared && this.base) return this.base;
    const gateway = this.config.profile.storage.gateway;
    const base = checkGatewayEndpoint({ url: gateway.url, tlsMode: gateway.tls.mode });
    if (gateway.tls.mode === 'mtls') {
      const read = (file: string | null, key: string) => {
        if (file === null) throw new ConfigError(`storage.gateway.tls.${key} is required with mode mtls`);
        return this.config.readSecretFile(file, `storage.gateway.tls.${key}`);
      };
      this.dispatcher = new Agent({
        connect: { ca: read(gateway.tls.ca_file, 'ca_file'), cert: read(gateway.tls.cert_file, 'cert_file'), key: read(gateway.tls.key_file, 'key_file') },
      });
    }
    this.base = base;
    this.prepared = true;
    return base;
  }

  private async call(
    path: string,
    init: {
      method: 'POST' | 'PUT';
      headers: Record<string, string>;
      body: string | Readable;
      timeoutMs: number;
      requestId?: string;
      signal?: AbortSignal;
    },
  ): Promise<Dispatcher.ResponseData> {
    if (!path.startsWith('/v1/')) throw new Error(`Gateway paths start with /v1/: ${path}`);
    const base = this.prepare();
    const url = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base);
    const token = this.config.readSecretFile(this.config.profile.storage.gateway.token_file, 'storage.gateway.token_file');
    const requestId = init.requestId ?? currentRequestId();
    // JSON calls have a deadline; streamed calls are limited by idle timeouts only, so a large file is not cut.
    const streamed = init.body instanceof Readable || path === '/v1/stream';
    const signals = [...(streamed ? [] : [AbortSignal.timeout(init.timeoutMs)]), ...(init.signal ? [init.signal] : [])];
    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: init.method,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          accept: 'application/json, application/octet-stream',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: init.body,
        dispatcher: this.dispatcher,
        headersTimeout: init.timeoutMs,
        bodyTimeout: init.timeoutMs,
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });
    } catch (error) {
      if (init.body instanceof Readable) init.body.destroy();
      throw new GatewayUnavailableError(`${init.method} ${path}: ${(error as Error).message}`, { cause: error });
    }
    if (response.statusCode >= 200 && response.statusCode < 300) return response;
    const text = await response.body.text().catch(() => '');
    throw problemOf(response.statusCode, text);
  }
}
