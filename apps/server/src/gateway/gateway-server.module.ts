import { Inject, Injectable, Logger, Module, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { Counter, Histogram } from 'prom-client';
import { ConfigError, MscdConfig } from '../config/mscd-config';
import { FileKeyProvider, keyFileTooOpen } from '../modules/keys/file-key-provider';
import { MetricsService } from '../modules/platform/metrics';
import { ReadinessService } from '../modules/platform/readiness.service';
import { ADAPTER_FACTORIES, AdapterRegistry, type AdapterFactory } from './adapters';
import { ManagedVaultAdapter } from './adapters/managed-vault/vault-adapter';
import { GatewayTokens } from './auth';
import { DataKeyService } from './crypto/data-keys';
import { gatewayRoutes, type GatewayCallLogEntry } from './routes';

/** Injection token of the adapter factories (tests replace it to add fake provider adapters). */
export const GATEWAY_ADAPTER_FACTORIES = Symbol.for('mscd.gatewayAdapterFactories');

/** Governance retention of audit anchors when the bucket has object lock but no default retention rule. */
export const ANCHOR_LOCK_DAYS = 3650;

/** Default provider base URLs (I.1); any other URL needs its host in `network.egress_allowlist` or demo mode. */
const DEFAULT_PROVIDER_URLS: readonly [path: string, url: string][] = [
  ['gateway.providers.m365.graph_base_url', 'https://graph.microsoft.com/v1.0'],
  ['gateway.providers.m365.login_base_url', 'https://login.microsoftonline.com'],
  ['gateway.providers.google.api_base_url', 'https://www.googleapis.com'],
  ['gateway.providers.google.token_url', 'https://oauth2.googleapis.com/token'],
];

/** Start-up checks of run mode `storage-gateway` that the profile schema cannot express (D.4, I.1). */
export function checkGatewayProfile(config: MscdConfig): void {
  const { profile } = config;
  if (profile.gateway.tls.mode === 'off' && !profile.demo.enabled) {
    throw new ConfigError('gateway.tls.mode off is refused unless demo.enabled is true (D.4)');
  }
  const providers = profile.gateway.providers;
  const configured: Record<string, string> = {
    'gateway.providers.m365.graph_base_url': providers.m365.graph_base_url,
    'gateway.providers.m365.login_base_url': providers.m365.login_base_url,
    'gateway.providers.google.api_base_url': providers.google.api_base_url,
    'gateway.providers.google.token_url': providers.google.token_url,
  };
  const allowed = new Set(profile.network.egress_allowlist.map((entry) => entry.toLowerCase()));
  for (const [path, defaultUrl] of DEFAULT_PROVIDER_URLS) {
    const url = configured[path]!;
    if (url.replace(/\/+$/, '') === defaultUrl || profile.demo.enabled) continue;
    const host = new URL(url).hostname.toLowerCase();
    if (!allowed.has(host)) {
      throw new ConfigError(`${path} ${url} is not the provider's default; add ${host} to network.egress_allowlist to use it (I.1)`);
    }
  }
}

/**
 * The storage gateway of run mode `storage-gateway` (D.5): loads `storage.key`, the gateway tokens and the adapters
 * at start, registers the `/v1` routes on the run mode's Fastify application, and adds the readiness checks
 * `storage-key` and `vault-bucket` (when the Managed Vault is enabled) and the call metrics.
 */
@Injectable()
export class GatewayRuntime implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('StorageGateway');
  private registry: AdapterRegistry | null = null;
  private keys: DataKeyService | null = null;

  constructor(
    private readonly config: MscdConfig,
    private readonly adapterHost: HttpAdapterHost,
    private readonly readiness: ReadinessService,
    private readonly metrics: MetricsService,
    @Optional() @Inject(GATEWAY_ADAPTER_FACTORIES) private readonly factories?: readonly AdapterFactory[],
  ) {}

  /** The adapters of this process (after start). */
  get adapters(): AdapterRegistry {
    if (!this.registry) throw new Error('The storage gateway has not started');
    return this.registry;
  }

  /** The tenant data key service (after start). */
  get dataKeys(): DataKeyService {
    if (!this.keys) throw new Error('The storage gateway has not started');
    return this.keys;
  }

  onModuleInit(): void {
    const { gateway } = this.config.profile;
    checkGatewayProfile(this.config);

    const kms = gateway.kms.file;
    for (const file of [kms.path, ...kms.previous_paths]) {
      if (keyFileTooOpen(file)) this.logger.warn(`Key file ${file} can be read by other users; use mode 0400 (F.11)`);
    }
    let kek: FileKeyProvider;
    const tokens = new GatewayTokens(gateway.token_files);
    try {
      kek = FileKeyProvider.fromFiles(kms.path, kms.previous_paths);
      tokens.assertCurrentReadable();
    } catch (error) {
      // A missing or malformed key or token stops the gateway before it serves anything, without a stack trace.
      throw new ConfigError((error as Error).message);
    }
    this.keys = new DataKeyService(kek);

    this.registry = AdapterRegistry.create({ config: this.config }, this.factories ?? ADAPTER_FACTORIES);
    const vault = this.registry.find('managed_vault');
    const anchorStore = vault instanceof ManagedVaultAdapter ? vault.store : null;

    const kekId = kek.kekId;
    this.readiness.register({ name: 'storage-key', check: async () => `storage.key ${kekId}` });
    if (vault?.ready) {
      const check = vault.ready.bind(vault);
      this.readiness.register({ name: 'vault-bucket', check: async () => (await check()) ?? undefined, timeoutMs: 5000 });
    }

    const calls = new Counter({
      name: 'mscd_gateway_calls_total',
      help: 'Storage gateway calls by operation, adapter and outcome',
      labelNames: ['operation', 'adapter', 'outcome'],
      registers: [this.metrics.registry],
    });
    const latency = new Histogram({
      name: 'mscd_gateway_call_duration_seconds',
      help: 'Storage gateway call latency',
      labelNames: ['operation', 'adapter'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.metrics.registry],
    });

    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    void fastify.register(
      gatewayRoutes({
        tlsMode: gateway.tls.mode,
        tokens,
        dataKeys: this.keys,
        adapters: this.registry,
        anchorStore,
        anchorLockDays: ANCHOR_LOCK_DAYS,
        log: (entry: GatewayCallLogEntry) => {
          calls.inc({ operation: entry.operation, adapter: entry.adapter ?? 'none', outcome: entry.outcome });
          latency.observe({ operation: entry.operation, adapter: entry.adapter ?? 'none' }, entry.latencyMs / 1000);
          if (entry.outcome === 'ok') this.logger.log(entry);
          else this.logger.warn(entry);
        },
      }),
      { prefix: '/v1' },
    );
    this.logger.log(
      `Storage gateway: storage.key ${kekId}, TLS ${gateway.tls.mode}, adapters ${this.registry.names().join(', ') || 'none'}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.keys?.clear();
    await this.registry?.close();
  }
}

/**
 * Storage gateway of run mode `storage-gateway` (D.5): HTTP server with mTLS, key handling, credential sealing,
 * file type detection and the adapters. Imported by `GatewayModule`; no database access.
 */
@Module({
  providers: [GatewayRuntime, { provide: GATEWAY_ADAPTER_FACTORIES, useValue: ADAPTER_FACTORIES }],
  exports: [GatewayRuntime],
})
export class GatewayServerModule {}
