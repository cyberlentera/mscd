import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashContent, isGoogleNative } from './content.js';
import { adminError } from './errors.js';
import {
  type CredentialFixture,
  type FixtureDocument,
  FixtureError,
  applyFixtures,
  ensureFolderPath,
  parseFixtureDocument,
  parseSettings,
  toPerson,
} from './fixtures.js';
import { anyJsonBody, queryOf } from './http.js';
import { mintAuthCode } from './identity.js';
import { isDriveId, isGraphId, isGraphVersionId } from './ids.js';
import { type ItemState, MockState, PROVIDER_APIS, type ProviderApi } from './state.js';

// Admin API for tests and the demo (build plan J.7). Never exposed outside test and demo installations.
//
//   GET  /_admin/health                         POST /_admin/reset [fixture document]   POST /_admin/fixtures <document>
//   GET  /_admin/state                          GET|POST /_admin/settings
//   GET|POST /_admin/credentials                POST /_admin/oauth/codes
//   POST /_admin/items                          GET /_admin/items/{id}
//   POST /_admin/items/{id}/move | /new-version | /delete | /purge-version | /corrupt-hash
//   POST /_admin/drives/{id}/forbid             POST /_admin/tokens/revoke
//   POST /_admin/throttle                       POST /_admin/latency
//   GET|DELETE /_admin/requests

export interface AdminContext {
  state: MockState;
  getBaseFixtures(): FixtureDocument | undefined;
  setBaseFixtures(document: FixtureDocument | undefined): void;
}

type Body = Record<string, unknown>;

function bad(message: string, details?: string[]) {
  return adminError(400, 'bad_request', message, details);
}

function objectBody(request: FastifyRequest): Body {
  const body = anyJsonBody(request, 'admin');
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  return body as Body;
}

function optionalString(body: Body, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value === '') throw bad(`${key} must be a non-empty string.`);
  return value;
}

function optionalInteger(body: Body, key: string, min: number, max: number): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(`${key} must be an integer from ${min} to ${max}.`);
  return value;
}

function optionalBoolean(body: Body, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw bad(`${key} must be true or false.`);
  return value;
}

function apisOf(body: Body, fallback: readonly ProviderApi[]): ProviderApi[] {
  const value = body.apis;
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || value.some((api) => !PROVIDER_APIS.includes(api as ProviderApi))) {
    throw bad(`apis must be a non-empty list of ${PROVIDER_APIS.join(', ')}.`);
  }
  return [...new Set(value as ProviderApi[])];
}

function fixtureFailure(error: unknown): never {
  if (error instanceof FixtureError) throw bad('The fixtures are invalid.', error.problems);
  throw error;
}

export function itemView(state: MockState, item: ItemState): Record<string, unknown> {
  const parent = item.parentId ? state.item(item.parentId) : undefined;
  const current = state.currentVersion(item);
  return {
    id: item.id,
    provider: item.provider,
    driveId: item.driveId,
    parentId: item.parentId,
    folderPath: parent ? `/${state.pathNames(parent).join('/')}` : null,
    name: item.name,
    kind: item.isFolder ? 'folder' : 'file',
    mimeType: item.mimeType,
    description: item.description,
    createdAt: item.createdAt,
    createdBy: item.createdBy,
    modifiedAt: current && !item.isFolder ? current.modifiedAt : item.modifiedAt,
    trashed: item.trashed,
    currentVersionId: current && !item.isFolder ? current.id : null,
    versions: item.versions.map((version) => ({
      id: version.id,
      modifiedAt: version.modifiedAt,
      modifiedBy: version.modifiedBy,
      size: version.size,
      quickXorHash: version.quickXorHash,
      sha256: version.sha256,
      md5: version.md5,
      keepForever: version.keepForever,
    })),
  };
}

export class AdminApi {
  constructor(private readonly context: AdminContext) {}

  private get state(): MockState {
    return this.context.state;
  }

