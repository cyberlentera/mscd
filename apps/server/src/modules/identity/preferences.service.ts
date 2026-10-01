// User preferences (build plan D.3 `PUT /me/preferences`, D.2 `Me.preferences`): one `platform.user_preference` row
// per key with a JSON value. A PUT merges the given keys into the stored ones (rows are never deleted, so a key is
// cleared by setting it to null); the whole set may not exceed 16 KiB. `Me` reads them through `get`.
import { Injectable } from '@nestjs/common';
import { MAX_PREFERENCES_BYTES, utf8ByteLength } from '@mscd/shared';
import { PayloadTooLargeError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { IdentityInfra } from './identity-infra';

class TooLarge extends Error {}

@Injectable()
export class PreferencesService {
  constructor(private readonly infra: IdentityInfra) {}

  /** The user's preferences without cleared (null) keys. Uses `trx` when given, else a transaction of its own. */
  async get(userId: string, trx?: Trx): Promise<Record<string, unknown>> {
    const read = (t: Trx) => t.selectFrom('platform.user_preference').select(['key', 'value']).where('user_id', '=', userId).orderBy('key').execute();
    const rows = trx ? await read(trx) : await this.infra.scope.withPlatform(read, { scope: 'auth', userId });
    const out: Record<string, unknown> = {};
    for (const row of rows) if (row.value !== null) out[row.key] = row.value;
    return out;
  }

  /** Merges `values` into the user's preferences; 413 when the stored set would exceed 16 KiB. */
  async put(userId: string, values: Record<string, unknown>): Promise<void> {
    const now = this.infra.clock.now();
    try {
      await this.infra.scope.withPlatform(
        async (trx) => {
          for (const [key, value] of Object.entries(values)) {
            const json = JSON.stringify(value === undefined ? null : value);
            await trx
              .insertInto('platform.user_preference')
              .values({ user_id: userId, key, value: json, updated_at: now })
              .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet({ value: json, updated_at: now }))
              .execute();
          }
          const all = await this.get(userId, trx);
          if (utf8ByteLength(JSON.stringify(all)) > MAX_PREFERENCES_BYTES) throw new TooLarge();
        },
        { scope: 'auth', userId },
      );
    } catch (error) {
      if (error instanceof TooLarge) throw new PayloadTooLargeError(`Preferences must not exceed ${MAX_PREFERENCES_BYTES / 1024} KiB in all`);
      throw error;
    }
  }
}
