// Tenant data keys and repository credentials of the demo seed (build plan C.8 step 4, D-08, WP-14 brief). The seed
// gets both from the storage gateway of the profile (Compose), or, where no gateway runs (integration test templates,
// a developer database), from an in-process gateway key service that uses the gateway's own key file
// (`gateway.kms.file`), so a gateway started later with the same profile opens what the seed sealed.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DataKeyResponse, SealedCredential, type CredentialKind, type StorageAdapter, type StorageMode } from '@mscd/shared';
import type { MscdConfig } from '../config/mscd-config';
import type { DataKeyIssuer, WrappedDataKey } from '../db/tenant-provisioner';
import { sealCredential } from '../gateway/crypto/credentials';
import { DataKeyService } from '../gateway/crypto/data-keys';
import { FileKeyProvider } from '../modules/keys/file-key-provider';
import { GatewayUnavailableError, HttpGatewayClient } from '../modules/storage/gateway-client';

export interface SealInput {
  tenant: { orgId: string; wrappedDek: string };
  repository: { id: string; slug: string; adapter: StorageAdapter; modes: StorageMode[]; config: Record<string, unknown> };
  kind: CredentialKind;
  secret: Record<string, unknown>;
}

export interface SealOutput {
  sealedBlob: string;
  keyId: string;
  configSha256: string;
}

/** Where the seed's data keys and sealed credentials come from. */
export interface SeedKeyService {
  /** `gateway` or `local`, for the command output. */
  readonly mode: 'gateway' | 'local';
  readonly dataKeys: DataKeyIssuer;
  /**
   * Seals a repository credential bound to organisation, repository and config (D-08). The gateway refuses a refresh
   * token outside the consent flow, so `sealsRefreshTokens` tells whether a delegated token can be seeded.
   */
  seal(input: SealInput): Promise<SealOutput>;
  readonly sealsRefreshTokens: boolean;
  close(): Promise<void>;
}

/** In-process key service on the gateway's key file (`gateway.kms.file`): what the gateway itself would do. */
export class LocalKeyService implements SeedKeyService {
  readonly mode = 'local' as const;
  readonly sealsRefreshTokens = true;
  readonly dataKeys: DataKeyIssuer;
  private readonly service: DataKeyService;

  constructor(kek: FileKeyProvider) {
    this.service = new DataKeyService(kek);
    this.dataKeys = { issue: (orgId: string): Promise<WrappedDataKey> => this.service.issue(orgId) };
  }

  static fromConfig(config: MscdConfig): LocalKeyService {
    const kms = config.profile.gateway.kms.file;
    return new LocalKeyService(FileKeyProvider.fromFiles(kms.path, kms.previous_paths));
  }

  async seal(input: SealInput): Promise<SealOutput> {
    const dataKey = await this.service.unwrap(input.tenant.orgId, input.tenant.wrappedDek);
    return sealCredential(dataKey, input.repository, input.kind, input.secret);
  }

  async close(): Promise<void> {
    this.service.clear();
  }
}

/** The storage gateway of the profile (`storage.gateway`): `POST /v1/keys/data-key` and `/v1/credentials/seal`. */
export class GatewayKeyService implements SeedKeyService {
  readonly mode = 'gateway' as const;
  readonly sealsRefreshTokens = false;
  readonly dataKeys: DataKeyIssuer;

  constructor(private readonly client: HttpGatewayClient) {
    this.dataKeys = {
      issue: async (orgId: string): Promise<WrappedDataKey> => DataKeyResponse.parse(await this.client.post('/v1/keys/data-key', { orgId })),
    };
  }

  async seal(input: SealInput): Promise<SealOutput> {
    const sealed = SealedCredential.parse(await this.client.post('/v1/credentials/seal', input));
    return { sealedBlob: sealed.sealedBlob, keyId: sealed.keyId, configSha256: sealed.configSha256 };
  }

  async close(): Promise<void> {
    await this.client.onApplicationShutdown();
  }
}

export type KeyServiceMode = 'auto' | 'gateway' | 'local';

/**
 * The key service for `seed demo --keys <mode>`. `auto` uses the gateway when it answers, else the local key file
 * of `gateway.kms.file` when this process can read it (a developer database without a running gateway).
 */
export async function chooseKeyService(config: MscdConfig, mode: KeyServiceMode, log: (line: string) => void = () => undefined): Promise<SeedKeyService> {
  if (mode === 'local') return LocalKeyService.fromConfig(config);
  const gateway = new GatewayKeyService(new HttpGatewayClient(config));
  if (mode === 'gateway') return gateway;
  try {
    // A throwaway key for a random organisation: the gateway keeps no state, so this only proves it answers.
    await gateway.dataKeys.issue(randomUUID());
    return gateway;
  } catch (error) {
    await gateway.close();
    if (!(error instanceof GatewayUnavailableError)) throw error;
    const keyFile = config.profile.gateway.kms.file.path;
    if (!existsSync(keyFile)) {
      throw new Error(`The storage gateway at ${config.profile.storage.gateway.url} is not reachable and ${keyFile} does not exist: ${error.message}`, { cause: error });
    }
    log(`seed demo: the storage gateway at ${config.profile.storage.gateway.url} is not reachable; using the gateway key file ${keyFile} in process`);
    return LocalKeyService.fromConfig(config);
  }
}
