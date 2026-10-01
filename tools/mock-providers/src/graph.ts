import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertDriveAccess, authenticate } from './auth.js';
import { mimeTypeFromName } from './content.js';
import { graphError } from './errors.js';
import { bodyBuffer, decodeSegment, header, intParam, jsonBody, originOf, queryOf, rawPath } from './http.js';
import { isGraphId, isGraphVersionId, randomToken, stableGuid } from './ids.js';
import { signDownload, signPageToken, verifyDownload, verifyPageToken } from './links.js';
import {
  type CopyJob,
  type DriveState,
  type ItemState,
  type MockState,
  type Person,
  type Principal,
  type UploadSession,
  type VersionState,
  personOf,
} from './state.js';

// Microsoft Graph v1.0 drive item API, the subset of D.5 plus what an adapter needs around it:
//
//   GET    /v1.0/drives/{drive-id}
//   GET    /v1.0/drives/{drive-id}/root | /items/{item-id}            item ("root" is an alias of the root id)
//   GET    .../root:/{path}  |  .../items/{item-id}:/{relative-path}   item by path
//   PATCH  .../items/{item-id}                                         rename, move, description
//   DELETE .../items/{item-id}
//   GET    .../children  (paged with $top, @odata.nextLink)            POST .../children (create folder)
//   GET    .../versions  |  .../versions/{version-id}[/content]
//   GET    .../content   (302 to a pre-authenticated download URL)
//   PUT    .../items/{parent-id}:/{name}:/content  |  .../items/{item-id}/content     simple upload, up to 4 MiB
//   POST   .../items/{parent-id}:/{name}:/createUploadSession  |  .../items/{item-id}/createUploadSession
//   POST   .../items/{item-id}/copy   (202 with a Location monitor URL)
//
// Drive and item ids must match ^[A-Za-z0-9!_-]+$ (D.5); anything else is answered 400 before any lookup.

export interface GraphContext {
  state: MockState;
  publicUrl: string | undefined;
}

const SESSION_LIFETIME_MS = 60 * 60 * 1000;
const FRAGMENT_MULTIPLE = 320 * 1024;
const MAX_FRAGMENT_BYTES = 60 * 1024 * 1024;
const FORBIDDEN_NAME = /["*:<>?/\\|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type ConflictBehavior = 'fail' | 'replace' | 'rename';

interface GraphRoute {
  driveId: string;
  /** Null for the drive resource itself. */
  baseId: string | null;
  relPath: string[] | null;
  suffix: string;
}

function invalid(message: string) {
  return graphError(400, 'invalidRequest', message);
}

function notFound(message = 'The resource could not be found.') {
  return graphError(404, 'itemNotFound', message);
}

function decodeId(raw: string): string {
  const id = decodeSegment(raw, 'graph');
  if (!isGraphId(id)) throw invalid(`Invalid id "${id}": drive and item ids must match [A-Za-z0-9!_-]+.`);
  return id;
}

/** Parses the path after /v1.0, including the colon path syntax (root:/a/b:, items/{id}:/name:/content). */
export function parseGraphPath(path: string): GraphRoute {
  const match = /^\/drives\/([^/:]+)(.*)$/.exec(path);
  if (!match) throw invalid(`Unsupported resource path "${path}".`);
  const driveId = decodeId(match[1]);
  let rest = match[2];
  if (rest === '' || rest === '/') return { driveId, baseId: null, relPath: null, suffix: '' };
  let baseId: string;
  if (rest === '/root' || rest.startsWith('/root:') || rest.startsWith('/root/')) {
    baseId = 'root';
    rest = rest.slice('/root'.length);
  } else if (rest.startsWith('/items/')) {
    const idEnd = rest.slice('/items/'.length).search(/[/:]/);
    const rawId = idEnd === -1 ? rest.slice('/items/'.length) : rest.slice('/items/'.length, '/items/'.length + idEnd);
    baseId = rawId === 'root' ? 'root' : decodeId(rawId);
    rest = idEnd === -1 ? '' : rest.slice('/items/'.length + idEnd);
  } else {
    throw invalid(`Unsupported resource path "${path}".`);
  }
  let relPath: string[] | null = null;
  if (rest.startsWith(':')) {
    if (rest === ':' || rest === ':/' || rest.startsWith(':/:')) {
      relPath = [];
      rest = rest.replace(/^:\/?:?/, '');
    } else {
      if (!rest.startsWith(':/')) throw invalid(`Malformed path segment "${rest}".`);
      const end = rest.indexOf(':', 2);
      const encoded = end === -1 ? rest.slice(2) : rest.slice(2, end);
      rest = end === -1 ? '' : rest.slice(end + 1);
      relPath = encoded.replace(/\/+$/, '').split('/').map((segment) => {
        const name = decodeSegment(segment, 'graph');
        if (name === '' || name === '.' || name === '..') throw invalid(`Invalid path segment "${segment}".`);
        return name;
      });
    }
  }
  return { driveId, baseId, relPath, suffix: rest.replace(/\/+$/, '') };
}

function validName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || name.length > 255 || FORBIDDEN_NAME.test(name) || CONTROL_CHARACTERS.test(name)) {
    throw invalid('The provided name contains invalid characters or is empty.');
  }
  return name;
}

