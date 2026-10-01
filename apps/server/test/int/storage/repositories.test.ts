// Storage repository administration through the api with a real storage gateway on SeaweedFS (D.3, D-08, F.8,
// BR-30, TS 5.7): repositories with config validation, credentials sealed by the gateway (the database holds sealed
// blobs only), a config change that unbinds the credential, connection tests, the repository OAuth consent with its
// binding cookie and single-use transaction, move requests, storage object metadata, and HttpDataKeyIssuer.
import { createHash } from 'node:crypto';
import { createSelfSignedCertificate } from '@mscd/mock-providers';
import { CommandResult, RepositoryView, StorageObjectMeta, pageOf } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { managedVaultAdapterFactory } from '../../../src/gateway/adapters/managed-vault/vault-adapter';
import { LICENCE_GATE } from '../../../src/common/tokens';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { HttpGatewayClient } from '../../../src/modules/storage/gateway-client';
import { repositoryConfigSha256 } from '../../../src/modules/storage/gateway-context';
import { HttpDataKeyIssuer } from '../../../src/modules/storage/http-data-key-issuer';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { addFramework, addManagementSystem, inScope } from '../db/helpers';
import { fakeDriveAdapter, gatewayConfig, startGateway, startSeaweed, vaultEnv, type RunningGateway, type Seaweed } from '../gateway/helpers';
import { createIntApp, infoOf, type IntApp } from '../platform/helpers';
import { addStorageUsers, storageLicenceGate } from './helpers';

const CALLBACK = '/api/v1/admin/storage/repositories/oauth/callback';