  register(app: FastifyInstance): void {
    const h = (fn: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply>) => fn.bind(this);
    app.get('/_admin/health', async () => ({ status: 'ok' }));
    app.post('/_admin/reset', h(this.reset));
    app.post('/_admin/fixtures', h(this.fixtures));
    app.get('/_admin/state', h(this.summary));
    app.get('/_admin/settings', async () => this.state.settings);
    app.post('/_admin/settings', h(this.settings));
    app.get('/_admin/credentials', h(this.listCredentials));
    app.post('/_admin/credentials', h(this.registerCredentials));
    app.post('/_admin/oauth/codes', h(this.mintCode));
    app.post('/_admin/items', h(this.createItem));
    app.get('/_admin/items/:id', h(this.getItem));
    app.post('/_admin/items/:id/move', h(this.move));
    app.post('/_admin/items/:id/new-version', h(this.newVersion));
    app.post('/_admin/items/:id/delete', h(this.deleteItem));
    app.post('/_admin/items/:id/purge-version', h(this.purgeVersion));
    app.post('/_admin/items/:id/corrupt-hash', h(this.corruptHash));
    app.post('/_admin/drives/:id/forbid', h(this.forbid));
    app.post('/_admin/tokens/revoke', h(this.revoke));
    app.post('/_admin/throttle', h(this.throttle));
    app.post('/_admin/latency', h(this.latency));
    app.get('/_admin/requests', h(this.requests));
    app.delete('/_admin/requests', h(this.clearRequests));
  }

  /** Clears the state and loads the base fixtures (or the document in the body, which becomes the new base). */
  resetTo(document: FixtureDocument | undefined): ReturnType<typeof applyFixtures> | null {
    if (document) {
      try {
        applyFixtures(new MockState(), document);
      } catch (error) {
        fixtureFailure(error);
      }
      this.context.setBaseFixtures(document);
    }
    this.state.clear();
    const base = this.context.getBaseFixtures();
    return base ? applyFixtures(this.state, base) : null;
  }

  private reset(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = anyJsonBody(request, 'admin');
    let document: FixtureDocument | undefined;
    if (body !== undefined) {
      try {
        document = parseFixtureDocument(body);
      } catch (error) {
        fixtureFailure(error);
      }
    }
    const summary = this.resetTo(document);
    return reply.send({
      ok: true,
      fixtures: summary ? 'loaded' : 'none',
      drives: this.state.drives.size,
      items: this.state.items.size,
      credentials: summary?.credentials.length ?? 0,
    });
  }

  private fixtures(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = anyJsonBody(request, 'admin');
    if (body === undefined) throw bad('Send a fixture document.');
    try {
      const summary = applyFixtures(this.state, parseFixtureDocument(body));
      return reply.send({ ok: true, ...summary });
    } catch (error) {
      fixtureFailure(error);
    }
  }

  private summary(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const now = Date.now();
    const counts = new Map<string, number>();
    for (const item of state.items.values()) counts.set(item.driveId, (counts.get(item.driveId) ?? 0) + 1);
    return reply.send({
      drives: [...state.drives.values()].map((drive) => ({
        id: drive.id,
        provider: drive.provider,
        name: drive.name,
        driveType: drive.driveType,
        rootId: drive.rootId,
        forbidden: drive.forbidden,
        allowedPrincipals: drive.allowedPrincipals,
        items: counts.get(drive.id) ?? 0,
      })),
      credentials: {
        m365Apps: state.apps.size,
        serviceAccounts: state.serviceAccounts.size,
        oauthClients: state.oauthClients.size,
        refreshTokens: state.refreshTokens.size,
      },
      accessTokens: {
        issued: state.accessTokens.size,
        active: [...state.accessTokens.values()].filter((t) => !t.revoked && t.expiresAt > now).length,
      },
      uploadSessions: state.uploadSessions.size,
      copyJobs: state.copyJobs.size,
      settings: state.settings,
      throttle: state.throttle,
      latency: state.latency,
    });
  }

  private settings(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    try {
      Object.assign(this.state.settings, parseSettings(objectBody(request)));
    } catch (error) {
      fixtureFailure(error);
    }
    return reply.send(this.state.settings);
  }

  private listCredentials(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    return reply.send({
      m365Apps: [...state.apps.values()].map((app) => ({
        tenantId: app.tenantId,
        tenantAliases: app.tenantAliases,
        clientId: app.clientId,
        displayName: app.displayName,
        revoked: app.revoked,
        certificates: app.certificates.map((c) => ({ thumbprintSha256: c.thumbprintSha256, thumbprintSha1: c.thumbprintSha1, notAfter: c.notAfter.toISOString() })),
      })),
      serviceAccounts: [...state.serviceAccounts.values()].map((sa) => ({
        clientEmail: sa.clientEmail,
        displayName: sa.displayName,
        revoked: sa.revoked,
        keyIds: sa.keys.map((k) => k.keyId),
      })),
      oauthClients: [...state.oauthClients.values()].map((c) => ({ clientId: c.clientId, redirectUris: c.redirectUris, revoked: c.revoked })),
      refreshTokens: [...state.refreshTokens.values()].map((t) => ({ clientId: t.clientId, account: t.account.email, scope: t.scope, revoked: t.revoked })),
    });
  }