function conflictBehavior(value: unknown, fallback: ConflictBehavior): ConflictBehavior {
  if (value === undefined || value === null) return fallback;
  if (value === 'fail' || value === 'replace' || value === 'rename') return value;
  throw invalid(`Invalid @microsoft.graph.conflictBehavior "${String(value)}".`);
}

function identitySet(person: Person): Record<string, unknown> {
  if (person.appId) {
    return { application: { id: person.appId, displayName: person.displayName }, user: { displayName: 'SharePoint App' } };
  }
  const user: Record<string, string> = { displayName: person.displayName };
  if (person.email) user.email = person.email;
  user.id = stableGuid(`user:${(person.email ?? person.displayName).toLowerCase()}`).toLowerCase();
  return { user };
}

function select(value: Record<string, unknown>, selection: string | null): Record<string, unknown> {
  if (!selection) return value;
  const keys = selection.split(',').map((key) => key.trim()).filter(Boolean);
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
}

export class GraphApi {
  constructor(private readonly context: GraphContext) {}

  private get state(): MockState {
    return this.context.state;
  }

  register(app: FastifyInstance): void {
    app.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/v1.0/*',
      handler: (request, reply) => this.handle(request, reply),
    });
    app.route({
      method: ['GET', 'PUT', 'DELETE'],
      url: '/_upload/graph/:sessionId',
      handler: (request, reply) => this.uploadFragment(request, reply),
    });
    app.get('/_monitor/:jobId', (request, reply) => this.monitor(request, reply));
    app.get('/_download/:token', (request, reply) => this.download(request, reply));
  }

  private origin(request: FastifyRequest): string {
    return originOf(request, this.context.publicUrl);
  }

  render(request: FastifyRequest, item: ItemState): Record<string, unknown> {
    const state = this.state;
    const drive = state.drives.get(item.driveId) as DriveState;
    const current = state.currentVersion(item);
    const lastModified = item.isFolder || !current ? item.modifiedAt : current.modifiedAt;
    const out: Record<string, unknown> = {
      createdBy: identitySet(item.createdBy),
      createdDateTime: item.createdAt,
      cTag: `"c:{${item.guid}},${item.ctagSeq}"`,
      eTag: `"{${item.guid}},${item.etagSeq}"`,
      id: item.id,
      lastModifiedBy: identitySet(item.isFolder || !current ? item.modifiedBy : current.modifiedBy),
      lastModifiedDateTime: lastModified,
      name: item.name,
      parentReference: this.parentReference(drive, item),
      webUrl: this.webUrl(drive, item),
      fileSystemInfo: { createdDateTime: item.createdAt, lastModifiedDateTime: lastModified },
      size: state.folderSize(item),
    };
    if (item.description !== null) out.description = item.description;
    if (item.parentId === null) out.root = {};
    if (item.isFolder) {
      out.folder = { childCount: state.childrenOf(item.id, false).length };
    } else if (current) {
      out.file = { mimeType: item.mimeType, hashes: { quickXorHash: current.quickXorHash } };
      out['@microsoft.graph.downloadUrl'] = `${this.origin(request)}/_download/${signDownload(state, item.id, current.id)}`;
    }
    return out;
  }

  private parentReference(drive: DriveState, item: ItemState): Record<string, unknown> {
    const reference: Record<string, unknown> = { driveType: drive.driveType, driveId: drive.id };
    if (item.parentId === null) return reference;
    const parent = this.state.item(item.parentId) as ItemState;
    const segments = this.state.pathNames(parent).map(encodeURIComponent);
    reference.id = parent.id;
    reference.path = `/drives/${drive.id}/root:${segments.length > 0 ? `/${segments.join('/')}` : ''}`;
    return reference;
  }

  private webUrl(drive: DriveState, item: ItemState): string {
    const segments = this.state.pathNames(item).map(encodeURIComponent);
    return segments.length === 0 ? drive.webUrl : `${drive.webUrl}/${segments.join('/')}`;
  }

  private renderDrive(drive: DriveState): Record<string, unknown> {
    const root = this.state.item(drive.rootId) as ItemState;
    const used = this.state.folderSize(root);
    const total = 1024 ** 4;
    const owner = drive.owner ? identitySet(drive.owner) : { group: { displayName: `${drive.name} Owners` } };
    return {
      id: drive.id,
      driveType: drive.driveType,
      name: drive.name,
      createdDateTime: drive.createdAt,
      lastModifiedDateTime: root.modifiedAt,
      webUrl: drive.webUrl,
      owner,
      quota: { deleted: 0, remaining: total - used, state: 'normal', total, used },
    };
  }

  private renderVersion(version: VersionState): Record<string, unknown> {
    return { id: version.id, lastModifiedBy: identitySet(version.modifiedBy), lastModifiedDateTime: version.modifiedAt, size: version.size };
  }

  private async handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const state = this.state;
    const principal = authenticate(state, request, 'm365');
    const route = parseGraphPath(rawPath(request).slice('/v1.0'.length));
    const drive = state.drives.get(route.driveId);
    if (!drive || drive.provider !== 'm365') throw notFound('The provided drive id appears to be malformed, or does not represent a valid drive.');
    assertDriveAccess(drive, principal);
    const method = request.method;
    const query = queryOf(request);
    if (route.baseId === null) {
      if (method !== 'GET') throw graphError(405, 'invalidRequest', 'The HTTP method is not supported for this resource.');
      return reply.send(select(this.renderDrive(drive), query.get('$select')));
    }
    const baseId = route.baseId === 'root' ? drive.rootId : route.baseId;
    const base = state.item(baseId);
    if (!base || base.driveId !== drive.id) throw notFound();

    const creates = (method === 'PUT' && route.suffix === '/content') || (method === 'POST' && route.suffix === '/createUploadSession');
    if (creates && route.relPath && route.relPath.length > 0) {
      if (method === 'PUT') this.assertSimpleUploadSize(request);
      const parent = this.ensureFolders(drive, base, route.relPath.slice(0, -1), personOf(principal));
      const name = validName(route.relPath[route.relPath.length - 1]);
      return method === 'PUT'
        ? this.simpleUpload(request, reply, drive, principal, { parent, name })
        : this.createUploadSession(request, reply, drive, principal, { parent, name });
    }
    const item = route.relPath ? this.walk(base, route.relPath) : base;
    const suffix = route.suffix;
    const versionMatch = /^\/versions\/([^/]+)(\/content)?$/.exec(suffix);

    if (suffix === '' && method === 'GET') return reply.send(select(this.render(request, item), query.get('$select')));
    if (suffix === '' && method === 'PATCH') return this.update(request, reply, drive, principal, item);
    if (suffix === '' && method === 'DELETE') {
      if (item.parentId === null) throw invalid('The root folder cannot be deleted.');
      state.removeItem(item.id);
      return reply.code(204).send();
    }
    if (suffix === '/children' && method === 'GET') return this.children(request, reply, drive, item);
    if (suffix === '/children' && method === 'POST') return this.createFolder(request, reply, drive, principal, item);
    if (suffix === '/content' && method === 'GET') {
      const current = this.fileVersion(item, 'current');
      return reply.code(302).header('Location', `${this.origin(request)}/_download/${signDownload(state, item.id, current.id)}`).send();
    }
    if (suffix === '/content' && method === 'PUT') return this.simpleUpload(request, reply, drive, principal, { item });
    if (suffix === '/createUploadSession' && method === 'POST') return this.createUploadSession(request, reply, drive, principal, { item });
    if (suffix === '/versions' && method === 'GET') {
      if (item.isFolder) throw invalid('Versions are only available for files.');
      return reply.send({ value: [...item.versions].reverse().map((version) => this.renderVersion(version)) });
    }
    if (versionMatch && method === 'GET') {
      const versionId = decodeSegment(versionMatch[1], 'graph');
      if (versionId !== 'current' && !isGraphVersionId(versionId)) throw invalid(`Invalid version id "${versionId}".`);
      const version = this.fileVersion(item, versionId);
      if (versionMatch[2]) {
        return reply.code(302).header('Location', `${this.origin(request)}/_download/${signDownload(state, item.id, version.id)}`).send();
      }
      return reply.send(this.renderVersion(version));
    }
    if (suffix === '/copy' && method === 'POST') return this.copy(request, reply, drive, principal, item);
    const known = ['', '/children', '/content', '/createUploadSession', '/versions', '/copy'].includes(suffix) || versionMatch;
    if (known) throw graphError(405, 'invalidRequest', 'The HTTP method is not supported for this resource.');
    throw invalid(`Unsupported segment "${suffix}".`);
  }

  private walk(base: ItemState, segments: string[]): ItemState {
    let current = base;
    for (const segment of segments) {
      const child = this.state.findChild(current.id, segment, 'm365');
      if (!child) throw notFound();
      current = child;
    }
    return current;
  }

  /** Path uploads create the missing parent folders, as OneDrive and SharePoint do. */
  private ensureFolders(drive: DriveState, base: ItemState, segments: string[], by: Person): ItemState {
    if (!base.isFolder) throw invalid('The parent of an upload must be a folder.');
    let current = base;
    for (const segment of segments) {
      const child = this.state.findChild(current.id, segment, 'm365');
      if (child && !child.isFolder) throw graphError(409, 'nameAlreadyExists', `A file named "${segment}" is in the way of the folder path.`);
      current = child ?? this.state.createFolder(drive, current.id, validName(segment), { createdBy: by });
    }
    return current;
  }

  private fileVersion(item: ItemState, versionId: string): VersionState {
    if (item.isFolder) throw invalid('Content and versions are only available for files.');
    const version = versionId === 'current' ? this.state.currentVersion(item) : item.versions.find((v) => v.id === versionId);
    if (!version) throw notFound('The version was not found.');
    return version;
  }

  private children(request: FastifyRequest, reply: FastifyReply, drive: DriveState, item: ItemState): FastifyReply {
    const state = this.state;
    const query = queryOf(request);
    const top = intParam(query.get('$top'), 1, 1000);
    if (top === null) throw invalid('$top must be an integer from 1 to 1000.');
    const pageSize = top ?? state.settings.graphPageSize;
    const scope = `graph:${drive.id}:${item.id}`;
    const skipToken = query.get('$skiptoken');
    const offset = skipToken ? verifyPageToken(state, scope, skipToken) : 0;
    if (offset === null) throw invalid('Invalid $skiptoken.');
    const children = item.isFolder ? state.childrenOf(item.id, false) : [];
    const page = children.slice(offset, offset + pageSize);
    const body: Record<string, unknown> = { value: page.map((child) => select(this.render(request, child), query.get('$select'))) };
    if (offset + pageSize < children.length) {
      const next = new URLSearchParams(query);
      next.set('$skiptoken', signPageToken(state, scope, offset + pageSize));
      body['@odata.nextLink'] = `${this.origin(request)}${rawPath(request)}?${next.toString().replace(/%24/g, '$')}`;
    }
    return reply.send(body);
  }

  private createFolder(request: FastifyRequest, reply: FastifyReply, drive: DriveState, principal: Principal, parent: ItemState): FastifyReply {
    if (!parent.isFolder) throw invalid('Folders can only be created in a folder.');
    const body = jsonBody(request, 'graph') ?? {};
    if (typeof body.folder !== 'object' || body.folder === null) {
      throw invalid('Only folders can be created here: the body needs a "folder" facet. Upload files with PUT .../content.');
    }
    let name = validName(body.name);
    const behavior = conflictBehavior(body['@microsoft.graph.conflictBehavior'] ?? queryOf(request).get('@microsoft.graph.conflictBehavior'), 'fail');
    const existing = this.state.findChild(parent.id, name, 'm365');
    if (existing) {
      if (behavior === 'fail') throw graphError(409, 'nameAlreadyExists', 'Name already exists');
      if (behavior === 'rename') name = this.state.uniqueName(parent.id, name, 'm365');
      else this.state.removeItem(existing.id);
    }
    const folder = this.state.createFolder(drive, parent.id, name, {
      createdBy: personOf(principal),
      description: typeof body.description === 'string' ? body.description : null,
    });
    return reply.code(201).send(this.render(request, folder));
  }

  private update(request: FastifyRequest, reply: FastifyReply, drive: DriveState, principal: Principal, item: ItemState): FastifyReply {
    if (item.parentId === null) throw invalid('The root folder cannot be changed.');
    const body = jsonBody(request, 'graph') ?? {};
    let parent = this.state.item(item.parentId) as ItemState;
    const reference = body.parentReference;
    if (reference !== undefined) {
      if (typeof reference !== 'object' || reference === null) throw invalid('parentReference must be an object.');
      const { id, driveId } = reference as { id?: unknown; driveId?: unknown };
      if (driveId !== undefined && driveId !== drive.id) throw invalid('Moving items to another drive is not supported; copy them instead.');
      if (id !== undefined) {
        if (!isGraphId(id)) throw invalid(`Invalid id "${String(id)}".`);
        const target = this.state.item(id === 'root' ? drive.rootId : id);
        if (!target || target.driveId !== drive.id || !target.isFolder) throw notFound('The target folder was not found.');
        if (this.state.isWithin(target.id, item.id)) throw invalid('An item cannot be moved into itself.');
        parent = target;
      }
    }
    let name = body.name !== undefined ? validName(body.name) : item.name;
    const existing = this.state.findChild(parent.id, name, 'm365');
    if (existing && existing.id !== item.id) {
      const behavior = conflictBehavior(queryOf(request).get('@microsoft.graph.conflictBehavior'), 'fail');
      if (behavior === 'rename') name = this.state.uniqueName(parent.id, name, 'm365');
      else throw graphError(409, 'nameAlreadyExists', 'Name already exists');
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') throw invalid('description must be a string.');
    item.parentId = parent.id;
    item.name = name;
    if (body.description !== undefined) item.description = (body.description as string | null) ?? null;
    this.state.touchMetadata(item, personOf(principal));
    return reply.send(this.render(request, item));
  }

  /** Writes new content: a new file in `parent`, or a new version of an existing file. */
  private store(
    drive: DriveState,
    by: Person,
    target: { parent: ItemState; name: string } | { item: ItemState },
    content: Buffer,
    behavior: ConflictBehavior,
    description: string | null,
  ): { item: ItemState; created: boolean } {
    const state = this.state;
    if ('item' in target) {
      if (target.item.isFolder) throw invalid('Content can only be written to a file.');
      state.addVersion(target.item, { content, modifiedBy: by });
      return { item: target.item, created: false };
    }
    let name = target.name;
    const existing = state.findChild(target.parent.id, name, 'm365');
    if (existing) {
      if (existing.isFolder || behavior === 'fail') throw graphError(409, 'nameAlreadyExists', 'Name already exists');
      if (behavior === 'replace') {
        state.addVersion(existing, { content, modifiedBy: by });
        if (description !== null) existing.description = description;
        return { item: existing, created: false };
      }
      name = state.uniqueName(target.parent.id, name, 'm365');
    }
    const item = state.createFile(drive, target.parent.id, name, {
      mimeType: mimeTypeFromName(name),
      createdBy: by,
      description,
      versions: [{ content, modifiedBy: by, modifiedAt: new Date().toISOString() }],
    });
    return { item, created: true };
  }

  private simpleUpload(
    request: FastifyRequest,
    reply: FastifyReply,
    drive: DriveState,
    principal: Principal,
    target: { parent: ItemState; name: string } | { item: ItemState },
  ): FastifyReply {
    const content = this.assertSimpleUploadSize(request);
    const behavior = conflictBehavior(queryOf(request).get('@microsoft.graph.conflictBehavior'), 'replace');
    const { item, created } = this.store(drive, personOf(principal), target, content, behavior, null);
    return reply.code(created ? 201 : 200).send(this.render(request, item));
  }

  private assertSimpleUploadSize(request: FastifyRequest): Buffer {
    const content = bodyBuffer(request);
    const limit = this.state.settings.graphSimpleUploadMaxBytes;
    if (content.length > limit) {
      throw graphError(413, 'invalidRequest', `The simple upload accepts at most ${limit} bytes; use createUploadSession for larger files.`);
    }
    return content;
  }

  private createUploadSession(
    request: FastifyRequest,
    reply: FastifyReply,
    drive: DriveState,
    principal: Principal,
    target: { parent: ItemState; name: string } | { item: ItemState },
  ): FastifyReply {
    const body = jsonBody(request, 'graph') ?? {};
    const itemProperties = (typeof body.item === 'object' && body.item !== null ? body.item : {}) as Record<string, unknown>;
    const behavior = conflictBehavior(itemProperties['@microsoft.graph.conflictBehavior'] ?? queryOf(request).get('@microsoft.graph.conflictBehavior'), 'fail');
    if (itemProperties.description !== undefined && typeof itemProperties.description !== 'string') throw invalid('item.description must be a string.');
    if ('item' in target && target.item.isFolder) throw invalid('Content can only be written to a file.');
    if ('parent' in target && behavior === 'fail') {
      const existing = this.state.findChild(target.parent.id, target.name, 'm365');
      if (existing) throw graphError(409, 'nameAlreadyExists', 'Name already exists');
    }
    const session: UploadSession = {
      id: randomToken('', 24),
      provider: 'm365',
      driveId: drive.id,
      parentId: 'parent' in target ? target.parent.id : (target.item.parentId as string),
      name: 'parent' in target ? target.name : target.item.name,
      targetItemId: 'item' in target ? target.item.id : null,
      conflictBehavior: behavior,
      mimeType: null,
      description: typeof itemProperties.description === 'string' ? itemProperties.description : null,
      createdBy: personOf(principal),
      chunks: [],
      received: 0,
      total: null,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
      fields: null,
    };
    this.state.uploadSessions.set(session.id, session);
    return reply.send({
      uploadUrl: `${this.origin(request)}/_upload/graph/${session.id}`,
      expirationDateTime: new Date(session.expiresAt).toISOString(),
      nextExpectedRanges: ['0-'],
    });
  }

  private async uploadFragment(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const state = this.state;
    const { sessionId } = request.params as { sessionId: string };
    const session = state.uploadSessions.get(sessionId);
    if (!session || session.provider !== 'm365' || session.expiresAt <= Date.now()) {
      throw notFound('The upload session was not found or has expired.');
    }
    if (header(request, 'authorization')) {
      throw graphError(401, 'unauthenticated', 'The upload URL is pre-authenticated; do not send an Authorization header with fragments.');
    }
    const drive = state.drives.get(session.driveId);
    if (!drive) throw notFound();
    if (drive.forbidden) throw graphError(403, 'accessDenied', 'Access denied');
    const expiration = new Date(session.expiresAt).toISOString();
    if (request.method === 'DELETE') {
      state.uploadSessions.delete(session.id);
      return reply.code(204).send();
    }
    if (request.method === 'GET') return reply.send({ expirationDateTime: expiration, nextExpectedRanges: [`${session.received}-`] });

    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header(request, 'content-range') ?? '');
    if (!range) throw invalid('The Content-Range header is missing or malformed (expected "bytes start-end/total").');
    const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
    const body = bodyBuffer(request);
    if (end < start || end >= total) throw invalid('The Content-Range header is not a valid range of the file.');
    if (body.length !== end - start + 1) throw invalid(`The body has ${body.length} bytes but Content-Range declares ${end - start + 1}.`);
    if (session.total !== null && session.total !== total) throw invalid('The total file size in Content-Range changed between fragments.');
    if (body.length > MAX_FRAGMENT_BYTES) throw graphError(413, 'invalidRequest', 'A fragment may carry at most 60 MiB.');
    if (start !== session.received) {
      throw graphError(416, 'invalidRange', `The fragment must start at byte ${session.received}.`, { innerCode: 'fragmentOverlap' });
    }
    const isFinal = end === total - 1;
    if (!isFinal && body.length % FRAGMENT_MULTIPLE !== 0) {
      throw invalid('Fragments other than the last must be a multiple of 320 KiB (327,680 bytes).');
    }
    session.total = total;
    session.chunks.push(body);
    session.received += body.length;
    if (!isFinal) return reply.code(202).send({ expirationDateTime: expiration, nextExpectedRanges: [`${session.received}-`] });

    state.uploadSessions.delete(session.id);
    const content = Buffer.concat(session.chunks);
    const target = session.targetItemId ? state.item(session.targetItemId) : undefined;
    const parent = state.item(session.parentId);
    if (session.targetItemId && !target) throw notFound('The item of the upload session no longer exists.');
    if (!target && (!parent || !parent.isFolder)) throw notFound('The parent folder of the upload session no longer exists.');
    const { item, created } = this.store(
      drive,
      session.createdBy,
      target ? { item: target } : { parent: parent as ItemState, name: session.name },
      content,
      session.conflictBehavior,
      session.description,
    );
    if (created && session.description !== null) item.description = session.description;
    return reply.code(created ? 201 : 200).send(this.render(request, item));
  }

  private copy(request: FastifyRequest, reply: FastifyReply, drive: DriveState, principal: Principal, item: ItemState): FastifyReply {
    const state = this.state;
    if (item.parentId === null) throw invalid('The root folder cannot be copied.');
    const body = jsonBody(request, 'graph') ?? {};
    const reference = (typeof body.parentReference === 'object' && body.parentReference !== null ? body.parentReference : {}) as Record<string, unknown>;
    const targetDriveId = reference.driveId ?? drive.id;
    const targetParentId = reference.id ?? item.parentId;
    if (!isGraphId(targetDriveId) || !isGraphId(targetParentId)) throw invalid('parentReference.driveId and parentReference.id must be valid ids.');
    const targetDrive = state.drives.get(targetDriveId);
    if (!targetDrive || targetDrive.provider !== 'm365') throw notFound('The target drive was not found.');
    assertDriveAccess(targetDrive, principal);
    const parent = state.item(targetParentId === 'root' ? targetDrive.rootId : targetParentId);
    if (!parent || parent.driveId !== targetDrive.id || !parent.isFolder) throw notFound('The target folder was not found.');
    if (item.isFolder && state.isWithin(parent.id, item.id)) throw invalid('A folder cannot be copied into itself.');
    const name = body.name !== undefined ? validName(body.name) : item.name;
    const now = new Date().toISOString();
    const job: CopyJob = {
      id: randomUUID(),
      createdAt: now,
      sourceItemId: item.id,
      targetDriveId: targetDrive.id,
      targetParentId: parent.id,
      name,
      conflictBehavior: conflictBehavior(queryOf(request).get('@microsoft.graph.conflictBehavior'), 'fail'),
      copiedBy: personOf(principal),
      pendingPolls: state.settings.copyPendingPolls,
      status: 'inProgress',
      resourceId: null,
      error: null,
    };
    state.copyJobs.set(job.id, job);
    if (job.pendingPolls === 0) this.runCopy(job);
    return reply.code(202).header('Location', `${this.origin(request)}/_monitor/${job.id}`).send();
  }

  private runCopy(job: CopyJob): void {
    const state = this.state;
    const fail = (code: string, message: string) => {
      job.status = 'failed';
      job.error = { code, message };
    };
    const source = state.item(job.sourceItemId);
    const drive = state.drives.get(job.targetDriveId);
    const parent = state.item(job.targetParentId);
    if (!source) return fail('itemNotFound', 'The source item no longer exists.');
    if (!drive || !parent || !parent.isFolder) return fail('itemNotFound', 'The target folder no longer exists.');
    let name = job.name;
    const existing = state.findChild(parent.id, name, 'm365');
    if (existing) {
      if (job.conflictBehavior === 'fail' || (job.conflictBehavior === 'replace' && (existing.isFolder || source.isFolder))) {
        return fail('nameAlreadyExists', 'Name already exists');
      }
      if (job.conflictBehavior === 'replace') state.removeItem(existing.id);
      else name = state.uniqueName(parent.id, name, 'm365');
    }
    const copy = this.copyTree(source, drive, parent, name, job.copiedBy);
    job.status = 'completed';
    job.resourceId = copy.id;
  }

  private copyTree(source: ItemState, drive: DriveState, parent: ItemState, name: string, by: Person): ItemState {
    const state = this.state;
    if (source.isFolder) {
      const folder = state.createFolder(drive, parent.id, name, { createdBy: by, description: source.description });
      for (const child of state.childrenOf(source.id, false)) this.copyTree(child, drive, folder, child.name, by);
      return folder;
    }
    const current = state.currentVersion(source) as VersionState;
    return state.createFile(drive, parent.id, name, {
      mimeType: source.mimeType,
      description: source.description,
      createdBy: by,
      versions: [{ content: current.content, quickXorHash: current.quickXorHash, sha256: current.sha256, md5: current.md5, modifiedBy: by, modifiedAt: new Date().toISOString() }],
    });
  }

  private monitor(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const { jobId } = request.params as { jobId: string };
    const job = this.state.copyJobs.get(jobId);
    if (!job) throw notFound('The monitor was not found.');
    if (job.status === 'inProgress') {
      if (job.pendingPolls > 0) {
        job.pendingPolls -= 1;
        const now = new Date().toISOString();
        return reply.send({ id: job.id, createdDateTime: job.createdAt, lastActionDateTime: now, percentageComplete: 50, percentComplete: 50, status: 'inProgress' });
      }
      this.runCopy(job);
    }
    const now = new Date().toISOString();
    if (job.status === 'failed') {
      return reply.send({ id: job.id, createdDateTime: job.createdAt, lastActionDateTime: now, status: 'failed', error: job.error });
    }
    return reply.send({
      '@odata.context': `${this.origin(request)}/v1.0/$metadata#drives('${job.targetDriveId}')/operations/$entity`,
      id: job.id,
      createdDateTime: job.createdAt,
      lastActionDateTime: now,
      percentageComplete: 100,
      percentComplete: 100,
      resourceId: job.resourceId,
      resourceLocation: `${this.origin(request)}/v1.0/drives/${job.targetDriveId}/items/${job.resourceId}`,
      status: 'completed',
    });
  }

  private download(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const { token } = request.params as { token: string };
    const link = verifyDownload(this.state, token);
    if (!link) throw graphError(401, 'unauthenticated', 'The download URL is invalid or has expired.');
    const item = this.state.item(link.itemId);
    const version = item?.versions.find((v) => v.id === link.versionId);
    if (!item || !version) throw notFound();
    const drive = this.state.drives.get(item.driveId);
    if (!drive || drive.forbidden) throw graphError(403, 'accessDenied', 'Access denied');
    return reply
      .code(200)
      .header('Content-Type', item.mimeType)
      .header('Content-Length', String(version.content.length))
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`)
      .send(version.content);
  }
}
