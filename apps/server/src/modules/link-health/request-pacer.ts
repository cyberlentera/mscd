// Per-repository token bucket of the link health check (E.4): Microsoft 365 4 requests per second, Google Drive 5,
// Managed Vault 50 (other adapters 5). One bucket per repository and worker process; a request waits for a token.
import { Injectable } from '@nestjs/common';
import type { StorageAdapter } from '@mscd/shared';

export const LINK_CHECK_RATES: Readonly<Record<StorageAdapter, number>> = {
  m365: 4,
  google_drive: 5,
  managed_vault: 50,
  smb: 5,
  s3: 5,
  webdav: 5,
};

interface Bucket {
  tokens: number;
  updatedAt: number;
  rate: number;
}

@Injectable()
export class RequestPacer {
  private readonly buckets = new Map<string, Bucket>();
  /** Requests per second by adapter (tests raise them). */
  rates: Record<StorageAdapter, number> = { ...LINK_CHECK_RATES };
  /** Time source and wait of the bucket (tests replace them). */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Waits until the repository's bucket has a token, then takes it. */
  async take(repositoryId: string, adapter: StorageAdapter): Promise<void> {
    const rate = Math.max(0.001, this.rates[adapter] ?? 5);
    for (;;) {
      const now = this.now();
      let bucket = this.buckets.get(repositoryId);
      if (!bucket || bucket.rate !== rate) {
        bucket = { tokens: rate, updatedAt: now, rate };
        this.buckets.set(repositoryId, bucket);
      }
      bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.updatedAt) / 1000) * rate);
      bucket.updatedAt = now;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - bucket.tokens) / rate) * 1000));
    }
  }
}
