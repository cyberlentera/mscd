// Helpers of the storage gateway and storage integration tests (WP-13): a SeaweedFS container (A.3), certificates
// of a throw-away installation CA made with openssl (no key material is committed, R-11), the gateway application
// on a random port, and HTTP calls with or without a client certificate.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Agent, request, type Dispatcher } from 'undici';
import { GatewayModule } from '../../../src/app/gateway.module';
import { MscdConfig } from '../../../src/config/mscd-config';
import type { AdapterFactory } from '../../../src/gateway/adapters/types';
import { gatewayAdapterOptions } from '../../../src/gateway/gateway-app';
import { GATEWAY_ADAPTER_FACTORIES, GatewayRuntime } from '../../../src/gateway/gateway-server.module';
import { configureHttpApplication } from '../../../src/modules/platform/http-app';

export const TEST_PROFILE_FILE = path.resolve(__dirname, '../../../profiles/test.yaml');
export const SECRETS_DIR = path.resolve(__dirname, '../../fixtures/secrets');
export const SEAWEED_IMAGE = 'chrislusf/seaweedfs:4.48';
export const VAULT_BUCKET = 'mscd-vault';
/** Containers of crashed runs are removed by the global setup once this old (R-06). */
const CONTAINER_LIFETIME_MS = 3 * 60 * 60 * 1000;

export const S3_ACCESS = readFileSync(path.join(SECRETS_DIR, 's3.access'), 'utf8').trim();
export const S3_SECRET = readFileSync(path.join(SECRETS_DIR, 's3.secret'), 'utf8').trim();
export const GATEWAY_TOKEN = readFileSync(path.join(SECRETS_DIR, 'gateway.token'), 'utf8').trim();

export function tempDir(prefix = 'mscd-wp13-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export interface Seaweed {
  endpoint: string;
  s3: S3Client;
  stop(): Promise<void>;
}

/** SeaweedFS `weed mini` with the bucket `mscd-vault` and the identity of the test secrets (A.3). */
export async function startSeaweed(): Promise<Seaweed> {
  const s3json = JSON.stringify({
    identities: [{ name: 'mscd', credentials: [{ accessKey: S3_ACCESS, secretKey: S3_SECRET }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }],
  });
  let container = new GenericContainer(SEAWEED_IMAGE)
    .withCommand(['mini', '-dir=/data', '-s3.config=/etc/seaweedfs/s3.json', `-bucket=${VAULT_BUCKET}`])
    .withCopyContentToContainer([{ content: s3json, target: '/etc/seaweedfs/s3.json', mode: 0o644 }])
    .withExposedPorts(8333)
    .withLabels({ 'mscd.test': 'true', 'mscd.test.expires': String(Date.now() + CONTAINER_LIFETIME_MS) });
  const prefix = process.env.MSCD_TEST_CONTAINER_PREFIX;
  if (prefix) container = container.withName(`${prefix}seaweedfs-${randomBytes(4).toString('hex')}`);
  const started: StartedTestContainer = await container.start();
  const endpoint = `http://${started.getHost()}:${started.getMappedPort(8333)}`;
  const s3 = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS, secretAccessKey: S3_SECRET },
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: VAULT_BUCKET }));
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        await started.stop();
        throw new Error(`SeaweedFS did not become ready: ${(error as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return {
    endpoint,
    s3,
    stop: async () => {
      s3.destroy();
      await started.stop();
    },
  };
}

export interface Certificates {
  dir: string;
  caCert: string;
  gatewayCert: string;
  gatewayKey: string;
  /** Client certificates signed by the CA, by common name. */
  client(cn: 'mscd-api' | 'mscd-worker' | 'intruder'): { cert: string; key: string; certFile: string; keyFile: string };
  /** A client certificate with CN=mscd-api signed by another CA. */
  rogue: { cert: string; key: string };
  files: { ca: string; gatewayCert: string; gatewayKey: string };
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

/** An installation CA, a gateway server certificate for localhost and client certificates (openssl). */
export function makeCertificates(): Certificates {
  const dir = tempDir('mscd-wp13-certs-');
  const ca = (name: string, cn: string) => {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '2', '-subj', `/CN=${cn}`], dir);
  };
  const leaf = (name: string, cn: string, signer: string, extensions: string) => {
    writeFileSync(path.join(dir, `${name}.ext`), extensions);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`], dir);
    openssl(
      ['x509', '-req', '-in', `${name}.csr`, '-CA', `${signer}.crt`, '-CAkey', `${signer}.key`, '-CAcreateserial', '-out', `${name}.crt`, '-days', '2', '-extfile', `${name}.ext`],
      dir,
    );
  };
  ca('ca', 'MSCD Test Installation CA');
  ca('rogue-ca', 'Another CA');
  leaf('gateway', 'storage-gateway', 'ca', 'subjectAltName=DNS:localhost,DNS:storage-gateway,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  for (const cn of ['mscd-api', 'mscd-worker', 'intruder']) leaf(cn, cn, 'ca', 'extendedKeyUsage=clientAuth\n');
  leaf('rogue', 'mscd-api', 'rogue-ca', 'extendedKeyUsage=clientAuth\n');
  const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');
  return {
    dir,
    caCert: read('ca.crt'),
    gatewayCert: read('gateway.crt'),
    gatewayKey: read('gateway.key'),
    client: (cn) => ({ cert: read(`${cn}.crt`), key: read(`${cn}.key`), certFile: path.join(dir, `${cn}.crt`), keyFile: path.join(dir, `${cn}.key`) }),
    rogue: { cert: read('rogue.crt'), key: read('rogue.key') },
    files: { ca: path.join(dir, 'ca.crt'), gatewayCert: path.join(dir, 'gateway.crt'), gatewayKey: path.join(dir, 'gateway.key') },
  };
}

