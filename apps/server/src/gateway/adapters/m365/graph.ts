// Microsoft Graph v1.0 calls of the Microsoft 365 adapter (build plan D.5): drive, item by id and by path,
// children, versions, folder creation, simple upload (up to 4 MiB), upload sessions, asynchronous copy with a
// monitor URL, and content downloads. Every id is checked against the Graph pattern before use, every path segment
// passes through `encodeURIComponent`, and queries are built with `URLSearchParams`. URLs Graph hands out (upload
// sessions, copy monitors, download links) are pre-authenticated: they get no `Authorization` header and pass the
// egress policy as `issued` targets.
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { GRAPH_ID_RE } from '@mscd/shared';
import { z } from 'zod';
import type { AdapterContext } from '../types';
import { badRequest, GatewayError } from '../../problems';
import type { M365Credential } from './credential';
import type { EntraTokens } from './entra-token';
import { ProviderError, unexpectedAnswer } from './provider/errors';
import type { Response } from 'undici';
import { discard, readJson, type ProviderHttp, type ProviderRequest } from './provider/http';
import { encodePath } from './provider/paths';

const Identity = z
  .looseObject({
    user: z.looseObject({ displayName: z.string().optional(), email: z.string().optional() }).optional(),
    application: z.looseObject({ displayName: z.string().optional() }).optional(),
  })
  .optional();

export const GraphItem = z.looseObject({
  id: z.string().regex(GRAPH_ID_RE),
  name: z.string(),
  size: z.number().int().min(0).optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  createdBy: Identity,
  lastModifiedBy: Identity,
  parentReference: z
    .looseObject({ driveId: z.string().optional(), driveType: z.string().optional(), id: z.string().optional(), path: z.string().optional() })
    .optional(),
  file: z.looseObject({ mimeType: z.string().optional(), hashes: z.looseObject({ quickXorHash: z.string().optional() }).optional() }).optional(),
  folder: z.looseObject({}).optional(),
  root: z.looseObject({}).optional(),
  package: z.looseObject({}).optional(),
  webUrl: z.string().optional(),
  description: z.string().nullable().optional(),
});
export type GraphItem = z.infer<typeof GraphItem>;

