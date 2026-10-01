// The Fastify application of run mode `storage-gateway` (build plan D.4, D.5): HTTPS with mutual TLS on
// `gateway.port` (client certificates of the installation CA required and verified), or plain HTTP when
// `gateway.tls.mode: off`, which start-up refuses unless demo mode is on. Health, readiness and metrics are also
// served on `observability.metrics_port`, which needs no client certificate (probes and Compose health checks).
import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { configureHttpApplication, fastifyAdapterOptions } from '../modules/platform/http-app';

/**
 * Largest request header block the gateway accepts. `X-MSCD-Put` carries the base64 JSON repository descriptor
 * (config, sealed credential, wrapped data key) and can exceed Node's default of 16 KiB.
 */
export const GATEWAY_MAX_HEADER_BYTES = 96 * 1024;

/** TLS material of `gateway.tls` for mode mtls. */
export function gatewayTlsOptions(config: MscdConfig): { key: string; cert: string; ca: string } {
  const tls = config.profile.gateway.tls;
  const read = (file: string | null, key: string) => {
    if (file === null) throw new ConfigError(`gateway.tls.${key} is required with mode mtls`);
    return config.readSecretFile(file, `gateway.tls.${key}`);
  };
  return { key: read(tls.key_file, 'key_file'), cert: read(tls.cert_file, 'cert_file'), ca: read(tls.ca_file, 'ca_file') };
}

/** Options of the gateway's Fastify instance: HTTPS with required client certificates in mode mtls. */
export function gatewayAdapterOptions(config: MscdConfig): ConstructorParameters<typeof FastifyAdapter>[0] {
  const base = { ...fastifyAdapterOptions(config), trustProxy: false };
  if (config.profile.gateway.tls.mode === 'off') {
    if (!config.profile.demo.enabled) throw new ConfigError('gateway.tls.mode off is refused unless demo.enabled is true (D.4)');
    return { ...base, http: { maxHeaderSize: GATEWAY_MAX_HEADER_BYTES } } as ConstructorParameters<typeof FastifyAdapter>[0];
  }
  return {
    ...base,
    https: {
      ...gatewayTlsOptions(config),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      maxHeaderSize: GATEWAY_MAX_HEADER_BYTES,
    },
  } as ConstructorParameters<typeof FastifyAdapter>[0];
}

/** Creates the gateway application on Fastify with pino logging (`GatewayModule.forRoot(config)`). */
export async function createGatewayApplication(
  module: DynamicModule | Type<unknown>,
  config: MscdConfig,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(module, new FastifyAdapter(gatewayAdapterOptions(config)), {
    logger: false,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  app.enableShutdownHooks();
  return app;
}
