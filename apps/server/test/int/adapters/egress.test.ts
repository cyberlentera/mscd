// Egress of the provider adapters (build plan I.1, D.5, J.7, WP-15): requests go only to the configured provider
// base URLs, a non-default base URL needs an allow-listed host (or demo mode), and URLs the provider hands out
// (upload sessions, copy monitors, download links, next-page links, resumable sessions) are followed only to the
// provider's own hosts. These tests run the adapters with the default (real) endpoints against an undici
// MockAgent in strict mode: any request to a host without an interceptor would fail as a network error, and the
// call history shows every origin that was contacted. The same setup covers Graph answers the mock providers never
// give (items without `parentReference.path`).
import { Readable } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/mscd-config';
import { GoogleDriveAdapter } from '../../../src/gateway/adapters/google-drive';
import { M365Adapter, QuickXorHash } from '../../../src/gateway/adapters/m365';
import { GatewayError } from '../../../src/gateway/problems';
import { GD, SP, TENANT_ID, Waits, googleContext, m365Context, scope, sha256, testOptions } from './helpers';

const GRAPH = 'https://graph.microsoft.com';
const LOGIN = 'https://login.microsoftonline.com';
const GOOGLE_API = 'https://www.googleapis.com';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com';
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };

const M365_DEFAULTS = { graphBaseUrl: `${GRAPH}/v1.0`, loginBaseUrl: LOGIN, egressAllowlist: [] as string[], demo: false };
const GOOGLE_DEFAULTS = { apiBaseUrl: GOOGLE_API, tokenUrl: `${GOOGLE_TOKEN}/token`, egressAllowlist: [] as string[], demo: false };

let agent: MockAgent;
let adapters: { close(): Promise<void> }[] = [];

function strictAgent(): MockAgent {
  agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  return agent;
}

function origins(): string[] {
  return [...new Set((agent.getCallHistory()?.calls() ?? []).map((call) => call.origin))].sort();
}

function m365(): M365Adapter {
  const adapter = new M365Adapter(M365_DEFAULTS, testOptions(new Waits(), { dispatcher: agent }));
  adapters.push(adapter);
  return adapter;
}

function google(): GoogleDriveAdapter {
  const adapter = new GoogleDriveAdapter(GOOGLE_DEFAULTS, testOptions(new Waits(), { dispatcher: agent }));
  adapters.push(adapter);
  return adapter;
}

async function problem(promise: Promise<unknown>): Promise<GatewayError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GatewayError);
  return error as GatewayError;
}

afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.close()));
  adapters = [];
  await agent?.close();
});

// Graph answers -------------------------------------------------------------------------------------------------

const ROOT_ITEM = {
  id: SP.root,
  name: 'Compliance',
  folder: { childCount: 1 },
  parentReference: { driveId: SP.driveId, id: 'DRIVEROOT', path: `/drives/${SP.driveId}/root:` },
};

