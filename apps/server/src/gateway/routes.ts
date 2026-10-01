// The `/v1` routes of the storage gateway (build plan D.5): one Fastify plugin, registered by
// `GatewayServerModule` on the run mode's own Fastify application. Every call is authenticated (bearer token and,
// with `tls.mode: mtls`, the client certificate), validated against the shared `gateway` schemas, logged as one
// JSON line `{event: 'gateway.call', ...}` and counted; problems are answered as `application/problem+json`.
import type { Readable } from 'node:stream';
import {
  AnchorWriteRequest,
  CopyWithinRequest,
  DataKeyRequest,
  EnsureFolderRequest,
  GoogleDriveRepositoryConfig,
  LinkRequest,
  ListRequest,
  M365RepositoryConfig,
  OAuthExchangeRequest,
  ObjectRequest,
  PutHeader,
  RegisterClientUploadRequest,
  RepositoryCredential,
  SealCredentialRequest,
  TestConnectionRequest,
  type CredentialKind,
  type GatewayCallerName,
  type GatewayRepository,
  type GatewayTenant,
  type ScopeRoot,
} from '@mscd/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { AdapterRegistry } from './adapters';
import type { AdapterContext, StorageAdapter } from './adapters/types';
import type { VaultStore } from './adapters/managed-vault/vault-store';
import { authenticate, callerName, type GatewayTokens } from './auth';
import { openCredential, sealCredential, type OpenedCredential } from './crypto/credentials';
import type { DataKey, DataKeyService } from './crypto/data-keys';
import { badRequest, forbidden, GatewayError, outsideRoot, unsupported } from './problems';

/** One `gateway.call` log line (D.5 "Audit of use"). */
export interface GatewayCallLogEntry {
  event: 'gateway.call';
  orgId: string | null;
  repositoryId: string | null;
  adapter: string | null;
  operation: string;
  callerCn: GatewayCallerName | null;
  outcome: string;
  latencyMs: number;
  requestId: string;
}

export interface GatewayRouteDeps {
  tlsMode: 'mtls' | 'off';
  tokens: GatewayTokens;
  dataKeys: DataKeyService;
  adapters: AdapterRegistry;
  /** The vault bucket for audit anchors; null when the Managed Vault is not enabled. */
  anchorStore: VaultStore | null;
  /** Days of governance retention for anchors when the bucket has object lock without a default rule. */
  anchorLockDays: number;
  log(entry: GatewayCallLogEntry): void;
}

interface CallRecord {
  operation: string;
  started: number;
  orgId: string | null;
  repositoryId: string | null;
  adapter: string | null;
  callerCn: GatewayCallerName | null;
  outcome: string | null;
}

/** Credential kinds each adapter accepts (D.2 `RepositoryCredential`, C.6 `storage_credential.kind`). */
const CREDENTIAL_KINDS: Readonly<Record<string, readonly CredentialKind[]>> = {
  managed_vault: [],
  m365: ['m365_certificate'],
  google_drive: ['google_service_account', 'oauth_refresh_token'],
  s3: ['s3_access_key'],
  smb: ['smb_account'],
  webdav: ['webdav_account'],
};

const OPERATIONS: Readonly<Record<string, string>> = {
  'POST /v1/keys/data-key': 'keys.data-key',
  'POST /v1/credentials/seal': 'credentials.seal',
  'POST /v1/credentials/oauth-exchange': 'credentials.oauth-exchange',
  'POST /v1/test-connection': 'test-connection',
  'POST /v1/list': 'list',
  'POST /v1/ensure-folder': 'ensure-folder',
  'PUT /v1/objects': 'objects.put',
  'POST /v1/link': 'link',
  'POST /v1/register-client-upload': 'register-client-upload',
  'POST /v1/stat': 'stat',
  'POST /v1/pin-version': 'pin-version',
  'POST /v1/open-url': 'open-url',
  'POST /v1/stream': 'stream',
  'POST /v1/copy-within': 'copy-within',
  'POST /v1/rehash': 'rehash',
  'POST /v1/anchors': 'anchors',
};

/** Largest `X-MSCD-Put` header value (base64 of the JSON descriptor). */
const PUT_HEADER_MAX = 65_536;

function parse<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue ? issue.path.map(String).join('.') : '';
    throw badRequest(`Invalid ${what}${path ? ` at ${path}` : ''}: ${issue?.message ?? 'not valid'}`);
  }
  return result.data;
}

