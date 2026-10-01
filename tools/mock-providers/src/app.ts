import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { AdminApi } from './admin.js';
import { requestPrincipal } from './auth.js';
import { DriveApi } from './drive.js';
import { type Api, MockHttpError, entraError, genericError, googleError, googleOAuthError, graphError } from './errors.js';
import { type FixtureDocument, applyFixtures, parseFixtureDocument, parseSettings } from './fixtures.js';
import { GraphApi } from './graph.js';
import { apiOf, header, rawPath } from './http.js';
import { registerIdentityRoutes } from './identity.js';
import { newRequestId } from './ids.js';
import { DEFAULT_SETTINGS, type MockSettings, MockState, PROVIDER_APIS, type ProviderApi, type ThrottleState } from './state.js';

export interface MockProvidersOptions {
  /** Fixture document (parsed JSON), loaded at start and by every `POST /_admin/reset` without a body. */
  fixtures?: unknown;
  /**
   * Origin written into generated links (upload URLs, copy monitors, `@odata.nextLink`, download URLs, resumable
   * session URLs). Default: the scheme and Host header of each request.
   */
  publicUrl?: string;
  /** Overrides of the default settings (token lifetime, simple upload limit, copy polls, page sizes). */
  settings?: Partial<MockSettings>;
  /** Receives one line per request: method, path without query, status and duration. */
  onRequestLog?: (line: string) => void;
}

export interface StartOptions extends MockProvidersOptions {
  /** TCP port; 0 picks a free port. Default 0. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
}

export interface RunningMockProviders {
  app: FastifyInstance;
  /** Base URL, for example http://127.0.0.1:4310 */
  url: string;
  port: number;
  close(): Promise<void>;
}

const BODY_LIMIT = 256 * 1024 * 1024;

function throttleError(api: ProviderApi, path: string, throttle: ThrottleState): MockHttpError {
  const headers = { 'Retry-After': String(throttle.retryAfterSeconds) };
  const status = throttle.statusCode;
  if (api === 'graph') {
    const requestId = newRequestId();
    return new MockHttpError(
      status,
      {
        error: {
          code: status === 429 ? 'TooManyRequests' : 'serviceNotAvailable',
          innerError: {
            code: String(status),
            date: new Date().toISOString().slice(0, 19),
            message: 'Please retry after',
            'request-id': requestId,
            status: String(status),
          },
          message: 'Please retry again later.',
        },
      },
      { ...headers, 'request-id': requestId },
    );
  }
  if (api === 'drive') {
    return status === 429
      ? googleError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', { domain: 'usageLimits', headers })
      : googleError(503, 'backendError', 'Backend Error', { headers });
  }
  const error = /\/oauth2\/v2\.0\/token$/.test(path)
    ? entraError(status, 'temporarily_unavailable', 50196, 'The server is temporarily unable to handle the request. Retry after the delay in Retry-After.')
    : googleOAuthError(status, 'temporarily_unavailable', 'Rate limit exceeded. Retry after the delay in Retry-After.');
  return new MockHttpError(error.statusCode, error.body, headers);
}

/** Builds the mock providers application (not listening). Throws `FixtureError` for invalid fixtures. */
export function buildMockProviders(options: MockProvidersOptions = {}): FastifyInstance {
  let baseFixtures: FixtureDocument | undefined = options.fixtures === undefined ? undefined : parseFixtureDocument(options.fixtures);
  const settings = options.settings ? parseSettings(options.settings) : {};
  const state = new MockState({ ...DEFAULT_SETTINGS, ...settings });
  if (baseFixtures) applyFixtures(state, baseFixtures);

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, routerOptions: { maxParamLength: 2048 } });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    state.purgeExpired();
    const path = rawPath(request);
    const api = apiOf(path);
    if (!PROVIDER_APIS.includes(api as ProviderApi)) return;
    const latency = state.latency;
    if (latency && latency.apis.includes(api as ProviderApi)) await sleep(latency.ms);
    const throttle = state.throttle;
    if (throttle && throttle.remaining > 0 && throttle.apis.includes(api as ProviderApi)) {
      throttle.remaining -= 1;
      if (throttle.remaining === 0) state.throttle = null;
      const error = throttleError(api as ProviderApi, path, throttle);
      reply.code(error.statusCode).headers(error.headers).send(error.body);
      return reply;
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const path = rawPath(request);
    const api: Api = apiOf(path);
    const durationMs = Math.round(reply.elapsedTime);
    if (api !== 'admin') {
      state.logRequest({
        at: new Date().toISOString(),
        api,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs,
        principal: requestPrincipal(request),
        authorization: Boolean(header(request, 'authorization')),
      });
    }
    options.onRequestLog?.(`${request.method} ${path} ${reply.statusCode} ${durationMs}ms`);
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof MockHttpError) return reply.code(error.statusCode).headers(error.headers).send(error.body);
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500) process.stderr.write(`mock-providers: ${request.method} ${request.url}: ${error.stack ?? error.message}\n`);
    const message = status === 413 ? 'The request body is too large.' : status >= 500 ? 'Internal error in the mock providers.' : error.message;
    const mapped = genericError(apiOf(rawPath(request)), status, message);
    return reply.code(status).headers(mapped.headers).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = rawPath(request);
    const api = apiOf(path);
    const error =
      api === 'graph'
        ? graphError(400, 'invalidRequest', `Unsupported resource path "${path}".`)
        : genericError(api, 404, `No route for ${request.method} ${path}.`);
    return reply.code(error.statusCode).headers(error.headers).send(error.body);
  });

  registerIdentityRoutes(app, { state, publicUrl: options.publicUrl });
  new GraphApi({ state, publicUrl: options.publicUrl }).register(app);
  new DriveApi({ state, publicUrl: options.publicUrl }).register(app);
  new AdminApi({
    state,
    getBaseFixtures: () => baseFixtures,
    setBaseFixtures: (document) => {
      baseFixtures = document;
    },
  }).register(app);

  return app;
}

/** Builds the application and listens; `url` is the base URL to give adapters and tests. */
export async function startMockProviders(options: StartOptions = {}): Promise<RunningMockProviders> {
  const app = buildMockProviders(options);
  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return { app, url: `http://${urlHost}:${port}`, port, close: () => app.close() };
}
