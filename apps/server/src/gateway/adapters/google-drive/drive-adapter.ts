// Google Drive adapter of the storage gateway (build plan D.5, TS 5.1 to 5.3, F.8, WP-15): a Shared Drive (or a
// My Drive, reported as personal ownership) through the Drive v3 API, as a service account member of the drive or
// with a delegated refresh token from the repository consent flow. Every item the adapter reads, links, lists,
// copies or verifies must lie below the repository's root folder (`config.rootFolderId`), and below the call's
// system folder (`scopeRoot`) when the call acts for one management system; Drive has no paths, so the adapter
// walks an item's parent folders by id. Trashed items, also those inside a trashed folder, count as missing.
// Provider hashes are `sha256Checksum` (binary files only; Google Docs, Sheets and Slides have none);
// pass-through uploads compute SHA-256 while streaming and compare it with the checksum Drive reports.
// `pin-version` sets `keepForever` on the pinned revision of a binary file.
import {
  GoogleDriveRepositoryConfig,
  type CopyWithinResult,
  type GatewayObjectRef,
  type ListResponse,
  type ObjectMetadata,
  type OpenUrlResult,
  type OwnershipType,
  type PinVersionResult,
  type PutResult,
  type ScopeRoot,
  type StatResult,
  type TestConnectionResponse,
} from '@mscd/shared';
import type { MscdConfig } from '../../../config/mscd-config';
import { OCTET_STREAM } from '../../file-type';
import { badRequest, forbidden, GatewayError, notFound, outsideRoot, tooLarge, unsupported } from '../../problems';
import type { AdapterContext, AdapterFactory, OAuthExchangeInput, OAuthExchangeOutput, PutInput, RegisterClientUploadInput, StorageAdapter, StreamResult } from '../types';
import { EgressPolicy } from '../m365/provider/egress';
import { parseProviderError, ProviderError, unexpectedAnswer } from '../m365/provider/errors';
import { ProviderHttp } from '../m365/provider/http';
import {
  chunkSize,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  SIMPLE_UPLOAD_MAX_BYTES,
  USER_AGENT,
  waitFor,
  type ProviderAdapterOptions,
} from '../m365/provider/options';
import { checkItemName, joinPath, pathSegments, samePath, startsWithPath } from '../m365/provider/paths';
import { connectionFailure, statFailure } from '../m365/provider/results';
import { detectAndReplay, meterUpload, type MeteredUpload } from '../m365/provider/streams';
import { TokenCache } from '../m365/provider/token-cache';
import { readGoogleCredential, readOAuthClient, refreshTokenCacheKey, type GoogleCredential } from './credential';
import {
  checkDriveId,
  DriveSession,
  FOLDER_MIME,
  isGoogleNative,
  queryString,
  SHORTCUT_MIME,
  type Corpus,
  type DriveFile,
  type DriveRevision,
  type DriveSessionDeps,
  type SessionTokens,
} from './drive';
import { GoogleTokens } from './google-token';

export const DEFAULT_API_BASE_URL = 'https://www.googleapis.com';
export const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Resumable upload chunks must be multiples of 256 KiB (Drive "Upload file data"). */
export const DRIVE_CHUNK_MULTIPLE = 256 * 1024;
const DEFAULT_CHUNK_BYTES = 32 * DRIVE_CHUNK_MULTIPLE;
/** Depth of a parent walk before the adapter gives up (cycles or absurd nesting). */
const MAX_PARENT_WALK = 64;

export interface GoogleDriveAdapterSettings {
  apiBaseUrl: string;
  tokenUrl: string;
  /** `network.egress_allowlist` (I.1). */
  egressAllowlist: readonly string[];
  demo: boolean;
}

/** The provider settings of the deployment profile (I.1 `gateway.providers.google`, `network.egress_allowlist`). */
export function googleDriveSettingsFromConfig(config: MscdConfig): GoogleDriveAdapterSettings {
  const { profile } = config;
  return {
    apiBaseUrl: profile.gateway.providers.google.api_base_url,
    tokenUrl: profile.gateway.providers.google.token_url,
    egressAllowlist: profile.network.egress_allowlist,
    demo: profile.demo.enabled,
  };
}

/** A folder or file and where it sits: its ancestors' ids (drive root first) and its path from the drive root. */
interface Placed {
  file: DriveFile;
  /** Ids of the folders above, from the drive root down to the parent (the drive root first); empty for a drive root. */
  ancestors: string[];
  /** Names from the drive root down to the item itself (none for a drive root). */
  segments: string[];
}

