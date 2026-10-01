// The storage adapter interface of the gateway (build plan D.5, TS 5.1): one method per D.5 operation. The gateway
// core validates the call, unwraps the tenant data key, opens the repository credential with its binding check and
// then dispatches to the adapter of `repository.adapter`. An adapter that lacks an optional operation answers
// `unsupported` (422) for it, except `pin-version`, which answers `{result: 'unsupported'}` (D.5).
//
// Adapters: `managed-vault` (WP-13, this folder), `m365` and `google-drive` (WP-15). An adapter must:
// - validate provider ids before use (Graph `^[A-Za-z0-9!_-]+$`, Drive `^[A-Za-z0-9_-]+$`), pass every path segment
//   through `encodeURIComponent` and build query strings with `URLSearchParams`;
// - keep every item it reads, links, lists, copies or verifies below `config.rootFolderId`, and below the call's
//   `scopeRoot` when one is given (`outside-root` otherwise);
// - throw `GatewayError` (src/gateway/problems.ts) for problems, and report provider states of `stat` in the result;
// - stream uploads through `ContentMeter` (src/gateway/streams.ts) for SHA-256, size limit and type detection.
import type { Readable } from 'node:stream';
import type {
  CopyWithinResult,
  GatewayObjectRef,
  GatewayRepository,
  ListResponse,
  ObjectMetadata,
  OpenUrlResult,
  PinVersionResult,
  PutResult,
  RehashResult,
  ScopeRoot,
  StatResult,
  StorageAdapter as StorageAdapterName,
  TestConnectionResponse,
} from '@mscd/shared';
import type { MscdConfig } from '../../config/mscd-config';
import type { OpenedCredential } from '../crypto/credentials';
import type { DataKey } from '../crypto/data-keys';

/** What an adapter receives with every call. */
export interface AdapterContext {
  /** Organisation of the call (`tenant.orgId`). */
  orgId: string;
  /** The unwrapped tenant data key. */
  dataKey: DataKey;
  /** The repository descriptor; `config` was validated with the adapter's `validateConfig`. */
  repository: GatewayRepository;
  /** The opened credential, when the descriptor carried one. */
  credential: OpenedCredential | null;
  requestId: string;
  /** Aborted when the caller goes away. */
  signal: AbortSignal;
}

export interface PutInput {
  scopeRoot: ScopeRoot;
  folderPath: string;
  fileName: string;
  maxBytes: number;
  metadataMinimization: boolean;
  /** The request body; read once. */
  body: Readable;
  /** `Content-Length` of the request when the caller sent one. */
  contentLength: number | null;
}

export interface RegisterClientUploadInput {
  scopeRoot: ScopeRoot;
  externalItemId: string;
  intent: { folderPath: string; notBefore: string; correlationCode: string; creatorEmail: string };
}

export interface StreamResult {
  stream: Readable;
  /** Plaintext size, sent as `Content-Length`. */
  size: number;
  /** Type detected when the object was stored, sent as `X-MSCD-Detected-Type`. */
  detectedType: string;
}

export interface OAuthExchangeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface OAuthExchangeOutput {
  /** The secret to seal in place of the client credential (for example `{clientId, clientSecret, refreshToken}`). */
  secret: Record<string, unknown>;
  /** The account that consented (email), stored as `storage_credential.external_account`. */
  externalAccount: string;
}

export interface StorageAdapter {
  readonly adapter: StorageAdapterName;
  /** Throws `bad-request` when the config is not valid for this adapter (and `forbidden` when it leaves the tenant). */
  validateConfig(orgId: string, config: Record<string, unknown>): void;
  testConnection(ctx: AdapterContext): Promise<Omit<TestConnectionResponse, 'latencyMs'>>;
  list(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; folderPath?: string; pageToken?: string }): Promise<ListResponse>;
  ensureFolder(ctx: AdapterContext, path: string): Promise<{ folderId: string; path: string }>;
  put?(ctx: AdapterContext, input: PutInput): Promise<PutResult>;
  link?(ctx: AdapterContext, input: { scopeRoot: ScopeRoot; externalItemId: string }): Promise<ObjectMetadata>;
  registerClientUpload?(ctx: AdapterContext, input: RegisterClientUploadInput): Promise<ObjectMetadata>;
  stat(ctx: AdapterContext, object: GatewayObjectRef): Promise<StatResult>;
  pinVersion?(ctx: AdapterContext, object: GatewayObjectRef): Promise<PinVersionResult>;
  openUrl?(ctx: AdapterContext, object: GatewayObjectRef): Promise<OpenUrlResult>;
  stream?(ctx: AdapterContext, object: GatewayObjectRef): Promise<StreamResult>;
  copyWithin(ctx: AdapterContext, objects: GatewayObjectRef[], targetFolderPath: string): Promise<CopyWithinResult>;
  rehash?(ctx: AdapterContext, object: GatewayObjectRef): Promise<RehashResult>;
  /** Repository OAuth consent (F.8): exchanges a code with the client credential of `ctx.credential`. */
  exchangeOAuthCode?(ctx: AdapterContext, input: OAuthExchangeInput): Promise<OAuthExchangeOutput>;
  /** Readiness of the adapter's backing store (the vault bucket); omitted when there is nothing to check. */
  ready?(): Promise<string | void>;
  /** Releases clients and agents. */
  close?(): Promise<void>;
}

/** What an adapter factory receives at gateway start. */
export interface AdapterFactoryContext {
  config: MscdConfig;
}

/** Creates one adapter; returns null when the adapter is not enabled in this installation. */
export type AdapterFactory = (context: AdapterFactoryContext) => StorageAdapter | null;
