import { describe, expect, it } from 'vitest';
import { ADAPTER_FACTORIES } from '../../../src/gateway/adapters';
import { googleDriveAdapterFactory } from '../../../src/gateway/adapters/google-drive';
import { managedVaultAdapterFactory } from '../../../src/gateway/adapters/managed-vault/vault-adapter';
import { m365AdapterFactory } from '../../../src/gateway/adapters/m365';

// The running storage-gateway builds its registry from ADAPTER_FACTORIES; an adapter missing here answers 422
// unsupported for every repository of its kind, even though its own tests pass with injected factories.
describe('storage gateway adapter factories', () => {
  it('registers the Managed Vault, Microsoft 365 and Google Drive adapters', () => {
    expect(ADAPTER_FACTORIES).toEqual([managedVaultAdapterFactory, m365AdapterFactory, googleDriveAdapterFactory]);
  });
});
