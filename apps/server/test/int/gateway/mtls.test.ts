// Gateway transport security (D.4, D.5, I.3): with `tls.mode: mtls` a client certificate of the installation CA is
// required and verified, only `CN=mscd-api` and `CN=mscd-worker` are callers and only the worker writes anchors;
// the api's gateway client presents its certificate and refuses http with mtls; the previous gateway token works
// until the next rotation; demo mode alone allows TLS off.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotateGatewayToken } from '../../../src/cli/keys';
import { ConfigError, MscdConfig } from '../../../src/config/mscd-config';
import { gatewayAdapterOptions } from '../../../src/gateway/gateway-app';
import { checkGatewayProfile } from '../../../src/gateway/gateway-server.module';
import { GatewayProblemError, GatewayUnavailableError, HttpGatewayClient, checkGatewayEndpoint } from '../../../src/modules/storage/gateway-client';
import { HttpDataKeyIssuer } from '../../../src/modules/storage/http-data-key-issuer';
import {
  GATEWAY_TOKEN,
  TEST_PROFILE_FILE,
  gatewayCall,
  gatewayConfig,
  makeCertificates,
  startGateway,
  startSeaweed,
  tempDir,
  tlsAgent,
  vaultEnv,
  type Certificates,
  type RunningGateway,
  type Seaweed,
} from './helpers';

const ORG = '00000000-0000-4000-8000-00000000c001';

