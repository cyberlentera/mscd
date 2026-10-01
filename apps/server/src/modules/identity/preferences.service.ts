// User preferences (build plan D.3 `PUT /me/preferences`, D.2 `Me.preferences`): one `platform.user_preference` row
// per key with a JSON value. A PUT merges the given keys into the stored ones. `mscd_app` cannot delete rows (C.4),
// so a key is cleared by setting it to null: the row stays with a null value, and a null for a key without a row
// writes nothing. Every stored row counts towards the 16 KiB limit, cleared ones included (key and `null`), so
// cleared keys cannot pile up without bound. `Me` reads them through `get`.
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
            if (value === null || value === undefined) {
              // Clearing: only a stored key has anything to clear.
              await trx.updateTable('platform.user_preference').set({ value: 'null', updated_at: now }).where('user_id', '=', userId).where('key', '=', key).execute();
              continue;
            }
            const json = JSON.stringify(value);
            await trx
              .insertInto('platform.user_preference')
              .values({ user_id: userId, key, value: json, updated_at: now })
              .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet({ value: json, updated_at: now }))
              .execute();
          }
          if ((await this.storedBytes(userId, trx)) > MAX_PREFERENCES_BYTES) throw new TooLarge();
        },
        { scope: 'auth', userId },
      );
    } catch (error) {
      if (error instanceof TooLarge) throw new PayloadTooLargeError(`Preferences must not exceed ${MAX_PREFERENCES_BYTES / 1024} KiB in all`);
      throw error;
    }
  }

  /** Size of every stored row of the user as one JSON object, cleared (null) keys included. */
  async storedBytes(userId: string, trx: Trx): Promise<number> {
    const rows = await trx.selectFrom('platform.user_preference').select(['key', 'value']).where('user_id', '=', userId).orderBy('key').execute();
    const stored: Record<string, unknown> = {};
    for (const row of rows) stored[row.key] = row.value;
    return utf8ByteLength(JSON.stringify(stored));
  }
}
