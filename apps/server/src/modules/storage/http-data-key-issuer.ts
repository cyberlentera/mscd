// `DataKeyIssuer` of `TenantProvisioner` (build plan C.8 step 4) through the storage gateway client: the gateway
// wraps a new tenant data key with `storage.key` (`POST /v1/keys/data-key`, D.5). An unreachable gateway or a
// malformed answer fails the provisioning, so no organisation is created without a key.
import { DataKeyResponse } from '@mscd/shared';
import type { MscdConfig } from '../../config/mscd-config';
import type { GatewayClient } from '../../common/tokens';
import { TenantProvisioningError, type DataKeyIssuer, type WrappedDataKey } from '../../db/tenant-provisioner';
import { HttpGatewayClient } from './gateway-client';

export class HttpDataKeyIssuer implements DataKeyIssuer {
  constructor(private readonly client: GatewayClient) {}

  async issue(orgId: string): Promise<WrappedDataKey> {
    let answer: unknown;
    try {
      answer = await this.client.post('/v1/keys/data-key', { orgId });
    } catch (error) {
      throw new TenantProvisioningError(`the storage gateway did not issue a data key: ${(error as Error).message}`, { cause: error });
    }
    const parsed = DataKeyResponse.safeParse(answer);
    if (!parsed.success) throw new TenantProvisioningError('the storage gateway answer has no valid wrappedDek and kekId');
    return { wrappedDek: parsed.data.wrappedDek, kekId: parsed.data.kekId };
  }
}

/** The issuer of a process outside Nest (commands): a gateway client on the profile's `storage.gateway`. */
export function httpDataKeyIssuer(config: MscdConfig): { issuer: HttpDataKeyIssuer; close(): Promise<void> } {
  const client = new HttpGatewayClient(config);
  return { issuer: new HttpDataKeyIssuer(client), close: () => client.onApplicationShutdown() };
}
