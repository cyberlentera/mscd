// Microsoft 365 adapter of the storage gateway (build plan D.5, TS 5.1 to 5.3, WP-15): SharePoint Online document
// libraries and OneDrive for Business drives through Microsoft Graph, authenticated as an Entra ID application
// with a certificate. Every item the adapter reads, links, lists, copies or verifies must lie below the
// repository's root folder (`config.rootFolderId`), and below the call's system folder (`scopeRoot`) when the call
// acts for one management system; item paths come from Graph (`parentReference.path`) and compare without regard
// to case, as SharePoint names do. Provider hashes are quickXorHash; pass-through uploads compute SHA-256 (and
// check the quickXorHash Graph reports) while streaming. Microsoft 365 has no version pinning: `pin-version`
// answers `unsupported` through the gateway core.
import {
  M365RepositoryConfig,
  type CopyWithinResult,
  type GatewayObjectRef,
  type ListResponse,
  type ObjectMetadata,
  type OpenUrlResult,
  type OwnershipType,
  type PutResult,
  type ScopeRoot,
  type StatResult,
  type TestConnectionResponse,
} from '@mscd/shared';
import type { MscdConfig } from '../../../config/mscd-config';
import { badRequest, forbidden, GatewayError, notFound, outsideRoot, tooLarge, unsupported } from '../../problems';
import type { AdapterContext, AdapterFactory, PutInput, RegisterClientUploadInput, StorageAdapter, StreamResult } from '../types';
import { readM365Credential, type M365Credential } from './credential';
import { EntraTokens } from './entra-token';
import { checkGraphId, GraphSession, type GraphItem, type GraphSessionDeps, type GraphVersion } from './graph';
import { EgressPolicy } from './provider/egress';
import { parseProviderError, unexpectedAnswer } from './provider/errors';
import { ProviderHttp } from './provider/http';
import { tokenRoles } from './provider/oauth';
import {
  chunkSize,
  DEFAULT_COPY_POLL,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  SIMPLE_UPLOAD_MAX_BYTES,
  USER_AGENT,
  waitFor,
  type ProviderAdapterOptions,
} from './provider/options';
import { checkItemName, joinPath, pathSegments, samePath, startsWithPath } from './provider/paths';
import { connectionFailure, statFailure } from './provider/results';
import { detectAndReplay, meterUpload, type MeteredUpload } from './provider/streams';
import { TokenCache } from './provider/token-cache';
import { QuickXorHash } from './quickxor';

export const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
export const DEFAULT_LOGIN_BASE_URL = 'https://login.microsoftonline.com';
/** Hosts Graph hands out upload session, copy monitor and download URLs on (SharePoint and OneDrive for Business). */
const GRAPH_ISSUED_HOSTS = ['.sharepoint.com', 'api.onedrive.com'];
/** Upload session fragments must be multiples of 320 KiB (Graph "Upload large files"). */
export const GRAPH_FRAGMENT_MULTIPLE = 320 * 1024;
const DEFAULT_FRAGMENT_BYTES = 16 * GRAPH_FRAGMENT_MULTIPLE;
/** Depth of a parent walk when Graph sends no `parentReference.path`. */
const MAX_PARENT_WALK = 64;

export interface M365AdapterSettings {
  graphBaseUrl: string;
  loginBaseUrl: string;
  /** `network.egress_allowlist` (I.1). */
  egressAllowlist: readonly string[];
  demo: boolean;
}

/** A located item: the Graph item and its path from the drive root (its own name last; none for the drive root). */
interface Placed {
  item: GraphItem;
  segments: string[];
}

interface CurrentVersion {
  id: string;
  label: string;
}

