// Managed Vault adapter (build plan D-10, D.5, F.11, A-08). Objects are immutable keys `tenants/<org_id>/<object_id>`
// below the repository's `config.prefix`, which must lie inside the calling organisation's prefix. Content is
// encrypted with a per-object content key in 64 KiB AES-256-GCM chunks (crypto/chunked.ts); the SHA-256 of the
// plaintext and the type detected from its first 4 KiB are computed while streaming and stored as object
// metadata. Folders are labels only (`mscd-folder`), so `ensure-folder` creates nothing. A new version is a new
// object; `copy-within` is a server-side copy whose encryption header is re-sealed for the new object id.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import {
  VaultRepositoryConfig,
  type CopyWithinResult,
  type GatewayObjectRef,
  type ListResponse,
  type ObjectMetadata,
  type PutResult,
  type RehashResult,
  type ScopeRoot,
  type StatResult,
  type TestConnectionResponse,
} from '@mscd/shared';
import { openWithKek, sealWithKek } from '../../../modules/keys/file-key-provider';
import {
  ChunkDecryptor,
  ChunkEncryptor,
  DecryptionError,
  ENCRYPTION_ALG,
  ENCRYPTION_HEADER_VERSION,
  newNoncePrefix,
  parseHeader,
  plaintextLength,
  serializeHeader,
  type ChunkKeys,
  type VaultEncryptionHeader,
} from '../../crypto/chunked';
import { objectKeyAad, type DataKey } from '../../crypto/data-keys';
import { OCTET_STREAM } from '../../file-type';
import { badRequest, forbidden, GatewayError, notFound, outsideRoot, tooLarge, unsupported } from '../../problems';
import { ContentMeter, HashingPassThrough } from '../../streams';
import type { AdapterContext, AdapterFactory, PutInput, StorageAdapter, StreamResult } from '../types';
import { VaultStore, type HeadResult, type ObjectMetadataMap } from './vault-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIST_PAGE = 200;

/** S3 metadata keys of a vault object (`x-amz-meta-<key>`). */
export const VAULT_METADATA = {
  encryption: 'mscd-enc',
  type: 'mscd-type',
  sha256: 'mscd-sha256',
  size: 'mscd-size',
  folder: 'mscd-folder',
  name: 'mscd-name',
  created: 'mscd-created',
} as const;

/** The tenant prefix every vault key of an organisation starts with (C.8 step 5). */
export function tenantPrefix(orgId: string): string {
  return `tenants/${orgId}/`;
}

/** A folder label: segments joined with `/`, without empty, `.` or `..` segments or control characters. */
export function joinFolder(...parts: (string | null | undefined)[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const raw of part.split('/')) {
      const segment = raw.trim();
      if (segment === '') continue;
      if (segment === '.' || segment === '..' || hasControlCharacter(segment)) throw badRequest('The folder path is not valid');
      segments.push(segment);
    }
  }
  return segments.join('/');
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function encodeMeta(value: string): string {
  return encodeURIComponent(value);
}

