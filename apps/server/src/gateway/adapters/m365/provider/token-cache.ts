// Access token cache of the provider adapters (WP-15): a token is reused until five minutes before it expires.
// Entries are keyed by a SHA-256 over the token endpoint and the whole credential secret, so a different or
// rotated credential never reuses another one's token, and the key itself reveals nothing. Concurrent calls for
// the same key share one token request. Tokens live in memory only.
import { createHash } from 'node:crypto';

export interface IssuedToken {
  accessToken: string;
  /** Lifetime the token endpoint reported (`expires_in`). */
  expiresInSeconds: number;
}

/** Tokens are not reused during the last five minutes of their lifetime. */
export const TOKEN_REUSE_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 1000;

/** Cache key of a credential: SHA-256 over the canonical JSON of the given parts. */
export function tokenCacheKey(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export class TokenCache {
  private readonly entries = new Map<string, { token: string; usableUntil: number }>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly limit: number;

  constructor(options: { now?: () => number; marginMs?: number; limit?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.marginMs = options.marginMs ?? TOKEN_REUSE_MARGIN_MS;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  /** A cached token, or a new one from `issue` (shared by concurrent callers of the same key). */
  async get(key: string, issue: () => Promise<IssuedToken>): Promise<string> {
    const cached = this.peek(key);
    if (cached) return cached;
    const running = this.pending.get(key);
    if (running) return running;
    const request = issue()
      .then((token) => {
        this.put(key, token);
        return token.accessToken;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  /** The cached token of a key while it is still usable. */
  peek(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.usableUntil > this.now()) return entry.token;
    this.entries.delete(key);
    return null;
  }

  /** Stores a token; one that expires within the reuse margin is not stored (it is used once). */
  put(key: string, token: IssuedToken): void {
    const usableUntil = this.now() + token.expiresInSeconds * 1000 - this.marginMs;
    if (usableUntil <= this.now()) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { token: token.accessToken, usableUntil });
  }

  /** Drops a key's token (after the API refused it); only when it is still `token`, when one is given. */
  invalidate(key: string, token?: string): void {
    const entry = this.entries.get(key);
    if (entry && (token === undefined || entry.token === token)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
