// Adapter registry of the storage gateway (build plan D.5, TS 5.1). Each factory builds one adapter at start, or
// returns null when its adapter is not enabled (`storage.adapters.enabled`). WP-15 adds the Microsoft 365 and
// Google Drive factories from `./m365` and `./google-drive` to `ADAPTER_FACTORIES`.
import type { StorageAdapter as StorageAdapterName } from '@mscd/shared';
import { unsupported } from '../problems';
import { managedVaultAdapterFactory } from './managed-vault/vault-adapter';
import type { AdapterFactory, AdapterFactoryContext, StorageAdapter } from './types';

export const ADAPTER_FACTORIES: readonly AdapterFactory[] = [managedVaultAdapterFactory];

/** The adapters of this gateway process, by adapter name. */
export class AdapterRegistry {
  private readonly byName = new Map<StorageAdapterName, StorageAdapter>();

  constructor(adapters: Iterable<StorageAdapter>) {
    for (const adapter of adapters) {
      if (this.byName.has(adapter.adapter)) throw new Error(`Two storage adapters for ${adapter.adapter}`);
      this.byName.set(adapter.adapter, adapter);
    }
  }

  /** Builds every enabled adapter of the factories. */
  static create(context: AdapterFactoryContext, factories: readonly AdapterFactory[] = ADAPTER_FACTORIES): AdapterRegistry {
    const adapters: StorageAdapter[] = [];
    for (const factory of factories) {
      const adapter = factory(context);
      if (adapter) adapters.push(adapter);
    }
    return new AdapterRegistry(adapters);
  }

  /** The adapter of a repository; `unsupported` (422) when this gateway has none for it. */
  get(name: StorageAdapterName): StorageAdapter {
    const adapter = this.byName.get(name);
    if (!adapter) throw unsupported(`The storage adapter ${name} is not available in this gateway`);
    return adapter;
  }

  find(name: StorageAdapterName): StorageAdapter | undefined {
    return this.byName.get(name);
  }

  names(): StorageAdapterName[] {
    return [...this.byName.keys()];
  }

  all(): StorageAdapter[] {
    return [...this.byName.values()];
  }

  async close(): Promise<void> {
    await Promise.all(this.all().map((adapter) => adapter.close?.().catch(() => undefined)));
  }
}

export type { AdapterContext, AdapterFactory, AdapterFactoryContext, StorageAdapter } from './types';
