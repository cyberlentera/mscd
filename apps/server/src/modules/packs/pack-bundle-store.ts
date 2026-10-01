// Where an imported pack bundle waits for the worker's `pack.install` job (D.3 `POST /admin/packs/import`). With a
// storage gateway client and an organisation, the bundle is stored in that organisation's Managed Vault through the
// gateway (encrypted, SHA-256 checked when read back). Without a gateway client (tests, a single process) or without
// an organisation (a platform operator who has none), it is a local temporary file readable only by this process's
// user. The object key names the store: `vault:<base64url JSON>` or `local:<install id>.pack`.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MAX_PACK_IMPORT_BYTES, type GatewayRepository, type PutHeader, type PutResult } from '@mscd/shared';
import { GATEWAY_CLIENT, SYSTEM_USER_ID, type GatewayClient, type TenantInfo, type Trx } from '../../common/tokens';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';

/** Folder of the local store (created with mode 0700). */
export const LOCAL_BUNDLE_DIR = path.join(os.tmpdir(), 'mscd-pack-imports');

const LOCAL_KEY = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pack$/;
const VAULT_PREFIX = 'vault:';

interface VaultRef {
  o: string;
  r: string;
  i: string;
  v: string | null;
  h: string;
  f: string;
}

export interface BundlePutContext {
  installId: string;
  /** The importing user's organisation (its Managed Vault holds the bundle when a gateway client exists). */
  org: TenantInfo | null;
}

@Injectable()
export class PackBundleStore {
  private readonly logger = new Logger('PackBundleStore');

  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    @Optional() @Inject(GATEWAY_CLIENT) private readonly gateway?: GatewayClient,
  ) {}

  /** Stores a bundle and returns its object key. */
  async put(bytes: Buffer, context: BundlePutContext): Promise<string> {
    if (this.gateway && context.org) return this.putVault(this.gateway, bytes, context.org, context.installId);
    if (this.gateway) this.logger.warn('Pack import without an organisation: the bundle is kept in a local temporary file of this process');
    return this.putLocal(bytes, context.installId);
  }

  /** Reads a stored bundle (at most the import limit). */
  async get(objectKey: string): Promise<Buffer> {
    const local = LOCAL_KEY.exec(objectKey);
    if (local) {
      const bytes = await readFile(path.join(LOCAL_BUNDLE_DIR, `${local[1]}.pack`));
      if (bytes.length > MAX_PACK_IMPORT_BYTES) throw new Error('The stored bundle is larger than the import limit');
      return bytes;
    }
    if (objectKey.startsWith(VAULT_PREFIX)) return this.getVault(objectKey);
    throw new Error('Unknown pack bundle object key');
  }

  /** Removes a local bundle after the install; vault objects are immutable and stay (D-10). */
  async remove(objectKey: string): Promise<void> {
    const local = LOCAL_KEY.exec(objectKey);
    if (local) await rm(path.join(LOCAL_BUNDLE_DIR, `${local[1]}.pack`), { force: true });
  }

  private async putLocal(bytes: Buffer, installId: string): Promise<string> {
    const key = `local:${installId}.pack`;
    if (!LOCAL_KEY.test(key)) throw new Error('The install id is not a UUID');
    await mkdir(LOCAL_BUNDLE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(path.join(LOCAL_BUNDLE_DIR, `${installId}.pack`), bytes, { mode: 0o600, flag: 'wx' });
    return key;
  }

  private async vaultOf(trx: Trx, orgId: string, repositoryId?: string): Promise<{ wrappedDek: string; repository: GatewayRepository }> {
    const key = await trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', orgId).executeTakeFirst();
    if (!key) throw new Error('The organisation has no data key');
    let query = trx
      .selectFrom('storage_repository')
      .select(['id', 'slug', 'adapter', 'modes', 'config'])
      .where('adapter', '=', 'managed_vault')
      .where('deleted_at', 'is', null);
    if (repositoryId) query = query.where('id', '=', repositoryId);
    const row = await query.orderBy('position').orderBy('created_at').executeTakeFirst();
    if (!row) throw new Error('The organisation has no Managed Vault repository');
    return {
      wrappedDek: key.wrapped_dek,
      repository: { id: row.id, slug: row.slug, adapter: row.adapter, modes: row.modes as GatewayRepository['modes'], config: row.config as Record<string, unknown> },
    };
  }

  private async putVault(gateway: GatewayClient, bytes: Buffer, org: TenantInfo, installId: string): Promise<string> {
    const vault = await this.scope.withTenant(systemContextOf(org), (trx) => this.vaultOf(trx, org.id));
    const header: PutHeader = {
      tenant: { orgId: org.id, wrappedDek: vault.wrappedDek },
      repository: vault.repository,
      scopeRoot: { folderId: null, path: 'packs' },
      folderPath: 'imports',
      fileName: `${installId}.pack`,
      maxBytes: MAX_PACK_IMPORT_BYTES,
      metadataMinimization: false,
    };
    const result = await gateway.putObject<PutResult>(header, Readable.from(bytes));
    const expected = createHash('sha256').update(bytes).digest('hex');
    if (result.hashValue !== expected) throw new Error('The vault stored different bytes than were sent');
    const ref: VaultRef = { o: org.id, r: vault.repository.id, i: result.externalItemId, v: result.externalVersionId, h: result.hashValue, f: result.folderPath };
    return `${VAULT_PREFIX}${Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url')}`;
  }

  private async getVault(objectKey: string): Promise<Buffer> {
    if (!this.gateway) throw new Error('The pack bundle is in the Managed Vault but this process has no storage gateway client');
    let ref: VaultRef;
    try {
      ref = JSON.parse(Buffer.from(objectKey.slice(VAULT_PREFIX.length), 'base64url').toString('utf8')) as VaultRef;
    } catch {
      throw new Error('The pack bundle object key is malformed');
    }
    const org = await this.tenants.resolveById(ref.o);
    if (!org) throw new Error('The organisation of the pack bundle does not exist');
    const vault = await this.scope.withTenant({ ...systemContextOf(org), userId: SYSTEM_USER_ID }, (trx) => this.vaultOf(trx, org.id, ref.r));
    const { stream } = await this.gateway.stream({
      tenant: { orgId: org.id, wrappedDek: vault.wrappedDek },
      repository: vault.repository,
      object: { externalItemId: ref.i, externalVersionId: ref.v, hashAlgorithm: 'sha256', hashValue: ref.h, hashSource: 'computed', folderPath: ref.f },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > MAX_PACK_IMPORT_BYTES) throw new Error('The stored bundle is larger than the import limit');
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.h) throw new Error('The stored bundle does not match its SHA-256');
    return bytes;
  }
}