/** Configuration of run mode `storage-gateway` from the test profile with the given overrides. */
export function gatewayConfig(env: Record<string, string>): MscdConfig {
  return MscdConfig.load({
    runMode: 'storage-gateway',
    env: { ...process.env, MSCD_PROFILE_FILE: TEST_PROFILE_FILE, MSCD__OBSERVABILITY__METRICS_PORT: 'null', ...env },
  });
}

/** Overrides of the vault endpoint for a SeaweedFS container. */
export function vaultEnv(seaweed: Pick<Seaweed, 'endpoint'>): Record<string, string> {
  return { MSCD__GATEWAY__VAULT__ENDPOINT: seaweed.endpoint };
}

export interface RunningGateway {
  url: string;
  app: NestFastifyApplication;
  runtime: GatewayRuntime;
  close(): Promise<void>;
}

/** The gateway application on a random port of 127.0.0.1 (`GatewayModule` as the run mode builds it). */
export async function startGateway(config: MscdConfig, options: { factories?: readonly AdapterFactory[] } = {}): Promise<RunningGateway> {
  let builder = Test.createTestingModule({ imports: [GatewayModule.forRoot(config)] });
  if (options.factories) builder = builder.overrideProvider(GATEWAY_ADAPTER_FACTORIES).useValue(options.factories);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(gatewayAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const scheme = config.profile.gateway.tls.mode === 'mtls' ? 'https' : 'http';
  return { url: `${scheme}://localhost:${address.port}`, app, runtime: app.get(GatewayRuntime), close: () => app.close() };
}

export interface CallOptions {
  method?: 'POST' | 'PUT' | 'GET';
  token?: string | null;
  headers?: Record<string, string>;
  body?: string | Buffer;
  dispatcher?: Dispatcher;
}

export interface CallResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  json<T = Record<string, unknown>>(): T;
}

/** One HTTP call to the gateway. */
export async function gatewayCall(base: string, pathName: string, payload: unknown, options: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const token = options.token === undefined ? GATEWAY_TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  let body: string | Buffer | undefined = options.body;
  if (body === undefined && payload !== undefined) {
    body = JSON.stringify(payload);
    headers['content-type'] = 'application/json';
  }
  const response = await request(`${base}${pathName}`, { method: options.method ?? 'POST', headers, body, dispatcher: options.dispatcher });
  const bytes = Buffer.from(await response.body.arrayBuffer());
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, string | string[] | undefined>,
    body: bytes,
    json: <T>() => JSON.parse(bytes.toString('utf8')) as T,
  };
}

/** `PUT /v1/objects` with the X-MSCD-Put header. */
export async function putObject(base: string, header: unknown, content: Buffer, options: CallOptions = {}): Promise<CallResult> {
  return gatewayCall(base, '/v1/objects', undefined, {
    ...options,
    method: 'PUT',
    body: content,
    headers: {
      'content-type': 'application/octet-stream',
      'x-mscd-put': Buffer.from(JSON.stringify(header)).toString('base64'),
      ...(options.headers ?? {}),
    },
  });
}

/** An undici agent that trusts the test CA and presents a client certificate (or none). */
export function tlsAgent(certs: Certificates, client?: { cert: string; key: string }): Agent {
  return new Agent({ connect: { ca: certs.caCert, ...(client ? { cert: client.cert, key: client.key } : {}) } });
}

export interface FakeDriveCall {
  operation: 'test' | 'oauth';
  credential: { ref: string; kind: string; secret: Record<string, unknown> } | null;
  input?: { code: string; redirectUri: string; codeVerifier: string };
}

/**
 * A stand-in for the Google Drive adapter of WP-15: it records what the gateway core hands it (the opened credential,
 * the OAuth code) and answers a connected test and a refresh token for any code.
 */
export function fakeDriveAdapter(): { factory: AdapterFactory; calls: FakeDriveCall[] } {
  const calls: FakeDriveCall[] = [];
  const factory: AdapterFactory = () => ({
    adapter: 'google_drive',
    validateConfig: (_orgId, config) => {
      if (typeof config.driveId !== 'string' || typeof config.rootFolderId !== 'string') throw new Error('not a Google Drive config');
    },
    testConnection: async (ctx) => {
      calls.push({ operation: 'test', credential: ctx.credential });
      return { status: 'ok', permissions: ['drive.file'], ownership: 'organizational', message: { en: 'Connected', id: 'Terhubung' } };
    },
    list: async (_ctx, input) => ({ path: input.scopeRoot.path, items: [] }),
    ensureFolder: async (_ctx, folder) => ({ folderId: 'f-new', path: folder }),
    stat: async () => ({ outcome: 'not_found', pinnedVersionAvailable: false }),
    copyWithin: async () => ({ items: [] }),
    exchangeOAuthCode: async (ctx, input) => {
      calls.push({ operation: 'oauth', credential: ctx.credential, input });
      return { secret: { ...ctx.credential!.secret, refreshToken: `refresh-for-${input.code}` }, externalAccount: 'tono.hartono@example.test' };
    },
  });
  return { factory, calls };
}
