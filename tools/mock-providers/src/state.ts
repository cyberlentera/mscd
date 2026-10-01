import { type KeyObject, randomBytes } from 'node:crypto';
import { GOOGLE_FOLDER_MIME, hashContent, isGoogleNative, synthesizeContent } from './content.js';
import type { Api } from './errors.js';
import { newDriveFileId, newGraphItemId, randomToken, stableDriveRevisionId, stableGuid } from './ids.js';

// In-memory state of the mock providers: drives and items of both providers, registered credentials, issued
// tokens, upload sessions, copy jobs, fault switches and the request log. Everything is lost on restart and
// rebuilt from the fixtures by `POST /_admin/reset`.

export type Provider = 'm365' | 'google';

export interface Person {
  displayName: string;
  email?: string;
  /** Set when an application with an app-only token made the change (Graph reports it under `application`). */
  appId?: string;
}

export interface VersionState {
  id: string;
  modifiedAt: string;
  modifiedBy: Person;
  content: Buffer;
  size: number;
  quickXorHash: string;
  sha256: string;
  md5: string;
  keepForever: boolean;
}

export interface ItemState {
  id: string;
  provider: Provider;
  driveId: string;
  /** Null for the root folder of a drive. */
  parentId: string | null;
  name: string;
  isFolder: boolean;
  mimeType: string;
  description: string | null;
  createdAt: string;
  createdBy: Person;
  /** Time of the last metadata change (folders report it as their modification time). */
  modifiedAt: string;
  modifiedBy: Person;
  /** File versions, oldest first; the last one is the current version. Empty for folders. */
  versions: VersionState[];
  guid: string;
  /** Graph eTag counter: every change. */
  etagSeq: number;
  /** Graph cTag counter: content changes only. */
  ctagSeq: number;
  /** Drive `version`: every change. */
  revision: number;
  trashed: boolean;
}

export type M365DriveType = 'documentLibrary' | 'business' | 'personal';
export type GoogleDriveKind = 'shared_drive' | 'my_drive';

export interface DriveState {
  id: string;
  provider: Provider;
  name: string;
  driveType: M365DriveType | GoogleDriveKind;
  rootId: string;
  webUrl: string;
  owner: Person | null;
  /** Graph drives only: the Entra tenant that owns the drive; tokens of another tenant are refused. */
  tenantId: string | null;
  createdAt: string;
  /** Fault switch: every request that touches the drive answers 403. */
  forbidden: boolean;
  /** Client ids (Graph) or account emails (Drive) allowed to use the drive; null allows every valid token. */
  allowedPrincipals: string[] | null;
}

export interface RegisteredCertificate {
  pem: string;
  thumbprintSha256: string;
  thumbprintSha1: string;
  publicKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
}

export interface M365App {
  tenantId: string;
  tenantAliases: string[];
  clientId: string;
  displayName: string;
  certificates: RegisteredCertificate[];
  revoked: boolean;
}

export interface ServiceAccountKey {
  keyId: string | null;
  publicKey: KeyObject;
}

export interface ServiceAccount {
  clientEmail: string;
  displayName: string;
  keys: ServiceAccountKey[];
  revoked: boolean;
}

export interface Account {
  email: string;
  displayName: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[] | null;
  defaultAccount: Account | null;
  revoked: boolean;
}

export interface RefreshTokenState {
  token: string;
  clientId: string;
  account: Account;
  scope: string;
  revoked: boolean;
}

export interface AuthCodeState {
  code: string;
  clientId: string;
  redirectUri: string;
  account: Account;
  scope: string;
  codeChallenge: string | null;
  codeChallengeMethod: 'S256' | 'plain' | null;
  offline: boolean;
  expiresAt: number;
  used: boolean;
}

export interface Principal {
  provider: Provider;
  kind: 'application' | 'service_account' | 'user';
  /** Graph: client id; Drive: account email. */
  id: string;
  tenantId: string | null;
  displayName: string;
  email: string | null;
  /** Identifies the credential that issued the token, for revocation. */
  credentialKey: string;
}