  private registerCredentials(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = anyJsonBody(request, 'admin');
    const list = Array.isArray(body)
      ? body
      : typeof body === 'object' && body !== null && Array.isArray((body as Body).credentials)
        ? ((body as Body).credentials as unknown[])
        : [body];
    let credentials: CredentialFixture[];
    try {
      credentials = parseFixtureDocument({ credentials: list }).credentials ?? [];
    } catch (error) {
      fixtureFailure(error);
    }
    const summary = applyFixtures(this.state, { credentials });
    return reply.code(201).send({ registered: summary.credentials });
  }

  private mintCode(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = objectBody(request);
    const clientId = optionalString(body, 'clientId');
    const redirectUri = optionalString(body, 'redirectUri');
    if (!clientId || !redirectUri) throw bad('clientId and redirectUri are required.');
    const account = body.account as Body | undefined;
    if (typeof account !== 'object' || account === null || typeof account.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(account.email)) {
      throw bad('account.email is required.');
    }
    const method = optionalString(body, 'codeChallengeMethod');
    if (method !== undefined && method !== 'S256' && method !== 'plain') throw bad('codeChallengeMethod must be S256 or plain.');
    const code = mintAuthCode(this.state, {
      clientId,
      redirectUri,
      account: { email: account.email, displayName: typeof account.displayName === 'string' ? account.displayName : account.email },
      scope: optionalString(body, 'scope') ?? 'https://www.googleapis.com/auth/drive.file',
      codeChallenge: optionalString(body, 'codeChallenge') ?? null,
      codeChallengeMethod: (method as 'S256' | 'plain' | undefined) ?? null,
      offline: optionalBoolean(body, 'offline') ?? true,
    });
    return reply.code(201).send({ code });
  }

  private createItem(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = objectBody(request);
    const { driveId, ...file } = body;
    if (typeof driveId !== 'string') throw bad('driveId is required.');
    const drive = this.state.drives.get(driveId);
    if (!drive) throw adminError(404, 'not_found', `Drive ${driveId} does not exist.`);
    try {
      const document = parseFixtureDocument({ [drive.provider]: { drives: [{ id: driveId, items: [file] }] } });
      const fixture = (drive.provider === 'm365' ? document.m365 : document.google)?.drives?.[0].items?.[0];
      if (!fixture) throw bad('The item is invalid.');
      fixture.id ??= this.state.newItemId(drive.provider);
      applyFixtures(this.state, document);
      return reply.code(201).send(itemView(this.state, this.state.item(fixture.id) as ItemState));
    } catch (error) {
      fixtureFailure(error);
    }
  }

  private item(request: FastifyRequest): ItemState {
    const { id } = request.params as { id: string };
    if (!isGraphId(id)) throw bad(`Invalid item id "${id}".`);
    const item = this.state.item(id);
    if (!item) throw adminError(404, 'not_found', `Item ${id} does not exist.`);
    return item;
  }

  private getItem(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    return reply.send(itemView(this.state, this.item(request)));
  }

