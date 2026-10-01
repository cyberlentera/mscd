// Google Drive v3 calls of the Google Drive adapter (build plan D.5): files get, list, create (folders, multipart
// and resumable uploads), copy, revisions list and update (`keepForever`), shared drive get, `about`, and content
// downloads (`alt=media`). Every id is checked against the Drive pattern before use, path segments pass through
// `encodeURIComponent`, queries are built with `URLSearchParams`, every call names its `fields` and sends
// `supportsAllDrives=true`, and names in `q` are quoted with Drive's escaping. The resumable session URL Drive
// hands out passes the egress policy as an `issued` target and gets no Authorization header.
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DRIVE_ID_RE } from '@mscd/shared';
import type { Response } from 'undici';
import { z } from 'zod';
import { badRequest } from '../../problems';
import type { AdapterContext } from '../types';
import { ProviderError, unexpectedAnswer } from '../m365/provider/errors';
import { discard, readJson, type ProviderHttp, type ProviderRequest } from '../m365/provider/http';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';

const DriveUser = z.looseObject({ displayName: z.string().optional(), emailAddress: z.string().optional() });
const Count = z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]);

export const DriveFile = z.looseObject({
  id: z.string().regex(DRIVE_ID_RE),
  name: z.string(),
  mimeType: z.string(),
  description: z.string().optional(),
  size: Count.optional(),
  sha256Checksum: z.string().optional(),
  md5Checksum: z.string().optional(),
  headRevisionId: z.string().optional(),
  parents: z.array(z.string()).optional(),
  owners: z.array(DriveUser).optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  lastModifyingUser: DriveUser.optional(),
  webViewLink: z.string().optional(),
  driveId: z.string().optional(),
  trashed: z.boolean().optional(),
  capabilities: z.looseObject({ canAddChildren: z.boolean().optional() }).optional(),
});
export type DriveFile = z.infer<typeof DriveFile>;

export const DriveRevision = z.looseObject({
  id: z.string().min(1),
  modifiedTime: z.string().optional(),
  keepForever: z.boolean().optional(),
  size: Count.optional(),
  lastModifyingUser: DriveUser.optional(),
});
export type DriveRevision = z.infer<typeof DriveRevision>;

const FileList = z.looseObject({ files: z.array(DriveFile), nextPageToken: z.string().optional() });
const RevisionList = z.looseObject({ revisions: z.array(DriveRevision), nextPageToken: z.string().optional() });
const SharedDrive = z.looseObject({ id: z.string(), name: z.string().optional() });
const About = z.looseObject({ user: DriveUser });

/** Fields of every file the adapter reads. */
export const FILE_FIELDS =
  'id,name,mimeType,description,size,sha256Checksum,md5Checksum,headRevisionId,parents,owners(displayName,emailAddress),createdTime,modifiedTime,lastModifyingUser(displayName,emailAddress),webViewLink,driveId,trashed';
/** Fields of folders on a parent walk. */
const FOLDER_FIELDS = 'id,name,mimeType,parents,driveId,trashed,capabilities(canAddChildren)';
const REVISION_FIELDS = 'id,modifiedTime,keepForever,size,lastModifyingUser(displayName,emailAddress)';
/** Files per list page. */
export const LIST_PAGE_SIZE = 200;
const MAX_REVISION_PAGES = 50;

/** True for Google Docs, Sheets, Slides and other Workspace types, which have no binary content or checksum. */
export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_APPS_PREFIX);
}

/** A Drive file, folder or revision id from a caller, checked against the D.5 pattern before any request. */
export function checkDriveId(id: string, what = 'file id'): string {
  if (!DRIVE_ID_RE.test(id) || id.length > 300) throw badRequest(`The Google Drive ${what} is not valid (D.5 pattern [A-Za-z0-9_-]+)`);
  return id;
}

/** A string literal of the Drive query language: backslash and single quote escaped. */
export function queryString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unexpectedAnswer('google_drive', what);
  return result.data;
}

/** Where `files.list` looks: one shared drive, or the account's own corpus (My Drive). */
export type Corpus = { kind: 'shared_drive'; driveId: string } | { kind: 'my_drive' };

/** The access token of a session: from the credential (cached) or fixed (consent flow). */
export interface SessionTokens {
  token(): Promise<string>;
  invalidate(token: string): void;
}

export interface DriveSessionDeps {
  http: ProviderHttp;
  apiBaseUrl: string;
  uploadTimeoutMs: number;
}

export class DriveSession {
  constructor(
    private readonly deps: DriveSessionDeps,
    private readonly ctx: Pick<AdapterContext, 'signal'>,
    private readonly tokens: SessionTokens,
  ) {}

  token(): Promise<string> {
    return this.tokens.token();
  }

  // Files ---------------------------------------------------------------------------------------------------------