export interface AccessTokenState {
  token: string;
  principal: Principal;
  scope: string;
  expiresAt: number;
  revoked: boolean;
  clientId: string | null;
}

export interface UploadSession {
  id: string;
  provider: Provider;
  driveId: string;
  parentId: string;
  name: string;
  /** Existing item that receives a new version, or null for a new file. */
  targetItemId: string | null;
  conflictBehavior: 'fail' | 'replace' | 'rename';
  mimeType: string | null;
  description: string | null;
  createdBy: Person;
  chunks: Buffer[];
  received: number;
  total: number | null;
  expiresAt: number;
  /** Drive only: `fields` of the initiating request. */
  fields: string | null;
}

export interface CopyJob {
  id: string;
  createdAt: string;
  sourceItemId: string;
  targetDriveId: string;
  targetParentId: string;
  name: string;
  conflictBehavior: 'fail' | 'replace' | 'rename';
  copiedBy: Person;
  pendingPolls: number;
  status: 'inProgress' | 'completed' | 'failed';
  resourceId: string | null;
  error: { code: string; message: string } | null;
}

export interface MockSettings {
  /** `expires_in` of issued access tokens. */
  tokenLifetimeSeconds: number;
  /** Largest body accepted by the Graph simple upload (`PUT .../content`). */
  graphSimpleUploadMaxBytes: number;
  /** Polls of a copy monitor that answer `inProgress` before the copy completes. */
  copyPendingPolls: number;
  /** Default Graph page size (`$top` overrides it). */
  graphPageSize: number;
  /** Default Drive page size (`pageSize` overrides it). */
  drivePageSize: number;
}

export const DEFAULT_SETTINGS: MockSettings = {
  tokenLifetimeSeconds: 3599,
  graphSimpleUploadMaxBytes: 4 * 1024 * 1024,
  copyPendingPolls: 1,
  graphPageSize: 200,
  drivePageSize: 100,
};

export type ProviderApi = Extract<Api, 'graph' | 'drive' | 'identity'>;
export const PROVIDER_APIS: readonly ProviderApi[] = ['graph', 'drive', 'identity'];

export interface ThrottleState {
  remaining: number;
  retryAfterSeconds: number;
  statusCode: 429 | 503;
  apis: ProviderApi[];
}

export interface LatencyState {
  ms: number;
  apis: ProviderApi[];
}

export interface RequestLogEntry {
  seq: number;
  at: string;
  api: Api;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  /** Principal id of the bearer token, when the request carried a valid one. */
  principal: string | null;
  authorization: boolean;
}

const REQUEST_LOG_LIMIT = 2000;

export interface NewVersionInput {
  id?: string;
  modifiedAt?: string;
  modifiedBy?: Person;
  content?: Buffer;
  size?: number;
  quickXorHash?: string;
  sha256?: string;
  md5?: string;
  keepForever?: boolean;
}

export interface NewItemOptions {
  id?: string;
  createdAt?: string;
  createdBy?: Person;
  description?: string | null;
}

export interface NewFileOptions extends NewItemOptions {
  mimeType: string;
  versions: NewVersionInput[];
}

export const SYSTEM_PERSON: Person = { displayName: 'System Account' };
const DEFAULT_SYNTHESIZED_SIZE = 1024;

export class MockState {
  readonly drives = new Map<string, DriveState>();
  readonly items = new Map<string, ItemState>();
  readonly apps = new Map<string, M365App>();
  readonly serviceAccounts = new Map<string, ServiceAccount>();
  readonly oauthClients = new Map<string, OAuthClient>();
  readonly refreshTokens = new Map<string, RefreshTokenState>();
  readonly authCodes = new Map<string, AuthCodeState>();
  readonly accessTokens = new Map<string, AccessTokenState>();
  readonly uploadSessions = new Map<string, UploadSession>();
  readonly copyJobs = new Map<string, CopyJob>();
  /** Signs pre-authenticated download URLs. */
  readonly secret = randomBytes(32);
  settings: MockSettings;
  throttle: ThrottleState | null = null;
  latency: LatencyState | null = null;
  requestLog: RequestLogEntry[] = [];
  private requestSeq = 0;
  private lastPurge = 0;

