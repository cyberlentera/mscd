// Tenant data keys of the storage gateway (build plan D-09, D.5, F.11). `storage.key` (the gateway KEK, file
// driver with previous keys for rotation) wraps one 32-byte data key per organisation with additional data
// `dek:<orgId>`. The wrapped key lives in `platform.tenant_key`; the api sends it with every call and the gateway
// unwraps it in memory, keeping unwrapped keys for five minutes at most. The data key encrypts vault content keys
// (`obj:<orgId>:<objectId>`) and seals repository credentials (`cred:<orgId>:<repositoryId>:<configSha256>`).
import { createHash, randomBytes } from 'node:crypto';
import { kekIdOf, type FileKeyProvider } from '../../modules/keys/file-key-provider';
import { badRequest } from '../problems';

/** An unwrapped tenant data key. */
export interface DataKey {
  orgId: string;
  key: Buffer;
  /** First 8 hex characters of the SHA-256 of the key (the SecretBox key id of values it seals). */
  id: string;
}

/** Additional data of a wrapped tenant data key (F.11). */
export function dataKeyAad(orgId: string): string {
  return `dek:${orgId}`;
}

/** Additional data of a vault object's content key (F.11). */
export function objectKeyAad(orgId: string, objectId: string): string {
  return `obj:${orgId}:${objectId}`;
}

/** How long an unwrapped data key stays in memory (D.5: five minutes). */
export const DATA_KEY_CACHE_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 10_000;

/**
 * Issues and unwraps tenant data keys with `storage.key`. Unwrapped keys are cached by organisation and wrapped
 * value for five minutes; nothing else is kept.
 */
export class DataKeyService {
  private readonly cache = new Map<string, { key: DataKey; expires: number }>();

  constructor(
    private readonly kek: FileKeyProvider,
    private readonly now: () => number = Date.now,
  ) {}

  /** Id of the current `storage.key`. */
  get kekId(): string {
    return this.kek.kekId;
  }

  /** A new random data key for an organisation, wrapped with the current `storage.key` (`POST /v1/keys/data-key`). */
  async issue(orgId: string): Promise<{ wrappedDek: string; kekId: string }> {
    const plain = randomBytes(32);
    try {
      return { wrappedDek: await this.kek.wrap(plain, dataKeyAad(orgId)), kekId: this.kek.kekId };
    } finally {
      plain.fill(0);
    }
  }

  /** The unwrapped data key of a call's tenant; a key that does not open is `bad-request`. */
  async unwrap(orgId: string, wrappedDek: string): Promise<DataKey> {
    const cacheKey = createHash('sha256').update(`${orgId}\n${wrappedDek}`).digest('hex');
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > now) return cached.key;
    if (cached) this.cache.delete(cacheKey);
    let key: Buffer;
    try {
      key = await this.kek.unwrap(wrappedDek, dataKeyAad(orgId));
    } catch {
      throw badRequest('The tenant data key cannot be opened for this organisation');
    }
    if (key.length !== 32) throw badRequest('The tenant data key has the wrong length');
    const dataKey: DataKey = { orgId, key, id: kekIdOf(key) };
    this.prune(now);
    this.cache.set(cacheKey, { key: dataKey, expires: now + DATA_KEY_CACHE_MS });
    return dataKey;
  }

  /** Re-wraps a data key with the current `storage.key` (`keys rewrap`); null when it already uses it. */
  async rewrap(orgId: string, wrappedDek: string): Promise<{ wrappedDek: string; kekId: string } | null> {
    if (!this.kek.needsRewrap(wrappedDek)) return null;
    const plain = await this.kek.unwrap(wrappedDek, dataKeyAad(orgId));
    try {
      return { wrappedDek: await this.kek.wrap(plain, dataKeyAad(orgId)), kekId: this.kek.kekId };
    } finally {
      plain.fill(0);
    }
  }

  /** Number of keys held in memory (tests). */
  get cachedKeys(): number {
    return this.cache.size;
  }

  /** Drops every unwrapped key. */
  clear(): void {
    for (const entry of this.cache.values()) entry.key.key.fill(0);
    this.cache.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expires <= now) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