function backupItem(extra: Record<string, unknown> = {}) {
  return {
    id: SP.backup,
    name: 'Backup.xlsx',
    size: 10,
    file: { mimeType: 'application/octet-stream', hashes: { quickXorHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
    parentReference: { driveId: SP.driveId, id: SP.root, path: `/drives/${SP.driveId}/root:/Compliance` },
    webUrl: 'https://nusantaradigital.sharepoint.com/sites/compliance/Compliance/Backup.xlsx',
    ...extra,
  };
}

function interceptGraphToken(): void {
  agent
    .get(LOGIN)
    .intercept({ path: `/${TENANT_ID}/oauth2/v2.0/token`, method: 'POST' })
    .reply(200, { token_type: 'Bearer', expires_in: 3599, access_token: 'graph-token' }, JSON_HEADERS)
    .persist();
}

function interceptGraphGet(prefix: string, body: object): void {
  agent
    .get(GRAPH)
    .intercept({ path: (path) => path === prefix || path.startsWith(`${prefix}?`), method: 'GET' })
    .reply(200, body, JSON_HEADERS)
    .persist();
}

const ITEMS = `/v1.0/drives/${SP.driveId}/items`;

function largeInput(content: Buffer) {
  return { scopeRoot: scope(SP.root, 'Compliance'), folderPath: '', fileName: 'Big.bin', maxBytes: 64 * 1024 * 1024, metadataMinimization: true, body: bufferStream(content), contentLength: content.length };
}

function bufferStream(content: Buffer): Readable {
  return Readable.from([content]);
}

describe('configured base URLs (I.1)', () => {
  it('refuses a non-default base URL unless its host is allow-listed or demo mode is on', () => {
    expect(() => new M365Adapter({ ...M365_DEFAULTS, graphBaseUrl: 'https://graph.example.internal/v1.0' })).toThrow(ConfigError);
    expect(() => new M365Adapter({ ...M365_DEFAULTS, graphBaseUrl: 'https://graph.example.internal/v1.0', egressAllowlist: ['graph.example.internal'] })).not.toThrow();
    expect(() => new M365Adapter({ ...M365_DEFAULTS, graphBaseUrl: 'https://graph.example.internal/v1.0', egressAllowlist: ['*.example.internal'] })).not.toThrow();
    expect(() => new M365Adapter({ ...M365_DEFAULTS, loginBaseUrl: 'http://mock-providers:4310', demo: true })).not.toThrow();
    expect(() => new M365Adapter({ ...M365_DEFAULTS, loginBaseUrl: 'http://login.example.internal', egressAllowlist: ['login.example.internal'] })).toThrow(/plain HTTP/);
    expect(() => new GoogleDriveAdapter({ ...GOOGLE_DEFAULTS, tokenUrl: 'https://oauth2.example.internal/token' })).toThrow(ConfigError);
    expect(() => new GoogleDriveAdapter({ ...GOOGLE_DEFAULTS, apiBaseUrl: 'https://user:pass@www.googleapis.com', egressAllowlist: ['www.googleapis.com'] })).toThrow(ConfigError);
  });
});

describe('Microsoft 365 with the default endpoints and a strict MockAgent', () => {
  it('follows an upload session URL on a SharePoint host, without the bearer token', async () => {
    strictAgent();
    interceptGraphToken();
    interceptGraphGet(`${ITEMS}/${SP.root}`, ROOT_ITEM);
    const content = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
    const quickXor = new QuickXorHash().update(content).digest();
    agent
      .get(GRAPH)
      .intercept({ path: `${ITEMS}/${SP.root}:/Big.bin:/createUploadSession`, method: 'POST' })
      .reply(200, { uploadUrl: 'https://nusantaradigital.sharepoint.com/_api/v2.0/uploadSession?guid=abc' }, JSON_HEADERS);
    const fragmentHeaders: Record<string, unknown>[] = [];
    agent
      .get('https://nusantaradigital.sharepoint.com')
      .intercept({ path: '/_api/v2.0/uploadSession?guid=abc', method: 'PUT' })
      .reply((options) => {
        fragmentHeaders.push(options.headers as Record<string, unknown>);
        return {
          statusCode: 201,
          data: JSON.stringify(backupItem({ id: 'NEWITEM', name: 'Big.bin', size: content.length, file: { hashes: { quickXorHash: quickXor } } })),
          responseOptions: JSON_HEADERS,
        };
      });
    interceptGraphGet(`${ITEMS}/NEWITEM/versions`, { value: [{ id: '1.0' }] });

    const result = await m365().put(m365Context(), largeInput(content));
    expect(result).toMatchObject({ externalItemId: 'NEWITEM', externalVersionId: '1.0', hashValue: sha256(content) });
    expect(fragmentHeaders).toHaveLength(1);
    expect(Object.keys(fragmentHeaders[0]!).map((name) => name.toLowerCase())).not.toContain('authorization');
    expect(origins()).toEqual([GRAPH, LOGIN, 'https://nusantaradigital.sharepoint.com'].sort());
  });

  it('refuses an upload session URL on another host before any request to it', async () => {
    strictAgent();
    interceptGraphToken();
    interceptGraphGet(`${ITEMS}/${SP.root}`, ROOT_ITEM);
    agent
      .get(GRAPH)
      .intercept({ path: `${ITEMS}/${SP.root}:/Big.bin:/createUploadSession`, method: 'POST' })
      .reply(200, { uploadUrl: 'https://upload.evil.example/session/1' }, JSON_HEADERS);
    const error = await problem(m365().put(m365Context(), largeInput(Buffer.alloc(4 * 1024 * 1024 + 1))));
    expect(error.slug).toBe('forbidden');
    expect(error.message).toContain('https://upload.evil.example');
    expect(origins()).toEqual([GRAPH, LOGIN].sort());
  });

  it('refuses a copy monitor, a download link and a next-page link on another host', async () => {
    strictAgent();
    interceptGraphToken();
    interceptGraphGet(`${ITEMS}/${SP.root}`, ROOT_ITEM);
    interceptGraphGet(`${ITEMS}/${SP.backup}`, backupItem());
    interceptGraphGet(`${ITEMS}/${SP.backup}/versions`, { value: [{ id: '1.0' }], '@odata.nextLink': 'https://graph.evil.example/v1.0/next' });
    agent
      .get(GRAPH)
      .intercept({ path: (path) => path.startsWith(`${ITEMS}/${SP.backup}/copy`), method: 'POST' })
      .reply(202, '', { headers: { location: 'https://monitor.evil.example/copy/1' } });
    agent
      .get(GRAPH)
      .intercept({ path: `${ITEMS}/${SP.backup}/content`, method: 'GET' })
      .reply(302, '', { headers: { location: 'https://files.evil.example/download/1' } });

    const object = { externalItemId: SP.backup, externalVersionId: null, hashAlgorithm: 'none' as const, hashValue: null, hashSource: 'none' as const, folderPath: 'Compliance' };
    const adapter = m365();
    // The versions list continues on another host: refused, reported as a refused check.
    expect(await adapter.stat(m365Context(), object)).toEqual({ outcome: 'forbidden', pinnedVersionAvailable: false });
    expect((await problem(adapter.stream(m365Context(), object))).message).toContain('evil.example');
    expect((await problem(adapter.copyWithin(m365Context(), [object], 'Compliance'))).message).toContain('https://monitor.evil.example');
    expect(origins()).toEqual([GRAPH, LOGIN].sort());
  });
});

describe('Google Drive with the default endpoints and a strict MockAgent', () => {
  const folder = (id: string, name: string, parents?: string[]) => ({
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    driveId: GD.driveId,
    trashed: false,
    ...(parents ? { parents } : {}),
  });
  const files: Record<string, object> = {
    [GD.driveId]: folder(GD.driveId, 'Compliance BCMS'),
    [GD.root]: folder(GD.root, 'Compliance', [GD.driveId]),
    [GD.plan]: {
      id: GD.plan,
      name: 'BC-Plan.pdf',
      mimeType: 'application/pdf',
      size: '5',
      sha256Checksum: sha256('plan!'),
      headRevisionId: 'rev-1',
      parents: [GD.root],
      driveId: GD.driveId,
      trashed: false,
      webViewLink: `https://drive.google.com/file/d/${GD.plan}/view`,
    },
  };

  function interceptDrive(options: { throttleFirst?: number } = {}): { throttled: () => number } {
    let throttled = 0;
    agent
      .get(GOOGLE_TOKEN)
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: 'drive-token', expires_in: 3599, token_type: 'Bearer' }, JSON_HEADERS)
      .persist();
    agent
      .get(GOOGLE_API)
      .intercept({ path: (path) => path.startsWith('/drive/v3/files/'), method: 'GET' })
      .reply((request) => {
        if (throttled < (options.throttleFirst ?? 0)) {
          throttled += 1;
          return {
            statusCode: 403,
            data: JSON.stringify({ error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }] } }),
            responseOptions: JSON_HEADERS,
          };
        }
        const [, , , , id, sub] = request.path.split('?')[0]!.split('/');
        if (sub === 'revisions') return { statusCode: 200, data: JSON.stringify({ revisions: [{ id: 'rev-1' }] }), responseOptions: JSON_HEADERS };
        const file = files[id!];
        return file
          ? { statusCode: 200, data: JSON.stringify(file), responseOptions: JSON_HEADERS }
          : { statusCode: 404, data: JSON.stringify({ error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } }), responseOptions: JSON_HEADERS };
      })
      .persist();
    return { throttled: () => throttled };
  }

  it('retries a 403 rate limit answer and reports a lasting one as rate-limited', async () => {
    strictAgent();
    const counter = interceptDrive({ throttleFirst: 2 });
    const object = { externalItemId: GD.plan, externalVersionId: 'rev-1', hashAlgorithm: 'sha256' as const, hashValue: sha256('plan!'), hashSource: 'provider' as const, folderPath: 'Compliance' };
    const result = await google().stat(googleContext({ config: { driveId: GD.driveId, rootFolderId: GD.root, roots: {} } }), object);
    expect(result).toMatchObject({ outcome: 'found', current: { externalVersionId: 'rev-1', versionLabel: 'rev 1', folderPath: 'Compliance' } });
    expect(counter.throttled()).toBe(2);
    expect(origins()).toEqual([GOOGLE_API, GOOGLE_TOKEN].sort());

    await agent.close();
    strictAgent();
    interceptDrive({ throttleFirst: 100 });
    const link = await problem(google().link(googleContext({ config: { driveId: GD.driveId, rootFolderId: GD.root, roots: {} } }), { scopeRoot: scope(GD.root, 'Compliance'), externalItemId: GD.plan }));
    expect(link.slug).toBe('rate-limited');
  });

  it('refuses a resumable session URL on another host', async () => {
    strictAgent();
    interceptDrive();
    agent
      .get(GOOGLE_API)
      .intercept({ path: (path) => path.startsWith('/upload/drive/v3/files?'), method: 'POST' })
      .reply(200, '', { headers: { location: 'https://uploads.evil.example/session?upload_id=1' } });
    const content = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    const input = { scopeRoot: scope(GD.root, 'Compliance'), folderPath: '', fileName: 'Big.bin', maxBytes: 64 * 1024 * 1024, metadataMinimization: false, body: bufferStream(content), contentLength: content.length };
    const error = await problem(google().put(googleContext({ config: { driveId: GD.driveId, rootFolderId: GD.root, roots: {} } }), input));
    expect(error.slug).toBe('forbidden');
    expect(origins()).toEqual([GOOGLE_API, GOOGLE_TOKEN].sort());
  });
});