  async file(fileId: string): Promise<DriveFile> {
    const url = this.url(`/drive/v3/files/${encodeURIComponent(checkDriveId(fileId))}`, { fields: FILE_FIELDS, supportsAllDrives: 'true' });
    return parse(DriveFile, await this.json({ method: 'GET', url, what: `reading file ${fileId}` }), 'file');
  }

  async folder(folderId: string): Promise<DriveFile> {
    const url = this.url(`/drive/v3/files/${encodeURIComponent(checkDriveId(folderId, 'folder id'))}`, { fields: FOLDER_FIELDS, supportsAllDrives: 'true' });
    return parse(DriveFile, await this.json({ method: 'GET', url, what: `reading folder ${folderId}` }), 'folder');
  }

  /** One page of `files.list` with a query `q`. */
  async list(q: string, corpus: Corpus, pageToken?: string, pageSize = LIST_PAGE_SIZE): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const query: Record<string, string> = {
      q,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: String(pageSize),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(corpus.kind === 'shared_drive' ? { corpora: 'drive', driveId: checkDriveId(corpus.driveId, 'drive id') } : { corpora: 'user' }),
      ...(pageToken !== undefined ? { pageToken } : {}),
    };
    const page = parse(FileList, await this.json({ method: 'GET', url: this.url('/drive/v3/files', query), what: 'listing a folder' }), 'file list');
    return { files: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  /** Revisions of a file, oldest first. */
  async revisions(fileId: string): Promise<DriveRevision[]> {
    const revisions: DriveRevision[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_REVISION_PAGES; page += 1) {
      const url = this.url(`/drive/v3/files/${encodeURIComponent(checkDriveId(fileId))}/revisions`, {
        fields: `nextPageToken,revisions(${REVISION_FIELDS})`,
        pageSize: '200',
        supportsAllDrives: 'true',
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      const answer: z.infer<typeof RevisionList> = parse(RevisionList, await this.json({ method: 'GET', url, what: `listing the revisions of file ${fileId}` }), 'revision list');
      revisions.push(...answer.revisions);
      pageToken = answer.nextPageToken;
      if (!pageToken) break;
    }
    return revisions;
  }

  /** Sets `keepForever` on a revision of a binary file. */
  async keepForever(fileId: string, revisionId: string): Promise<DriveRevision> {
    const url = this.url(
      `/drive/v3/files/${encodeURIComponent(checkDriveId(fileId))}/revisions/${encodeURIComponent(checkDriveId(revisionId, 'revision id'))}`,
      { fields: REVISION_FIELDS, supportsAllDrives: 'true' },
    );
    // Setting the same flag twice is harmless, so the PATCH may be repeated.
    return parse(DriveRevision, await this.json({ method: 'PATCH', url, json: { keepForever: true }, idempotent: true, what: `pinning revision ${revisionId}` }), 'revision');
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const url = this.url('/drive/v3/files', { fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const body = { name, mimeType: FOLDER_MIME, parents: [checkDriveId(parentId, 'folder id')] };
    return parse(DriveFile, await this.json({ method: 'POST', url, json: body, what: `creating folder ${name}` }), 'folder');
  }

  async copy(fileId: string, parentId: string, name: string): Promise<DriveFile> {
    const url = this.url(`/drive/v3/files/${encodeURIComponent(checkDriveId(fileId))}/copy`, { fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const body = { name, parents: [checkDriveId(parentId, 'folder id')] };
    return parse(DriveFile, await this.json({ method: 'POST', url, json: body, what: `copying file ${fileId}` }), 'file');
  }

  async sharedDrive(driveId: string): Promise<z.infer<typeof SharedDrive>> {
    const url = this.url(`/drive/v3/drives/${encodeURIComponent(checkDriveId(driveId, 'drive id'))}`, { fields: 'id,name' });
    return parse(SharedDrive, await this.json({ method: 'GET', url, what: 'reading the shared drive' }), 'shared drive');
  }

  /** The account of the session's token. */
  async about(): Promise<{ emailAddress?: string; displayName?: string }> {
    const url = this.url('/drive/v3/about', { fields: 'user(displayName,emailAddress)' });
    return parse(About, await this.json({ method: 'GET', url, what: 'reading the account' }), 'about').user;
  }

  // Uploads -----------------------------------------------------------------------------------------------------

  /** A new file in one multipart request (metadata and content). */
  async uploadMultipart(parentId: string, name: string, content: Buffer, contentType: string): Promise<DriveFile> {
    let boundary = `mscd-${randomBytes(16).toString('hex')}`;
    while (content.includes(boundary)) boundary = `mscd-${randomBytes(16).toString('hex')}`;
    const metadata = JSON.stringify({ name, parents: [checkDriveId(parentId, 'folder id')] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const url = this.url('/upload/drive/v3/files', { uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const response = await this.send({
      method: 'POST',
      url,
      body,
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      timeoutMs: this.deps.uploadTimeoutMs,
      what: `uploading ${name}`,
    });
    return parse(DriveFile, await readJson(response, 'google_drive'), 'file');
  }

  /** Starts a resumable upload of a new file; returns the session URL. */
  async startResumable(parentId: string, name: string, contentType: string, length: number | null): Promise<URL> {
    const url = this.url('/upload/drive/v3/files', { uploadType: 'resumable', fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const response = await this.send({
      method: 'POST',
      url,
      json: { name, parents: [checkDriveId(parentId, 'folder id')] },
      headers: { 'x-upload-content-type': contentType, ...(length !== null ? { 'x-upload-content-length': String(length) } : {}) },
      what: `starting the upload of ${name}`,
    });
    const location = response.headers.get('location');
    await discard(response);
    if (!location) throw unexpectedAnswer('google_drive', 'resumable upload without a session URL');
    let session: URL;
    try {
      session = new URL(location, this.deps.apiBaseUrl);
    } catch {
      throw unexpectedAnswer('google_drive', 'resumable session URL');
    }
    this.deps.http.egress.assertAllowed(session, 'issued');
    return session;
  }

  /**
   * Sends one chunk of a resumable upload (`total` null while the length is unknown); returns the file when the
   * upload is complete, null when Drive expects more (308).
   */
  async uploadChunk(session: URL, chunk: Buffer, start: number, total: number | null): Promise<DriveFile | null> {
    const end = start + chunk.length - 1;
    const range = chunk.length === 0 ? `bytes */${total ?? start}` : `bytes ${start}-${end}/${total ?? '*'}`;
    const response = await this.deps.http.send({
      method: 'PUT',
      url: session,
      target: 'issued',
      body: chunk,
      headers: { 'content-range': range },
      accept: [308],
      idempotent: false,
      timeoutMs: this.deps.uploadTimeoutMs,
      signal: this.ctx.signal,
      what: 'uploading a file chunk',
    });
    if (response.status === 308) {
      const received = response.headers.get('range');
      await discard(response);
      const expected = `bytes=0-${end}`;
      if (chunk.length > 0 && received !== expected) {
        throw new ProviderError('unreachable', `Google Drive received ${received ?? 'nothing'} of the upload, expected ${expected}`, {
          provider: 'google_drive',
          status: 308,
          code: null,
        });
      }
      return null;
    }
    return parse(DriveFile, await readJson(response, 'google_drive'), 'file');
  }

  /** Cancels a resumable upload (best effort). */
  async cancelResumable(session: URL): Promise<void> {
    try {
      const response = await this.deps.http.send({ method: 'DELETE', url: session, target: 'issued', accept: [404, 499], signal: AbortSignal.timeout(10_000) });
      await discard(response);
    } catch {
      // The session expires on its own.
    }
  }

  // Downloads -------------------------------------------------------------------------------------------------------

  /** Content of the head revision, or of one revision, as a stream. */
  async media(fileId: string, revisionId: string | null): Promise<{ stream: Readable; size: number | null }> {
    const path =
      revisionId === null
        ? `/drive/v3/files/${encodeURIComponent(checkDriveId(fileId))}`
        : `/drive/v3/files/${encodeURIComponent(checkDriveId(fileId))}/revisions/${encodeURIComponent(checkDriveId(revisionId, 'revision id'))}`;
    const response = await this.send({
      method: 'GET',
      url: this.url(path, { alt: 'media', supportsAllDrives: 'true' }),
      // The bytes as stored: the gateway passes their exact length on (`Content-Length`).
      headers: { accept: '*/*', 'accept-encoding': 'identity' },
      timeoutMs: this.deps.uploadTimeoutMs,
      what: `downloading file ${fileId}`,
    });
    if (!response.body) throw unexpectedAnswer('google_drive', 'download without a body');
    const header = response.headers.get('content-length');
    const length = Number(header);
    return {
      stream: Readable.fromWeb(response.body as unknown as WebReadableStream),
      size: header !== null && Number.isSafeInteger(length) && length >= 0 ? length : null,
    };
  }

  // Plumbing ------------------------------------------------------------------------------------------------------

  private url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${this.deps.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  /** An API call with the session's token; a 401 answer is retried once with a new token. */
  private async send(request: Omit<ProviderRequest, 'signal'>): Promise<Response> {
    const first = await this.tokens.token();
    try {
      return await this.deps.http.send({ ...request, signal: this.ctx.signal, headers: { ...request.headers, authorization: `Bearer ${first}` } });
    } catch (error) {
      if (!(error instanceof ProviderError) || error.providerStatus !== 401) throw error;
      this.tokens.invalidate(first);
      const second = await this.tokens.token();
      return this.deps.http.send({ ...request, signal: this.ctx.signal, headers: { ...request.headers, authorization: `Bearer ${second}` } });
    }
  }

  private async json(request: Omit<ProviderRequest, 'signal'>): Promise<unknown> {
    return readJson(await this.send(request), 'google_drive');
  }
}