/** The Fastify plugin with every `/v1` route. Register it with `{prefix: '/v1'}`. */
export function gatewayRoutes(deps: GatewayRouteDeps) {
  return async function plugin(fastify: FastifyInstance): Promise<void> {
    const calls = new WeakMap<FastifyRequest, CallRecord>();
    const callOf = (request: FastifyRequest): CallRecord => {
      let call = calls.get(request);
      if (!call) {
        const routeKey = `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0]}`;
        call = {
          operation: OPERATIONS[routeKey] ?? 'unknown',
          started: performance.now(),
          orgId: null,
          repositoryId: null,
          adapter: null,
          callerCn: null,
          outcome: null,
        };
        calls.set(request, call);
      }
      return call;
    };

    fastify.addHook('onRequest', async (request) => {
      const call = callOf(request);
      call.callerCn = callerName(request, deps.tlsMode);
      authenticate(request, deps.tokens);
    });

    fastify.addHook('onResponse', async (request, reply) => {
      const call = callOf(request);
      deps.log({
        event: 'gateway.call',
        orgId: call.orgId,
        repositoryId: call.repositoryId,
        adapter: call.adapter,
        operation: call.operation,
        callerCn: call.callerCn,
        outcome: call.outcome ?? (reply.statusCode < 400 ? 'ok' : 'error'),
        latencyMs: Math.round(performance.now() - call.started),
        requestId: String(request.id),
      });
    });

    fastify.setErrorHandler(async (error: FastifyError | GatewayError, request, reply) => {
      const problem = toGatewayError(error);
      callOf(request).outcome = problem.slug;
      // A refused upload is not read to its end: close the connection after the answer.
      if (!request.raw.complete) reply.header('connection', 'close');
      if (problem.slug === 'internal') request.log.error({ err: error }, 'Storage gateway call failed');
      if (problem.slug === 'rate-limited' && problem.extras.retryAfter !== undefined) {
        reply.header('retry-after', String(Math.max(0, Math.ceil(problem.extras.retryAfter))));
      }
      return reply.status(problem.status).type('application/problem+json').send(problem.toProblem(String(request.id)));
    });

    fastify.setNotFoundHandler(async (request, reply) => {
      const problem = new GatewayError('not-found', 'No such gateway operation');
      callOf(request).outcome = problem.slug;
      return reply.status(problem.status).type('application/problem+json').send(problem.toProblem(String(request.id)));
    });

    /** Abort signal of the request: fires when the caller goes away before the answer is complete. */
    const signalOf = (request: FastifyRequest, reply: FastifyReply): AbortSignal => {
      const controller = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      request.raw.once('aborted', () => controller.abort());
      return controller.signal;
    };

    /** Tenant data key, opened credential and adapter of a call that names a repository. */
    const prepare = async (
      request: FastifyRequest,
      reply: FastifyReply,
      tenant: GatewayTenant,
      repository: GatewayRepository,
      options: { credential?: { ref: string; sealedBlob: string; kind: CredentialKind } | null } = {},
    ): Promise<{ adapter: StorageAdapter; ctx: AdapterContext }> => {
      const call = callOf(request);
      call.orgId = tenant.orgId;
      call.repositoryId = repository.id;
      call.adapter = repository.adapter;
      const dataKey = await deps.dataKeys.unwrap(tenant.orgId, tenant.wrappedDek);
      // The binding check runs before anything else uses the repository (D-08).
      const sealed = options.credential === undefined ? repository.credential : options.credential;
      const credential = sealed ? openBoundCredential(dataKey, repository, sealed) : null;
      const adapter = deps.adapters.get(repository.adapter);
      adapter.validateConfig(tenant.orgId, repository.config);
      return { adapter, ctx: { orgId: tenant.orgId, dataKey, repository, credential, requestId: String(request.id), signal: signalOf(request, reply) } };
    };

    fastify.post('/keys/data-key', async (request) => {
      const body = parse(DataKeyRequest, request.body, 'request body');
      callOf(request).orgId = body.orgId;
      return deps.dataKeys.issue(body.orgId);
    });

    fastify.post('/credentials/seal', async (request) => {
      const body = parse(SealCredentialRequest, request.body, 'request body');
      const call = callOf(request);
      call.orgId = body.tenant.orgId;
      call.repositoryId = body.repository.id;
      call.adapter = body.repository.adapter;
      checkCredential(body.repository, body.kind, body.secret);
      const dataKey = await deps.dataKeys.unwrap(body.tenant.orgId, body.tenant.wrappedDek);
      return sealCredential(dataKey, body.repository, body.kind, body.secret);
    });

    fastify.post('/credentials/oauth-exchange', async (request, reply) => {
      const body = parse(OAuthExchangeRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository, { credential: body.credential });
      if (!adapter.exchangeOAuthCode) throw unsupported(`The ${adapter.adapter} adapter has no OAuth consent`);
      const output = await adapter.exchangeOAuthCode(ctx, { code: body.code, redirectUri: body.redirectUri, codeVerifier: body.codeVerifier });
      checkCredential(body.repository, 'oauth_refresh_token', output.secret, { allowRefreshToken: true });
      const sealedCredential = sealCredential(ctx.dataKey, body.repository, 'oauth_refresh_token', output.secret);
      return { ...sealedCredential, externalAccount: output.externalAccount };
    });

    fastify.post('/test-connection', async (request, reply) => {
      const body = parse(TestConnectionRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      const started = performance.now();
      const result = await adapter.testConnection(ctx);
      return { ...result, latencyMs: Math.round(performance.now() - started) };
    });

    fastify.post('/list', async (request, reply) => {
      const body = parse(ListRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      checkScopeRoot(body.repository, body.scopeRoot);
      return adapter.list(ctx, { scopeRoot: body.scopeRoot, folderPath: body.folderPath, pageToken: body.pageToken });
    });

    fastify.post('/ensure-folder', async (request, reply) => {
      const body = parse(EnsureFolderRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      return adapter.ensureFolder(ctx, body.path);
    });

    fastify.put('/objects', async (request, reply) => {
      const header = parse(PutHeader, decodePutHeader(request.headers['x-mscd-put']), 'X-MSCD-Put header');
      const { adapter, ctx } = await prepare(request, reply, header.tenant, header.repository);
      checkScopeRoot(header.repository, header.scopeRoot);
      if (!adapter.put) throw unsupported(`The ${adapter.adapter} adapter does not store files`);
      if (adapter.adapter !== 'managed_vault' && !header.repository.modes.includes('pass_through')) {
        throw unsupported('The repository does not accept pass-through uploads');
      }
      const length = Number(request.headers['content-length']);
      return adapter.put(ctx, {
        scopeRoot: header.scopeRoot,
        folderPath: header.folderPath,
        fileName: header.fileName,
        maxBytes: header.maxBytes,
        metadataMinimization: header.metadataMinimization,
        body: request.body as Readable,
        contentLength: Number.isSafeInteger(length) && length >= 0 && request.headers['content-length'] !== undefined ? length : null,
      });
    });

    fastify.post('/link', async (request, reply) => {
      const body = parse(LinkRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      checkScopeRoot(body.repository, body.scopeRoot);
      if (!adapter.link) throw unsupported(`The ${adapter.adapter} adapter does not link existing items`);
      return adapter.link(ctx, { scopeRoot: body.scopeRoot, externalItemId: body.externalItemId });
    });

    fastify.post('/register-client-upload', async (request, reply) => {
      const body = parse(RegisterClientUploadRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      checkScopeRoot(body.repository, body.scopeRoot);
      if (!adapter.registerClientUpload) throw unsupported(`The ${adapter.adapter} adapter has no zero-transit uploads`);
      return adapter.registerClientUpload(ctx, { scopeRoot: body.scopeRoot, externalItemId: body.externalItemId, intent: body.intent });
    });

    fastify.post('/stat', async (request, reply) => {
      const body = parse(ObjectRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      return adapter.stat(ctx, body.object);
    });

    fastify.post('/pin-version', async (request, reply) => {
      const body = parse(ObjectRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      return adapter.pinVersion ? adapter.pinVersion(ctx, body.object) : { result: 'unsupported' as const };
    });

    fastify.post('/open-url', async (request, reply) => {
      const body = parse(ObjectRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      if (!adapter.openUrl) throw unsupported(`The ${adapter.adapter} adapter has no provider URL`);
      return adapter.openUrl(ctx, body.object);
    });

    fastify.post('/stream', async (request, reply) => {
      const body = parse(ObjectRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      if (!adapter.stream) throw unsupported(`The ${adapter.adapter} adapter does not stream content`);
      const result = await adapter.stream(ctx, body.object);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(result.size));
      reply.header('x-mscd-detected-type', result.detectedType);
      return reply.send(result.stream);
    });

    fastify.post('/copy-within', async (request, reply) => {
      const body = parse(CopyWithinRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      return adapter.copyWithin(ctx, body.objects, body.targetFolderPath);
    });

    fastify.post('/rehash', async (request, reply) => {
      const body = parse(ObjectRequest, request.body, 'request body');
      const { adapter, ctx } = await prepare(request, reply, body.tenant, body.repository);
      if (!adapter.rehash) throw unsupported(`The ${adapter.adapter} adapter has no computed hashes`);
      return adapter.rehash(ctx, body.object);
    });

    fastify.post('/anchors', async (request) => {
      const body = parse(AnchorWriteRequest, request.body, 'request body');
      const call = callOf(request);
      // Only the worker writes anchors (D.5); without TLS (demo) there is no certificate name to check.
      if (deps.tlsMode === 'mtls' && call.callerCn !== 'mscd-worker') throw forbidden('Only the worker writes audit anchors', 'caller');
      if (!deps.anchorStore) throw unsupported('The Managed Vault bucket is not enabled in this gateway');
      call.adapter = 'managed_vault';
      return writeAnchor(deps.anchorStore, body.objectKey, body.body, deps.anchorLockDays);
    });
  };
}

/** Opens the call's credential with the binding check; a kind the adapter does not use is refused. */
function openBoundCredential(
  dataKey: DataKey,
  repository: GatewayRepository,
  sealed: { ref: string; sealedBlob: string; kind: CredentialKind },
): OpenedCredential {
  if (!(CREDENTIAL_KINDS[repository.adapter] ?? []).includes(sealed.kind)) {
    throw forbidden(`A ${sealed.kind} credential cannot be used with a ${repository.adapter} repository`, 'credential-kind');
  }
  return openCredential(dataKey, repository, sealed);
}

/** The repository config and the secret of a credential to seal (D.2 `RepositoryCredential`). */
function checkCredential(
  repository: GatewayRepository,
  kind: CredentialKind,
  secret: Record<string, unknown>,
  options: { allowRefreshToken?: boolean } = {},
): void {
  if (!(CREDENTIAL_KINDS[repository.adapter] ?? []).includes(kind)) {
    throw unsupported(`A ${repository.adapter} repository takes no ${kind} credential`);
  }
  if (repository.adapter === 'm365') parse(M365RepositoryConfig, repository.config, 'repository config');
  if (repository.adapter === 'google_drive') parse(GoogleDriveRepositoryConfig, repository.config, 'repository config');
  if (kind === 'oauth_refresh_token' && options.allowRefreshToken) {
    const { refreshToken, ...client } = secret;
    if (typeof refreshToken !== 'string' || refreshToken === '') throw badRequest('The OAuth exchange gave no refresh token');
    parse(RepositoryCredential, { kind, secret: client }, 'credential');
    return;
  }
  // A refresh token arrives only through the consent flow (D.2), never in a sealing request.
  if (['m365_certificate', 'google_service_account', 'oauth_refresh_token'].includes(kind)) parse(RepositoryCredential, { kind, secret }, 'credential');
}

/** The call's scope root must be the repository root or one of its per-system roots (D.5 root enforcement). */
function checkScopeRoot(repository: GatewayRepository, scopeRoot: ScopeRoot): void {
  const config = repository.config as { rootFolderId?: unknown; roots?: unknown };
  if (typeof config.rootFolderId !== 'string') return;
  if (scopeRoot.folderId === null) throw outsideRoot('The call names no folder of the repository');
  if (scopeRoot.folderId === config.rootFolderId) return;
  const roots = config.roots && typeof config.roots === 'object' ? Object.values(config.roots as Record<string, { folderId?: unknown }>) : [];
  if (!roots.some((root) => root?.folderId === scopeRoot.folderId)) throw outsideRoot('The scope root is not a root folder of this repository');
}

function decodePutHeader(value: string | string[] | undefined): unknown {
  if (typeof value !== 'string' || value === '') throw badRequest('The X-MSCD-Put header is missing');
  if (value.length > PUT_HEADER_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw badRequest('The X-MSCD-Put header is not base64');
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw badRequest('The X-MSCD-Put header is not base64 JSON');
  }
}

/** Writes a signed anchor under `audit-anchors/` and never overwrites one: a different body gets the next free name. */
async function writeAnchor(store: VaultStore, objectKey: string, body: Record<string, unknown>, lockDays: number): Promise<{ location: string }> {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  const stem = objectKey.slice(0, -'.json'.length);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const key = attempt === 1 ? objectKey : `${stem}-${attempt}.json`;
    if ((await store.putIfAbsent(key, bytes, 'application/json', lockDays)) === 'created') return { location: store.location(key) };
    const existing = await store.get(key);
    if (existing) {
      const chunks: Buffer[] = [];
      for await (const chunk of existing.body) chunks.push(Buffer.from(chunk as Buffer));
      if (Buffer.concat(chunks).equals(bytes)) return { location: store.location(key) };
    }
  }
  throw new GatewayError('internal', 'No free name for the audit anchor');
}

/** Any error of a route as a gateway problem. */
function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const fastifyError = error as Partial<FastifyError> | null;
  const code = fastifyError?.code ?? '';
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new GatewayError('too-large', 'The request body is too large');
  if (code.startsWith('FST_ERR_CTP_') || code === 'FST_ERR_VALIDATION' || fastifyError?.statusCode === 400 || fastifyError?.statusCode === 415) {
    return badRequest(fastifyError?.message ?? 'The request is not valid');
  }
  return new GatewayError('internal', fastifyError?.message ?? 'Internal error', {}, { cause: error });
}
