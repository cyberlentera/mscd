import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertDriveAccess, authenticate } from './auth.js';
import { GOOGLE_FOLDER_MIME, OCTET_STREAM, isGoogleNative, mimeTypeFromName } from './content.js';
import { googleError } from './errors.js';
import { FieldsSyntaxError, selectFields } from './fields.js';
import { bodyBuffer, header, intParam, jsonBody, originOf, queryOf, truthy } from './http.js';
import { isDriveId, randomToken, stableDigits } from './ids.js';
import { signPageToken, verifyPageToken } from './links.js';
import {
  type DriveState,
  type ItemState,
  type MockState,
  type Person,
  type Principal,
  type UploadSession,
  type VersionState,
  personOf,
  principalMayUse,
} from './state.js';

// Google Drive API v3, the subset of D.5 plus what an adapter needs around it:
//
//   GET    /drive/v3/files                       list (q, corpora, driveId, includeItemsFromAllDrives, pageSize, pageToken)
//   POST   /drive/v3/files                       create metadata only (folders)
//   GET    /drive/v3/files/{id}                  get (alt=media downloads binary content)
//   PATCH  /drive/v3/files/{id}                  name, description, trashed, addParents and removeParents
//   DELETE /drive/v3/files/{id}
//   POST   /drive/v3/files/{id}/copy
//   GET    /drive/v3/files/{id}/revisions[/{revisionId}]     PATCH .../revisions/{revisionId} (keepForever)
//   GET    /drive/v3/drives/{driveId}            shared drive
//   GET    /drive/v3/about?fields=user
//   POST   /upload/drive/v3/files?uploadType=media|multipart|resumable, PUT/DELETE on the resumable session URL
//   PATCH  /upload/drive/v3/files/{id}?uploadType=...  new content for an existing file
//
// Behaviour kept from the real API because adapters depend on it: responses carry only the default fields unless
// `fields` asks for more; items of shared drives are invisible without supportsAllDrives=true; `size` and
// `version` are strings (int64); md5Checksum, sha256Checksum and headRevisionId exist only for binary files;
// `owners` only outside shared drives, naming the account that created the file; a My Drive is visible only to its
// owner and to the accounts in `allowedPrincipals` (404 for everyone else, as for a file nobody shared with the
// caller). File, drive and revision ids must match ^[A-Za-z0-9_-]+$ (D.5).

export interface DriveContext {
  state: MockState;
  publicUrl: string | undefined;
}

const FILE_DEFAULT_FIELDS = 'kind,id,name,mimeType';
const LIST_DEFAULT_FIELDS = 'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)';
const REVISION_DEFAULT_FIELDS = 'kind,id,mimeType,modifiedTime';
const REVISION_LIST_DEFAULT_FIELDS = 'kind,nextPageToken,revisions(kind,id,mimeType,modifiedTime)';
const DRIVE_DEFAULT_FIELDS = 'kind,id,name';
const RESUMABLE_CHUNK_MULTIPLE = 256 * 1024;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function badRequest(message: string, location?: string) {
  return googleError(400, location ? 'invalid' : 'badRequest', message, location ? { location, locationType: 'parameter' } : {});
}

function fileNotFound(id: string) {
  return googleError(404, 'notFound', `File not found: ${id}.`, { location: 'fileId', locationType: 'parameter' });
}

function checkId(value: string, location: string): string {
  if (!isDriveId(value)) throw badRequest(`Invalid Value: ${location} must match [A-Za-z0-9_-]+.`, location);
  return value;
}

function isOwner(drive: DriveState, principal: Principal): boolean {
  return Boolean(principal.email && drive.owner?.email?.toLowerCase() === principal.email.toLowerCase());
}

/**
 * Whether a principal can see a drive at all (the forbid switch is separate): a My Drive belongs to its owner and
 * to the accounts named in `allowedPrincipals` (null names nobody else); a shared drive admits every principal its
 * allow-list admits (null admits all).
 */
function driveVisible(drive: DriveState, principal: Principal): boolean {
  if (drive.driveType === 'my_drive') return isOwner(drive, principal) || (drive.allowedPrincipals !== null && principalMayUse(drive, principal));
  return principalMayUse(drive, principal);
}

function mediaType(value: string | undefined | null): string | null {
  if (!value) return null;
  const type = value.split(';')[0].trim().toLowerCase();
  return type === '' ? null : type;
}

// Query language subset: '<id>' in parents, name = '...', name != '...', name contains '...', mimeType = '...',
// mimeType != '...', trashed = true|false, joined with "and" and grouped with parentheses.

type Token = { kind: 'string'; value: string } | { kind: 'word'; value: string } | { kind: 'op'; value: string } | { kind: 'paren'; value: string };
type Predicate = (item: ItemState) => boolean;