  constructor(private readonly defaultSettings: MockSettings = DEFAULT_SETTINGS) {
    this.settings = { ...defaultSettings };
  }

  /** Forgets everything, including the request log, and restores the default settings. */
  clear(): void {
    for (const map of [
      this.drives,
      this.items,
      this.apps,
      this.serviceAccounts,
      this.oauthClients,
      this.refreshTokens,
      this.authCodes,
      this.accessTokens,
      this.uploadSessions,
      this.copyJobs,
    ] as Map<string, unknown>[]) {
      map.clear();
    }
    this.settings = { ...this.defaultSettings };
    this.throttle = null;
    this.latency = null;
    this.requestLog = [];
  }

  /**
   * Drops expired upload sessions (which may hold buffered chunks), copy jobs older than a day, access tokens
   * expired for an hour and expired authorization codes. Runs at most once a minute, from the request hook, so a
   * long-running demo server does not grow without bound.
   */
  purgeExpired(now = Date.now()): void {
    if (now - this.lastPurge < 60_000) return;
    this.lastPurge = now;
    for (const [id, session] of this.uploadSessions) if (session.expiresAt <= now) this.uploadSessions.delete(id);
    for (const [id, job] of this.copyJobs) if (Date.parse(job.createdAt) < now - 24 * 60 * 60 * 1000) this.copyJobs.delete(id);
    for (const [token, record] of this.accessTokens) if (record.expiresAt < now - 60 * 60 * 1000) this.accessTokens.delete(token);
    for (const [code, record] of this.authCodes) if (record.expiresAt <= now) this.authCodes.delete(code);
  }

  logRequest(entry: Omit<RequestLogEntry, 'seq'>): void {
    this.requestSeq += 1;
    this.requestLog.push({ seq: this.requestSeq, ...entry });
    if (this.requestLog.length > REQUEST_LOG_LIMIT) this.requestLog.splice(0, this.requestLog.length - REQUEST_LOG_LIMIT);
  }

  appKey(tenant: string, clientId: string): string {
    return `${tenant.toLowerCase()}/${clientId.toLowerCase()}`;
  }

  /** Finds an app registration by the tenant named in the token request (id or alias) and client id. */
  findApp(tenant: string, clientId: string): M365App | undefined {
    const direct = this.apps.get(this.appKey(tenant, clientId));
    if (direct) return direct;
    const wanted = tenant.toLowerCase();
    for (const app of this.apps.values()) {
      if (app.clientId.toLowerCase() === clientId.toLowerCase() && app.tenantAliases.some((alias) => alias.toLowerCase() === wanted)) {
        return app;
      }
    }
    return undefined;
  }

  tenantKnown(tenant: string): boolean {
    const wanted = tenant.toLowerCase();
    for (const app of this.apps.values()) {
      if (app.tenantId.toLowerCase() === wanted || app.tenantAliases.some((alias) => alias.toLowerCase() === wanted)) return true;
    }
    for (const drive of this.drives.values()) {
      if (drive.tenantId?.toLowerCase() === wanted) return true;
    }
    return false;
  }

  issueAccessToken(principal: Principal, scope: string, clientId: string | null): AccessTokenState {
    const token: AccessTokenState = {
      token: randomToken(principal.provider === 'm365' ? 'mock-graph.' : 'mock-google.'),
      principal,
      scope,
      expiresAt: Date.now() + this.settings.tokenLifetimeSeconds * 1000,
      revoked: false,
      clientId,
    };
    this.accessTokens.set(token.token, token);
    return token;
  }

  // Drives and items

  item(id: string): ItemState | undefined {
    return this.items.get(id);
  }

  currentVersion(item: ItemState): VersionState | undefined {
    return item.versions[item.versions.length - 1];
  }