const GraphItemPage = z.looseObject({ value: z.array(GraphItem), '@odata.nextLink': z.string().optional() });
const GraphVersion = z.looseObject({ id: z.string().min(1), lastModifiedDateTime: z.string().optional(), size: z.number().optional() });
export type GraphVersion = z.infer<typeof GraphVersion>;
const GraphVersionPage = z.looseObject({ value: z.array(GraphVersion), '@odata.nextLink': z.string().optional() });
export const GraphDrive = z.looseObject({ id: z.string(), driveType: z.string().optional(), name: z.string().optional(), webUrl: z.string().optional() });
export type GraphDrive = z.infer<typeof GraphDrive>;
const UploadSession = z.looseObject({ uploadUrl: z.string().min(1) });
const CopyStatus = z.looseObject({
  status: z.string(),
  resourceId: z.string().optional(),
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

/** Fields asked for on every item. */
const ITEM_SELECT = 'id,name,size,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,parentReference,file,folder,root,package,webUrl,description';
/** Items per children page. */
export const CHILDREN_PAGE_SIZE = 200;
/** Version list pages followed at most (Graph pages long version histories). */
const MAX_VERSION_PAGES = 50;
/** Query parameters of a children `@odata.nextLink` that the adapter carries in its page token. */
const PAGE_PARAMS = ['$skiptoken', '$skipToken', '$top'];
const PAGE_TOKEN_PREFIX = 'g1.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Downloads ask for the bytes as stored: the gateway passes their exact length on (`Content-Length`). */
const DOWNLOAD_HEADERS = { accept: '*/*', 'accept-encoding': 'identity' };

/** A Graph drive or item id from a caller, checked against the D.5 pattern before any request. */
export function checkGraphId(id: string, what = 'item id'): string {
  if (!GRAPH_ID_RE.test(id) || id.length > 300) throw badRequest(`The Microsoft 365 ${what} is not valid (D.5 pattern [A-Za-z0-9!_-]+)`);
  return id;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unexpectedAnswer('m365', what);
  return result.data;
}

export interface GraphSessionDeps {
  http: ProviderHttp;
  tokens: EntraTokens;
  graphBaseUrl: string;
  /** Polls of a copy monitor: first wait, longest wait and the total time allowed. */
  copyPoll: { initialMs: number; maxMs: number; timeoutMs: number };
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Timeout of upload requests (fragments of several MiB). */
  uploadTimeoutMs: number;
}

/** The Graph calls of one gateway call: one drive, one credential, the caller's abort signal. */
export class GraphSession {
  private readonly base: string;

  constructor(
    private readonly deps: GraphSessionDeps,
    private readonly ctx: AdapterContext,
    readonly driveId: string,
    private readonly credential: M365Credential,
  ) {
    this.base = deps.graphBaseUrl;
    checkGraphId(driveId, 'drive id');
  }

  /** The access token of the call's credential (cached across calls). */
  token(): Promise<string> {
    return this.deps.tokens.token(this.credential);
  }

  // Drive and items ------------------------------------------------------------------------------------------

  async drive(): Promise<GraphDrive> {
    const url = this.url(`/drives/${encodeURIComponent(this.driveId)}`, { $select: 'id,driveType,name,webUrl' });
    return parse(GraphDrive, await this.json({ method: 'GET', url, what: 'reading the drive' }), 'drive');
  }

  async item(itemId: string): Promise<GraphItem> {
    const url = this.url(`${this.itemPath(itemId)}`, { $select: ITEM_SELECT });
    return parse(GraphItem, await this.json({ method: 'GET', url, what: `reading item ${itemId}` }), 'drive item');
  }

  /** The item at a path below a folder; null when nothing is there. */
  async itemByPath(baseId: string, segments: readonly string[]): Promise<GraphItem | null> {
    if (segments.length === 0) return this.item(baseId);
    const url = this.url(`${this.itemPath(baseId)}:/${encodePath(segments)}:`, { $select: ITEM_SELECT });
    const response = await this.send({ method: 'GET', url, accept: [404], what: 'looking up a folder path' });
    if (response.status === 404) {
      await discard(response);
      return null;
    }
    return parse(GraphItem, await readJson(response, 'm365'), 'drive item');
  }

  /** One page of a folder's children. */
  async children(folderId: string, pageToken?: string): Promise<{ items: GraphItem[]; nextPageToken?: string }> {
    const query: Record<string, string> = { $top: String(CHILDREN_PAGE_SIZE), $select: ITEM_SELECT };
    if (pageToken !== undefined) Object.assign(query, decodePageToken(pageToken));
    const url = this.url(`${this.itemPath(folderId)}/children`, query);
    const page = parse(GraphItemPage, await this.json({ method: 'GET', url, what: 'listing a folder' }), 'children page');
    const next = page['@odata.nextLink'];
    return { items: page.value, ...(next ? { nextPageToken: encodePageToken(next) } : {}) };
  }

  /** Versions of a file, newest (current) first. */
  async versions(itemId: string): Promise<GraphVersion[]> {
    const versions: GraphVersion[] = [];
    let url: URL | null = this.url(`${this.itemPath(itemId)}/versions`);
    for (let page = 0; url && page < MAX_VERSION_PAGES; page += 1) {
      const answer: z.infer<typeof GraphVersionPage> = parse(
        GraphVersionPage,
        await this.json({ method: 'GET', url, what: `listing the versions of item ${itemId}` }),
        'version list',
      );
      versions.push(...answer.value);
      const next: string | undefined = answer['@odata.nextLink'];
      url = next ? this.continuation(next) : null;
    }
    return versions;
  }

  /** Creates a folder; null when an item of that name exists already (conflict behaviour `fail`). */
  async createFolder(parentId: string, name: string): Promise<GraphItem | null> {
    const url = this.url(`${this.itemPath(parentId)}/children`, { $select: ITEM_SELECT });
    const response = await this.send({
      method: 'POST',
      url,
      json: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      accept: [409],
      what: `creating folder ${name}`,
    });
    if (response.status === 409) {
      await discard(response);
      return null;
    }
    return parse(GraphItem, await readJson(response, 'm365'), 'drive item');
  }

  // Uploads -----------------------------------------------------------------------------------------------------

  /** Simple upload (at most 4 MiB) of a new file; a name in use gets a new name (conflict behaviour `rename`). */
  async uploadSmall(folderId: string, name: string, content: Buffer): Promise<GraphItem> {
    const url = this.url(`${this.itemPath(folderId)}:/${encodeURIComponent(name)}:/content`, { '@microsoft.graph.conflictBehavior': 'rename' });
    const response = await this.send({
      method: 'PUT',
      url,
      body: content,
      headers: { 'content-type': 'application/octet-stream' },
      // A repeated PUT after a lost answer would store a second, renamed copy.
      idempotent: false,
      timeoutMs: this.deps.uploadTimeoutMs,
      what: `uploading ${name}`,
    });
    return parse(GraphItem, await readJson(response, 'm365'), 'drive item');
  }

  /** Starts an upload session for a new file; returns its pre-authenticated upload URL. */
  async createUploadSession(folderId: string, name: string): Promise<URL> {
    const url = this.url(`${this.itemPath(folderId)}:/${encodeURIComponent(name)}:/createUploadSession`);
    const answer = parse(
      UploadSession,
      await this.json({ method: 'POST', url, json: { item: { '@microsoft.graph.conflictBehavior': 'rename' } }, what: `starting the upload of ${name}` }),
      'upload session',
    );
    const uploadUrl = parseUrl(answer.uploadUrl, 'upload session URL');
    this.deps.http.egress.assertAllowed(uploadUrl, 'issued');
    return uploadUrl;
  }

  /** Sends one fragment; returns the item when the upload is complete. */
  async uploadFragment(uploadUrl: URL, fragment: Buffer, start: number, total: number): Promise<GraphItem | null> {
    const response = await this.deps.http.send({
      method: 'PUT',
      url: uploadUrl,
      target: 'issued',
      body: fragment,
      headers: { 'content-range': `bytes ${start}-${start + fragment.length - 1}/${total}`, 'content-type': 'application/octet-stream' },
      idempotent: false,
      timeoutMs: this.deps.uploadTimeoutMs,
      signal: this.ctx.signal,
      what: 'uploading a file fragment',
    });
    if (response.status === 202) {
      await discard(response);
      return null;
    }
    return parse(GraphItem, await readJson(response, 'm365'), 'drive item');
  }

  /** Cancels an upload session (best effort). */
  async cancelUploadSession(uploadUrl: URL): Promise<void> {
    try {
      const response = await this.deps.http.send({ method: 'DELETE', url: uploadUrl, target: 'issued', accept: [404], signal: AbortSignal.timeout(10_000) });
      await discard(response);
    } catch {
      // The session expires on its own.
    }
  }

  // Copies and downloads ------------------------------------------------------------------------------------------

  /** Copies an item into a folder of the same drive and waits for the copy; returns the new item id. */
  async copy(itemId: string, targetFolderId: string, name: string): Promise<string> {
    const url = this.url(`${this.itemPath(itemId)}/copy`, { '@microsoft.graph.conflictBehavior': 'rename' });
    const response = await this.send({
      method: 'POST',
      url,
      json: { parentReference: { driveId: this.driveId, id: targetFolderId }, name },
      what: `copying item ${itemId}`,
    });
    const location = response.headers.get('location');
    await discard(response);
    if (response.status !== 202 || !location) throw unexpectedAnswer('m365', 'copy accepted without a monitor URL');
    const monitor = parseUrl(location, 'copy monitor URL');
    this.deps.http.egress.assertAllowed(monitor, 'issued');
    return this.awaitCopy(monitor, itemId);
  }

  /**
   * The current content, or one version's, as a stream. Graph answers with a redirect to a pre-authenticated
   * download URL, which is followed without the Authorization header after the egress check.
   */
  async content(itemId: string, versionId: string | null): Promise<{ stream: Readable; size: number | null }> {
    const path = versionId === null ? `${this.itemPath(itemId)}/content` : `${this.itemPath(itemId)}/versions/${encodeURIComponent(versionId)}/content`;
    let response = await this.send({
      method: 'GET',
      url: this.url(path),
      accept: [302, 303, 307],
      headers: DOWNLOAD_HEADERS,
      timeoutMs: this.deps.uploadTimeoutMs,
      what: `opening the content of item ${itemId}`,
    });
    if (response.status >= 300) {
      const location = response.headers.get('location');
      await discard(response);
      if (!location) throw unexpectedAnswer('m365', 'redirect without a download URL');
      const download = parseUrl(location, 'download URL', this.base);
      response = await this.deps.http.send({
        method: 'GET',
        url: download,
        target: 'issued',
        headers: DOWNLOAD_HEADERS,
        signal: this.ctx.signal,
        timeoutMs: this.deps.uploadTimeoutMs,
        what: 'downloading content',
      });
    }
    if (!response.body) throw unexpectedAnswer('m365', 'download without a body');
    const header = response.headers.get('content-length');
    const length = Number(header);
    return {
      stream: Readable.fromWeb(response.body as unknown as WebReadableStream),
      size: header !== null && Number.isSafeInteger(length) && length >= 0 ? length : null,
    };
  }

  // Plumbing ------------------------------------------------------------------------------------------------------

  private itemPath(itemId: string): string {
    return `/drives/${encodeURIComponent(this.driveId)}/items/${encodeURIComponent(checkGraphId(itemId))}`;
  }

  private url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  /** A Graph `@odata.nextLink`: followed only below the configured Graph base URL. */
  private continuation(link: string): URL {
    const url = parseUrl(link, 'next page link');
    this.deps.http.egress.assertAllowed(url, 'api');
    return url;
  }

  private async awaitCopy(monitor: URL, itemId: string): Promise<string> {
    const { initialMs, maxMs, timeoutMs } = this.deps.copyPoll;
    const deadline = Date.now() + timeoutMs;
    let wait = initialMs;
    for (;;) {
      const response = await this.deps.http.send({ method: 'GET', url: monitor, target: 'issued', accept: [202, 303], signal: this.ctx.signal, what: 'waiting for a copy' });
      if (response.status === 303) {
        // Some monitors redirect to the new item when the copy is done.
        const location = response.headers.get('location') ?? '';
        await discard(response);
        const id = /\/items\/([^/?#]+)/.exec(location)?.[1];
        if (!id || !GRAPH_ID_RE.test(id)) throw unexpectedAnswer('m365', 'copy monitor redirect without an item');
        return id;
      }
      const status = parse(CopyStatus, await readJson(response, 'm365'), 'copy status');
      if (status.status === 'completed') {
        if (!status.resourceId || !GRAPH_ID_RE.test(status.resourceId)) throw unexpectedAnswer('m365', 'completed copy without a valid resourceId');
        return status.resourceId;
      }
      if (status.status === 'failed') {
        const reason = status.error?.message ?? status.error?.code ?? 'unknown reason';
        throw new ProviderError('unreachable', `Microsoft 365 could not copy item ${itemId}: ${reason}`, { provider: 'm365', status: null, code: status.error?.code ?? null });
      }
      if (Date.now() + wait > deadline) {
        throw new GatewayError('unreachable', `Microsoft 365 did not finish copying item ${itemId} within ${Math.round(timeoutMs / 1000)} seconds`);
      }
      await this.deps.sleep(wait, this.ctx.signal);
      wait = Math.min(maxMs, wait * 2);
    }
  }

  /** An API call with the call's token; a 401 answer is retried once with a new token. */
  private async send(request: Omit<ProviderRequest, 'signal'>): Promise<Response> {
    const first = await this.token();
    try {
      return await this.deps.http.send({ ...request, signal: this.ctx.signal, headers: this.headers(first, request.headers) });
    } catch (error) {
      if (!(error instanceof ProviderError) || error.providerStatus !== 401) throw error;
      this.deps.tokens.invalidate(this.credential, first);
      const second = await this.token();
      return this.deps.http.send({ ...request, signal: this.ctx.signal, headers: this.headers(second, request.headers) });
    }
  }

  private async json(request: Omit<ProviderRequest, 'signal'>): Promise<unknown> {
    return readJson(await this.send(request), 'm365');
  }

  private headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      ...(UUID.test(this.ctx.requestId) ? { 'client-request-id': this.ctx.requestId } : {}),
      ...extra,
    };
  }
}

function parseUrl(value: string, what: string, base?: string): URL {
  try {
    return new URL(value, base);
  } catch {
    throw unexpectedAnswer('m365', what);
  }
}

/** The page token handed to the caller: the paging parameters of Graph's next link, base64url JSON. */
function encodePageToken(nextLink: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(nextLink).searchParams;
  } catch {
    throw unexpectedAnswer('m365', 'next page link');
  }
  const kept: Record<string, string> = {};
  for (const name of PAGE_PARAMS) {
    const value = params.get(name);
    if (value !== null) kept[name] = value;
  }
  if (Object.keys(kept).length === 0) throw unexpectedAnswer('m365', 'next page link without $skiptoken');
  return `${PAGE_TOKEN_PREFIX}${Buffer.from(JSON.stringify(kept), 'utf8').toString('base64url')}`;
}

function decodePageToken(token: string): Record<string, string> {
  const invalid = () => badRequest('The page token is not valid for this listing');
  if (!token.startsWith(PAGE_TOKEN_PREFIX)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token.slice(PAGE_TOKEN_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!PAGE_PARAMS.includes(key) || typeof entry !== 'string' || entry.length > 2048) throw invalid();
    out[key] = entry;
  }
  return out;
}