interface CurrentRevision {
  id: string;
  /** `rev <n>`; null where the position is not known (listings). */
  label: string | null;
}

interface FolderStep {
  id: string;
  name: string;
  parentId: string | null;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function instant(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function sizeOf(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/** The head revision and its label `rev <n>` (n: its position among the revisions, oldest first). */
function currentRevisionOf(file: DriveFile, revisions: readonly DriveRevision[]): CurrentRevision | null {
  const id = file.headRevisionId ?? revisions[revisions.length - 1]?.id;
  if (!id) return null;
  const index = revisions.findIndex((revision) => revision.id === id);
  return { id, label: `rev ${index >= 0 ? index + 1 : Math.max(1, revisions.length)}` };
}

function toMetadata(file: DriveFile, revision: CurrentRevision | null, segments: readonly string[], createdByEmail?: string): ObjectMetadata {
  const sha256 = file.sha256Checksum?.toLowerCase();
  const md5 = file.md5Checksum?.toLowerCase();
  const hash = sha256 ? { hashAlgorithm: 'sha256' as const, hashValue: sha256 } : md5 ? { hashAlgorithm: 'md5' as const, hashValue: md5 } : null;
  const creator = createdByEmail ?? file.owners?.[0]?.emailAddress;
  return {
    externalItemId: file.id,
    externalVersionId: revision?.id ?? null,
    versionLabel: revision?.label ?? null,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: sizeOf(file.size),
    hashAlgorithm: hash?.hashAlgorithm ?? 'none',
    hashValue: hash?.hashValue ?? null,
    hashSource: hash ? 'provider' : 'none',
    providerCreatedAt: instant(file.createdTime),
    providerModifiedAt: instant(file.modifiedTime),
    modifiedBy: file.lastModifyingUser?.displayName ?? null,
    ...(creator ? { createdByEmail: creator } : {}),
    folderPath: joinPath(segments.slice(0, -1)),
    folderId: file.parents?.[0] ?? null,
    webUrl: file.webViewLink ?? null,
  };
}

/** Root enforcement and folder handling of one gateway call. */
class DriveCall {
  private rootPlaced: Promise<Placed> | null = null;
  private readonly steps = new Map<string, Promise<FolderStep>>();

  constructor(
    readonly session: DriveSession,
    readonly config: GoogleDriveRepositoryConfig,
  ) {}

  /** The repository root folder; it must be a folder, not trashed, and in `config.driveId` when on a shared drive. */
  root(): Promise<Placed> {
    this.rootPlaced ??= (async () => {
      const file = await this.session.folder(this.config.rootFolderId);
      if (file.mimeType !== FOLDER_MIME) throw notFound(`The root folder ${this.config.rootFolderId} of the repository is not a folder`);
      if (file.trashed) throw notFound(`The root folder ${this.config.rootFolderId} of the repository is in the trash`);
      if (file.driveId !== undefined && file.driveId !== this.config.driveId) {
        throw outsideRoot(`The root folder ${this.config.rootFolderId} is not in the configured shared drive ${this.config.driveId}`);
      }
      return this.place(file);
    })();
    return this.rootPlaced;
  }

  /** Where `files.list` searches: the shared drive of the root folder, or the account's own files (My Drive). */
  async corpus(): Promise<Corpus> {
    const root = await this.root();
    return root.file.driveId !== undefined ? { kind: 'shared_drive', driveId: root.file.driveId } : { kind: 'my_drive' };
  }

  /** The call's system folder: the root folder or one of `config.roots`, lying below the root folder. */
  async scope(scopeRoot: ScopeRoot): Promise<Placed> {
    if (scopeRoot.folderId === null) throw outsideRoot('The call names no folder of the repository');
    const folderId = checkDriveId(scopeRoot.folderId, 'folder id');
    const root = await this.root();
    if (folderId === this.config.rootFolderId) return root;
    if (!Object.values(this.config.roots).some((entry) => entry.folderId === folderId)) {
      throw outsideRoot('The scope root is not a root folder of this repository');
    }
    const file = await this.session.folder(folderId);
    if (file.mimeType !== FOLDER_MIME) throw notFound(`The system folder ${folderId} is not a folder`);
    if (file.trashed) throw notFound(`The system folder ${folderId} is in the trash`);
    return this.placeWithin(file, root);
  }

  /** Places an item and refuses one that is not below `within` (or that sits in another drive). */
  async placeWithin(file: DriveFile, within: Placed): Promise<Placed> {
    const root = await this.root();
    if ((file.driveId ?? null) !== (root.file.driveId ?? null)) throw outsideRoot('The item belongs to another drive');
    const placed = await this.place(file);
    if (!placed.ancestors.includes(within.file.id)) {
      throw outsideRoot(`The item is not below ${joinPath(within.segments) || 'the drive root'}`);
    }
    return placed;
  }

  /** The ancestors and path of a file or folder, from the parent walk. */
  async place(file: DriveFile): Promise<Placed> {
    const parentId = file.parents?.[0];
    if (!parentId) return { file, ancestors: [], segments: [] };
    const chain: FolderStep[] = [];
    let next: string | null = parentId;
    for (let depth = 0; next !== null; depth += 1) {
      if (depth > MAX_PARENT_WALK) throw unexpectedAnswer('google_drive', 'folder chain deeper than expected');
      const step: FolderStep = await this.step(next);
      chain.unshift(step);
      next = step.parentId;
    }
    // chain[0] is the drive root, whose name is not part of a path.
    return { file, ancestors: chain.map((step) => step.id), segments: [...chain.slice(1).map((step) => step.name), file.name] };
  }

  private step(folderId: string): Promise<FolderStep> {
    let known = this.steps.get(folderId);
    if (!known) {
      known = this.session.folder(folderId).then((folder) => {
        if (folder.mimeType !== FOLDER_MIME) throw unexpectedAnswer('google_drive', `parent ${folderId} that is not a folder`);
        return { id: folder.id, name: folder.name, parentId: folder.parents?.[0] ?? null };
      });
      this.steps.set(folderId, known);
    }
    return known;
  }

  async currentRevision(file: DriveFile): Promise<{ current: CurrentRevision | null; revisions: DriveRevision[] }> {
    const revisions = await this.session.revisions(file.id);
    return { current: currentRevisionOf(file, revisions), revisions };
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
    let current = base;
    const corpus = await this.corpus();
    for (const segment of relative) {
      const name = checkItemName(segment, 'folder name');
      const found = await this.findFolder(current.file.id, name, corpus);
      const folder = found ?? (await this.session.createFolder(current.file.id, name));
      if (folder.mimeType !== FOLDER_MIME) throw unexpectedAnswer('google_drive', `folder ${name} that is not a folder`);
      current = { file: folder, ancestors: [...current.ancestors, current.file.id], segments: [...current.segments, folder.name] };
    }
    return current;
  }

  /** The folder named `name` directly in `parentId` (not trashed); the oldest when Drive holds several. */
  async findFolder(parentId: string, name: string, corpus: Corpus): Promise<DriveFile | null> {
    const q = `${queryString(checkDriveId(parentId, 'folder id'))} in parents and name = ${queryString(name)} and mimeType = ${queryString(FOLDER_MIME)} and trashed = false`;
    const page = await this.session.list(q, corpus, undefined, 10);
    const folders = page.files.filter((file) => file.mimeType === FOLDER_MIME && file.name === name);
    folders.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || a.id.localeCompare(b.id));
    return folders[0] ?? null;
  }
}

export class GoogleDriveAdapter implements StorageAdapter {
  readonly adapter = 'google_drive' as const;
  private readonly http: ProviderHttp;
  private readonly tokens: GoogleTokens;
  private readonly deps: DriveSessionDeps;
  private readonly tokenUrl: string;
  private readonly chunkBytes: number;

  constructor(settings: GoogleDriveAdapterSettings, options: ProviderAdapterOptions = {}) {
    const apiBaseUrl = trimSlash(settings.apiBaseUrl);
    this.tokenUrl = settings.tokenUrl;
    const now = options.now ?? (() => new Date());
    const egress = EgressPolicy.create({
      endpoints: [
        { setting: 'gateway.providers.google.api_base_url', url: apiBaseUrl, defaultUrl: DEFAULT_API_BASE_URL },
        { setting: 'gateway.providers.google.token_url', url: settings.tokenUrl, defaultUrl: DEFAULT_TOKEN_URL },
      ],
      allowlist: settings.egressAllowlist,
      demo: settings.demo,
    });
    this.http = new ProviderHttp({
      provider: 'google_drive',
      egress,
      parseError: parseProviderError,
      userAgent: USER_AGENT,
      dispatcher: options.dispatcher,
      retry: options.retry,
      sleep: options.sleep ?? waitFor,
      timeoutMs: options.requestTimeoutMs,
      now: () => now().getTime(),
    });
    this.tokens = new GoogleTokens(this.http, settings.tokenUrl, options.tokenCache ?? new TokenCache({ now: () => now().getTime() }), now);
    this.chunkBytes = chunkSize(options.uploadChunkBytes, DEFAULT_CHUNK_BYTES, DRIVE_CHUNK_MULTIPLE, 'Google Drive');
    this.deps = { http: this.http, apiBaseUrl, uploadTimeoutMs: options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS };
  }

  validateConfig(_orgId: string, config: Record<string, unknown>): void {
    const parsed = GoogleDriveRepositoryConfig.safeParse(config);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`The Google Drive repository config is not valid${issue ? ` at ${issue.path.map(String).join('.') || 'config'}: ${issue.message}` : ''}`);
    }
  }