describe('storage repository administration (D.3, D-08, F.8)', () => {
  const db = useTestDatabase('empty');
  const drive = fakeDriveAdapter();
  let seaweed: Seaweed;
  let gateway: RunningGateway;
  let ctx: IntApp;
  let ndt: CreatedTenant;
  let ids: Record<string, string>;
  const certificate = createSelfSignedCertificate({ commonName: 'mscd-sharepoint', days: 30 });
  const repoIds: Record<string, string> = {};
  const licence = storageLicenceGate();

  const as = (who: string, extra: Record<string, string> = {}) => ({ [FAKE_PRINCIPAL_HEADER]: who, ...extra });
  const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method, url, headers: as(who, headers), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const tenantScope = <T>(fn: Parameters<typeof inScope<T>>[2]) => inScope<T>(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, fn);
  const spConfig = (driveId = 'drive-sp-compliance') => ({
    siteId: 'contoso.sharepoint.com,1,2',
    driveId,
    rootFolderId: 'root-compliance',
    roots: { isms: { folderId: 'f-isms', path: 'Compliance/ISMS' } },
  });
  const gdConfig = { driveId: 'drive-gd-bcms', rootFolderId: 'root-compliance', oauthClientId: 'client-1', roots: { qms: { folderId: 'f-qms', path: 'Compliance/QMS' } } };
  const view = (slug: string, list: RepositoryView[]) => list.find((r) => r.id === slug)!;
  const listRepositories = async (who = 'ta1') => {
    const response = await call(who, 'GET', '/api/v1/admin/storage/repositories');
    expect(response.statusCode).toBe(200);
    return response.json<RepositoryView[]>().map((r) => RepositoryView.parse(r));
  };

  beforeAll(async () => {
    seaweed = await startSeaweed();
    gateway = await startGateway(gatewayConfig(vaultEnv(seaweed)), { factories: [managedVaultAdapterFactory, drive.factory] });
    ndt = await createTenant(db, 'ndt');
    const fw = await addFramework(db.migrator);
    const systems = { isms: await addManagementSystem(db.migrator, ndt, fw.versionId, 'isms'), qms: await addManagementSystem(db.migrator, ndt, fw.versionId, 'qms') };
    const users = await addStorageUsers(db, ndt, systems, {
      ta1: { handle: 'ta.one', orgRoles: ['tenant_admin'], rolesByMs: { isms: ['ms_manager'] } },
      ta2: { handle: 'ta.two', orgRoles: ['tenant_admin'] },
      sa: { handle: 'sa.one', orgRoles: ['storage_admin'] },
      mm: { handle: 'mm.qms', rolesByMs: { qms: ['ms_manager'] } },
      do: { handle: 'do.isms', rolesByMs: { isms: ['domain_owner'] } },
    });
    ids = users.ids;
    ctx = await createIntApp(
      db,
      { imports: [StorageModule] },
      {
        auth: { identities: users.identities },
        env: { MSCD__STORAGE__GATEWAY__URL: gateway.url },
        overrides: (builder) => builder.overrideProvider(LICENCE_GATE).useValue(licence),
      },
    );
  });
  afterAll(async () => {
    await ctx?.close();
    await gateway?.close();
    await seaweed?.stop();
  });

  it('lists the Managed Vault of the organisation with its REPOS fields (G.5)', async () => {
    const list = await listRepositories();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'vault',
      ref: ndt.vaultRepositoryId,
      name: 'Managed Vault',
      type: '',
      status: 'ok',
      adapter: 'managed_vault',
      modes: ['stored'],
      ownershipType: 'organizational',
      connectionStatus: 'ok',
      credentialSet: false,
      actions: ['test'],
      ms: ['ISMS', 'QMS'],
      last: '-',
      config: { prefix: `tenants/${ndt.id}/` },
    });
    // MS Managers of any system read the repositories; Domain Owners do not.
    expect((await call('mm', 'GET', '/api/v1/admin/storage/repositories')).statusCode).toBe(200);
    expect((await call('do', 'GET', '/api/v1/admin/storage/repositories')).statusCode).toBe(403);
  });

  it('creates repositories with validated configs', async () => {
    const base = { name: 'SharePoint Online', adapter: 'm365', modes: ['link', 'pass_through'], ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: true };
    const unknownRoot = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'sp', config: { ...spConfig(), roots: { abms: { folderId: 'f', path: 'X' } } } });
    expect(unknownRoot.statusCode).toBe(400);
    expect(unknownRoot.json()).toMatchObject({ errors: [{ path: 'body.config.roots.abms' }] });
    const badId = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'sp', config: { ...spConfig(), driveId: 'drive/../x' } });
    expect(badId.statusCode).toBe(400);
    const smb = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'share', adapter: 'smb', modes: ['link'], config: {} });
    expect(smb.statusCode).toBe(422);
    expect(smb.json()).toMatchObject({ messageKey: 'storage.adapter_not_enabled' });
    licence.unlicensed.add('m365');
    const unlicensed = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'sp', config: spConfig() });
    expect(unlicensed.statusCode).toBe(422);
    expect(unlicensed.json()).toMatchObject({ rule: 'LIC-FEATURE' });
    licence.unlicensed.clear();
    const foreignVault = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', {
      ...base,
      slug: 'vault2',
      adapter: 'managed_vault',
      modes: ['stored'],
      config: { prefix: 'tenants/00000000-0000-4000-8000-000000000999/' },
    });
    expect(foreignVault.statusCode).toBe(400);
    expect((await call('mm', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'sp', config: spConfig() })).statusCode).toBe(403);

    const created = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'sp', config: spConfig(), display: { configSummary: 'Compliance library, Sites.Selected' } });
    expect(created.statusCode).toBe(201);
    const sp = RepositoryView.parse(created.json());
    repoIds.sp = sp.ref;
    expect(sp).toMatchObject({ id: 'sp', type: 'Microsoft 365', status: 'bad', connectionStatus: 'failed', credentialSet: false, tenant: 'Compliance library, Sites.Selected', actions: ['test'] });
    expect(sp.msg?.[0]).toMatch(/No credential set/);
    expect((await call('ta1', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'sp', config: spConfig() })).statusCode).toBe(409);

    const od = await call('sa', 'POST', '/api/v1/admin/storage/repositories', { ...base, slug: 'od', name: 'OneDrive personal', modes: ['link'], ownershipType: 'personal', config: spConfig('drive-od-fnugroho') });
    expect(od.statusCode).toBe(201);
    repoIds.od = RepositoryView.parse(od.json()).ref;
    expect(RepositoryView.parse(od.json()).actions).toEqual(['test', 'moveToLibrary']);

    const gd = await call('ta1', 'POST', '/api/v1/admin/storage/repositories', {
      ...base,
      slug: 'gd',
      name: 'Google Shared Drive',
      adapter: 'google_drive',
      modes: ['zero_transit', 'link'],
      config: gdConfig,
    });
    expect(gd.statusCode).toBe(201);
    repoIds.gd = RepositoryView.parse(gd.json()).ref;

    const audit = await tenantScope((trx) => trx.selectFrom('audit_trail').select(['action', 'entity_code']).where('action', '=', 'storage.repository.created').orderBy('seq').execute());
    expect(audit.map((a) => a.entity_code)).toEqual(['sp', 'od', 'gd']);
  });

  it('seals credentials through the gateway and stores only the sealed blob', async () => {
    const secret = { tenantId: '9a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', clientId: 'app-mscd', certificatePem: certificate.certificatePem, privateKeyPem: certificate.privateKeyPem };
    const wrongKind = await call('ta1', 'PUT', `/api/v1/admin/storage/repositories/${repoIds.sp}/credentials`, { kind: 'google_service_account', secret: { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem: certificate.privateKeyPem } });
    expect(wrongKind.statusCode).toBe(422);
    const vault = await call('ta1', 'PUT', `/api/v1/admin/storage/repositories/${ndt.vaultRepositoryId}/credentials`, { kind: 'm365_certificate', secret });
    expect(vault.statusCode).toBe(422);

    const response = await call('ta1', 'PUT', `/api/v1/admin/storage/repositories/${repoIds.sp}/credentials`, { kind: 'm365_certificate', secret });
    expect(response.statusCode).toBe(204);
    const rows = await tenantScope((trx) => trx.selectFrom('storage_credential').selectAll().where('storage_repository_id', '=', repoIds.sp!).execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'm365_certificate', external_account: 'app-mscd', revoked_at: null, config_sha256: repositoryConfigSha256(spConfig()) });
    expect(rows[0]!.sealed_blob).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(rows[0]!.key_id).toBe(rows[0]!.sealed_blob.split('.')[1]);
    expect(rows[0]!.expires_at?.toISOString()).toBe(certificate.notAfter.toISOString().replace(/\.\d{3}Z$/, '.000Z'));
    const sp = view('sp', await listRepositories());
    expect(sp).toMatchObject({ credentialSet: true, credentialExpiresAt: rows[0]!.expires_at!.toISOString() });
    expect(sp.msg?.[0]).toMatch(/Credential set/);
    const audit = await tenantScope((trx) =>
      trx.selectFrom('audit_trail').select(['after_data']).where('action', '=', 'storage.credential.set').where('entity_code', '=', 'sp').executeTakeFirstOrThrow(),
    );
    expect(audit.after_data).toMatchObject({ kind: 'm365_certificate', credentialRef: rows[0]!.credential_ref, externalAccount: 'app-mscd' });

    // A second credential replaces the first (revoked, kept for the record).
    expect((await call('sa', 'PUT', `/api/v1/admin/storage/repositories/${repoIds.sp}/credentials`, { kind: 'm365_certificate', secret })).statusCode).toBe(204);
    const all = await tenantScope((trx) => trx.selectFrom('storage_credential').select(['credential_ref', 'revoked_at']).where('storage_repository_id', '=', repoIds.sp!).orderBy('created_at').execute());
    expect(all).toHaveLength(2);
    expect(all[0]!.revoked_at).not.toBeNull();
    expect(all[1]!.revoked_at).toBeNull();
  });

  it('tests connections: the vault through the gateway, an adapter the gateway lacks as failed', async () => {
    const vault = await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${ndt.vaultRepositoryId}/test`);
    expect(vault.statusCode).toBe(200);
    const result = CommandResult.parse(vault.json());
    expect(result.message).toEqual(['Managed Vault reachable', 'Managed Vault dapat dijangkau']);
    expect(result.data).toMatchObject({ status: 'ok', permissions: ['read', 'write'], references: 0, nextCheckAt: expect.stringMatching(/T19:30:00\.000Z$/) });
    const row = await tenantScope((trx) => trx.selectFrom('storage_repository').select(['connection_status', 'last_checked_at']).where('id', '=', ndt.vaultRepositoryId).executeTakeFirstOrThrow());
    expect(row.connection_status).toBe('ok');
    expect(row.last_checked_at).not.toBeNull();
    expect(view('vault', await listRepositories()).last).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/);

    // No Microsoft 365 adapter in this gateway yet (WP-15): the test fails and says so.
    const sp = await call('sa', 'POST', `/api/v1/admin/storage/repositories/${repoIds.sp}/test`);
    expect(CommandResult.parse(sp.json()).data).toMatchObject({ status: 'failed' });
    expect(view('sp', await listRepositories())).toMatchObject({ connectionStatus: 'failed', status: 'bad', msg: ['This repository type is not available in the storage gateway', expect.any(String)] });
    expect((await call('mm', 'POST', `/api/v1/admin/storage/repositories/${repoIds.sp}/test`)).statusCode).toBe(403);
  });

  it('unbinds the credential when the binding config changes, not when only a root label changes (D-08)', async () => {
    const relabel = await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${repoIds.sp}`, {
      config: { ...spConfig(), roots: { isms: { folderId: 'f-isms', path: 'Compliance/Information Security' } } },
    });
    expect(relabel.statusCode).toBe(200);
    expect(RepositoryView.parse(relabel.json()).credentialSet).toBe(true);

    const moved = await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${repoIds.sp}`, { config: spConfig('drive-sp-other') });
    expect(moved.statusCode).toBe(200);
    const sp = RepositoryView.parse(moved.json());
    expect(sp).toMatchObject({ credentialSet: false, connectionStatus: 'failed', status: 'bad', msg: ['The configuration changed: set the credential again', expect.any(String)] });
    const active = await tenantScope((trx) =>
      trx.selectFrom('storage_credential').select('id').where('storage_repository_id', '=', repoIds.sp!).where('revoked_at', 'is', null).execute(),
    );
    expect(active).toEqual([]);
    const revoked = await tenantScope((trx) =>
      trx.selectFrom('audit_trail').select('after_data').where('action', '=', 'storage.credential.revoked').where('entity_code', '=', 'sp').execute(),
    );
    expect(revoked[0]!.after_data).toMatchObject({ reason: 'config_changed' });

    expect((await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${repoIds.sp}`, { modes: ['stored'] })).statusCode).toBe(400);
    expect((await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${ndt.vaultRepositoryId}`, { config: { prefix: 'tenants/other/' } })).statusCode).toBe(400);
    // D-10: the vault prefix is fixed once created, even inside the organisation; stored keys depend on it.
    const vaultPrefix = `tenants/${ndt.id}/`;
    const reprefixed = await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${ndt.vaultRepositoryId}`, { config: { prefix: `${vaultPrefix}x/` } });
    expect(reprefixed.statusCode).toBe(409);
    expect(reprefixed.json()).toMatchObject({ type: expect.stringMatching(/conflict$/), messageKey: 'storage.vault_prefix_fixed' });
    const samePrefix = await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${ndt.vaultRepositoryId}`, { config: { prefix: vaultPrefix } });
    expect(samePrefix.statusCode).toBe(200);
    expect(RepositoryView.parse(samePrefix.json())).toMatchObject({ connectionStatus: 'ok' });
    const vaultConfig = await tenantScope((trx) => trx.selectFrom('storage_repository').select('config').where('id', '=', ndt.vaultRepositoryId).executeTakeFirstOrThrow());
    expect(vaultConfig.config).toEqual({ prefix: vaultPrefix });
    const renamed = await call('ta1', 'PATCH', `/api/v1/admin/storage/repositories/${repoIds.sp}`, { name: 'SharePoint Compliance' });
    expect(RepositoryView.parse(renamed.json()).name).toBe('SharePoint Compliance');
  });

  describe('repository OAuth consent (F.8)', () => {
    let state: string;
    let challenge: string;
    let binding: string;

    const callback = (who: string, query: Record<string, string>, cookie?: string) =>
      ctx.app.inject({ method: 'GET', url: `${CALLBACK}?${new URLSearchParams(query).toString()}`, headers: as(who, cookie ? { cookie } : {}) });
    const transactions = () =>
      tenantScope((trx) => trx.selectFrom('platform.auth_transaction').select(['id', 'user_id', 'target_id']).where('kind', '=', 'repo_oauth').execute());
    const activeCredential = () =>
      tenantScope((trx) =>
        trx.selectFrom('storage_credential').selectAll().where('storage_repository_id', '=', repoIds.gd!).where('revoked_at', 'is', null).executeTakeFirst(),
      );

    it('refuses consent for app-only credentials and before the OAuth client is set', async () => {
      expect((await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${repoIds.sp}/reauthorize`)).statusCode).toBe(409);
      expect((await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${repoIds.gd}/reauthorize`)).statusCode).toBe(409);
      const wrongClient = await call('ta1', 'PUT', `/api/v1/admin/storage/repositories/${repoIds.gd}/credentials`, { kind: 'oauth_refresh_token', secret: { clientId: 'client-2', clientSecret: 's3cr3t-client' } });
      expect(wrongClient.statusCode).toBe(400);
      const client = await call('ta1', 'PUT', `/api/v1/admin/storage/repositories/${repoIds.gd}/credentials`, { kind: 'oauth_refresh_token', secret: { clientId: 'client-1', clientSecret: 's3cr3t-client' } });
      expect(client.statusCode).toBe(204);
    });

    it('starts the consent with a hashed state, a sealed PKCE verifier and a binding cookie', async () => {
      const response = await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${repoIds.gd}/reauthorize`);
      expect(response.statusCode).toBe(200);
      const result = CommandResult.parse(response.json());
      const url = new URL(result.redirectUrl!);
      expect(`${url.origin}${url.pathname}`).toBe('http://localhost:4310/o/oauth2/v2/auth');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: 'client-1',
        redirect_uri: `http://localhost:4174${CALLBACK}`,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive.file',
        access_type: 'offline',
        code_challenge_method: 'S256',
      });
      state = url.searchParams.get('state')!;
      challenge = url.searchParams.get('code_challenge')!;
      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toMatch(/^mscd_repo_tx=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/api\/v1\/admin\/storage\/repositories\/oauth\/; HttpOnly; SameSite=Lax$/);
      binding = /^mscd_repo_tx=([^;]+)/.exec(cookie)![1]!;
      const rows = await tenantScope((trx) => trx.selectFrom('platform.auth_transaction').selectAll().where('kind', '=', 'repo_oauth').execute());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organization_id: ndt.id, user_id: ids.ta1, target_id: repoIds.gd, return_to: '/storage' });
      expect(rows[0]!.state_hash.equals(createHash('sha256').update(state).digest())).toBe(true);
      expect(rows[0]!.browser_binding_hash.equals(createHash('sha256').update(binding).digest())).toBe(true);
      expect(rows[0]!.code_verifier_sealed).not.toContain(challenge);
      const verifier = await ctx.moduleRef.get(SecretBox).openText(rows[0]!.code_verifier_sealed!, { purpose: 'pkce', transactionId: rows[0]!.id });
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    });

    it('changes nothing for a callback without the binding cookie, from another user or with another state', async () => {
      const before = await activeCredential();
      for (const [who, query, cookie] of [
        ['ta1', { state, code: 'code-1' }, undefined],
        ['ta2', { state, code: 'code-1' }, `mscd_repo_tx=${binding}`],
        ['ta1', { state, code: 'code-1' }, 'mscd_repo_tx=not-the-binding-value-of-this-transaction-x'],
        ['ta1', { state: 'another-state', code: 'code-1' }, `mscd_repo_tx=${binding}`],
      ] as const) {
        const response = await callback(who, query, cookie);
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/storage?oauth=failed');
      }
      expect(await transactions()).toHaveLength(1);
      expect((await activeCredential())?.credential_ref).toBe(before?.credential_ref);
      expect(drive.calls.filter((c) => c.operation === 'oauth')).toEqual([]);
    });

    it('exchanges the code in the gateway, stores the sealed refresh token and is single use', async () => {
      const before = await activeCredential();
      const response = await callback('ta1', { state, code: 'code-1', scope: 'https://www.googleapis.com/auth/drive.file' }, `mscd_repo_tx=${binding}`);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/storage');
      expect(String(response.headers['set-cookie'])).toMatch(/^mscd_repo_tx=; /);
      const exchange = drive.calls.find((c) => c.operation === 'oauth')!;
      expect(exchange.input).toMatchObject({ code: 'code-1', redirectUri: `http://localhost:4174${CALLBACK}` });
      expect(createHash('sha256').update(exchange.input!.codeVerifier).digest('base64url')).toBe(challenge);
      expect(exchange.credential?.secret).toEqual({ clientId: 'client-1', clientSecret: 's3cr3t-client' });

      const after = await activeCredential();
      expect(after?.credential_ref).not.toBe(before?.credential_ref);
      expect(after).toMatchObject({ kind: 'oauth_refresh_token', external_account: 'tono.hartono@example.test' });
      expect(await transactions()).toEqual([]);
      const gd = view('gd', await listRepositories());
      expect(gd).toMatchObject({ connectionStatus: 'ok', status: 'ok', credentialSet: true, actions: ['test', 'reauthorise'] });
      const audit = await tenantScope((trx) =>
        trx.selectFrom('audit_trail').select('after_data').where('action', '=', 'storage.credential.set').where('entity_code', '=', 'gd').orderBy('seq', 'desc').executeTakeFirstOrThrow(),
      );
      expect(audit.after_data).toMatchObject({ kind: 'oauth_refresh_token', externalAccount: 'tono.hartono@example.test' });

      // The gateway opens the new credential with the refresh token; the api never saw it.
      drive.calls.length = 0;
      await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${repoIds.gd}/test`);
      expect(drive.calls[0]!.credential?.secret).toEqual({ clientId: 'client-1', clientSecret: 's3cr3t-client', refreshToken: 'refresh-for-code-1' });

      const replay = await callback('ta1', { state, code: 'code-1' }, `mscd_repo_tx=${binding}`);
      expect(replay.headers.location).toBe('/storage?oauth=failed');
      expect((await activeCredential())?.credential_ref).toBe(after?.credential_ref);
    });

    it('consumes the transaction but stores nothing when the user denied consent', async () => {
      const start = await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${repoIds.gd}/reauthorize`);
      const url = new URL(CommandResult.parse(start.json()).redirectUrl!);
      const cookie = /^(mscd_repo_tx=[^;]+)/.exec(String(start.headers['set-cookie']))![1]!;
      const before = await activeCredential();
      const denied = await callback('ta1', { state: url.searchParams.get('state')!, error: 'access_denied' }, cookie);
      expect(denied.headers.location).toBe('/storage?oauth=denied');
      expect(await transactions()).toEqual([]);
      expect((await activeCredential())?.credential_ref).toBe(before?.credential_ref);
    });
  });

  it('holds only sealed credentials in the database (D-08)', async () => {
    const secrets = ['s3cr3t-client', 'refresh-for-code-1', certificate.privateKeyPem.split('\n')[2]!];
    const dumps = await inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName, platformScope: true }, async (trx) => {
      const texts: string[] = [];
      for (const table of ['storage_credential', 'storage_repository', 'audit_trail', 'notification', 'platform.audit_log', 'platform.auth_transaction', 'platform.tenant_key']) {
        const { rows } = await sql<{ t: string }>`select row_to_json(x)::text as t from ${sql.table(table)} x`.execute(trx);
        texts.push(...rows.map((r) => r.t));
      }
      return texts.join('\n');
    });
    for (const secret of secrets) expect(dumps).not.toContain(secret);
  });

  it('records move requests for personal repositories and notifies the Tenant Admins (BR-30)', async () => {
    const response = await call('mm', 'POST', `/api/v1/admin/storage/repositories/${repoIds.od}/move-requests`, { ms: 'qms', note: 'Account disabled 15 Aug 2026' });
    expect(response.statusCode).toBe(201);
    expect(CommandResult.parse(response.json())).toMatchObject({ count: 2, message: ['Move request sent to the Tenant Admins', expect.any(String)] });
    const rows = await tenantScope(async (trx) => ({
      requests: await trx.selectFrom('repository_move_request').selectAll().execute(),
      notifications: await trx.selectFrom('notification').select(['recipient_user_id', 'kind', 'title_en']).where('kind', '=', 'move_request').execute(),
      audit: await trx.selectFrom('audit_trail').select(['action', 'entity_code']).where('action', '=', 'storage.move_requested').execute(),
    }));
    expect(rows.requests).toMatchObject([{ storage_repository_id: repoIds.od, status: 'open', note: 'Account disabled 15 Aug 2026', created_by: ids.mm }]);
    expect(rows.notifications.map((n) => n.recipient_user_id).sort()).toEqual([ids.ta1, ids.ta2].sort());
    expect(rows.audit).toEqual([{ action: 'storage.move_requested', entity_code: 'od' }]);
    const organisational = await call('mm', 'POST', `/api/v1/admin/storage/repositories/${repoIds.sp}/move-requests`, { ms: 'qms' });
    expect(organisational.statusCode).toBe(422);
    expect(organisational.json()).toMatchObject({ type: expect.stringMatching(/business-rule$/), messageKey: 'storage.move_not_personal' });
    expect(organisational.json()).not.toHaveProperty('rule');
    // The permission is checked in the system of the body: an MS Manager of QMS cannot ask for ISMS.
    expect((await call('mm', 'POST', `/api/v1/admin/storage/repositories/${repoIds.od}/move-requests`, { ms: 'isms' })).statusCode).toBe(403);
  });

  it('lists storage object metadata without content or provider URLs', async () => {
    await tenantScope(async (trx) => {
      await trx
        .insertInto('storage_object')
        .values([
          {
            storage_repository_id: ndt.vaultRepositoryId,
            external_item_id: `tenants/${ndt.id}/6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f`,
            hash_algorithm: 'sha256',
            hash_value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            hash_source: 'computed',
            size_bytes: '0',
            display_name: 'EV-0103-1.pdf',
          },
          {
            storage_repository_id: repoIds.sp!,
            external_item_id: 'demo-sp-EV-0313',
            external_version_id: '3.0',
            hash_algorithm: 'quickxor',
            hash_value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            hash_source: 'provider',
            link_status: 'missing',
            web_url: 'https://contoso.sharepoint.com/sites/compliance/secret-link',
          },
        ])
        .execute();
    });
    const page = pageOf(StorageObjectMeta);
    const all = page.parse((await call('sa', 'GET', '/api/v1/admin/storage/objects')).json());
    expect(all.total).toBe(2);
    expect(JSON.stringify(all)).not.toContain('secret-link');
    expect(Object.keys(all.items[0]!)).not.toContain('webUrl');
    const missing = page.parse((await call('sa', 'GET', '/api/v1/admin/storage/objects?status=missing')).json());
    expect(missing.items.map((i) => [i.repository, i.externalItemId, i.linkStatus])).toEqual([['sp', 'demo-sp-EV-0313', 'missing']]);
    const vaultOnly = page.parse((await call('sa', 'GET', '/api/v1/admin/storage/objects?repository=vault&pageSize=1')).json());
    expect(vaultOnly).toMatchObject({ total: 1, pageSize: 1, items: [{ repository: 'vault', sizeBytes: 0, hashAlgorithm: 'sha256' }] });
    expect((await call('mm', 'GET', '/api/v1/admin/storage/objects')).statusCode).toBe(403);
    // Objects count as references of the repository in the connection test.
    const tested = CommandResult.parse((await call('ta1', 'POST', `/api/v1/admin/storage/repositories/${ndt.vaultRepositoryId}/test`)).json());
    expect(tested.data).toMatchObject({ references: 1 });
  });

  it('provisions a tenant with a data key from the gateway (HttpDataKeyIssuer, C.8)', async () => {
    const client = new HttpGatewayClient(db.config({ MSCD__STORAGE__GATEWAY__URL: gateway.url }));
    try {
      const tenant = await createTenant(db, 'viagw', { dataKeys: new HttpDataKeyIssuer(client) });
      const key = await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.selectFrom('platform.tenant_key').select(['wrapped_dek', 'kek_id']).where('organization_id', '=', tenant.id).executeTakeFirstOrThrow(),
      );
      expect(key.kek_id).toBe(tenant.kekId);
      const tested = await client.post<{ status: string }>('/v1/test-connection', {
        tenant: { orgId: tenant.id, wrappedDek: key.wrapped_dek },
        repository: { id: tenant.vaultRepositoryId, slug: 'vault', adapter: 'managed_vault', modes: ['stored'], config: { prefix: `tenants/${tenant.id}/` } },
      });
      expect(tested.status).toBe('ok');
    } finally {
      await client.onApplicationShutdown();
    }
  });

  it('keeps organisations apart: another organisation sees only its own repositories', async () => {
    const other = await createTenant(db, 'bsd');
    const fw = await addFramework(db.migrator, 'OTHER');
    const systems = { isms: await addManagementSystem(db.migrator, other, fw.versionId, 'isms') };
    const users = await addStorageUsers(db, other, systems, { ta: { handle: 'ta.bsd', orgRoles: ['tenant_admin'] } }, infoOf(other));
    const app = await createIntApp(
      db,
      { imports: [StorageModule] },
      {
        auth: { identities: users.identities },
        env: { MSCD__STORAGE__GATEWAY__URL: gateway.url },
        overrides: (builder) => builder.overrideProvider(LICENCE_GATE).useValue(storageLicenceGate()),
      },
    );
    try {
      const response = await app.app.inject({ method: 'GET', url: '/api/v1/admin/storage/repositories', headers: { [FAKE_PRINCIPAL_HEADER]: 'ta' } });
      expect(response.json<RepositoryView[]>().map((r) => r.ref)).toEqual([other.vaultRepositoryId]);
      const foreign = await app.app.inject({ method: 'PATCH', url: `/api/v1/admin/storage/repositories/${repoIds.sp}`, headers: { [FAKE_PRINCIPAL_HEADER]: 'ta' }, payload: { name: 'x' } });
      expect(foreign.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