function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "'") {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= q.length) throw badRequest('Invalid Value: unterminated string in q.', 'q');
        if (q[i] === '\\' && i + 1 < q.length) {
          value += q[i + 1];
          i += 2;
        } else if (q[i] === "'") {
          i += 1;
          break;
        } else {
          value += q[i];
          i += 1;
        }
      }
      tokens.push({ kind: 'string', value });
    } else if (c === '(' || c === ')') {
      tokens.push({ kind: 'paren', value: c });
      i += 1;
    } else if (c === '!' && q[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' });
      i += 2;
    } else if (c === '=') {
      tokens.push({ kind: 'op', value: '=' });
      i += 1;
    } else {
      const match = /^[A-Za-z]+/.exec(q.slice(i));
      if (!match) throw badRequest(`Invalid Value: unexpected "${c}" in q.`, 'q');
      tokens.push({ kind: 'word', value: match[0] });
      i += match[0].length;
    }
  }
  return tokens;
}

export function parseDriveQuery(q: string): Predicate {
  const tokens = tokenize(q);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const expectWord = (word: string) => {
    const token = next();
    if (!token || token.kind !== 'word' || token.value.toLowerCase() !== word) throw badRequest(`Invalid Value: expected "${word}" in q.`, 'q');
  };
  const parseTerm = (): Predicate => {
    const token = next();
    if (!token) throw badRequest('Invalid Value: incomplete q.', 'q');
    if (token.kind === 'paren' && token.value === '(') {
      const inner = parseExpression();
      const close = next();
      if (!close || close.kind !== 'paren' || close.value !== ')') throw badRequest('Invalid Value: missing ")" in q.', 'q');
      return inner;
    }
    if (token.kind === 'string') {
      expectWord('in');
      expectWord('parents');
      const parentId = checkId(token.value, 'q');
      return (item) => item.parentId === parentId;
    }
    if (token.kind === 'word') {
      const field = token.value;
      if (field === 'not' || field === 'or') throw badRequest(`Invalid Value: "${field}" is not supported by this mock.`, 'q');
      const operator = next();
      if (field === 'name' && operator?.kind === 'word' && operator.value === 'contains') {
        const value = next();
        if (!value || value.kind !== 'string') throw badRequest('Invalid Value: name contains needs a string.', 'q');
        return (item) => item.name.toLowerCase().includes(value.value.toLowerCase());
      }
      if (!operator || operator.kind !== 'op') throw badRequest(`Invalid Value: expected = or != after ${field}.`, 'q');
      const value = next();
      const negate = operator.value === '!=';
      if (field === 'trashed') {
        if (!value || value.kind !== 'word' || !['true', 'false'].includes(value.value)) throw badRequest('Invalid Value: trashed needs true or false.', 'q');
        const wanted = value.value === 'true';
        return (item) => (item.trashed === wanted) !== negate;
      }
      if (field === 'name' || field === 'mimeType') {
        if (!value || value.kind !== 'string') throw badRequest(`Invalid Value: ${field} needs a string.`, 'q');
        return (item) => ((field === 'name' ? item.name : item.mimeType) === value.value) !== negate;
      }
      throw badRequest(`Invalid Value: the field "${field}" is not supported by this mock.`, 'q');
    }
    throw badRequest('Invalid Value: unexpected token in q.', 'q');
  };
  const parseExpression = (): Predicate => {
    const terms = [parseTerm()];
    while (peek()?.kind === 'word' && peek()?.value.toLowerCase() === 'and') {
      next();
      terms.push(parseTerm());
    }
    if (peek()?.kind === 'word' && peek()?.value.toLowerCase() === 'or') throw badRequest('Invalid Value: "or" is not supported by this mock.', 'q');
    return (item) => terms.every((term) => term(item));
  };
  const predicate = parseExpression();
  if (index !== tokens.length) throw badRequest('Invalid Value: unexpected text at the end of q.', 'q');
  return predicate;
}

interface MultipartBody {
  metadata: Record<string, unknown>;
  mediaType: string | null;
  content: Buffer;
}