  async testConnection(ctx: AdapterContext): Promise<Omit<TestConnectionResponse, 'latencyMs'>> {
    let ownership: OwnershipType = 'organizational';
    let call: DriveCall;
    try {
      call = this.call(ctx);
    } catch (error) {
      return connectionFailure(error, 'google_drive', ownership);
    }
    try {
      await call.session.token();
      const root = await call.root();
      let where = joinPath(root.segments) || '/';
      if (root.file.driveId !== undefined) {
        const drive = await call.session.sharedDrive(root.file.driveId);
        if (drive.name) where = `${drive.name}, ${where}`;
      } else {
        ownership = 'personal';
      }
      const problems: string[] = [];
      for (const [ms, entry] of Object.entries(call.config.roots)) {
        try {
          await call.scope({ folderId: entry.folderId, path: entry.path });
        } catch (error) {
          if (!(error instanceof GatewayError) || error.slug === 'rate-limited' || error.slug === 'unreachable') throw error;
          problems.push(`${ms} (${error.message})`);
        }
      }
      const permissions = ['read', ...(root.file.capabilities?.canAddChildren ? ['write'] : [])];
      if (problems.length > 0) {
        return {
          status: 'degraded',
          permissions,
          ownership,
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
        message: {
          en: `Connected to ${where}${ownership === 'personal' ? ' (a My Drive: files belong to one account)' : ''}`,
          id: `Terhubung ke ${where}${ownership === 'personal' ? ' (My Drive: berkas dimiliki satu akun)' : ''}`,
        },
      };
    } catch (error) {
      return connectionFailure(error, 'google_drive', ownership);
    }
  }

  async list(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; folderPath?: string; pageToken?: string }): Promise<ListResponse> {
    const relative = pathSegments(input.folderPath);
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    const corpus = await call.corpus();
    let folder = scope;
    for (const segment of relative) {
      const found = await call.findFolder(folder.file.id, segment, corpus);
      if (!found) throw notFound(`The folder ${joinPath([...folder.segments, segment])} does not exist`);
      folder = { file: found, ancestors: [...folder.ancestors, folder.file.id], segments: [...folder.segments, found.name] };
    }
    const q = `${queryString(folder.file.id)} in parents and trashed = false and mimeType != ${queryString(FOLDER_MIME)}`;
    const page = await call.session.list(q, corpus, input.pageToken);
    const items = page.files
      .filter((file) => file.mimeType !== FOLDER_MIME && file.mimeType !== SHORTCUT_MIME && !file.trashed)
      .map((file) => toMetadata(file, file.headRevisionId ? { id: file.headRevisionId, label: null } : null, [...folder.segments, file.name]));
    return { path: joinPath(folder.segments), items, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  async ensureFolder(ctx: AdapterContext, path: string): Promise<{ folderId: string; path: string }> {
    const folder = await this.call(ctx).ensureFolderPath(path);
    return { folderId: folder.file.id, path: joinPath(folder.segments) };
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
    let file: DriveFile;
    try {
      const first = await upload.reader.read(SIMPLE_UPLOAD_MAX_BYTES + 1);
      if (first.length <= SIMPLE_UPLOAD_MAX_BYTES) {
        file = await call.session.uploadMultipart(folder.file.id, name, first, mediaType(upload));
      } else {
        file = await this.uploadResumable(call, folder, name, first, upload, input.contentLength);
      }
    } catch (error) {
      upload.abort();
      throw error;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    const meter = upload.meter;
    const size = sizeOf(file.size);
    if (size !== null && size !== meter.size) {
      throw new GatewayError('internal', `Google Drive stored ${size} bytes of the ${meter.size} streamed for file ${file.id}`);
    }
    if (file.sha256Checksum && file.sha256Checksum.toLowerCase() !== meter.sha256) {
      throw new GatewayError('internal', `Google Drive reports another SHA-256 for file ${file.id} than the streamed bytes have`);
    }
    // The new file must sit in the folder it was uploaded to (which lies below the system folder).
    if (file.parents?.[0] !== folder.file.id) throw unexpectedAnswer('google_drive', `uploaded file ${file.id} outside its target folder`);
    return {
      externalItemId: file.id,
      externalVersionId: file.headRevisionId ?? null,
      // A new file has one revision.
      versionLabel: 'rev 1',
      hashAlgorithm: 'sha256',
      hashValue: meter.sha256,
      hashSource: 'computed',
      sizeBytes: meter.size,
      detectedMimeType: meter.detectedType,
      providerCreatedAt: instant(file.createdTime),
      ...(file.webViewLink ? { webUrl: file.webViewLink } : {}),
      folderPath: joinPath(folder.segments),
    };
  }

  async link(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; externalItemId: string }): Promise<ObjectMetadata> {
    const fileId = checkDriveId(input.externalItemId);
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    const file = this.fileOnly(await call.session.file(fileId));
    const placed = await call.placeWithin(file, scope);
    const { current } = await call.currentRevision(file);
    return toMetadata(file, current, placed.segments);
  }

  async registerClientUpload(ctx: AdapterContext, input: RegisterClientUploadInput): Promise<ObjectMetadata> {
    const fileId = checkDriveId(input.externalItemId);
    const intentFolder = pathSegments(input.intent.folderPath, 'upload folder');
    const call = this.call(ctx);
    const scope = await call.scope(input.scopeRoot);
    const file = this.fileOnly(await call.session.file(fileId));
    const placed = await call.placeWithin(file, scope);
    const folder = placed.segments.slice(0, -1);
    if (!samePath(folder, intentFolder, true)) {
      throw outsideRoot(`The item is in ${joinPath(folder)}, not in the upload folder ${joinPath(intentFolder)}`);
    }
    const created = Date.parse(file.createdTime ?? '');
    if (Number.isNaN(created) || created < Date.parse(input.intent.notBefore)) {
      throw forbidden(`The item was created before the upload intent was issued (${input.intent.notBefore})`);
    }
    const { current, revisions } = await call.currentRevision(file);
    // Shared drive files have no owners: the account of the first revision created the file. A My Drive file is
    // owned by the account that uploaded it.
    const wanted = input.intent.creatorEmail.toLowerCase();
    const creator =
      file.driveId !== undefined
        ? revisions[0]?.lastModifyingUser?.emailAddress
        : file.owners?.find((owner) => owner.emailAddress?.toLowerCase() === wanted)?.emailAddress;
    if (!creator || creator.toLowerCase() !== wanted) {
      throw forbidden('The item was not created by the account the upload intent was issued to');
    }
    if (!`${file.name}\n${file.description ?? ''}`.includes(input.intent.correlationCode)) {
      throw forbidden(`Neither the name nor the description of the item carries the correlation code ${input.intent.correlationCode}`);
    }
    return toMetadata(file, current, placed.segments, creator);
  }

  async stat(ctx: AdapterContext, object: GatewayObjectRef): Promise<StatResult> {
    const fileId = checkDriveId(object.externalItemId);
    try {
      const call = this.call(ctx);
      const file = await call.session.file(fileId);
      // A trashed file (also one inside a trashed folder) is gone for MSCD, as a deleted one.
      if (file.trashed || file.mimeType === FOLDER_MIME || file.mimeType === SHORTCUT_MIME) return { outcome: 'not_found', pinnedVersionAvailable: false };
      const placed = await call.placeWithin(file, await call.root());
      const { current, revisions } = await call.currentRevision(file);
      const metadata = toMetadata(file, current, placed.segments);
      const pinned = object.externalVersionId;
      const pinnedVersionAvailable = pinned === null || revisions.some((revision) => revision.id === pinned) || current?.id === pinned;
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

  async pinVersion(ctx: AdapterContext, object: GatewayObjectRef): Promise<PinVersionResult> {
    const call = this.call(ctx);
    const file = this.fileOnly(await call.session.file(checkDriveId(object.externalItemId)));
    await call.placeWithin(file, await call.root());
    // Google Docs, Sheets and Slides keep their revisions on Google's terms; keepForever applies to binary files.
    if (isGoogleNative(file.mimeType)) return { result: 'unsupported' };
    const revisionId = object.externalVersionId ?? file.headRevisionId;
    if (!revisionId) return { result: 'unsupported' };
    await call.session.keepForever(file.id, checkDriveId(revisionId, 'revision id'));
    return { result: 'ok' };
  }

  async openUrl(ctx: AdapterContext, object: GatewayObjectRef): Promise<OpenUrlResult> {
    const call = this.call(ctx);
    const file = this.fileOnly(await call.session.file(checkDriveId(object.externalItemId)));
    await call.placeWithin(file, await call.root());
    if (!file.webViewLink) throw notFound(`File ${file.id} has no web address`);
    return { url: file.webViewLink };
  }

  async stream(ctx: AdapterContext, object: GatewayObjectRef): Promise<StreamResult> {
    if (!ctx.repository.modes.includes('pass_through')) {
      throw unsupported('Only pass-through repositories stream file content through MSCD; open the file in Google Drive');
    }
    const call = this.call(ctx);
    const file = this.fileOnly(await call.session.file(checkDriveId(object.externalItemId)));
    await call.placeWithin(file, await call.root());
    if (isGoogleNative(file.mimeType)) throw unsupported('Google Docs, Sheets and Slides have no file content to stream; open them in Google Drive');
    const pinned = object.externalVersionId;
    let revisionId: string | null = null;
    let expectedSize = sizeOf(file.size);
    if (pinned !== null && file.headRevisionId !== undefined && pinned !== file.headRevisionId) {
      const revisions = await call.session.revisions(file.id);
      const revision = revisions.find((entry) => entry.id === pinned);
      if (!revision) throw notFound(`Revision ${pinned} of file ${file.id} is no longer available`);
      revisionId = checkDriveId(revision.id, 'revision id');
      expectedSize = sizeOf(revision.size);
    }
    const content = await call.session.media(file.id, revisionId);
    const size = content.size ?? expectedSize;
    if (size === null) {
      content.stream.destroy();
      throw unexpectedAnswer('google_drive', 'download without a length');
    }
    const { stream, detectedType } = await detectAndReplay(content.stream);
    return { stream, size, detectedType };
  }

  async copyWithin(ctx: AdapterContext, objects: GatewayObjectRef[], targetFolderPath: string): Promise<CopyWithinResult> {
    // Ids and the target path are checked before any request, every source before anything is copied.
    const ids = objects.map((object) => checkDriveId(object.externalItemId));
    if (pathSegments(targetFolderPath, 'target folder').length === 0) throw badRequest('The target folder is empty');
    const call = this.call(ctx);
    const root = await call.root();
    const sources: DriveFile[] = [];
    for (const [index, object] of objects.entries()) {
      const file = this.fileOnly(await call.session.file(ids[index]!));
      await call.placeWithin(file, root);
      if (object.externalVersionId !== null) {
        const current = file.headRevisionId ?? (await call.currentRevision(file)).current?.id;
        if (current && current !== object.externalVersionId) {
          throw unsupported(
            `File ${file.id} changed after revision ${object.externalVersionId} was pinned (now ${current}); Google Drive copies only the head revision`,
          );
        }
      }
      sources.push(file);
    }
    const target = await call.ensureFolderPath(targetFolderPath);
    const items: CopyWithinResult['items'] = [];
    for (const source of sources) {
      const copy = await call.session.copy(source.id, target.file.id, source.name);
      items.push({ externalItemId: source.id, newItemId: copy.id, location: joinPath([...target.segments, copy.name]) });
    }
    return { items };
  }

  async exchangeOAuthCode(ctx: AdapterContext, input: OAuthExchangeInput): Promise<OAuthExchangeOutput> {
    const client = readOAuthClient(ctx.credential);
    let answer: Awaited<ReturnType<GoogleTokens['exchangeCode']>>;
    try {
      answer = await this.tokens.exchangeCode(client, input.code, input.redirectUri, input.codeVerifier);
    } catch (error) {
      // A refused code, verifier, redirect URI or client is a failed consent, not an unreachable provider.
      if (error instanceof ProviderError && error.credentialInvalid) throw badRequest(`Google refused the authorization code: ${error.message}`);
      throw error;
    }
    if (!answer.refreshToken) {
      throw badRequest('Google returned no refresh token; repeat the consent with offline access (access_type=offline, prompt=consent)');
    }
    // The new token must reach the configured drive and root folder before it is sealed (D.5).
    const fixed: SessionTokens = {
      token: async () => answer.accessToken,
      invalidate: () => undefined,
    };
    const call = new DriveCall(new DriveSession(this.deps, ctx, fixed), this.config(ctx));
    await call.root();
    const account = await call.session.about();
    if (!account.emailAddress) throw unexpectedAnswer('google_drive', 'account without an email address');
    const secret = { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: answer.refreshToken };
    this.tokens.remember(refreshTokenCacheKey(secret, this.tokenUrl), answer);
    return { secret, externalAccount: account.emailAddress };
  }

  async close(): Promise<void> {
    await this.http.close();
  }

  // -------------------------------------------------------------------------------------------------------------

  private config(ctx: AdapterContext): GoogleDriveRepositoryConfig {
    const parsed = GoogleDriveRepositoryConfig.safeParse(ctx.repository.config);
    if (!parsed.success) throw badRequest('The Google Drive repository config is not valid');
    return parsed.data;
  }

  private call(ctx: AdapterContext): DriveCall {
    const credential = readGoogleCredential(ctx.credential, this.tokenUrl);
    return new DriveCall(new DriveSession(this.deps, ctx, this.sessionTokens(credential)), this.config(ctx));
  }

  private sessionTokens(credential: GoogleCredential): SessionTokens {
    return {
      token: () => this.tokens.token(credential),
      invalidate: (token) => this.tokens.invalidate(credential, token),
    };
  }

  /** Files only: folders and shortcuts are refused; trashed files (also inside a trashed folder) count as missing. */
  private fileOnly(file: DriveFile): DriveFile {
    if (file.mimeType === FOLDER_MIME) throw badRequest(`Item ${file.id} is a folder, not a file`);
    if (file.mimeType === SHORTCUT_MIME) throw badRequest(`Item ${file.id} is a shortcut; link the file it points to`);
    if (file.trashed) throw notFound(`File ${file.id} is in the trash`);
    return file;
  }

  private async uploadResumable(call: DriveCall, folder: Placed, name: string, first: Buffer, upload: MeteredUpload, total: number | null): Promise<DriveFile> {
    const session = await call.session.startResumable(folder.file.id, name, mediaType(upload), total);
    try {
      upload.reader.unshift(first);
      let offset = 0;
      for (;;) {
        const chunk = await upload.reader.read(this.chunkBytes);
        // The last chunk is the one after which nothing is left; Drive needs the total size with it.
        const following = chunk.length === this.chunkBytes ? await upload.reader.read(1) : Buffer.alloc(0);
        const last = following.length === 0;
        upload.reader.unshift(following);
        const end = offset + chunk.length;
        if (total !== null && (end > total || (last && end !== total))) {
          throw badRequest(`The upload has ${last ? end : 'more than ' + end} bytes, not the ${total} its Content-Length announced`);
        }
        const file = await call.session.uploadChunk(session, chunk, offset, last ? end : null);
        offset = end;
        if (last) {
          if (!file) throw unexpectedAnswer('google_drive', 'resumable upload not complete after its last chunk');
          return file;
        }
        if (file) throw unexpectedAnswer('google_drive', 'resumable upload completed before its last chunk');
      }
    } catch (error) {
      await call.session.cancelResumable(session);
      throw error;
    }
  }
}

/** The media type sent with an upload: the detected one, so Drive never guesses (and never converts). */
function mediaType(upload: MeteredUpload): string {
  return upload.meter.detectedType || OCTET_STREAM;
}

/** Registry factory: the Google Drive adapter when `google_drive` is enabled (I.1 `storage.adapters.enabled`). */
export const googleDriveAdapterFactory: AdapterFactory = ({ config }) => {
  if (!config.profile.storage.adapters.enabled.includes('google_drive')) return null;
  return new GoogleDriveAdapter(googleDriveSettingsFromConfig(config));
};