  childrenOf(parentId: string, includeTrashed = true): ItemState[] {
    const children: ItemState[] = [];
    for (const item of this.items.values()) {
      if (item.parentId === parentId && (includeTrashed || !item.trashed)) children.push(item);
    }
    return children.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  }

  /** Graph names are case-insensitive and unique in a folder; Drive names are exact and may repeat. */
  findChild(parentId: string, name: string, provider: Provider): ItemState | undefined {
    const wanted = provider === 'm365' ? name.toLowerCase() : name;
    for (const item of this.childrenOf(parentId)) {
      if ((provider === 'm365' ? item.name.toLowerCase() : item.name) === wanted && !item.trashed) return item;
    }
    return undefined;
  }

  /** Names of the folders from the drive root (exclusive) down to the item (inclusive). */
  pathNames(item: ItemState): string[] {
    const names: string[] = [];
    for (let current: ItemState | undefined = item; current && current.parentId !== null; ) {
      names.unshift(current.name);
      current = this.items.get(current.parentId);
    }
    return names;
  }

  isWithin(itemId: string, ancestorId: string): boolean {
    for (let current = this.items.get(itemId); current; current = current.parentId ? this.items.get(current.parentId) : undefined) {
      if (current.id === ancestorId) return true;
    }
    return false;
  }

  folderSize(item: ItemState): number {
    if (!item.isFolder) return this.currentVersion(item)?.size ?? 0;
    return this.childrenOf(item.id).reduce((sum, child) => sum + this.folderSize(child), 0);
  }

  /** Removes an item and everything below it; returns the number of removed items. */
  removeItem(id: string): number {
    const item = this.items.get(id);
    if (!item) return 0;
    let removed = 1;
    for (const child of this.childrenOf(id)) removed += this.removeItem(child.id);
    this.items.delete(id);
    return removed;
  }

  /** Graph "rename" conflict behaviour: the lowest integer that makes the name unique ("report 1.pdf"). */
  uniqueName(parentId: string, name: string, provider: Provider): string {
    if (!this.findChild(parentId, name, provider)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; ; n += 1) {
      const candidate = `${stem} ${n}${extension}`;
      if (!this.findChild(parentId, candidate, provider)) return candidate;
    }
  }

  newItemId(provider: Provider): string {
    for (;;) {
      const id = provider === 'm365' ? newGraphItemId() : newDriveFileId();
      if (!this.items.has(id) && !this.drives.has(id)) return id;
    }
  }

  createFolder(drive: DriveState, parentId: string | null, name: string, options: NewItemOptions = {}): ItemState {
    const createdAt = options.createdAt ?? new Date().toISOString();
    const createdBy = options.createdBy ?? SYSTEM_PERSON;
    const id = options.id ?? this.newItemId(drive.provider);
    const item: ItemState = {
      id,
      provider: drive.provider,
      driveId: drive.id,
      parentId,
      name,
      isFolder: true,
      mimeType: GOOGLE_FOLDER_MIME,
      description: options.description ?? null,
      createdAt,
      createdBy,
      modifiedAt: createdAt,
      modifiedBy: createdBy,
      versions: [],
      guid: stableGuid(`item:${id}`),
      etagSeq: 1,
      ctagSeq: 0,
      revision: 1,
      trashed: false,
    };
    this.items.set(id, item);
    return item;
  }

