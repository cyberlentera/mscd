// Streamed `PUT /v1/objects` with the upload's length (build plan D.5, WP-15 handoff deviation 6). Microsoft 365
// upload sessions above 4 MiB need the total size up front, which the gateway reads from `Content-Length`. The
// shared `GATEWAY_CLIENT.putObject` (WP-13) sends the body chunked, so this client, used only by the upload content
// route, makes the same call with the browser's `Content-Length`. It reuses the gateway settings, the token file and
// the mTLS agent exactly as `HttpGatewayClient` builds them, and maps refusals to the same `GatewayProblemError`.
import type { Readable } from 'node:stream';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { GATEWAY_PROBLEM_SLUGS, GATEWAY_PROBLEM_STATUS, type GatewayProblemReason, type GatewayProblemSlug, type PutHeader, type PutResult } from '@mscd/shared';
import { Agent, request, type Dispatcher } from 'undici';
import { currentRequestId } from '../../common/request-context';
import { GATEWAY_CLIENT, type GatewayClient } from '../../common/tokens';
import { ConfigError, MscdConfig } from '../../config/mscd-config';
import { checkGatewayEndpoint, GatewayProblemError, GatewayUnavailableError, HttpGatewayClient } from '../storage';

const STREAM_TIMEOUT_MS = 300_000;

/** The problem document of a failed gateway answer, as `HttpGatewayClient` reads it. */
function problemOf(status: number, text: string): GatewayProblemError {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Not a problem document: the status decides.
  }
  const type = typeof body.type === 'string' ? body.type : '';
  const fromType = type.slice(type.lastIndexOf('/') + 1);
  const slug: GatewayProblemSlug = (GATEWAY_PROBLEM_SLUGS as readonly string[]).includes(fromType)
    ? (fromType as GatewayProblemSlug)
    : ((Object.entries(GATEWAY_PROBLEM_STATUS).find(([, code]) => code === status)?.[0] as GatewayProblemSlug | undefined) ?? 'internal');
  return new GatewayProblemError(
    slug,
    status,
    typeof body.detail === 'string' ? body.detail : undefined,
    typeof body.reason === 'string' ? (body.reason as GatewayProblemReason) : undefined,
    typeof body.retryAfter === 'number' ? body.retryAfter : undefined,
  );
}

@Injectable()
export class GatewayUpload implements OnApplicationShutdown {
  private dispatcher: Dispatcher | undefined;
  private base: URL | null = null;

  constructor(
    private readonly config: MscdConfig,
    @Inject(GATEWAY_CLIENT) private readonly client: GatewayClient,
  ) {}

  /**
   * `PUT /v1/objects`. With a known length the body is sent with `Content-Length`; without one (a chunked browser
   * upload) the call goes through the shared client. A test double of `GATEWAY_CLIENT` is always used as it is.
   */
  async put(header: PutHeader, body: Readable, contentLength: number | null): Promise<PutResult> {
    if (contentLength === null || !(this.client instanceof HttpGatewayClient)) return this.client.putObject<PutResult>(header, body);
    const base = this.prepare();
    const url = new URL(`${base.pathname.replace(/\/+$/, '')}/v1/objects`, base);
    const gateway = this.config.profile.storage.gateway;
    const token = this.config.readSecretFile(gateway.token_file, 'storage.gateway.token_file');
    const requestId = currentRequestId();
    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(contentLength),
          'x-mscd-put': Buffer.from(JSON.stringify(header), 'utf8').toString('base64'),
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body,
        dispatcher: this.dispatcher,
        headersTimeout: STREAM_TIMEOUT_MS,
        bodyTimeout: STREAM_TIMEOUT_MS,
      });
    } catch (error) {
      body.destroy();
      throw new GatewayUnavailableError(`PUT /v1/objects: ${(error as Error).message}`, { cause: error });
    }
    if (response.statusCode >= 200 && response.statusCode < 300) return (await response.body.json()) as PutResult;
    const text = await response.body.text().catch(() => '');
    throw problemOf(response.statusCode, text);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher?.close().catch(() => undefined);
    this.dispatcher = undefined;
    this.base = null;
  }

  private prepare(): URL {
    if (this.base) return this.base;
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
    return base;
  }
}
