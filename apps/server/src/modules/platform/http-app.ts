import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { Logger } from 'nestjs-pino';
import type { MscdConfig } from '../../config/mscd-config';
import type { Profile } from '../../config/profile.schema';
import { requestIdFrom } from './request-id';

/** F.12 body limit for JSON. Upload content streams are limited by their intent; pack imports set a route limit. */
export const JSON_BODY_LIMIT = 1024 * 1024;

/** F.12: JSON never needs more than this policy; file responses tighten it further (F.13). */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** `http.trust_proxy` to Fastify `trustProxy`: hop count or address ranges, never `true` (F.12). */
export function trustProxyOption(trustProxy: Profile['http']['trust_proxy']): false | number | string[] {
  if ('hops' in trustProxy) return trustProxy.hops === 0 ? false : trustProxy.hops;
  return [...trustProxy.cidrs];
}

/** Options of the Fastify instance behind Nest. */
export function fastifyAdapterOptions(config: MscdConfig) {
  return {
    trustProxy: trustProxyOption(config.profile.http.trust_proxy),
    bodyLimit: JSON_BODY_LIMIT,
    // X-Request-Id is accepted only in the D.1 form; otherwise a new UUID.
    requestIdHeader: false as const,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => requestIdFrom(req.headers['x-request-id']),
    logger: false,
    return503OnClosing: true,
  };
}

/**
 * Registers the HTTP plugins and hooks every MSCD Fastify application uses: cookies, security headers (F.12),
 * multipart uploads limited by `storage.max_upload_bytes`, a raw `application/octet-stream` parser that hands
 * the request stream to the handler without buffering (upload content routes), the request id response header
 * and `Cache-Control: no-store`.
 */
export async function configureHttpApplication(app: NestFastifyApplication, config: MscdConfig): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    global: true,
    // Set exactly as F.12 writes it by the hook below.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.profile.storage.max_upload_bytes, files: 1, fields: 20, parts: 21 },
  });

  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  fastify.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', API_CONTENT_SECURITY_POLICY);
    done();
  });
}

/** Creates the Nest application of an HTTP run mode on Fastify, with pino logging and the plugins above. */
export async function createHttpApplication(
  module: DynamicModule | Type<unknown>,
  config: MscdConfig,
): Promise<NestFastifyApplication> {
  // Nest's console logger stays off: start-up errors are printed once by the caller (configuration errors without
  // a stack trace), and everything after start goes through pino.
  const app = await NestFactory.create<NestFastifyApplication>(module, new FastifyAdapter(fastifyAdapterOptions(config)), {
    logger: false,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  app.enableShutdownHooks();
  return app;
}