  private move(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const item = this.item(request);
    if (item.parentId === null) throw bad('The root folder cannot be moved.');
    const body = objectBody(request);
    const drive = state.drives.get(item.driveId);
    if (!drive) throw adminError(404, 'not_found', 'The drive of the item does not exist.');
    const parentId = optionalString(body, 'parentId');
    const path = optionalString(body, 'path');
    const name = optionalString(body, 'name');
    if (parentId && path) throw bad('Give parentId or path, not both.');
    let target: ItemState;
    try {
      if (parentId) {
        const found = state.item(parentId);
        if (!found || !found.isFolder || found.driveId !== drive.id) throw bad(`${parentId} is not a folder of drive ${drive.id}.`);
        target = found;
      } else if (path !== undefined) {
        target = ensureFolderPath(state, drive, path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean), undefined);
      } else {
        const parent = state.item(item.parentId) as ItemState;
        const existing = state.findChild(parent.id, 'Moved', drive.provider);
        target = existing?.isFolder ? existing : state.createFolder(drive, parent.id, 'Moved', { createdBy: drive.owner ?? undefined });
      }
    } catch (error) {
      fixtureFailure(error);
    }
    if (state.isWithin(target.id, item.id)) throw bad('An item cannot be moved into itself.');
    const newName = name ?? item.name;
    const clash = state.findChild(target.id, newName, drive.provider);
    item.name = clash && clash.id !== item.id && drive.provider === 'm365' ? state.uniqueName(target.id, newName, 'm365') : newName;
    item.parentId = target.id;
    state.touchMetadata(item);
    return reply.send(itemView(state, item));
  }

  private newVersion(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const item = this.item(request);
    if (item.isFolder) throw bad('Folders have no versions.');
    const body = objectBody(request);
    const content = optionalString(body, 'content');
    const contentBase64 = optionalString(body, 'contentBase64');
    const versionId = optionalString(body, 'versionId');
    const modifiedAt = optionalString(body, 'modifiedAt');
    if (content !== undefined && contentBase64 !== undefined) throw bad('Give content or contentBase64, not both.');
    if (versionId !== undefined) {
      const valid = item.provider === 'm365' ? isGraphVersionId(versionId) : isDriveId(versionId);
      if (!valid || item.versions.some((v) => v.id === versionId)) throw bad(`versionId ${versionId} is invalid or already used.`);
    }
    if (modifiedAt !== undefined && Number.isNaN(Date.parse(modifiedAt))) throw bad('modifiedAt must be an ISO 8601 date-time.');
    let modifiedBy;
    if (body.modifiedBy !== undefined) {
      const by = body.modifiedBy as Body;
      if (typeof by !== 'object' || by === null || typeof by.displayName !== 'string') throw bad('modifiedBy needs a displayName.');
      modifiedBy = toPerson({ displayName: by.displayName, ...(typeof by.email === 'string' ? { email: by.email } : {}) });
    }
    const current = state.currentVersion(item);
    const bytes =
      content !== undefined
        ? Buffer.from(content, 'utf8')
        : contentBase64 !== undefined
          ? Buffer.from(contentBase64, 'base64')
          : Buffer.concat([current?.content ?? Buffer.alloc(0), Buffer.from(`\nversion ${item.versions.length + 1} at ${new Date().toISOString()}\n`)]);
    state.addVersion(item, {
      content: bytes,
      ...(versionId ? { id: versionId } : {}),
      ...(modifiedAt ? { modifiedAt: new Date(modifiedAt).toISOString() } : {}),
      ...(modifiedBy ? { modifiedBy } : {}),
    });
    return reply.send(itemView(state, item));
  }

  private deleteItem(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const item = this.item(request);
    if (item.parentId === null) throw bad('The root folder cannot be deleted.');
    const mode = optionalString(objectBody(request), 'mode') ?? 'purge';
    if (mode !== 'purge' && mode !== 'trash') throw bad('mode must be purge or trash.');
    if (mode === 'trash' && item.provider === 'google') {
      item.trashed = true;
      this.state.touchMetadata(item);
      return reply.send({ ok: true, mode, removed: 0 });
    }
    return reply.send({ ok: true, mode: 'purge', removed: this.state.removeItem(item.id) });
  }

  private purgeVersion(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const item = this.item(request);
    if (item.isFolder) throw bad('Folders have no versions.');
    const versionId = optionalString(objectBody(request), 'versionId');
    const current = this.state.currentVersion(item);
    if (versionId !== undefined) {
      if (versionId === current?.id) throw bad('The current version cannot be purged; add a new version first.');
      if (!item.versions.some((v) => v.id === versionId)) throw adminError(404, 'not_found', `Version ${versionId} does not exist.`);
      item.versions = item.versions.filter((v) => v.id !== versionId);
    } else {
      item.versions = current ? [current] : [];
    }
    return reply.send(itemView(this.state, item));
  }

  private corruptHash(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const item = this.item(request);
    const current = this.state.currentVersion(item);
    if (item.isFolder || !current) throw bad('Only files can be corrupted.');
    if (item.provider === 'google' && isGoogleNative(item.mimeType)) throw bad('Google Workspace files have no content hash.');
    const content = Buffer.from(current.content);
    if (content.length === 0) {
      current.content = Buffer.from([0]);
    } else {
      content[0] ^= 0xff;
      current.content = content;
    }
    const before = { quickXorHash: current.quickXorHash, sha256: current.sha256, md5: current.md5 };
    const hashes = hashContent(current.content);
    current.size = current.content.length;
    current.quickXorHash = hashes.quickXorHash === before.quickXorHash ? flip(hashes.quickXorHash) : hashes.quickXorHash;
    current.sha256 = hashes.sha256;
    current.md5 = hashes.md5;
    return reply.send({ ...itemView(this.state, item), previousHashes: before });
  }

  private forbid(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const { id } = request.params as { id: string };
    const drive = this.state.drives.get(id);
    if (!drive) throw adminError(404, 'not_found', `Drive ${id} does not exist.`);
    drive.forbidden = optionalBoolean(objectBody(request), 'forbidden') ?? true;
    return reply.send({ id: drive.id, forbidden: drive.forbidden });
  }

  private revoke(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const body = objectBody(request);
    const clientId = optionalString(body, 'clientId');
    const clientEmail = optionalString(body, 'clientEmail')?.toLowerCase();
    const refreshToken = optionalString(body, 'refreshToken');
    const accessTokensOnly = optionalBoolean(body, 'accessTokensOnly') ?? false;
    const everything = !clientId && !clientEmail && !refreshToken;
    let accessTokens = 0;
    let credentials = 0;
    let refreshTokens = 0;
    for (const token of state.accessTokens.values()) {
      const p = token.principal;
      const matches =
        everything ||
        (clientId !== undefined && (token.clientId === clientId || (p.kind === 'application' && p.id === clientId))) ||
        (clientEmail !== undefined && p.credentialKey === `sa:${clientEmail}`) ||
        (refreshToken !== undefined && p.credentialKey === `refresh:${refreshToken}`);
      if (matches && !token.revoked) {
        token.revoked = true;
        accessTokens += 1;
      }
    }
    if (!accessTokensOnly) {
      for (const app of state.apps.values()) {
        if ((everything || app.clientId === clientId) && !app.revoked) {
          app.revoked = true;
          credentials += 1;
        }
      }
      for (const account of state.serviceAccounts.values()) {
        if ((everything || account.clientEmail.toLowerCase() === clientEmail) && !account.revoked) {
          account.revoked = true;
          credentials += 1;
        }
      }
      for (const token of state.refreshTokens.values()) {
        if ((everything || token.clientId === clientId || token.token === refreshToken) && !token.revoked) {
          token.revoked = true;
          refreshTokens += 1;
        }
      }
    }
    return reply.send({ revokedAccessTokens: accessTokens, revokedCredentials: credentials, revokedRefreshTokens: refreshTokens });
  }

  private throttle(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = objectBody(request);
    const count = optionalInteger(body, 'count', 0, 100000);
    if (count === undefined) throw bad('count is required (0 switches throttling off).');
    const status = optionalInteger(body, 'status', 429, 503) ?? 429;
    if (status !== 429 && status !== 503) throw bad('status must be 429 or 503.');
    this.state.throttle =
      count === 0
        ? null
        : { remaining: count, retryAfterSeconds: optionalInteger(body, 'retryAfterSeconds', 0, 3600) ?? 1, statusCode: status, apis: apisOf(body, ['graph', 'drive']) };
    return reply.send({ throttle: this.state.throttle });
  }

  private latency(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const body = objectBody(request);
    const ms = optionalInteger(body, 'ms', 0, 60000);
    if (ms === undefined) throw bad('ms is required (0 switches the delay off).');
    this.state.latency = ms === 0 ? null : { ms, apis: apisOf(body, PROVIDER_APIS) };
    return reply.send({ latency: this.state.latency });
  }

  private requests(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const query = queryOf(request);
    const api = query.get('api');
    const since = Number(query.get('since') ?? '0');
    return reply.send({
      requests: this.state.requestLog.filter((entry) => (!api || entry.api === api) && entry.seq > (Number.isFinite(since) ? since : 0)),
    });
  }

  private clearRequests(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
    this.state.requestLog = [];
    return reply.code(204).send();
  }
}

function flip(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}