function decodeMeta(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export class ManagedVaultAdapter implements StorageAdapter {
  readonly adapter = 'managed_vault' as const;

  constructor(
    readonly store: VaultStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  validateConfig(orgId: string, config: Record<string, unknown>): void {
    const parsed = VaultRepositoryConfig.safeParse(config);
    if (!parsed.success) throw badRequest('The Managed Vault config needs a prefix of path segments ending in /');
    if (!parsed.data.prefix.startsWith(tenantPrefix(orgId))) {
      throw forbidden('The Managed Vault prefix lies outside the organisation', 'tenant-prefix');
    }
  }

  async ready(): Promise<string> {
    await this.store.checkBucket();
    return `bucket ${this.store.bucket}`;
  }

  async testConnection(ctx: AdapterContext): Promise<Omit<TestConnectionResponse, 'latencyMs'>> {
    try {
      await this.store.checkBucket();
      await this.store.list(this.prefix(ctx), 1);
      return {
        status: 'ok',
        permissions: ['read', 'write'],
        ownership: 'organizational',
        message: { en: 'Managed Vault reachable', id: 'Managed Vault dapat dijangkau' },
      };
    } catch (error) {
      const problem = error instanceof GatewayError ? error : null;
      return {
        status: 'failed',
        permissions: [],
        ownership: 'organizational',
        message: {
          en: `Managed Vault not reachable${problem ? `: ${problem.message}` : ''}`,
          id: `Managed Vault tidak dapat dijangkau${problem ? `: ${problem.message}` : ''}`,
        },
      };
    }
  }

  async list(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; folderPath?: string; pageToken?: string }): Promise<ListResponse> {
    const folder = joinFolder(input.scopeRoot.path, input.folderPath);
    const page = await this.store.list(this.prefix(ctx), LIST_PAGE, input.pageToken);
    const items: ObjectMetadata[] = [];
    for (const key of page.keys) {
      if (!this.objectIdOf(ctx, key, false)) continue;
      const head = await this.store.head(key);
      if (!head) continue;
      if ((decodeMeta(head.metadata[VAULT_METADATA.folder]) ?? '') !== folder) continue;
      items.push(this.metadataOf(key, head));
    }
    return { path: folder, items, ...(page.next ? { nextPageToken: page.next } : {}) };
  }

  async ensureFolder(_ctx: AdapterContext, path: string): Promise<{ folderId: string; path: string }> {
    const folder = joinFolder(path);
    if (folder === '') throw badRequest('The folder path is empty');
    // Vault folders are labels on the objects; there is nothing to create.
    return { folderId: `vault:${createHash('sha256').update(folder).digest('hex').slice(0, 32)}`, path: folder };
  }

  async put(ctx: AdapterContext, input: PutInput): Promise<PutResult> {
    if (input.contentLength !== null && input.contentLength > input.maxBytes) throw tooLarge(input.maxBytes);
    const folder = joinFolder(input.scopeRoot.path, input.folderPath);
    const objectId = randomUUID();
    const key = `${this.prefix(ctx)}${objectId}`;
    const contentKey = randomBytes(32);
    const noncePrefix = newNoncePrefix();
    const header: VaultEncryptionHeader = {
      v: ENCRYPTION_HEADER_VERSION,
      alg: ENCRYPTION_ALG,
      ck: sealWithKek(ctx.dataKey.key, contentKey, objectKeyAad(ctx.orgId, objectId)),
      np: noncePrefix.toString('base64url'),
      cid: objectId,
    };
    const created = this.now().toISOString();
    const metadata: ObjectMetadataMap = {
      [VAULT_METADATA.encryption]: serializeHeader(header),
      [VAULT_METADATA.folder]: encodeMeta(folder),
      [VAULT_METADATA.created]: created,
      ...(input.metadataMinimization ? {} : { [VAULT_METADATA.name]: encodeMeta(input.fileName) }),
    };
    const meter = new ContentMeter(input.maxBytes);
    const encryptor = new ChunkEncryptor({ contentKey, noncePrefix, cid: objectId });
    const sealed = new PassThrough();
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
    let uploaded = false;
    try {
      const upload = this.store.upload(key, sealed, metadata, abort.signal).then(() => {
        uploaded = true;
      });
      // The request body is piped by hand: when the meter refuses it (size limit), the request is left unread and
      // the answer closes the connection, instead of destroying the socket before the problem is sent.
      const source = input.body;
      const onSourceError = (error: Error) => meter.destroy(error);
      source.once('error', onSourceError);
      const feed = pipeline(meter, encryptor, sealed).catch((error: unknown) => {
        source.unpipe(meter);
        source.pause();
        abort.abort();
        throw error;
      });
      source.pipe(meter);
      void feed.finally(() => source.off('error', onSourceError)).catch(() => undefined);
      // The feed's error (size limit, cancelled request) explains a failed upload better than the upload's own.
      const [fed, stored] = await Promise.allSettled([feed, upload]);
      if (fed.status === 'rejected') throw fed.reason;
      if (stored.status === 'rejected') throw stored.reason;
      const detectedType = meter.detectedType;
      await this.store.replaceMetadata(key, {
        ...metadata,
        [VAULT_METADATA.type]: detectedType,
        [VAULT_METADATA.sha256]: meter.sha256,
        [VAULT_METADATA.size]: String(meter.size),
      });
      return {
        externalItemId: key,
        externalVersionId: null,
        versionLabel: 'v1',
        hashAlgorithm: 'sha256',
        hashValue: meter.sha256,
        hashSource: 'computed',
        sizeBytes: meter.size,
        detectedMimeType: detectedType,
        providerCreatedAt: created,
        folderPath: folder,
        encryption: { v: ENCRYPTION_HEADER_VERSION, alg: ENCRYPTION_ALG, keyId: ctx.dataKey.id },
      };
    } catch (error) {
      if (uploaded) await this.store.delete(key).catch(() => undefined);
      if (error instanceof GatewayError) throw error;
      if (ctx.signal.aborted) throw badRequest('The upload was cancelled');
      throw new GatewayError('internal', `Upload failed: ${(error as Error).message}`, {}, { cause: error });
    } finally {
      ctx.signal.removeEventListener('abort', onCallerAbort);
      contentKey.fill(0);
    }
  }

  async stat(ctx: AdapterContext, object: GatewayObjectRef): Promise<StatResult> {
    const key = this.keyOf(ctx, object.externalItemId);
    let head: HeadResult | null;
    try {
      head = await this.store.head(key);
    } catch (error) {
      if (error instanceof GatewayError && error.slug === 'unreachable') return { outcome: 'unreachable', pinnedVersionAvailable: false };
      if (error instanceof GatewayError && error.slug === 'rate-limited') {
        return { outcome: 'rate_limited', pinnedVersionAvailable: false, retryAfterSeconds: error.extras.retryAfter ?? 1 };
      }
      if (error instanceof GatewayError && error.slug === 'forbidden') return { outcome: 'forbidden', pinnedVersionAvailable: false };
      throw error;
    }
    if (!head) return { outcome: 'not_found', pinnedVersionAvailable: false };
    const current = this.metadataOf(key, head);
    return {
      outcome: 'found',
      current,
      pinnedVersionAvailable: true,
      ...(current.hashValue ? { pinnedHash: current.hashValue } : {}),
      ...(current.folderPath !== null ? { folderPath: current.folderPath } : {}),
    };
  }

  async pinVersion(): Promise<{ result: 'unsupported' }> {
    return { result: 'unsupported' };
  }

  async openUrl(): Promise<never> {
    throw unsupported('The Managed Vault has no provider URL; the api streams vault content itself');
  }

  async stream(ctx: AdapterContext, object: GatewayObjectRef): Promise<StreamResult> {
    const key = this.keyOf(ctx, object.externalItemId);
    const objectId = this.objectIdOf(ctx, key, true)!;
    const stored = await this.store.get(key, ctx.signal);
    if (!stored) throw notFound();
    const keys = this.contentKeys(ctx.dataKey, ctx.orgId, objectId, stored.metadata);
    const size = this.plainSize(stored.metadata, stored.contentLength);
    const decryptor = new ChunkDecryptor(keys);
    void pipeline(stored.body, decryptor).catch(() => undefined);
    // The first chunk is decrypted before the answer starts, so a changed object fails with a problem document
    // instead of a cut response; a later failure aborts the stream.
    const iterator = decryptor[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let first: IteratorResult<Buffer>;
    try {
      first = await iterator.next();
    } catch (error) {
      stored.body.destroy();
      keys.contentKey.fill(0);
      if (error instanceof DecryptionError) throw new GatewayError('internal', 'The object failed its integrity check', {}, { cause: error });
      throw error;
    }
    const contentKey = keys.contentKey;
    async function* rest(): AsyncGenerator<Buffer> {
      try {
        if (!first.done) yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        contentKey.fill(0);
        stored?.body.destroy();
      }
    }
    return { stream: Readable.from(rest(), { objectMode: false }), size, detectedType: stored.metadata[VAULT_METADATA.type] ?? OCTET_STREAM };
  }

  async copyWithin(ctx: AdapterContext, objects: GatewayObjectRef[], targetFolderPath: string): Promise<CopyWithinResult> {
    const folder = joinFolder(targetFolderPath);
    if (folder === '') throw badRequest('The target folder is empty');
    const items: CopyWithinResult['items'] = [];
    for (const object of objects) {
      const key = this.keyOf(ctx, object.externalItemId);
      const objectId = this.objectIdOf(ctx, key, true)!;
      const head = await this.store.head(key);
      if (!head) throw notFound(`The object ${object.externalItemId} does not exist`);
      const header = parseHeader(head.metadata[VAULT_METADATA.encryption]);
      if (!header) throw new GatewayError('internal', 'The object has no readable encryption header');
      const contentKey = this.openContentKey(ctx.dataKey, ctx.orgId, objectId, header);
      const newId = randomUUID();
      const newKey = `${this.prefix(ctx)}${newId}`;
      try {
        const newHeader: VaultEncryptionHeader = { ...header, ck: sealWithKek(ctx.dataKey.key, contentKey, objectKeyAad(ctx.orgId, newId)) };
        await this.store.copy(key, newKey, {
          ...head.metadata,
          [VAULT_METADATA.encryption]: serializeHeader(newHeader),
          [VAULT_METADATA.folder]: encodeMeta(folder),
          [VAULT_METADATA.created]: this.now().toISOString(),
        });
      } finally {
        contentKey.fill(0);
      }
      const name = decodeMeta(head.metadata[VAULT_METADATA.name]) ?? newId;
      items.push({ externalItemId: key, newItemId: newKey, location: `${folder}/${name}` });
    }
    return { items };
  }

  async rehash(ctx: AdapterContext, object: GatewayObjectRef): Promise<RehashResult> {
    const key = this.keyOf(ctx, object.externalItemId);
    const objectId = this.objectIdOf(ctx, key, true)!;
    const stored = await this.store.get(key, ctx.signal);
    if (!stored) throw notFound();
    const keys = this.contentKeys(ctx.dataKey, ctx.orgId, objectId, stored.metadata);
    const cipherHash = new HashingPassThrough();
    const plainHash = new HashingPassThrough();
    try {
      await pipeline(stored.body, cipherHash, new ChunkDecryptor(keys), plainHash, new PassThrough().resume());
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error instanceof GatewayError ? error : new GatewayError('unreachable', 'Reading the object failed', {}, { cause: error });
      // Hash the whole stored ciphertext for the record; the object never matches.
      const again = await this.store.get(key, ctx.signal);
      const hasher = new HashingPassThrough();
      if (again) await pipeline(again.body, hasher, new PassThrough().resume());
      return { hashValue: again ? hasher.sha256 : createHash('sha256').digest('hex'), matches: false, detail: 'decryption_failed' };
    } finally {
      keys.contentKey.fill(0);
    }
    const hashValue = plainHash.sha256;
    const matches = object.hashAlgorithm === 'sha256' && object.hashValue !== null && object.hashValue.toLowerCase() === hashValue;
    return { hashValue, matches };
  }

  async close(): Promise<void> {
    this.store.close();
  }

  // -------------------------------------------------------------------------------------------------------------

  private prefix(ctx: AdapterContext): string {
    const prefix = (ctx.repository.config as { prefix: string }).prefix;
    // validateConfig ran before; checked again because every key below depends on it.
    if (!prefix.startsWith(tenantPrefix(ctx.orgId))) throw forbidden('The Managed Vault prefix lies outside the organisation', 'tenant-prefix');
    return prefix;
  }

  /** The key of an item id, which must lie directly below the repository prefix (D.5 root enforcement). */
  private keyOf(ctx: AdapterContext, externalItemId: string): string {
    if (!this.objectIdOf(ctx, externalItemId, false)) throw outsideRoot('The object is not in this Managed Vault repository');
    return externalItemId;
  }

  private objectIdOf(ctx: AdapterContext, key: string, required: boolean): string | null {
    const prefix = this.prefix(ctx);
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    if (UUID.test(id)) return id;
    if (required) throw outsideRoot('The object is not in this Managed Vault repository');
    return null;
  }

  private openContentKey(dataKey: DataKey, orgId: string, objectId: string, header: VaultEncryptionHeader): Buffer {
    try {
      return openWithKek(dataKey.key, header.ck, objectKeyAad(orgId, objectId));
    } catch {
      throw new GatewayError('internal', 'The content key of the object cannot be opened');
    }
  }

  private contentKeys(dataKey: DataKey, orgId: string, objectId: string, metadata: ObjectMetadataMap): ChunkKeys {
    const header = parseHeader(metadata[VAULT_METADATA.encryption]);
    if (!header) throw new GatewayError('internal', 'The object has no readable encryption header');
    return {
      contentKey: this.openContentKey(dataKey, orgId, objectId, header),
      noncePrefix: Buffer.from(header.np, 'base64url'),
      cid: header.cid,
    };
  }

  private plainSize(metadata: ObjectMetadataMap, contentLength: number): number {
    const stored = Number(metadata[VAULT_METADATA.size]);
    if (Number.isSafeInteger(stored) && stored >= 0) return stored;
    const derived = plaintextLength(contentLength);
    if (derived === null) throw new GatewayError('internal', 'The object has a length no encrypted object has');
    return derived;
  }

  private metadataOf(key: string, head: HeadResult): ObjectMetadata {
    const sha256 = head.metadata[VAULT_METADATA.sha256];
    const type = head.metadata[VAULT_METADATA.type] ?? null;
    const created = head.metadata[VAULT_METADATA.created];
    const size = Number(head.metadata[VAULT_METADATA.size]);
    const hash = sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null;
    return {
      externalItemId: key,
      externalVersionId: null,
      versionLabel: null,
      name: decodeMeta(head.metadata[VAULT_METADATA.name]) ?? key.slice(key.lastIndexOf('/') + 1),
      mimeType: type,
      ...(type ? { detectedMimeType: type } : {}),
      sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : plaintextLength(head.contentLength),
      hashAlgorithm: hash ? 'sha256' : 'none',
      hashValue: hash,
      hashSource: hash ? 'computed' : 'none',
      providerCreatedAt: created && !Number.isNaN(Date.parse(created)) ? new Date(created).toISOString() : (head.lastModified?.toISOString() ?? null),
      providerModifiedAt: head.lastModified?.toISOString() ?? null,
      modifiedBy: null,
      folderPath: decodeMeta(head.metadata[VAULT_METADATA.folder]),
      folderId: null,
      webUrl: null,
    };
  }
}

/** Factory of the registry: the vault adapter when `managed_vault` is enabled (I.1 `storage.adapters.enabled`). */
export const managedVaultAdapterFactory: AdapterFactory = ({ config }) => {
  if (!config.profile.storage.adapters.enabled.includes('managed_vault')) return null;
  return new ManagedVaultAdapter(VaultStore.fromConfig(config));
};
