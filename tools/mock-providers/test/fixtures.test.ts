import { X509Certificate, createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyFixtures, parseFixtureDocument } from '../src/fixtures.js';
import { FixtureError, buildMockProviders, createSelfSignedCertificate, hashContent, inspectCertificate, quickXorHash } from '../src/index.js';
import { MockState } from '../src/state.js';
import { call, standardFixtures } from './helpers.js';

function problems(input: unknown): string[] {
  try {
    parseFixtureDocument(input);
  } catch (error) {
    if (error instanceof FixtureError) return error.problems;
    throw error;
  }
  return [];
}

describe('fixture documents', () => {
  it('accepts the standard test fixtures', () => {
    expect(problems(standardFixtures())).toEqual([]);
  });

  it('lists every problem with its path', () => {
    const found = problems({
      version: 2,
      extra: true,
      m365: {
        drives: [
          {
            id: 'drive/one',
            driveType: 'team',
            items: [
              { name: 'a:b.txt' },
              { name: 'ok.txt', content: 'x', contentBase64: 'eA==' },
              { name: 'v.txt', content: 'x', versions: [{ id: '1.0' }] },
              { name: 'h.txt', quickXorHash: 'short', sha256: 'XYZ', size: 3, content: 'four' },
              { name: 'p.txt', path: 'A/../B' },
              { name: 'd.txt', createdAt: 'yesterday', createdBy: { email: 'no-name@x.y' } },
            ],
          },
        ],
      },
      google: { drives: [{ id: 'g', rootId: 'r' }] },
      credentials: [{ kind: 'aws' }],
    });
    const text = found.join('\n');
    for (const expected of [
      'fixtures.version: must be 1',
      'fixtures.extra: is not a known key',
      'fixtures.m365.drives[0].id: does not match the id pattern of D.5',
      'fixtures.m365.drives[0].driveType: must be documentLibrary, business or personal',
      'fixtures.m365.drives[0].items[0].name: is not a valid file name',
      'fixtures.m365.drives[0].items[1]: give content or contentBase64, not both',
      'fixtures.m365.drives[0].items[2]: with versions, move content into a version',
      'fixtures.m365.drives[0].items[3].quickXorHash: must be 20 bytes in base64 (28 characters)',
      'fixtures.m365.drives[0].items[3].sha256: must be 64 lower-case hex characters',
      'fixtures.m365.drives[0].items[3].size: is 3 but the content has 4 bytes',
      'fixtures.m365.drives[0].items[4].path: has an invalid folder name ".."',
      'fixtures.m365.drives[0].items[5].createdAt: must be an ISO 8601 date-time',
      'fixtures.m365.drives[0].items[5].createdBy.displayName: is required',
      'fixtures.google.drives[0].rootId: applies to my_drive only',
      'fixtures.credentials[0].kind: must be m365_certificate',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('builds the folder tree from paths with stable ids and reports declared hashes', () => {
    const declared = hashContent(Buffer.from('declared'));
    const doc = parseFixtureDocument({
      m365: {
        drives: [
          {
            id: 'drive-a',
            items: [
              { id: 'F1', path: 'A/B', name: 'one.txt', content: 'one' },
              { id: 'F2', path: 'a/b', name: 'two.txt', quickXorHash: declared.quickXorHash, size: 10 },
            ],
          },
        ],
      },
    });
    const first = new MockState();
    applyFixtures(first, doc);
    const second = new MockState();
    applyFixtures(second, doc);
    const one = first.item('F1');
    const two = first.item('F2');
    expect(one?.parentId).toBe(two?.parentId);
    expect(second.item('F1')?.parentId).toBe(one?.parentId);
    expect(first.pathNames(first.item(one?.parentId as string) as never)).toEqual(['A', 'B']);
    expect(one?.versions[0]).toMatchObject({ id: '1.0', quickXorHash: quickXorHash('one'), size: 3 });
    expect(two?.versions[0]).toMatchObject({ quickXorHash: declared.quickXorHash, size: 10 });
  });

  it('refuses a duplicate name in a Graph folder but allows it in Drive', () => {
    const graph = parseFixtureDocument({ m365: { drives: [{ id: 'd', items: [{ id: 'A1', name: 'x.txt' }, { id: 'A2', name: 'X.TXT' }] }] } });
    expect(() => applyFixtures(new MockState(), graph)).toThrow(FixtureError);
    const drive = parseFixtureDocument({ google: { drives: [{ id: 'd', items: [{ id: 'a1', name: 'x.txt' }, { id: 'a2', name: 'x.txt' }] }] } });
    expect(applyFixtures(new MockState(), drive).items).toBe(2);
  });

  it('describes the G.8 demo situations: changed versions, a disabled OneDrive, an expired delegated token', async () => {
    const app = buildMockProviders({ fixtures: standardFixtures() });
    try {
      const view = (await call(app, 'GET', '/_admin/items/ITEM-BACKUP')).json();
      expect(view.versions.map((v: { id: string }) => v.id)).toEqual(['1.0', '2.0', '3.0']);
      const state = (await call(app, 'GET', '/_admin/state')).json();
      expect(state.drives.find((d: { id: string }) => d.id === 'drive-od-fnugroho').forbidden).toBe(true);
      const credentials = (await call(app, 'GET', '/_admin/credentials')).json();
      expect(credentials.refreshTokens.find((t: { revoked: boolean }) => t.revoked)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('fails to build with invalid fixtures', () => {
    expect(() => buildMockProviders({ fixtures: { m365: { drives: [{ id: '' }] } } })).toThrow(FixtureError);
    expect(() => buildMockProviders({ settings: { tokenLifetimeSeconds: 0 } })).toThrow(FixtureError);
  });
});

describe('self-signed certificates', () => {
  it('creates certificates that parse, verify and carry the thumbprints of their DER encoding', () => {
    const cert = createSelfSignedCertificate({ commonName: 'thumbprint test', days: 10 });
    const x509 = new X509Certificate(cert.certificatePem);
    expect(x509.subject).toBe('CN=thumbprint test');
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.checkPrivateKey(createPrivateKey(cert.privateKeyPem))).toBe(true);
    expect(cert.thumbprintSha256).toBe(Buffer.from(x509.fingerprint256.replace(/:/g, ''), 'hex').toString('base64url'));
    expect(cert.thumbprintSha1).toBe(Buffer.from(x509.fingerprint.replace(/:/g, ''), 'hex').toString('base64url'));
    expect(cert.notAfter.getTime() - cert.notBefore.getTime()).toBe(10 * 86400_000);
    expect(inspectCertificate(cert.certificatePem).thumbprintSha256).toBe(cert.thumbprintSha256);
  });

  it('uses GeneralizedTime after 2049', () => {
    const cert = createSelfSignedCertificate({ notBefore: new Date('2049-12-01T00:00:00Z'), days: 60 });
    expect(new Date(new X509Certificate(cert.certificatePem).validTo).getUTCFullYear()).toBe(2050);
  });
});