/** The provider settings of the deployment profile (I.1 `gateway.providers.m365`, `network.egress_allowlist`). */
export function m365SettingsFromConfig(config: MscdConfig): M365AdapterSettings {
  const { profile } = config;
  return {
    graphBaseUrl: profile.gateway.providers.m365.graph_base_url,
    loginBaseUrl: profile.gateway.providers.m365.login_base_url,
    egressAllowlist: profile.network.egress_allowlist,
    demo: profile.demo.enabled,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function instant(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function displayName(identity: GraphItem['createdBy']): string | null {
  return identity?.user?.displayName ?? identity?.application?.displayName ?? null;
}

/** Graph version ids are `1.0`, `2.0`, ... in SharePoint; other ids are labelled by their position. */
function currentVersionOf(versions: readonly GraphVersion[]): CurrentVersion | null {
  const current = versions[0];
  if (!current) return null;
  return { id: current.id, label: /^\d+(\.\d+)?$/.test(current.id) ? `v${current.id}` : `v${versions.length}` };
}

/** Folder names of `parentReference.path` (`/drives/{id}/root:/A/B`, percent-encoded); null when it has no root marker. */
function parseParentPath(path: string): string[] | null {
  const marker = path.indexOf('root:');
  if (marker === -1) return null;
  const segments: string[] = [];
  for (const raw of path.slice(marker + 'root:'.length).split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      segments.push(raw);
    }
  }
  return segments;
}

function toMetadata(item: GraphItem, version: CurrentVersion | null, segments: readonly string[]): ObjectMetadata {
  const hash = item.file?.hashes?.quickXorHash;
  const createdByEmail = item.createdBy?.user?.email;
  return {
    externalItemId: item.id,
    externalVersionId: version?.id ?? null,
    versionLabel: version?.label ?? null,
    name: item.name,
    mimeType: item.file?.mimeType ?? null,
    sizeBytes: item.size ?? null,
    hashAlgorithm: hash ? 'quickxor' : 'none',
    hashValue: hash ?? null,
    hashSource: hash ? 'provider' : 'none',
    providerCreatedAt: instant(item.createdDateTime),
    providerModifiedAt: instant(item.lastModifiedDateTime),
    modifiedBy: displayName(item.lastModifiedBy),
    ...(createdByEmail ? { createdByEmail } : {}),
    folderPath: joinPath(segments.slice(0, -1)),
    folderId: item.parentReference?.id ?? null,
    webUrl: item.webUrl ?? null,
  };
}

/** Root enforcement and folder handling of one gateway call. */
class M365Call {
  readonly graph: GraphSession;
  private rootPlaced: Promise<Placed> | null = null;
  private readonly folderPaths = new Map<string, Promise<string[]>>();

  constructor(
    deps: GraphSessionDeps,
    ctx: AdapterContext,
    readonly config: M365RepositoryConfig,
    credential: M365Credential,
  ) {
    this.graph = new GraphSession(deps, ctx, config.driveId, credential);
  }

  /** The repository root folder (`config.rootFolderId`) and its path. */
  root(): Promise<Placed> {
    this.rootPlaced ??= (async () => {
      const item = await this.graph.item(this.config.rootFolderId);
      if (!item.folder && !item.root) throw notFound(`The root folder ${this.config.rootFolderId} of the repository is not a folder`);
      return { item, segments: await this.segmentsOf(item) };
    })();
    return this.rootPlaced;
  }

  /** The call's system folder: the root folder or one of `config.roots`, lying below the root folder. */
  async scope(scopeRoot: ScopeRoot): Promise<Placed> {
    if (scopeRoot.folderId === null) throw outsideRoot('The call names no folder of the repository');
    const folderId = checkGraphId(scopeRoot.folderId, 'folder id');
    const root = await this.root();
    if (folderId === this.config.rootFolderId) return root;
    if (!Object.values(this.config.roots).some((entry) => entry.folderId === folderId)) {
      throw outsideRoot('The scope root is not a root folder of this repository');
    }
    const item = await this.graph.item(folderId);
    if (!item.folder) throw notFound(`The system folder ${folderId} is not a folder`);
    const segments = await this.segmentsOf(item);
    if (segments.length <= root.segments.length || !startsWithPath(segments, root.segments, true)) {
      throw outsideRoot(`The system folder ${joinPath(segments)} is not below the repository root folder ${joinPath(root.segments) || '(drive root)'}`);
    }
    return { item, segments };
  }

  /** The path of an item that must lie below `within`; `outside-root` otherwise. */
  async within(item: GraphItem, within: Placed): Promise<string[]> {
    const segments = await this.segmentsOf(item);
    if (segments.length <= within.segments.length || !startsWithPath(segments, within.segments, true)) {
      throw outsideRoot(`The item is not below ${joinPath(within.segments) || 'the drive root'}`);
    }
    return segments;
  }

  /** Path segments of an item from the drive root. */
  async segmentsOf(item: GraphItem): Promise<string[]> {
    if (item.root) return [];
    const reference = item.parentReference;
    if (reference?.driveId && reference.driveId.toLowerCase() !== this.config.driveId.toLowerCase()) {
      throw outsideRoot('The item belongs to another drive');
    }
    const parsed = reference?.path !== undefined ? parseParentPath(reference.path) : null;
    if (parsed) return [...parsed, item.name];
    if (!reference?.id) throw unexpectedAnswer('m365', 'item without a parent reference');
    return [...(await this.folderPath(reference.id, 0)), item.name];
  }

  /** Path of a folder by its id, walking parents (only when Graph sent no `parentReference.path`). */
  private folderPath(folderId: string, depth: number): Promise<string[]> {
    let known = this.folderPaths.get(folderId);
    if (!known) {
      known = (async () => {
        if (depth > MAX_PARENT_WALK) throw unexpectedAnswer('m365', 'folder chain deeper than expected');
        const folder = await this.graph.item(folderId);
        if (folder.root) return [];
        const parentId = folder.parentReference?.id;
        const parsed = folder.parentReference?.path !== undefined ? parseParentPath(folder.parentReference.path) : null;
        if (parsed) return [...parsed, folder.name];
        if (!parentId) throw unexpectedAnswer('m365', 'folder without a parent reference');
        return [...(await this.folderPath(parentId, depth + 1)), folder.name];
      })();
      this.folderPaths.set(folderId, known);
    }
    return known;
  }

  async currentVersion(itemId: string): Promise<CurrentVersion | null> {
    return currentVersionOf(await this.graph.versions(itemId));
  }

  /** A folder path from the drive root that lies below the root folder, created where missing. */
  async ensureFolderPath(path: string): Promise<Placed> {
    const segments = pathSegments(path);
    if (segments.length === 0) throw badRequest('The folder path is empty');
    const root = await this.root();
    if (!startsWithPath(segments, root.segments, true)) {
      throw outsideRoot(`The folder ${joinPath(segments)} is not below the repository root folder ${joinPath(root.segments) || '(drive root)'}`);
    }
    return this.ensureFolders(root, segments.slice(root.segments.length));
  }

  /** The folder at `relative` below `base`, created segment by segment where missing. */
  async ensureFolders(base: Placed, relative: readonly string[]): Promise<Placed> {
    if (relative.length === 0) return base;
    const existing = await this.graph.itemByPath(base.item.id, relative);
    if (existing) {
      if (!existing.folder) throw badRequest(`${joinPath([...base.segments, ...relative])} is a file, not a folder`);
      return { item: existing, segments: await this.segmentsOf(existing) };
    }
    let current = base;
    for (const segment of relative) {
      const name = checkItemName(segment, 'folder name');
      let child = await this.graph.itemByPath(current.item.id, [name]);
      // Another call may create the folder between the lookup and the creation (409): look it up again.
      child ??= (await this.graph.createFolder(current.item.id, name)) ?? (await this.graph.itemByPath(current.item.id, [name]));
      if (!child) throw unexpectedAnswer('m365', `folder ${name} was neither found nor created`);
      if (!child.folder) throw badRequest(`${joinPath([...current.segments, child.name])} is a file, not a folder`);
      current = { item: child, segments: [...current.segments, child.name] };
    }
    return current;
  }
}

export class M365Adapter implements StorageAdapter {
  readonly adapter = 'm365' as const;
  private readonly http: ProviderHttp;
  private readonly deps: GraphSessionDeps;
  private readonly tokens: EntraTokens;
  private readonly loginBaseUrl: string;
  private readonly now: () => Date;
  private readonly fragmentBytes: number;

  constructor(settings: M365AdapterSettings, options: ProviderAdapterOptions = {}) {
    const graphBaseUrl = trimSlash(settings.graphBaseUrl);
    this.loginBaseUrl = trimSlash(settings.loginBaseUrl);
    this.now = options.now ?? (() => new Date());
    const egress = EgressPolicy.create({
      endpoints: [
        { setting: 'gateway.providers.m365.graph_base_url', url: graphBaseUrl, defaultUrl: DEFAULT_GRAPH_BASE_URL, issuedHosts: GRAPH_ISSUED_HOSTS },
        { setting: 'gateway.providers.m365.login_base_url', url: this.loginBaseUrl, defaultUrl: DEFAULT_LOGIN_BASE_URL },
      ],
      allowlist: settings.egressAllowlist,
      demo: settings.demo,
    });
    const sleep = options.sleep ?? waitFor;
    this.http = new ProviderHttp({
      provider: 'm365',
      egress,
      parseError: parseProviderError,
      userAgent: USER_AGENT,
      dispatcher: options.dispatcher,
      retry: options.retry,
      sleep,
      timeoutMs: options.requestTimeoutMs,
      now: () => this.now().getTime(),
    });
    this.tokens = new EntraTokens(this.http, this.loginBaseUrl, options.tokenCache ?? new TokenCache({ now: () => this.now().getTime() }), this.now);
    this.fragmentBytes = chunkSize(options.uploadChunkBytes, DEFAULT_FRAGMENT_BYTES, GRAPH_FRAGMENT_MULTIPLE, 'Microsoft 365');
    this.deps = {
      http: this.http,
      tokens: this.tokens,
      graphBaseUrl,
      copyPoll: { ...DEFAULT_COPY_POLL, ...options.copyPoll },
      sleep,
      uploadTimeoutMs: options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    };
  }

  validateConfig(_orgId: string, config: Record<string, unknown>): void {
    const parsed = M365RepositoryConfig.safeParse(config);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`The Microsoft 365 repository config is not valid${issue ? ` at ${issue.path.map(String).join('.') || 'config'}: ${issue.message}` : ''}`);
    }
  }

  async testConnection(ctx: AdapterContext): Promise<Omit<TestConnectionResponse, 'latencyMs'>> {
    let ownership: OwnershipType = 'organizational';
    let credential: M365Credential;
    try {
      credential = readM365Credential(ctx.credential, this.loginBaseUrl);
    } catch (error) {
      return connectionFailure(error, 'm365', ownership);
    }
    const credentialExpiresAt = credential.notAfter.toISOString();
    const call = new M365Call(this.deps, ctx, this.config(ctx), credential);
    try {
      const token = await call.graph.token();
      const drive = await call.graph.drive();
      // OneDrive (for Business or personal) holds one account's files (BR-30); document libraries are shared.
      ownership = drive.driveType === 'personal' || drive.driveType === 'business' ? 'personal' : 'organizational';
      const root = await call.root();
      const problems: string[] = [];
      for (const [ms, entry] of Object.entries(call.config.roots)) {
        try {
          await call.scope({ folderId: entry.folderId, path: entry.path });
        } catch (error) {
          if (!(error instanceof GatewayError) || error.slug === 'rate-limited' || error.slug === 'unreachable') throw error;
          problems.push(`${ms} (${error.message})`);
        }
      }
      const permissions = ['read', ...tokenRoles(token)];
      const rootPath = joinPath(root.segments) || '/';
      const where = drive.name ? `${drive.name}, ${rootPath}` : rootPath;
      if (problems.length > 0) {
        return {
          status: 'degraded',
          permissions,
          ownership,
          credentialExpiresAt,
          message: {
            en: `Connected to ${where}, but these system folders are missing or outside the root folder: ${problems.join('; ')}`,
            id: `Terhubung ke ${where}, tetapi folder sistem berikut tidak ada atau berada di luar folder akar: ${problems.join('; ')}`,
          },
        };
      }
      return {
        status: 'ok',
        permissions,
        ownership,
        credentialExpiresAt,
        message: {
          en: `Connected to ${where}${ownership === 'personal' ? ' (a OneDrive: files belong to one account)' : ''}`,
          id: `Terhubung ke ${where}${ownership === 'personal' ? ' (OneDrive: berkas dimiliki satu akun)' : ''}`,
        },
      };
    } catch (error) {
      return connectionFailure(error, 'm365', ownership, credentialExpiresAt);
    }
  }

  async list(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; folderPath?: string; pageToken?: string }): Promise<ListResponse> {
    const relative = pathSegments(input.folderPath);
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    let folder = scope;
    if (relative.length > 0) {
      const found = await call.graph.itemByPath(scope.item.id, relative);
      if (!found || !found.folder) throw notFound(`The folder ${joinPath([...scope.segments, ...relative])} does not exist`);
      folder = { item: found, segments: await call.within(found, scope) };
    }
    const page = await call.graph.children(folder.item.id, input.pageToken);
    const items = page.items.filter((item) => item.file !== undefined).map((item) => toMetadata(item, null, [...folder.segments, item.name]));
    return { path: joinPath(folder.segments), items, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  async ensureFolder(ctx: AdapterContext, path: string): Promise<{ folderId: string; path: string }> {
    const folder = await this.call(ctx).ensureFolderPath(path);
    return { folderId: folder.item.id, path: joinPath(folder.segments) };
  }

  async put(ctx: AdapterContext, input: PutInput): Promise<PutResult> {
    if (input.contentLength !== null && input.contentLength > input.maxBytes) throw tooLarge(input.maxBytes);
    const name = checkItemName(input.fileName);
    const relative = pathSegments(input.folderPath);
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    const folder = await call.ensureFolders(scope, relative);
    const upload = meterUpload(input.body, input.maxBytes);
    const onAbort = () => upload.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const quickXor = new QuickXorHash();
    let item: GraphItem;
    try {
      const first = await upload.reader.read(SIMPLE_UPLOAD_MAX_BYTES + 1);
      if (first.length <= SIMPLE_UPLOAD_MAX_BYTES) {
        quickXor.update(first);
        item = await call.graph.uploadSmall(folder.item.id, name, first);
      } else {
        item = await this.uploadInSession(call, folder, name, first, upload, input.contentLength, quickXor);
      }
    } catch (error) {
      upload.abort();
      throw error;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    const meter = upload.meter;
    if (item.size !== undefined && item.size !== meter.size) {
      throw new GatewayError('internal', `Microsoft 365 stored ${item.size} bytes of the ${meter.size} streamed for item ${item.id}`);
    }
    const reported = item.file?.hashes?.quickXorHash;
    if (reported && reported !== quickXor.digest()) {
      throw new GatewayError('internal', `Microsoft 365 reports another quickXorHash for item ${item.id} than the streamed bytes have`);
    }
    const segments = await call.within(item, scope);
    const version = await call.currentVersion(item.id);
    return {
      externalItemId: item.id,
      externalVersionId: version?.id ?? null,
      versionLabel: version?.label ?? 'v1.0',
      hashAlgorithm: 'sha256',
      hashValue: meter.sha256,
      hashSource: 'computed',
      sizeBytes: meter.size,
      detectedMimeType: meter.detectedType,
      providerCreatedAt: instant(item.createdDateTime),
      ...(item.webUrl ? { webUrl: item.webUrl } : {}),
      folderPath: joinPath(segments.slice(0, -1)),
    };
  }

  async link(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; externalItemId: string }): Promise<ObjectMetadata> {
    const itemId = checkGraphId(input.externalItemId);
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    const item = this.fileOnly(await call.graph.item(itemId));
    const segments = await call.within(item, scope);
    return toMetadata(item, await call.currentVersion(item.id), segments);
  }

  async registerClientUpload(ctx: AdapterContext, input: RegisterClientUploadInput): Promise<ObjectMetadata> {
    const itemId = checkGraphId(input.externalItemId);
    const intentFolder = pathSegments(input.intent.folderPath, 'upload folder');
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    const item = this.fileOnly(await call.graph.item(itemId));
    const segments = await call.within(item, scope);
    const folder = segments.slice(0, -1);
    if (!samePath(folder, intentFolder, true)) {
      throw outsideRoot(`The item is in ${joinPath(folder)}, not in the upload folder ${joinPath(intentFolder)}`);
    }
    const created = Date.parse(item.createdDateTime ?? '');
    if (Number.isNaN(created) || created < Date.parse(input.intent.notBefore)) {
      throw forbidden(`The item was created before the upload intent was issued (${input.intent.notBefore})`);
    }
    const creator = item.createdBy?.user?.email;
    if (!creator || creator.toLowerCase() !== input.intent.creatorEmail.toLowerCase()) {
      throw forbidden('The item was not created by the account the upload intent was issued to');
    }
    if (!`${item.name}\n${item.description ?? ''}`.includes(input.intent.correlationCode)) {
      throw forbidden(`Neither the name nor the description of the item carries the correlation code ${input.intent.correlationCode}`);
    }
    return toMetadata(item, await call.currentVersion(item.id), segments);
  }

  async stat(ctx: AdapterContext, object: GatewayObjectRef): Promise<StatResult> {
    const itemId = checkGraphId(object.externalItemId);
    try {
      const call = this.call(ctx);
      const item = await call.graph.item(itemId);
      if (!item.file) return { outcome: 'not_found', pinnedVersionAvailable: false };
      const segments = await call.within(item, await call.root());
      const versions = await call.graph.versions(item.id);
      const current = currentVersionOf(versions);
      const metadata = toMetadata(item, current, segments);
      const pinned = object.externalVersionId;
      const pinnedVersionAvailable = pinned === null || versions.some((version) => version.id === pinned);
      const samePinned = pinned !== null && current !== null && current.id === pinned;
      return {
        outcome: 'found',
        current: metadata,
        pinnedVersionAvailable,
        ...(samePinned && metadata.hashValue ? { pinnedHash: metadata.hashValue } : {}),
        ...(metadata.folderPath !== null ? { folderPath: metadata.folderPath } : {}),
      };
    } catch (error) {
      return statFailure(error);
    }
  }

  async openUrl(ctx: AdapterContext, object: GatewayObjectRef): Promise<OpenUrlResult> {
    const call = this.call(ctx);
    const item = this.fileOnly(await call.graph.item(checkGraphId(object.externalItemId)));
    await call.within(item, await call.root());
    if (!item.webUrl) throw notFound(`Item ${item.id} has no web address`);
    return { url: item.webUrl };
  }

  async stream(ctx: AdapterContext, object: GatewayObjectRef): Promise<StreamResult> {
    if (!ctx.repository.modes.includes('pass_through')) {
      throw unsupported('Only pass-through repositories stream file content through MSCD; open the file in Microsoft 365');
    }
    const call = this.call(ctx);
    const item = this.fileOnly(await call.graph.item(checkGraphId(object.externalItemId)));
    await call.within(item, await call.root());
    const versions = await call.graph.versions(item.id);
    const currentId = versions[0]?.id ?? null;
    const pinned = object.externalVersionId;
    let versionId: string | null = null;
    let expectedSize = item.size ?? null;
    if (pinned !== null && currentId !== null && pinned !== currentId) {
      const version = versions.find((entry) => entry.id === pinned);
      if (!version) throw notFound(`Version ${pinned} of item ${item.id} is no longer available`);
      versionId = version.id;
      expectedSize = version.size ?? null;
    }
    const content = await call.graph.content(item.id, versionId);
    const size = content.size ?? expectedSize;
    if (size === null) {
      content.stream.destroy();
      throw unexpectedAnswer('m365', 'download without a length');
    }
    const { stream, detectedType } = await detectAndReplay(content.stream);
    return { stream, size, detectedType };
  }

  async copyWithin(ctx: AdapterContext, objects: GatewayObjectRef[], targetFolderPath: string): Promise<CopyWithinResult> {
    // Ids and the target path are checked before any request, every source before anything is copied.
    const ids = objects.map((object) => checkGraphId(object.externalItemId));
    if (pathSegments(targetFolderPath, 'target folder').length === 0) throw badRequest('The target folder is empty');
    const call = this.call(ctx);
    const root = await call.root();
    const sources: GraphItem[] = [];
    for (const [index, object] of objects.entries()) {
      const item = this.fileOnly(await call.graph.item(ids[index]!));
      await call.within(item, root);
      if (object.externalVersionId !== null) {
        const current = await call.currentVersion(item.id);
        if (current && current.id !== object.externalVersionId) {
          throw unsupported(
            `Item ${item.id} changed after version ${object.externalVersionId} was pinned (now ${current.id}); Microsoft 365 copies only the current version`,
          );
        }
      }
      sources.push(item);
    }
    const target = await call.ensureFolderPath(targetFolderPath);
    const items: CopyWithinResult['items'] = [];
    for (const source of sources) {
      const newItemId = await call.graph.copy(source.id, target.item.id, source.name);
      const copy = await call.graph.item(newItemId);
      items.push({ externalItemId: source.id, newItemId, location: joinPath([...target.segments, copy.name]) });
    }
    return { items };
  }

  async close(): Promise<void> {
    await this.http.close();
  }

  // -------------------------------------------------------------------------------------------------------------

  private config(ctx: AdapterContext): M365RepositoryConfig {
    const parsed = M365RepositoryConfig.safeParse(ctx.repository.config);
    if (!parsed.success) throw badRequest('The Microsoft 365 repository config is not valid');
    return parsed.data;
  }

  private call(ctx: AdapterContext): M365Call {
    const credential = readM365Credential(ctx.credential, this.loginBaseUrl);
    return new M365Call(this.deps, ctx, this.config(ctx), credential);
  }

  /** Files only: folders and OneNote notebooks (`package`) are refused. */
  private fileOnly(item: GraphItem): GraphItem {
    if (!item.file) throw badRequest(`Item ${item.id} is ${item.folder ? 'a folder' : 'not a file'}`);
    return item;
  }

  private async uploadInSession(
    call: M365Call,
    folder: Placed,
    name: string,
    first: Buffer,
    upload: MeteredUpload,
    total: number | null,
    quickXor: QuickXorHash,
  ): Promise<GraphItem> {
    // Every fragment of a Graph upload session names the total size, so a large stream needs its length up front.
    if (total === null) throw badRequest('A pass-through upload larger than 4 MiB to Microsoft 365 needs a Content-Length');
    const uploadUrl = await call.graph.createUploadSession(folder.item.id, name);
    try {
      upload.reader.unshift(first);
      let offset = 0;
      for (;;) {
        const fragment = await upload.reader.read(this.fragmentBytes);
        if (fragment.length === 0 || (fragment.length < this.fragmentBytes && offset + fragment.length < total)) {
          throw badRequest(`The upload ended after ${offset + fragment.length} of the ${total} bytes its Content-Length announced`);
        }
        if (offset + fragment.length > total) throw badRequest(`The upload is longer than the ${total} bytes its Content-Length announced`);
        const last = offset + fragment.length === total;
        if (last && (await upload.reader.read(1)).length > 0) {
          throw badRequest(`The upload is longer than the ${total} bytes its Content-Length announced`);
        }
        quickXor.update(fragment);
        const item = await call.graph.uploadFragment(uploadUrl, fragment, offset, total);
        offset += fragment.length;
        if (last) {
          if (!item) throw unexpectedAnswer('m365', 'upload session not complete after its last fragment');
          return item;
        }
        if (item) throw unexpectedAnswer('m365', 'upload session completed before its last fragment');
      }
    } catch (error) {
      await call.graph.cancelUploadSession(uploadUrl);
      throw error;
    }
  }
}

/** Registry factory: the Microsoft 365 adapter when `m365` is enabled (I.1 `storage.adapters.enabled`). */
export const m365AdapterFactory: AdapterFactory = ({ config }) => {
  if (!config.profile.storage.adapters.enabled.includes('m365')) return null;
  return new M365Adapter(m365SettingsFromConfig(config));
};