describe('mutual TLS and gateway tokens (D.4, D.5)', () => {
  let seaweed: Seaweed;
  let certs: Certificates;
  let gateway: RunningGateway;
  let tokenDir: string;
  let currentToken: string;
  let previousToken: string;

  beforeAll(async () => {
    seaweed = await startSeaweed();
    certs = makeCertificates();
    tokenDir = tempDir('mscd-wp13-tokens-');
    currentToken = path.join(tokenDir, 'gateway.token');
    previousToken = path.join(tokenDir, 'gateway.token.previous');
    writeFileSync(currentToken, `${GATEWAY_TOKEN}\n`, { mode: 0o600 });
    gateway = await startGateway(
      gatewayConfig({
        ...vaultEnv(seaweed),
        MSCD__GATEWAY__TLS__MODE: 'mtls',
        MSCD__GATEWAY__TLS__CA_FILE: certs.files.ca,
        MSCD__GATEWAY__TLS__CERT_FILE: certs.files.gatewayCert,
        MSCD__GATEWAY__TLS__KEY_FILE: certs.files.gatewayKey,
        MSCD__GATEWAY__TOKEN_FILES: `[${currentToken}, ${previousToken}]`,
      }),
    );
  });
  afterAll(async () => {
    await gateway?.close();
    await seaweed?.stop();
  });

  it('refuses a connection without a client certificate or with one of another CA', async () => {
    await expect(gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG }, { dispatcher: tlsAgent(certs) })).rejects.toThrow();
    await expect(gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG }, { dispatcher: tlsAgent(certs, certs.rogue) })).rejects.toThrow();
  });

  it('accepts the api and worker certificates and refuses any other name of the CA', async () => {
    const api = await gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG }, { dispatcher: tlsAgent(certs, certs.client('mscd-api')) });
    expect(api.status).toBe(200);
    const worker = await gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG }, { dispatcher: tlsAgent(certs, certs.client('mscd-worker')) });
    expect(worker.status).toBe(200);
    const intruder = await gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG }, { dispatcher: tlsAgent(certs, certs.client('intruder')) });
    expect(intruder.status).toBe(403);
    expect(intruder.json()).toMatchObject({ reason: 'caller' });
  });

  it('lets only the worker write audit anchors', async () => {
    const body = { tenant: null, objectKey: 'audit-anchors/tenant/2026-09-29-mtls.json', body: { chain: 'tenant', seq: 1 } };
    const api = await gatewayCall(gateway.url, '/v1/anchors', body, { dispatcher: tlsAgent(certs, certs.client('mscd-api')) });
    expect(api.status).toBe(403);
    expect(api.json()).toMatchObject({ reason: 'caller' });
    const worker = await gatewayCall(gateway.url, '/v1/anchors', body, { dispatcher: tlsAgent(certs, certs.client('mscd-worker')) });
    expect(worker.status).toBe(200);
  });

  it('keeps the previous token valid until the next rotation (keys rotate-gateway-token)', async () => {
    const dispatcher = tlsAgent(certs, certs.client('mscd-api'));
    const call = (token: string) => gatewayCall(gateway.url, '/v1/keys/data-key', { orgId: ORG }, { dispatcher, token });
    const first = GATEWAY_TOKEN;
    expect((await call(first)).status).toBe(200);
    rotateGatewayToken(currentToken, previousToken);
    const second = readFileSync(currentToken, 'utf8').trim();
    expect(second).not.toBe(first);
    expect((await call(second)).status).toBe(200);
    expect((await call(first)).status).toBe(200);
    rotateGatewayToken(currentToken, previousToken);
    const third = readFileSync(currentToken, 'utf8').trim();
    expect((await call(third)).status).toBe(200);
    expect((await call(second)).status).toBe(200);
    const refused = await call(first);
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({ reason: 'token' });
  });

  it('the api gateway client presents its certificate, reads the token per call and maps problems', async () => {
    const config = MscdConfig.load({
      runMode: 'api',
      env: {
        ...process.env,
        MSCD_PROFILE_FILE: TEST_PROFILE_FILE,
        MSCD__STORAGE__GATEWAY__URL: gateway.url,
        MSCD__STORAGE__GATEWAY__TOKEN_FILE: currentToken,
        MSCD__STORAGE__GATEWAY__TLS__MODE: 'mtls',
        MSCD__STORAGE__GATEWAY__TLS__CA_FILE: certs.files.ca,
        MSCD__STORAGE__GATEWAY__TLS__CERT_FILE: certs.client('mscd-api').certFile,
        MSCD__STORAGE__GATEWAY__TLS__KEY_FILE: certs.client('mscd-api').keyFile,
      },
    });
    const client = new HttpGatewayClient(config);
    try {
      const issued = await new HttpDataKeyIssuer(client).issue(ORG);
      expect(issued.wrappedDek.startsWith(`v1.${issued.kekId}.`)).toBe(true);
      // A rotation needs no restart of the api: the token file is read on every call.
      rotateGatewayToken(currentToken, previousToken);
      expect((await new HttpDataKeyIssuer(client).issue(ORG)).kekId).toBe(issued.kekId);
      const problem = await client.post('/v1/stat', { tenant: { orgId: ORG, wrappedDek: issued.wrappedDek } }).catch((error: unknown) => error);
      expect(problem).toBeInstanceOf(GatewayProblemError);
      expect(problem).toMatchObject({ gatewaySlug: 'bad-request', gatewayStatus: 400 });
    } finally {
      await client.onApplicationShutdown();
    }
    // A certificate of the CA with another name is refused as a caller.
    const noCert = new HttpGatewayClient(
      MscdConfig.load({
        runMode: 'api',
        env: {
          ...process.env,
          MSCD_PROFILE_FILE: TEST_PROFILE_FILE,
          MSCD__STORAGE__GATEWAY__URL: gateway.url,
          MSCD__STORAGE__GATEWAY__TOKEN_FILE: currentToken,
          MSCD__STORAGE__GATEWAY__TLS__MODE: 'mtls',
          MSCD__STORAGE__GATEWAY__TLS__CA_FILE: certs.files.ca,
          MSCD__STORAGE__GATEWAY__TLS__CERT_FILE: certs.client('intruder').certFile,
          MSCD__STORAGE__GATEWAY__TLS__KEY_FILE: certs.client('intruder').keyFile,
        },
      }),
    );
    try {
      await expect(noCert.post('/v1/keys/data-key', { orgId: ORG })).rejects.toMatchObject({ gatewaySlug: 'forbidden', reason: 'caller' });
    } finally {
      await noCert.onApplicationShutdown();
    }
  });

  it('refuses an http gateway URL with mtls, and TLS off outside demo mode', async () => {
    expect(() => checkGatewayEndpoint({ url: 'http://storage-gateway:8443', tlsMode: 'mtls' })).toThrow(ConfigError);
    expect(() => checkGatewayEndpoint({ url: 'https://storage-gateway:8443', tlsMode: 'off' })).toThrow(ConfigError);
    expect(checkGatewayEndpoint({ url: 'https://storage-gateway:8443', tlsMode: 'mtls' }).host).toBe('storage-gateway:8443');
    const client = new HttpGatewayClient(
      MscdConfig.load({
        runMode: 'api',
        env: { ...process.env, MSCD_PROFILE_FILE: TEST_PROFILE_FILE, MSCD__STORAGE__GATEWAY__URL: 'http://127.0.0.1:9', MSCD__STORAGE__GATEWAY__TLS__MODE: 'off' },
      }),
    );
    await expect(client.post('/v1/keys/data-key', { orgId: ORG })).rejects.toBeInstanceOf(GatewayUnavailableError);
    await client.onApplicationShutdown();
    // The profile rules refuse TLS off without demo mode; the gateway checks again at start.
    expect(() => gatewayConfig({ MSCD__DEMO__ENABLED: 'false', MSCD__DEMO__FIXED_TODAY: 'null', MSCD__DEMO__PERSONAS: 'false', MSCD__IDENTITY__OIDC__ALLOW_INSECURE_HTTP: 'false', MSCD__STORAGE__GATEWAY__TLS__MODE: 'mtls', MSCD__TEST__ENDPOINTS_ENABLED: 'false' })).toThrow(/gateway.tls.mode/);
    const demo = gatewayConfig({});
    expect(() => gatewayAdapterOptions(demo)).not.toThrow();
    expect(() => checkGatewayProfile(demo)).not.toThrow();
  });

  it('refuses non-default provider URLs outside demo mode unless their host is allowed (I.1)', () => {
    const base = {
      MSCD__DEMO__ENABLED: 'false',
      MSCD__DEMO__FIXED_TODAY: 'null',
      MSCD__DEMO__PERSONAS: 'false',
      MSCD__IDENTITY__OIDC__ALLOW_INSECURE_HTTP: 'false',
      MSCD__TEST__ENDPOINTS_ENABLED: 'false',
      MSCD__GATEWAY__TLS__MODE: 'mtls',
      MSCD__GATEWAY__TLS__CA_FILE: certs.files.ca,
      MSCD__GATEWAY__TLS__CERT_FILE: certs.files.gatewayCert,
      MSCD__GATEWAY__TLS__KEY_FILE: certs.files.gatewayKey,
      MSCD__STORAGE__GATEWAY__URL: 'https://storage-gateway:8443',
      MSCD__STORAGE__GATEWAY__TLS__MODE: 'mtls',
      MSCD__STORAGE__GATEWAY__TLS__CA_FILE: certs.files.ca,
      MSCD__STORAGE__GATEWAY__TLS__CERT_FILE: certs.client('mscd-api').certFile,
      MSCD__STORAGE__GATEWAY__TLS__KEY_FILE: certs.client('mscd-api').keyFile,
    };
    expect(() => checkGatewayProfile(gatewayConfig(base))).toThrow(/egress_allowlist/);
    const allowed = gatewayConfig({ ...base, MSCD__NETWORK__EGRESS_ALLOWLIST: '[localhost]' });
    expect(() => checkGatewayProfile(allowed)).not.toThrow();
  });
});