  createFile(drive: DriveState, parentId: string, name: string, options: NewFileOptions): ItemState {
    const id = options.id ?? this.newItemId(drive.provider);
    const firstVersion = options.versions[0];
    const createdAt = options.createdAt ?? firstVersion?.modifiedAt ?? new Date().toISOString();
    const createdBy = options.createdBy ?? firstVersion?.modifiedBy ?? SYSTEM_PERSON;
    const item: ItemState = {
      id,
      provider: drive.provider,
      driveId: drive.id,
      parentId,
      name,
      isFolder: false,
      mimeType: options.mimeType,
      description: options.description ?? null,
      createdAt,
      createdBy,
      modifiedAt: createdAt,
      modifiedBy: createdBy,
      versions: [],
      guid: stableGuid(`item:${id}`),
      etagSeq: 0,
      ctagSeq: 0,
      revision: 0,
      trashed: false,
    };
    const inputs = options.versions.length > 0 ? options.versions : [{}];
    inputs.forEach((input, index) => {
      const version = this.makeVersion(item, { modifiedAt: createdAt, modifiedBy: createdBy, ...input }, index, true);
      item.versions.push(version);
      item.etagSeq += 1;
      item.ctagSeq += 1;
      item.revision += 1;
    });
    const current = item.versions[item.versions.length - 1];
    item.modifiedAt = current.modifiedAt;
    item.modifiedBy = current.modifiedBy;
    this.items.set(id, item);
    return item;
  }

  /** Adds a new current version (new content) to a file. */
  addVersion(item: ItemState, input: NewVersionInput): VersionState {
    const version = this.makeVersion(item, { modifiedAt: new Date().toISOString(), ...input }, item.versions.length, false);
    item.versions.push(version);
    item.modifiedAt = version.modifiedAt;
    item.modifiedBy = version.modifiedBy;
    item.etagSeq += 1;
    item.ctagSeq += 1;
    item.revision += 1;
    return version;
  }

  /** Records a metadata change (name, description, parent). */
  touchMetadata(item: ItemState, by?: Person): void {
    item.etagSeq += 1;
    item.revision += 1;
    if (item.isFolder) {
      item.modifiedAt = new Date().toISOString();
      if (by) item.modifiedBy = by;
    }
  }

  private makeVersion(item: ItemState, input: NewVersionInput, index: number, fromFixture: boolean): VersionState {
    const id = input.id ?? this.nextVersionId(item, index, fromFixture);
    const content = input.content ?? synthesizeContent(`${item.id}:${id}`, input.size ?? DEFAULT_SYNTHESIZED_SIZE);
    const hashes = hashContent(content);
    return {
      id,
      modifiedAt: input.modifiedAt ?? new Date().toISOString(),
      modifiedBy: input.modifiedBy ?? item.createdBy,
      content,
      size: content.length,
      quickXorHash: input.quickXorHash ?? hashes.quickXorHash,
      sha256: input.sha256 ?? hashes.sha256,
      md5: input.md5 ?? hashes.md5,
      keepForever: input.keepForever ?? false,
    };
  }

  private nextVersionId(item: ItemState, index: number, fromFixture: boolean): string {
    if (item.provider === 'm365') {
      const majors = item.versions.map((v) => /^(\d+)\.\d+$/.exec(v.id)).filter((m) => m !== null).map((m) => Number(m[1]));
      return `${Math.max(index, ...majors) + 1}.0`;
    }
    if (isGoogleNative(item.mimeType)) {
      const numbers = item.versions.map((v) => Number(v.id)).filter((n) => Number.isInteger(n));
      return String(Math.max(index, ...numbers) + 1);
    }
    return fromFixture ? stableDriveRevisionId(`${item.id}:${index}`) : stableDriveRevisionId(randomToken(`${item.id}:`));
  }
}

/** The person recorded as author of a change made with a principal's token. */
export function personOf(principal: Principal): Person {
  return principal.kind === 'application'
    ? { displayName: principal.displayName, appId: principal.id }
    : { displayName: principal.displayName, ...(principal.email ? { email: principal.email } : {}) };
}

/** Whether a principal may use a drive at all (tenant and allow-list rules; the forbid switch is separate). */
export function principalMayUse(drive: DriveState, principal: Principal): boolean {
  if (drive.provider !== principal.provider) return false;
  if (drive.tenantId && principal.tenantId && drive.tenantId.toLowerCase() !== principal.tenantId.toLowerCase()) return false;
  if (!drive.allowedPrincipals) return true;
  const ids = [principal.id, principal.email].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase());
  return drive.allowedPrincipals.some((allowed) => ids.includes(allowed.toLowerCase()));
}