export function parseMultipartRelated(body: Buffer, contentType: string | undefined): MultipartBody {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1];
  if (!contentType || !/^multipart\/related/i.test(contentType) || !boundary) {
    throw badRequest('A multipart upload needs Content-Type multipart/related with a boundary.');
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: { headers: Record<string, string>; content: Buffer }[] = [];
  let position = body.indexOf(delimiter);
  if (position === -1) throw badRequest('The multipart body has no boundary line.');
  for (;;) {
    let start = position + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else if (body[start] === 0x0a) start += 1;
    const next = body.indexOf(delimiter, start);
    if (next === -1) throw badRequest('The multipart body is not terminated.');
    let end = next;
    if (body[end - 1] === 0x0a) end -= 1;
    if (body[end - 1] === 0x0d) end -= 1;
    const part = body.subarray(start, end);
    let split = part.indexOf('\r\n\r\n');
    let gap = 4;
    if (split === -1) {
      split = part.indexOf('\n\n');
      gap = 2;
    }
    const headerText = split === -1 ? part.toString('utf8') : part.subarray(0, split).toString('utf8');
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    parts.push({ headers, content: split === -1 ? Buffer.alloc(0) : part.subarray(split + gap) });
    position = next;
  }
  if (parts.length !== 2) throw badRequest(`A multipart upload must have exactly two parts (metadata and media), found ${parts.length}.`);
  let metadata: unknown;
  try {
    metadata = parts[0].content.length === 0 ? {} : JSON.parse(parts[0].content.toString('utf8'));
  } catch {
    throw badRequest('The metadata part of the multipart upload is not valid JSON.');
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw badRequest('The metadata part must be a JSON object.');
  return { metadata: metadata as Record<string, unknown>, mediaType: mediaType(parts[1].headers['content-type']), content: parts[1].content };
}

interface FileMetadata {
  name?: string;
  mimeType?: string;
  description?: string;
  parents?: string[];
}

function readMetadata(metadata: Record<string, unknown>): FileMetadata {
  const out: FileMetadata = {};
  if (metadata.name !== undefined) {
    if (typeof metadata.name !== 'string' || metadata.name.trim() === '') throw badRequest('Invalid Value: name must be a non-empty string.', 'name');
    out.name = metadata.name;
  }
  if (metadata.mimeType !== undefined) {
    if (typeof metadata.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(metadata.mimeType)) throw badRequest('Invalid Value: mimeType.', 'mimeType');
    out.mimeType = metadata.mimeType;
  }
  if (metadata.description !== undefined) {
    if (typeof metadata.description !== 'string') throw badRequest('Invalid Value: description must be a string.', 'description');
    out.description = metadata.description;
  }
  if (metadata.parents !== undefined) {
    if (!Array.isArray(metadata.parents) || metadata.parents.some((p) => typeof p !== 'string')) throw badRequest('Invalid Value: parents must be an array of ids.', 'parents');
    if (metadata.parents.length > 1) throw googleError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.');
    out.parents = (metadata.parents as string[]).map((p) => checkId(p, 'parents'));
  }
  return out;
}

export class DriveApi {
  constructor(private readonly context: DriveContext) {}

  private get state(): MockState {
    return this.context.state;
  }

  register(app: FastifyInstance): void {
    const h = (fn: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply>) => fn.bind(this);
    app.get('/drive/v3/files', h(this.list));
    app.post('/drive/v3/files', h(this.createMetadata));
    app.get('/drive/v3/files/:fileId', h(this.get));
    app.patch('/drive/v3/files/:fileId', h(this.updateMetadata));
    app.delete('/drive/v3/files/:fileId', h(this.remove));
    app.post('/drive/v3/files/:fileId/copy', h(this.copy));
    app.get('/drive/v3/files/:fileId/revisions', h(this.listRevisions));
    app.get('/drive/v3/files/:fileId/revisions/:revisionId', h(this.getRevision));
    app.patch('/drive/v3/files/:fileId/revisions/:revisionId', h(this.updateRevision));
    app.get('/drive/v3/drives/:driveId', h(this.getDrive));
    app.get('/drive/v3/about', h(this.about));
    app.post('/upload/drive/v3/files', h(this.uploadCreate));
    app.patch('/upload/drive/v3/files/:fileId', h(this.uploadUpdate));
    app.put('/upload/drive/v3/files', h(this.resumablePut));
    app.put('/upload/drive/v3/files/:fileId', h(this.resumablePut));
    app.delete('/upload/drive/v3/files', h(this.resumableCancel));
    app.delete('/upload/drive/v3/files/:fileId', h(this.resumableCancel));
  }

  // Rendering

  private user(person: Person, principal: Principal): Record<string, unknown> {
    const user: Record<string, unknown> = { kind: 'drive#user', displayName: person.displayName };
    if (person.email) user.emailAddress = person.email;
    user.me = Boolean(person.email && principal.email && person.email.toLowerCase() === principal.email.toLowerCase());
    user.permissionId = stableDigits(`permission:${(person.email ?? person.displayName).toLowerCase()}`);
    return user;
  }

  private webViewLink(item: ItemState): string {
    if (item.isFolder) return `https://drive.google.com/drive/folders/${item.id}`;
    const editor: Record<string, string> = {
      'application/vnd.google-apps.document': 'document',
      'application/vnd.google-apps.spreadsheet': 'spreadsheets',
      'application/vnd.google-apps.presentation': 'presentation',
    };
    const kind = editor[item.mimeType];
    return kind ? `https://docs.google.com/${kind}/d/${item.id}/edit?usp=drivesdk` : `https://drive.google.com/file/d/${item.id}/view?usp=drivesdk`;
  }

  renderFile(item: ItemState, principal: Principal): Record<string, unknown> {
    const drive = this.state.drives.get(item.driveId) as DriveState;
    const current = this.state.currentVersion(item);
    const binary = !item.isFolder && !isGoogleNative(item.mimeType);
    const out: Record<string, unknown> = { kind: 'drive#file', id: item.id, name: item.name, mimeType: item.mimeType };
    if (item.description !== null) out.description = item.description;
    if (item.parentId !== null) out.parents = [item.parentId];
    if (drive.driveType === 'shared_drive') out.driveId = drive.id;
    // A My Drive file is owned by the account that created or uploaded it (a folder or file made by the drive
    // owner, a file uploaded by another account or a service account); fixture items without a creator email
    // fall back to the drive owner.
    const owner = item.createdBy.email ? item.createdBy : drive.owner;
    if (drive.driveType === 'my_drive' && owner) out.owners = [this.user(owner, principal)];
    out.createdTime = item.createdAt;
    out.modifiedTime = current && !item.isFolder ? current.modifiedAt : item.modifiedAt;
    out.version = String(item.revision);
    out.trashed = item.trashed;
    out.webViewLink = this.webViewLink(item);
    out.lastModifyingUser = this.user(current && !item.isFolder ? current.modifiedBy : item.modifiedBy, principal);
    if (!item.isFolder && current) out.size = String(current.size);
    if (binary && current) {
      out.md5Checksum = current.md5;
      out.sha256Checksum = current.sha256;
      out.headRevisionId = current.id;
    }
    return out;
  }

  private renderRevision(item: ItemState, version: VersionState, principal: Principal): Record<string, unknown> {
    const out: Record<string, unknown> = {
      kind: 'drive#revision',
      id: version.id,
      mimeType: item.mimeType,
      modifiedTime: version.modifiedAt,
      lastModifyingUser: this.user(version.modifiedBy, principal),
    };
    if (isGoogleNative(item.mimeType)) {
      out.published = false;
    } else {
      out.keepForever = version.keepForever;
      out.md5Checksum = version.md5;
      out.size = String(version.size);
    }
    return out;
  }

  private respond(reply: FastifyReply, value: unknown, fields: string | null, defaults: string, status = 200): FastifyReply {
    let selected: unknown;
    try {
      selected = selectFields(value, fields, defaults);
    } catch (error) {
      if (error instanceof FieldsSyntaxError) throw googleError(400, 'invalidParameter', error.message, { location: 'fields', locationType: 'parameter' });
      throw error;
    }
    return reply.code(status).send(selected);
  }

  // Lookups

  private myDriveOf(principal: Principal): DriveState | undefined {
    for (const drive of this.state.drives.values()) {
      if (drive.provider === 'google' && drive.driveType === 'my_drive' && isOwner(drive, principal)) return drive;
    }
    return undefined;
  }

  /** Resolves a file id the way Drive does: shared drive items need supportsAllDrives, access rules apply. */
  private resolve(principal: Principal, rawId: string, query: URLSearchParams): { item: ItemState; drive: DriveState } {
    const id = checkId(rawId, 'fileId');
    let item: ItemState | undefined;
    if (id === 'root') {
      const myDrive = this.myDriveOf(principal);
      item = myDrive ? this.state.item(myDrive.rootId) : undefined;
    } else {
      item = this.state.item(id);
    }
    if (!item || item.provider !== 'google') throw fileNotFound(id);
    const drive = this.state.drives.get(item.driveId) as DriveState;
    if (drive.driveType === 'shared_drive' && !(truthy(query.get('supportsAllDrives')) || truthy(query.get('supportsTeamDrives')))) {
      throw fileNotFound(id);
    }
    if (!drive.forbidden && !driveVisible(drive, principal)) throw fileNotFound(id);
    assertDriveAccess(drive, principal, id);
    return { item, drive };
  }

  private resolveParent(principal: Principal, parents: string[] | undefined, query: URLSearchParams): { item: ItemState; drive: DriveState } {
    if (!parents || parents.length === 0) {
      const myDrive = this.myDriveOf(principal);
      if (!myDrive) throw badRequest('This mock needs parents: the account has no My Drive registered in the fixtures.', 'parents');
      assertDriveAccess(myDrive, principal);
      return { item: this.state.item(myDrive.rootId) as ItemState, drive: myDrive };
    }
    const parent = this.resolve(principal, parents[0], query);
    if (!parent.item.isFolder) throw badRequest('Invalid Value: the parent is not a folder.', 'parents');
    if (parent.item.trashed) throw fileNotFound(parents[0]);
    return parent;
  }

  // files

  private list(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const principal = authenticate(state, request, 'google');
    const query = queryOf(request);
    const pageSize = intParam(query.get('pageSize'), 1, 1000);
    if (pageSize === null) throw badRequest('Invalid Value: pageSize must be from 1 to 1000.', 'pageSize');
    const corpora = query.get('corpora') ?? 'user';
    if (!['user', 'drive', 'allDrives', 'domain'].includes(corpora)) throw badRequest('Invalid Value: corpora.', 'corpora');
    const allDrives = truthy(query.get('includeItemsFromAllDrives')) || truthy(query.get('includeTeamDriveItems'));
    const supportsAll = truthy(query.get('supportsAllDrives')) || truthy(query.get('supportsTeamDrives'));
    const driveIdParam = query.get('driveId') ?? query.get('teamDriveId');
    let drives: DriveState[];
    if (driveIdParam !== null) {
      const driveId = checkId(driveIdParam, 'driveId');
      if (corpora !== 'drive') throw badRequest('Invalid Value: driveId requires corpora=drive.', 'corpora');
      if (!allDrives || !supportsAll) {
        throw googleError(403, 'teamDriveParameterRequired', 'includeItemsFromAllDrives and supportsAllDrives must be true when driveId is set.');
      }
      const drive = state.drives.get(driveId);
      if (!drive || drive.provider !== 'google' || drive.driveType !== 'shared_drive') {
        throw googleError(404, 'notFound', `Shared drive not found: ${driveId}`, { location: 'driveId', locationType: 'parameter' });
      }
      assertDriveAccess(drive, principal, driveId);
      drives = [drive];
    } else {
      if (corpora === 'drive') throw badRequest('Invalid Value: corpora=drive requires driveId.', 'driveId');
      drives = [...state.drives.values()].filter((drive) => {
        if (drive.provider !== 'google' || drive.forbidden) return false;
        if (drive.driveType === 'shared_drive' && !(allDrives && supportsAll)) return false;
        return driveVisible(drive, principal);
      });
    }
    const q = query.get('q');
    const predicate = q && q.trim() !== '' ? parseDriveQuery(q) : () => true;
    const driveIds = new Set(drives.map((drive) => drive.id));
    const matches = [...state.items.values()]
      .filter((item) => item.provider === 'google' && driveIds.has(item.driveId) && item.parentId !== null && predicate(item))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    const scope = `drive:${principal.id}:${corpora}:${driveIdParam ?? ''}:${allDrives}:${q ?? ''}`;
    const pageToken = query.get('pageToken');
    const offset = pageToken ? verifyPageToken(state, scope, pageToken) : 0;
    if (offset === null) throw badRequest('Invalid Value: pageToken.', 'pageToken');
    const size = pageSize ?? state.settings.drivePageSize;
    const body: Record<string, unknown> = {
      kind: 'drive#fileList',
      incompleteSearch: false,
      files: matches.slice(offset, offset + size).map((item) => this.renderFile(item, principal)),
    };
    if (offset + size < matches.length) body.nextPageToken = signPageToken(state, scope, offset + size);
    return this.respond(reply, body, query.get('fields'), LIST_DEFAULT_FIELDS);
  }

  private get(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const query = queryOf(request);
    const { item } = this.resolve(principal, (request.params as { fileId: string }).fileId, query);
    if (query.get('alt') === 'media') {
      const current = this.state.currentVersion(item);
      if (item.isFolder || isGoogleNative(item.mimeType) || !current) {
        throw googleError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', {
          location: 'alt',
          locationType: 'parameter',
        });
      }
      return reply.code(200).header('Content-Type', item.mimeType).header('Content-Length', String(current.content.length)).send(current.content);
    }
    return this.respond(reply, this.renderFile(item, principal), query.get('fields'), FILE_DEFAULT_FIELDS);
  }

  private createMetadata(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const query = queryOf(request);
    const metadata = readMetadata(jsonBody(request, 'drive') ?? {});
    const parent = this.resolveParent(principal, metadata.parents, query);
    const by = personOf(principal);
    const name = metadata.name ?? 'Untitled';
    const item =
      metadata.mimeType === GOOGLE_FOLDER_MIME
        ? this.state.createFolder(parent.drive, parent.item.id, name, { createdBy: by, description: metadata.description ?? null })
        : this.state.createFile(parent.drive, parent.item.id, name, {
            mimeType: metadata.mimeType ?? mimeTypeFromName(name),
            description: metadata.description ?? null,
            createdBy: by,
            versions: [{ content: Buffer.alloc(0), modifiedBy: by, modifiedAt: new Date().toISOString() }],
          });
    return this.respond(reply, this.renderFile(item, principal), query.get('fields'), FILE_DEFAULT_FIELDS);
  }

  private updateMetadata(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const query = queryOf(request);
    const fileId = checkId((request.params as { fileId: string }).fileId, 'fileId');
    const addParents = query.get('addParents');
    const removeParents = query.get('removeParents');
    const addIds = addParents ? addParents.split(',').map((id) => checkId(id.trim(), 'addParents')) : [];
    const removeIds = removeParents ? removeParents.split(',').map((id) => checkId(id.trim(), 'removeParents')) : [];
    const { item, drive } = this.resolve(principal, fileId, query);
    if (item.parentId === null) throw googleError(403, 'cannotModifyRoot', 'The root folder of a drive cannot be changed.');
    const body = jsonBody(request, 'drive') ?? {};
    const metadata = readMetadata({ ...body, parents: undefined });
    if (body.parents !== undefined) throw googleError(403, 'fieldNotWritable', 'The resource body includes fields which are not directly writable. Use addParents and removeParents.');
    if (body.trashed !== undefined && typeof body.trashed !== 'boolean') throw badRequest('Invalid Value: trashed must be true or false.', 'trashed');
    let newParent: ItemState | null = null;
    if (addIds.length > 0) {
      if (addIds.length !== 1 || removeIds.length !== 1 || removeIds[0] !== item.parentId) {
        throw googleError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.');
      }
      const target = this.resolve(principal, addIds[0], query);
      if (!target.item.isFolder) throw badRequest('Invalid Value: the parent is not a folder.', 'addParents');
      if (target.drive.id !== drive.id) throw badRequest('Moving files between drives is not supported by this mock.', 'addParents');
      if (this.state.isWithin(target.item.id, item.id)) throw badRequest('A folder cannot be moved into itself.', 'addParents');
      newParent = target.item;
    } else if (removeIds.length > 0) {
      throw googleError(403, 'cannotRemoveParent', 'A file must keep exactly one parent.');
    }
    if (metadata.name !== undefined) item.name = metadata.name;
    if (metadata.description !== undefined) item.description = metadata.description;
    if (typeof body.trashed === 'boolean') item.trashed = body.trashed;
    if (newParent) item.parentId = newParent.id;
    this.state.touchMetadata(item, personOf(principal));
    return this.respond(reply, this.renderFile(item, principal), query.get('fields'), FILE_DEFAULT_FIELDS);
  }

  private remove(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const { item } = this.resolve(principal, (request.params as { fileId: string }).fileId, queryOf(request));
    if (item.parentId === null) throw googleError(403, 'cannotDeleteRoot', 'The root folder of a drive cannot be deleted.');
    this.state.removeItem(item.id);
    return reply.code(204).send();
  }

  private copy(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const principal = authenticate(state, request, 'google');
    const query = queryOf(request);
    const { item } = this.resolve(principal, (request.params as { fileId: string }).fileId, query);
    if (item.isFolder) throw googleError(403, 'cannotCopyFile', 'This file cannot be copied by the user.');
    const metadata = readMetadata(jsonBody(request, 'drive') ?? {});
    const parent = this.resolveParent(principal, metadata.parents ?? [item.parentId as string], query);
    const current = state.currentVersion(item) as VersionState;
    const by = personOf(principal);
    const copy = state.createFile(parent.drive, parent.item.id, metadata.name ?? item.name, {
      mimeType: item.mimeType,
      description: metadata.description ?? item.description,
      createdBy: by,
      versions: [{ content: current.content, quickXorHash: current.quickXorHash, sha256: current.sha256, md5: current.md5, modifiedBy: by, modifiedAt: new Date().toISOString() }],
    });
    return this.respond(reply, this.renderFile(copy, principal), query.get('fields'), FILE_DEFAULT_FIELDS);
  }

  // revisions

  private fileWithRevisions(request: FastifyRequest): { item: ItemState; principal: Principal; query: URLSearchParams } {
    const principal = authenticate(this.state, request, 'google');
    const query = queryOf(request);
    const { item } = this.resolve(principal, (request.params as { fileId: string }).fileId, query);
    if (item.isFolder) throw googleError(403, 'revisionsNotSupported', 'The file does not support revisions.');
    return { item, principal, query };
  }

  private revisionOf(item: ItemState, rawId: string): VersionState {
    const revisionId = checkId(rawId, 'revisionId');
    const version = item.versions.find((v) => v.id === revisionId);
    if (!version) throw googleError(404, 'notFound', `Revision not found: ${revisionId}.`, { location: 'revisionId', locationType: 'parameter' });
    return version;
  }

  private listRevisions(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const { item, principal, query } = this.fileWithRevisions(request);
    const pageSize = intParam(query.get('pageSize'), 1, 1000);
    if (pageSize === null) throw badRequest('Invalid Value: pageSize must be from 1 to 1000.', 'pageSize');
    const scope = `revisions:${item.id}`;
    const pageToken = query.get('pageToken');
    const offset = pageToken ? verifyPageToken(this.state, scope, pageToken) : 0;
    if (offset === null) throw badRequest('Invalid Value: pageToken.', 'pageToken');
    const size = pageSize ?? 200;
    const body: Record<string, unknown> = {
      kind: 'drive#revisionList',
      revisions: item.versions.slice(offset, offset + size).map((version) => this.renderRevision(item, version, principal)),
    };
    if (offset + size < item.versions.length) body.nextPageToken = signPageToken(this.state, scope, offset + size);
    return this.respond(reply, body, query.get('fields'), REVISION_LIST_DEFAULT_FIELDS);
  }

  private getRevision(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const { item, principal, query } = this.fileWithRevisions(request);
    const version = this.revisionOf(item, (request.params as { revisionId: string }).revisionId);
    if (query.get('alt') === 'media') {
      if (isGoogleNative(item.mimeType)) {
        throw googleError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded. Use Export with Docs Editors files.');
      }
      return reply.code(200).header('Content-Type', item.mimeType).header('Content-Length', String(version.content.length)).send(version.content);
    }
    return this.respond(reply, this.renderRevision(item, version, principal), query.get('fields'), REVISION_DEFAULT_FIELDS);
  }

  private updateRevision(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const { item, principal, query } = this.fileWithRevisions(request);
    const version = this.revisionOf(item, (request.params as { revisionId: string }).revisionId);
    const body = jsonBody(request, 'drive') ?? {};
    if (body.keepForever !== undefined) {
      if (typeof body.keepForever !== 'boolean') throw badRequest('Invalid Value: keepForever must be true or false.', 'keepForever');
      if (isGoogleNative(item.mimeType)) {
        throw badRequest('keepForever is only applicable to files with binary content in Google Drive.', 'keepForever');
      }
      version.keepForever = body.keepForever;
    }
    return this.respond(reply, this.renderRevision(item, version, principal), query.get('fields'), REVISION_DEFAULT_FIELDS);
  }

  // drives and about

  private getDrive(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const query = queryOf(request);
    const driveId = checkId((request.params as { driveId: string }).driveId, 'driveId');
    const drive = this.state.drives.get(driveId);
    const notFound = googleError(404, 'notFound', `Shared drive not found: ${driveId}`, { location: 'driveId', locationType: 'parameter' });
    if (!drive || drive.provider !== 'google' || drive.driveType !== 'shared_drive') throw notFound;
    if (!drive.forbidden && !principalMayUse(drive, principal)) throw notFound;
    assertDriveAccess(drive, principal, driveId);
    const body = { kind: 'drive#drive', id: drive.id, name: drive.name, createdTime: drive.createdAt, hidden: false };
    return this.respond(reply, body, query.get('fields'), DRIVE_DEFAULT_FIELDS);
  }

  private about(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const fields = queryOf(request).get('fields');
    if (!fields) throw googleError(400, 'required', "The 'fields' parameter is required for this method.", { location: 'fields', locationType: 'parameter' });
    const body = {
      kind: 'drive#about',
      user: { ...this.user(personOf(principal), principal), me: true },
      storageQuota: { limit: String(15 * 1024 ** 3), usage: '0', usageInDrive: '0', usageInDriveTrash: '0' },
    };
    return this.respond(reply, body, fields, fields);
  }

  // uploads

  private writeContent(
    principal: Principal,
    query: URLSearchParams,
    target: { item: ItemState } | { metadata: FileMetadata },
    content: Buffer,
    contentType: string | null,
  ): ItemState {
    const state = this.state;
    const by = personOf(principal);
    if ('item' in target) {
      const item = target.item;
      if (item.isFolder || isGoogleNative(item.mimeType)) throw badRequest('Binary content can only be written to binary files.');
      state.addVersion(item, { content, modifiedBy: by });
      if (contentType && contentType !== OCTET_STREAM) item.mimeType = contentType;
      return item;
    }
    const metadata = target.metadata;
    if (metadata.mimeType === GOOGLE_FOLDER_MIME) throw badRequest('A folder cannot have content.', 'mimeType');
    const parent = this.resolveParent(principal, metadata.parents, query);
    const name = metadata.name ?? 'Untitled';
    const mimeType = metadata.mimeType ?? (contentType && contentType !== OCTET_STREAM ? contentType : mimeTypeFromName(name));
    return state.createFile(parent.drive, parent.item.id, name, {
      mimeType,
      description: metadata.description ?? null,
      createdBy: by,
      versions: [{ content, modifiedBy: by, modifiedAt: new Date().toISOString() }],
    });
  }

  private uploadCreate(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    return this.upload(request, reply, null);
  }

  private uploadUpdate(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    return this.upload(request, reply, (request.params as { fileId: string }).fileId);
  }

  private upload(request: FastifyRequest, reply: FastifyReply, fileId: string | null): FastifyReply {
    const principal = authenticate(this.state, request, 'google');
    const query = queryOf(request);
    const uploadType = query.get('uploadType');
    const existing = fileId === null ? null : this.resolve(principal, fileId, query).item;
    if (existing && existing.parentId === null) throw googleError(403, 'cannotModifyRoot', 'The root folder of a drive cannot be changed.');
    if (uploadType === 'media') {
      const item = this.writeContent(principal, query, existing ? { item: existing } : { metadata: {} }, bodyBuffer(request), mediaType(header(request, 'content-type')));
      return this.respond(reply, this.renderFile(item, principal), query.get('fields'), FILE_DEFAULT_FIELDS);
    }
    if (uploadType === 'multipart') {
      const parsed = parseMultipartRelated(bodyBuffer(request), header(request, 'content-type'));
      const metadata = readMetadata(parsed.metadata);
      let item: ItemState;
      if (existing) {
        if (metadata.parents) throw googleError(403, 'fieldNotWritable', 'Use addParents and removeParents to move a file.');
        item = this.writeContent(principal, query, { item: existing }, parsed.content, metadata.mimeType ?? parsed.mediaType);
        if (metadata.name !== undefined) item.name = metadata.name;
        if (metadata.description !== undefined) item.description = metadata.description;
      } else {
        item = this.writeContent(principal, query, { metadata }, parsed.content, parsed.mediaType);
      }
      return this.respond(reply, this.renderFile(item, principal), query.get('fields'), FILE_DEFAULT_FIELDS);
    }
    if (uploadType === 'resumable') return this.startResumable(request, reply, principal, query, existing);
    throw badRequest('Invalid Value: uploadType must be media, multipart or resumable.', 'uploadType');
  }

  private startResumable(request: FastifyRequest, reply: FastifyReply, principal: Principal, query: URLSearchParams, existing: ItemState | null): FastifyReply {
    const metadata = readMetadata(jsonBody(request, 'drive') ?? {});
    const declaredLength = intParam(header(request, 'x-upload-content-length'), 0, 5 * 1024 ** 4);
    if (declaredLength === null) throw badRequest('Invalid X-Upload-Content-Length.');
    let driveId: string;
    let parentId: string;
    if (existing) {
      if (existing.isFolder || isGoogleNative(existing.mimeType)) throw badRequest('Binary content can only be written to binary files.');
      if (metadata.parents) throw googleError(403, 'fieldNotWritable', 'Use addParents and removeParents to move a file.');
      driveId = existing.driveId;
      parentId = existing.parentId as string;
    } else {
      if (metadata.mimeType === GOOGLE_FOLDER_MIME) throw badRequest('A folder cannot have content.', 'mimeType');
      const parent = this.resolveParent(principal, metadata.parents, query);
      driveId = parent.drive.id;
      parentId = parent.item.id;
    }
    const session: UploadSession = {
      id: randomToken('', 24),
      provider: 'google',
      driveId,
      parentId,
      name: metadata.name ?? existing?.name ?? 'Untitled',
      targetItemId: existing?.id ?? null,
      conflictBehavior: 'rename',
      mimeType: metadata.mimeType ?? mediaType(header(request, 'x-upload-content-type')),
      description: metadata.description ?? null,
      createdBy: personOf(principal),
      chunks: [],
      received: 0,
      total: declaredLength ?? null,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
      fields: query.get('fields'),
    };
    this.state.uploadSessions.set(session.id, session);
    const path = existing ? `/upload/drive/v3/files/${existing.id}` : '/upload/drive/v3/files';
    const params = new URLSearchParams({ uploadType: 'resumable', upload_id: session.id });
    if (truthy(query.get('supportsAllDrives'))) params.set('supportsAllDrives', 'true');
    return reply
      .code(200)
      .header('Location', `${originOf(request, this.context.publicUrl)}${path}?${params.toString()}`)
      .header('X-GUploader-UploadID', session.id)
      .send();
  }

  private session(request: FastifyRequest): UploadSession {
    const fileId = (request.params as { fileId?: string }).fileId;
    if (fileId !== undefined) checkId(fileId, 'fileId');
    const uploadId = queryOf(request).get('upload_id');
    if (!uploadId) throw badRequest('Invalid Value: upload_id is required.', 'upload_id');
    const session = this.state.uploadSessions.get(uploadId);
    if (!session || session.provider !== 'google' || session.expiresAt <= Date.now()) {
      throw googleError(404, 'notFound', 'The upload session was not found or has expired.');
    }
    const drive = this.state.drives.get(session.driveId);
    if (!drive) throw googleError(404, 'notFound', 'The upload session was not found or has expired.');
    if (drive.forbidden) throw googleError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
    return session;
  }

  private resumableCancel(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const session = this.session(request);
    this.state.uploadSessions.delete(session.id);
    return reply.code(499).send();
  }

  private resumablePut(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const state = this.state;
    const session = this.session(request);
    const body = bodyBuffer(request);
    const rangeHeader = header(request, 'content-range');
    const incomplete = () => {
      if (session.received > 0) reply.header('Range', `bytes=0-${session.received - 1}`);
      return reply.code(308).send();
    };
    let start: number;
    let end: number;
    let total: number | null;
    if (!rangeHeader) {
      if (session.received > 0) throw badRequest('Content-Range is required after the first chunk.');
      start = 0;
      end = body.length - 1;
      total = body.length;
    } else {
      const status = /^bytes \*\/(\d+|\*)$/.exec(rangeHeader);
      if (status) {
        if (body.length > 0) throw badRequest('A status query must have an empty body.');
        return incomplete();
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(rangeHeader);
      if (!range) throw badRequest('Invalid Content-Range header.');
      start = Number(range[1]);
      end = Number(range[2]);
      total = range[3] === '*' ? null : Number(range[3]);
      if (end < start || (total !== null && end >= total)) throw badRequest('Invalid Content-Range header.');
      if (body.length !== end - start + 1) throw badRequest(`The body has ${body.length} bytes but Content-Range declares ${end - start + 1}.`);
    }
    if (start !== session.received) throw badRequest(`The chunk must start at byte ${session.received}.`);
    if (total !== null && session.total !== null && total !== session.total) throw badRequest('The total size differs from X-Upload-Content-Length or an earlier chunk.');
    const isFinal = total !== null && end === total - 1;
    if (!isFinal && body.length % RESUMABLE_CHUNK_MULTIPLE !== 0) {
      throw badRequest('Chunks other than the last must be a multiple of 256 KiB (262,144 bytes).');
    }
    if (total !== null) session.total = total;
    session.chunks.push(body);
    session.received += body.length;
    if (!isFinal && !(total === 0 && body.length === 0)) return incomplete();

    state.uploadSessions.delete(session.id);
    const principal: Principal = {
      provider: 'google',
      kind: 'user',
      id: session.createdBy.email ?? session.createdBy.displayName,
      tenantId: null,
      displayName: session.createdBy.displayName,
      email: session.createdBy.email ?? null,
      credentialKey: 'upload-session',
    };
    const content = Buffer.concat(session.chunks);
    let item: ItemState;
    if (session.targetItemId) {
      const existing = state.item(session.targetItemId);
      if (!existing) throw fileNotFound(session.targetItemId);
      state.addVersion(existing, { content, modifiedBy: session.createdBy });
      if (session.name !== existing.name) existing.name = session.name;
      if (session.description !== null) existing.description = session.description;
      item = existing;
    } else {
      const drive = state.drives.get(session.driveId) as DriveState;
      const parent = state.item(session.parentId);
      if (!parent || !parent.isFolder) throw fileNotFound(session.parentId);
      item = state.createFile(drive, parent.id, session.name, {
        mimeType: session.mimeType ?? mimeTypeFromName(session.name),
        description: session.description,
        createdBy: session.createdBy,
        versions: [{ content, modifiedBy: session.createdBy, modifiedAt: new Date().toISOString() }],
      });
    }
    return this.respond(reply, this.renderFile(item, principal), queryOf(request).get('fields') ?? session.fields, FILE_DEFAULT_FIELDS);
  }
}