describe('Graph answers without parentReference.path', () => {
  it('places an item by walking its parent folders', async () => {
    strictAgent();
    interceptGraphToken();
    const isms = { id: SP.isms, name: 'ISMS', folder: {}, parentReference: { driveId: SP.driveId, id: SP.root } };
    const root = { id: SP.root, name: 'Compliance', folder: {}, parentReference: { driveId: SP.driveId, id: 'DRIVEROOT' } };
    const driveRoot = { id: 'DRIVEROOT', name: 'root', folder: {}, root: {} };
    interceptGraphGet(`${ITEMS}/${SP.root}`, root);
    interceptGraphGet(`${ITEMS}/DRIVEROOT`, driveRoot);
    interceptGraphGet(`${ITEMS}/${SP.isms}`, isms);
    interceptGraphGet(`${ITEMS}/${SP.backup}`, backupItem({ parentReference: { driveId: SP.driveId, id: SP.isms } }));
    interceptGraphGet(`${ITEMS}/${SP.backup}/versions`, { value: [{ id: '2.0' }, { id: '1.0' }] });
    const metadata = await m365().link(m365Context(), { scopeRoot: scope(SP.isms, 'Compliance/ISMS'), externalItemId: SP.backup });
    expect(metadata).toMatchObject({ folderPath: 'Compliance/ISMS', folderId: SP.isms, externalVersionId: '2.0', versionLabel: 'v2.0' });

    // An item of another drive is refused whatever its path.
    agent.get(GRAPH).intercept({ path: (path) => path.startsWith(`${ITEMS}/${SP.policy}`), method: 'GET' }).reply(200, backupItem({ id: SP.policy, parentReference: { driveId: 'b!other', id: SP.isms } }), JSON_HEADERS);
    expect((await problem(m365().link(m365Context(), { scopeRoot: scope(SP.isms, 'Compliance/ISMS'), externalItemId: SP.policy }))).slug).toBe('outside-root');
  });
});
