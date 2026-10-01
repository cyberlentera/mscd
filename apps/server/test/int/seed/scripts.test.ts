// The scripts around the demo seed (G.1, G.2, G.8): the snapshot export with `--check`, the mock provider fixture it
// writes (loaded by the mock providers, with a certificate whose key the seed derives), and ensure-built.mjs, which
// rebuilds packs/dist after it was deleted (run in a scratch copy, so the repository's packs/dist is never touched).
import { execFile } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createM365ClientAssertion, parseFixtureDocument, startMockProviders } from '@mscd/mock-providers';
import { afterAll, describe, expect, it } from 'vitest';
import { demoPrivateKeyPem } from '../../../src/seed/demo-key';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const EXPORT_SCRIPT = path.join(REPO_ROOT, 'apps/web/scripts/export-sample-snapshot.mjs');
const FIXTURE_FILE = path.join(REPO_ROOT, 'tools/mock-providers/fixtures/demo.json');

describe('export-sample-snapshot.mjs and the demo mock fixture (G.2, G.8)', () => {
  it('finds the committed snapshot and fixture up to date with the sample (--check)', async () => {
    const { stdout } = await run(process.execPath, [EXPORT_SCRIPT, '--check'], { cwd: REPO_ROOT });
    expect(stdout).toContain('match the sample');
  });

  it('answers an unknown option with exit code 2', async () => {
    const failure = await run(process.execPath, [EXPORT_SCRIPT, '--write-everything'], { cwd: REPO_ROOT }).catch((error: { code: number; stderr: string }) => error);
    expect(failure).toMatchObject({ code: 2 });
    expect((failure as { stderr: string }).stderr).toContain('unknown option --write-everything');
  });

  it('writes the snapshot keys of G.2 with ref objects replaced by record keys', () => {
    const sample = loadSampleSnapshot();
    expect(Object.keys(sample.snapshots)).toEqual(['ndt', 'bsd', 'rmn']);
    expect(sample.today).toBe('2026-09-29');
    expect(Object.keys(sample.raw).sort()).toEqual(['FREQ', 'OUTPUT_MAP', 'PHASES', 'PHASE_STATE', 'PICKER_FILES', 'TERA_KEYS']);
    expect(sample.literals.docApprover).toEqual({ isms: 'hendra', qms: 'sari', bcms: 'hendra', abms: 'lina' });
    const items = sample.snapshots.ndt!.bundles.isms!.chain.items;
    for (const item of items) if (item.ref !== undefined) expect(item.ref).toBe(item.key);
    const acts = sample.snapshots.ndt!.bundles.isms!.phases.flatMap((p) => p.acts);
    expect(acts.find((a) => a.out === 'SOA-01')?.doc).toBe('isms:doc:SOA-01');
    expect(sample.snapshots.bsd!.MS.map((m) => m.id)).toEqual(['isms', 'qms']);
  });

  it('derives the private key of the demo app certificate in the seed (no key file anywhere)', () => {
    const sample = loadSampleSnapshot();
    const pem = demoPrivateKeyPem(sample.storage.m365.keyLabel, sample.storage.m365.certificatePem);
    const certificate = new X509Certificate(sample.storage.m365.certificatePem);
    expect(certificate.checkPrivateKey(createPrivateKey(pem))).toBe(true);
    expect(new Date(certificate.validTo).toISOString()).toBe(sample.storage.m365.notAfter);
    expect(() => demoPrivateKeyPem('another label', sample.storage.m365.certificatePem)).toThrow(/does not match the demo certificate/);
  });

  describe('mock providers loaded with the demo fixture', () => {
    let mock: Awaited<ReturnType<typeof startMockProviders>> | undefined;
    afterAll(async () => {
      await mock?.close();
    });

    it('loads the fixture, accepts the demo app certificate and serves the SharePoint, OneDrive and Shared Drive state of G.8', async () => {
      const fixture = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as unknown;
      parseFixtureDocument(fixture);
      mock = await startMockProviders({ port: 0, fixtures: fixture });
      const sample = loadSampleSnapshot();
      const { m365 } = sample.storage;
      const tokenUrl = `${mock.url}/${m365.tenantId}/oauth2/v2.0/token`;
      const privateKeyPem = demoPrivateKeyPem(m365.keyLabel, m365.certificatePem);
      expect(createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' })).toBe(new X509Certificate(m365.certificatePem).publicKey.export({ type: 'spki', format: 'pem' }));
      const assertion = await createM365ClientAssertion({ clientId: m365.clientId, audience: tokenUrl, certificatePem: m365.certificatePem, privateKeyPem });
      const token = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: m365.clientId,
          scope: 'https://graph.microsoft.com/.default',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
        }),
      });
      expect(token.status).toBe(200);
      const { access_token: accessToken } = (await token.json()) as { access_token: string };
      const graph = (url: string) => fetch(`${mock!.url}/v1.0${url}`, { headers: { authorization: `Bearer ${accessToken}` } });

      // Picker files of PICKER_FILES.sp under Compliance / ISMS / Evidence / 2026 / Q3.
      const listing = await graph(`/drives/${sample.storage.drives.sp!.driveId}/root:/Compliance/ISMS/Evidence/2026/Q3:/children`);
      expect(listing.status).toBe(200);
      const names = ((await listing.json()) as { value: { name: string }[] }).value.map((v) => v.name);
      for (const [name] of sample.raw.PICKER_FILES.sp!.files) expect(names).toContain(name);
      // An evidence item with its pinned version and stored hash; a changed item has a newer version; a missing one is absent.
      const evidence = sample.snapshots.ndt!.bundles.isms!.evs;
      const object = (ctrlKey: string) => sample.storage.objects[`ev:${evidence.find((e) => e.ctrlKey === ctrlKey)!.code}`]!;
      const intact = object('5.1');
      const item = (await (await graph(`/drives/drive-sp-compliance/items/${intact.externalItemId}/versions`)).json()) as { value: { id: string }[] };
      expect(item.value[0]!.id).toBe(intact.externalVersionId);
      const changed = object('5.9');
      const changedVersions = (await (await graph(`/drives/drive-sp-compliance/items/${changed.externalItemId}/versions`)).json()) as { value: { id: string }[] };
      expect(changedVersions.value[0]!.id).not.toBe(changed.externalVersionId);
      expect(changedVersions.value.map((v) => v.id)).toContain(changed.externalVersionId);
      expect((await graph(`/drives/drive-sp-compliance/items/${object('8.13').externalItemId}`)).status).toBe(404);
      // The disabled OneDrive answers 403 to everything.
      expect((await graph(`/drives/drive-od-fnugroho/items/${object('7.13').externalItemId}`)).status).toBe(403);
      // The delegated Google token expired: the token endpoint answers invalid_grant.
      const google = await fetch(`${mock.url}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sample.storage.google.refreshToken, client_id: sample.storage.google.clientId, client_secret: sample.storage.google.clientSecret }),
      });
      expect(google.status).toBe(400);
      expect(((await google.json()) as { error: string }).error).toBe('invalid_grant');
    });
  });
});

describe('tools/scripts/ensure-built.mjs (G.1)', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mscd-ensure-built-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('rebuilds packs/dist after it was deleted and leaves current outputs alone', async () => {
    // Bring the repository's outputs up to date (what the global setup does for runs that use the demo template).
    await run(process.execPath, [path.join(REPO_ROOT, 'tools/scripts/ensure-built.mjs'), '--quiet'], { cwd: REPO_ROOT });
    // A copy of what the script reads and writes, with the original modification times, and the dependencies linked.
    for (const part of ['tools/scripts', 'packs/sources', 'packages/shared', 'packages/pack-tools', 'tsconfig.base.json', 'package.json']) {
      cpSync(path.join(REPO_ROOT, part), path.join(scratch, part), { recursive: true, preserveTimestamps: true, filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}.cache`) });
    }
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
    const script = path.join(scratch, 'tools/scripts/ensure-built.mjs');
    // The repository's outputs are current (the global setup ran the script), so the copy has nothing to build but the packs.
    rmSync(path.join(scratch, 'packs/dist'), { recursive: true, force: true });
    const first = await run(process.execPath, [script], { cwd: scratch });
    expect(first.stdout).toContain('ensure-built: @mscd/shared up to date');
    expect(first.stdout).toContain('ensure-built: building packs/dist (missing packs/dist/');
    const packs = readdirSync(path.join(scratch, 'packs/dist')).filter((name) => name.endsWith('.pack')).sort();
    expect(packs).toEqual([
      'ISO22301-2019-1.0.0.pack', 'ISO27001-2022-1.2.0.pack', 'ISO37001-2016-1.0.0.pack', 'ISO37001-2025-0.6.0.pack', 'ISO9001-2015-1.4.2.pack', 'ISO9001-2026-0.9.0.pack',
    ]);
    for (const pack of packs) expect(readFileSync(path.join(scratch, 'packs/dist', pack))).toEqual(readFileSync(path.join(REPO_ROOT, 'packs/dist', pack)));
    const built = statSync(path.join(scratch, 'packs/dist', packs[0]!)).mtimeMs;

    const second = await run(process.execPath, [script, '--check'], { cwd: scratch });
    expect(second.stdout).toContain('everything is up to date');
    await run(process.execPath, [script, '--quiet'], { cwd: scratch });
    expect(statSync(path.join(scratch, 'packs/dist', packs[0]!)).mtimeMs).toBe(built);
    expect(existsSync(path.join(scratch, 'packs/dist'))).toBe(true);
  });
});
