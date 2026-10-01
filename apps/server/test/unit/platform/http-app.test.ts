import type { Readable } from 'node:stream';
import { Body, Controller, Get, Module, Post, Req, type DynamicModule } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiModule } from '../../../src/app/api.module';
import { ConfigModule } from '../../../src/config/config.module';
import { MscdConfig } from '../../../src/config/mscd-config';
import { API_CONTENT_SECURITY_POLICY, createHttpApplication, trustProxyOption } from '../../../src/modules/platform/http-app';
import { PlatformModule } from '../../../src/modules/platform/platform.module';

const TEST_PROFILE = `${__dirname}/../../../profiles/test.yaml`;

function testConfig(env: Record<string, string> = {}): MscdConfig {
  return MscdConfig.load({
    runMode: 'api',
    flavor: 'dev',
    env: {
      MSCD_PROFILE_FILE: TEST_PROFILE,
      // Nothing listens there: readiness must report the database as failing.
      MSCD_DATABASE_URL: 'postgres://mscd_app:unused@127.0.0.1:1/mscd',
      MSCD__OBSERVABILITY__METRICS_PORT: 'null',
      MSCD__OBSERVABILITY__LOG_LEVEL: 'silent',
      ...env,
    },
  });
}

async function start(module: DynamicModule, config: MscdConfig): Promise<NestFastifyApplication> {
  const app = await createHttpApplication(module, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('api run mode over HTTP', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const config = testConfig();
    app = await start(ApiModule.forRoot(config), config);
  });
  afterAll(() => app?.close());

  it('answers /healthz with the F.12 headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes a valid X-Request-Id and replaces an invalid one (D.1)', async () => {
    const valid = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'trace-0001-abcd' } });
    expect(valid.headers['x-request-id']).toBe('trace-0001-abcd');
    const invalid = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'bad id!' } });
    expect(invalid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves the system profile from configuration', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/system/profile' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deploy: 'onprem',
      capabilities: {
        licenseValidation: 'offline',
        updatesChannel: 'offline',
        packsChannel: 'offline',
        telemetry: false,
        identityProviders: ['local', 'oidc', 'saml'],
        storageAdapters: ['managed_vault', 'm365', 'google_drive'],
        mailTransport: 'smtp',
        jobsDriver: 'pgboss',
      },
      demo: { enabled: true, personas: true, fixedToday: '2026-09-29' },
      login: { mfaEnforced: true },
    });
    expect(JSON.stringify(response.json())).not.toMatch(/secrets|postgres:|\/run\//);
  });

  it('reports not ready while the database is unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks).toEqual([expect.objectContaining({ name: 'database', status: 'fail' })]);
  });

  it('answers unknown routes with 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/nothing' })).statusCode).toBe(404);
  });
});

@Controller('probe')
class ProbeController {
  @Post('stream')
  async stream(@Body() body: Readable): Promise<{ streamed: boolean; bytes: number }> {
    let bytes = 0;
    for await (const chunk of body) bytes += (chunk as Buffer).length;
    return { streamed: typeof body.pipe === 'function', bytes };
  }

  @Post('json')
  json(@Body() body: unknown): unknown {
    return body;
  }

  @Get('ip')
  ip(@Req() request: FastifyRequest): { ip: string } {
    return { ip: request.ip };
  }
}

@Module({})
class ProbeModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: ProbeModule,
      imports: [ConfigModule.forRoot(config), PlatformModule.forRunMode('worker')],
      controllers: [ProbeController],
    };
  }
}

describe('HTTP plugins and proxy trust', () => {
  it('hands application/octet-stream bodies to the handler as a stream, beyond the JSON limit', async () => {
    const config = testConfig();
    const app = await start(ProbeModule.forRoot(config), config);
    try {
      const payload = Buffer.alloc(3 * 1024 * 1024, 7);
      const streamed = await app.inject({ method: 'POST', url: '/probe/stream', payload, headers: { 'content-type': 'application/octet-stream' } });
      expect(streamed.json()).toEqual({ streamed: true, bytes: payload.length });
      const tooLarge = await app.inject({
        method: 'POST',
        url: '/probe/json',
        payload: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }),
        headers: { 'content-type': 'application/json' },
      });
      expect(tooLarge.statusCode).toBe(413);
      // The system profile route belongs to run mode api only.
      expect((await app.inject({ method: 'GET', url: '/api/v1/system/profile' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('ignores X-Forwarded-For unless the peer is a trusted proxy (F.12)', async () => {
    const untrusted = testConfig();
    const app = await start(ProbeModule.forRoot(untrusted), untrusted);
    try {
      const response = await app.inject({ method: 'GET', url: '/probe/ip', headers: { 'x-forwarded-for': '203.0.113.9' } });
      expect(response.json()).toEqual({ ip: '127.0.0.1' });
    } finally {
      await app.close();
    }
    const trusted = testConfig({ MSCD__HTTP__TRUST_PROXY: '{cidrs: [127.0.0.1/32]}' });
    const proxied = await start(ProbeModule.forRoot(trusted), trusted);
    try {
      const response = await proxied.inject({ method: 'GET', url: '/probe/ip', headers: { 'x-forwarded-for': '203.0.113.9' } });
      expect(response.json()).toEqual({ ip: '203.0.113.9' });
    } finally {
      await proxied.close();
    }
  });

  it('maps http.trust_proxy to Fastify trustProxy and never to true', () => {
    expect(trustProxyOption({ hops: 0 })).toBe(false);
    expect(trustProxyOption({ hops: 1 })).toBe(1);
    expect(trustProxyOption({ cidrs: ['172.31.250.10/32'] })).toEqual(['172.31.250.10/32']);
  });
});
