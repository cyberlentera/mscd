// `seed demo` as a command (WP-14, G.1, G.3): demo mode required, the Keycloak provider with pre-registered subjects
// when demo.keycloak is set, "already seeded" on a second run, `--reset` reseeding (here with data keys and sealed
// credentials from a running storage gateway), an interrupted run refused, and the choice of the key service.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MscdConfig } from '../../../src/config/mscd-config';
import { openCredential } from '../../../src/gateway/crypto/credentials';
import { DataKeyService } from '../../../src/gateway/crypto/data-keys';
import { FileKeyProvider } from '../../../src/modules/keys/file-key-provider';
import { HttpGatewayClient } from '../../../src/modules/storage/gateway-client';
import { chooseKeyService, GatewayKeyService, LocalKeyService } from '../../../src/seed/key-service';
import { SEED_MARKER_KEY, seedDemo, SeedError } from '../../../src/seed/seed-demo';
import { startGateway, type RunningGateway } from '../gateway/helpers';
import { TEST_STORAGE_KEY_FILE } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, inPlatform, ORG_IDS } from './helpers';

const SECRETS = path.resolve(__dirname, '../../fixtures/secrets');
const KEYCLOAK_ISSUER = 'http://localhost:18088/realms/mscd';
const KEYCLOAK = {
  MSCD__DEMO__KEYCLOAK: `{issuer: "${KEYCLOAK_ISSUER}", client_id: mscd, client_secret_file: "${path.join(SECRETS, 'keycloak-client.secret')}"}`,
};
const SEED_TIMEOUT = 300_000;

describe('seed demo command (G.1, G.3)', () => {
  const db = useTestDatabase('empty');
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  let gateway: RunningGateway | undefined;

  afterAll(async () => {
    await gateway?.close();
  });

  const counts = () =>
    inPlatform(db.migrator, async (trx) => ({
      organisations: (await trx.selectFrom('platform.organization').select('slug').orderBy('position').execute()).map((o) => o.slug),
      users: (await trx.selectFrom('platform.app_user').select('id').where('is_demo', '=', true).execute()).length,
      memberships: (await trx.selectFrom('platform.org_membership').select('user_id').execute()).length,
      licences: (await trx.selectFrom('platform.licence').select('id').execute()).length,
      packs: (await trx.selectFrom('platform.pack_install').select('id').where('status', '=', 'installed').execute()).length,
    }));

  it('refuses to run without demo mode (D-20)', async () => {
    const config = db.config({}, 'cli');
    const noDemo = new MscdConfig({
      profile: { ...config.profile, demo: { ...config.profile.demo, enabled: false } },
      profileFile: config.profileFile,
      flavor: config.flavor,
      runMode: 'cli',
      env: config.env,
    });
    await expect(seedDemo(noDemo, { keys: LocalKeyService.fromConfig(config) })).rejects.toThrow(/demo\.enabled/);
    expect((await counts()).organisations).toEqual([]);
  });

  it(
    'seeds with demo.keycloak: the provider of ndt and tst and the pre-registered subjects of four users (G.3)',
    async () => {
      const config = db.config(KEYCLOAK, 'cli');
      const keys = LocalKeyService.fromConfig(config);
      const result = await seedDemo(config, { keys, log });
      await keys.close();
      expect(result.status).toBe('seeded');
      expect(result.organisations.map((o) => o.slug)).toEqual(['ndt', 'bsd', 'rmn', 'tst']);
      expect(result.packs.map((p) => p.status)).toEqual(['installed', 'installed', 'installed', 'installed', 'installed', 'installed']);
      const providers = await inPlatform(db.migrator, (trx) =>
        trx
          .selectFrom('platform.identity_provider as p')
          .innerJoin('platform.organization as o', 'o.id', 'p.organization_id')
          .select(['p.id', 'o.slug as org', 'p.slug', 'p.kind', 'p.display_name', 'p.icon', 'p.oidc_issuer', 'p.oidc_client_id', 'p.oidc_client_secret_sealed', 'p.require_mfa_claim', 'p.mfa_fallback', 'p.jit_provisioning', 'p.enabled'])
          .orderBy('o.position')
          .execute(),
      );
      expect(providers.map((p) => [p.org, p.slug])).toEqual([['ndt', 'keycloak'], ['tst', 'keycloak-tst']]);
      const platformKeys = FileKeyProvider.fromFiles(config.profile.kms.file.path);
      for (const provider of providers) {
        expect(provider).toMatchObject({
          kind: 'oidc', display_name: 'Sign in with Keycloak', icon: 'generic', oidc_issuer: KEYCLOAK_ISSUER, oidc_client_id: 'mscd',
          require_mfa_claim: true, mfa_fallback: 'local_totp', jit_provisioning: false, enabled: true,
        });
        const secret = await platformKeys.unwrap(provider.oidc_client_secret_sealed!, `idp:${provider.id}`);
        expect(secret.toString('utf8')).toBe(config.readSecretFile(path.join(SECRETS, 'keycloak-client.secret')));
        const identities = await inPlatform(db.migrator, (trx) =>
          trx
            .selectFrom('platform.user_identity as i')
            .innerJoin('platform.app_user as u', 'u.id', 'i.user_id')
            .select(['u.handle', 'i.subject', 'i.link_method', 'i.email_at_link'])
            .where('i.identity_provider_id', '=', provider.id)
            .orderBy('i.subject')
            .execute(),
        );
        expect(identities).toEqual([
          { handle: 'rina', subject: '00000000-0000-4000-8000-0000000000c1', link_method: 'admin', email_at_link: 'rina.kusuma@nusantaradigital.co.id' },
          { handle: 'bagus', subject: '00000000-0000-4000-8000-0000000000c2', link_method: 'admin', email_at_link: 'bagus.prasetyo@nusantaradigital.co.id' },
          { handle: 'maya', subject: '00000000-0000-4000-8000-0000000000c3', link_method: 'admin', email_at_link: 'maya.putri@nusantaradigital.co.id' },
          { handle: 'hendra', subject: '00000000-0000-4000-8000-0000000000c4', link_method: 'admin', email_at_link: 'hendra.wijaya@nusantaradigital.co.id' },
        ]);
      }

      // A second run changes nothing and says so.
      const before = await counts();
      lines.length = 0;
      const again = await seedDemo(config, { keys: LocalKeyService.fromConfig(config), log });
      expect(again.status).toBe('already_seeded');
      expect(lines).toContain('seed demo: already seeded (run seed demo --reset to seed again)');
      expect(await counts()).toEqual(before);
      expect(before).toEqual({ organisations: ['ndt', 'bsd', 'rmn', 'tst'], users: 90, memberships: 3 * 86 + 12, licences: 4, packs: 6 });
    },
    SEED_TIMEOUT,
  );

  it(
    '--reset removes the demo and seeds it again, here with keys and credentials from a running storage gateway',
    async () => {
      const usersBefore = await inPlatform(db.migrator, (trx) => trx.selectFrom('platform.app_user').select(['id', 'handle']).where('is_demo', '=', true).execute());
      gateway = await startGateway(db.config({}, 'storage-gateway'));
      // demo.keycloak names a secret file this host does not have (the Compose path of demo.yaml): no provider.
      const missingSecret = path.join(SECRETS, 'no-such-keycloak-client.secret');
      const config = db.config(
        { MSCD__STORAGE__GATEWAY__URL: gateway.url, MSCD__DEMO__KEYCLOAK: `{issuer: "${KEYCLOAK_ISSUER}", client_id: mscd, client_secret_file: "${missingSecret}"}` },
        'cli',
      );
      const keys = new GatewayKeyService(new HttpGatewayClient(config));
      lines.length = 0;
      const result = await seedDemo(config, { reset: true, keys, log });
      await keys.close();
      expect(result.status).toBe('seeded');
      expect(result.removed).toEqual({ organisations: expect.arrayContaining(['ndt', 'bsd', 'rmn', 'tst']), users: 90 });
      expect(lines).toEqual(expect.arrayContaining(['seed demo: removed organisation ndt and schema org_ndt', 'seed demo: removed 90 demo users']));
      expect(await counts()).toEqual({ organisations: ['ndt', 'bsd', 'rmn', 'tst'], users: 90, memberships: 3 * 86 + 12, licences: 4, packs: 6 });
      const usersAfter = await inPlatform(db.migrator, (trx) => trx.selectFrom('platform.app_user').select(['id', 'handle']).where('is_demo', '=', true).execute());
      expect(usersAfter.map((u) => u.handle).sort()).toEqual(usersBefore.map((u) => u.handle).sort());
      expect(usersAfter.some((u) => usersBefore.some((b) => b.id === u.id))).toBe(false);
      // The providers of the first seed are gone, and the unreadable secret file left the Keycloak provider out.
      expect(lines.some((line) => line.startsWith('seed demo: demo.keycloak is set, but ') && line.endsWith('the Keycloak provider is not created'))).toBe(true);
      expect(await inPlatform(db.migrator, (trx) => trx.selectFrom('platform.identity_provider').select('id').execute())).toEqual([]);
      expect(await inPlatform(db.migrator, (trx) => trx.selectFrom('platform.user_identity').select('subject').execute())).toEqual([]);

      // The gateway sealed the credentials; they open with the storage key. A refresh token is sealed only in the
      // consent flow, so the Google Drive credential holds the OAuth client alone.
      const dataKeys = new DataKeyService(FileKeyProvider.fromFiles(TEST_STORAGE_KEY_FILE));
      const key = await inPlatform(db.migrator, (trx) => trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', ORG_IDS.ndt).executeTakeFirstOrThrow());
      const dataKey = await dataKeys.unwrap(ORG_IDS.ndt, key.wrapped_dek);
      const repos = await inOrg(db.migrator, 'ndt', (trx) =>
        trx
          .selectFrom('storage_repository as r')
          .innerJoin('storage_credential as c', (join) => join.onRef('c.storage_repository_id', '=', 'r.id').onRef('c.credential_ref', '=', 'r.credential_ref'))
          .select(['r.id', 'r.slug', 'r.config', 'c.kind', 'c.sealed_blob', 'c.credential_ref'])
          .execute(),
      );
      expect(repos.map((r) => r.slug).sort()).toEqual(['gd', 'od', 'sp']);
      for (const repo of repos) {
        const opened = openCredential(dataKey, { id: repo.id, config: repo.config as Record<string, unknown> }, { ref: repo.credential_ref, sealedBlob: repo.sealed_blob, kind: repo.kind });
        if (repo.slug === 'gd') expect(Object.keys(opened.secret).sort()).toEqual(['clientId', 'clientSecret']);
        else expect(Object.keys(opened.secret).sort()).toEqual(['certificatePem', 'clientId', 'privateKeyPem', 'tenantId']);
      }
      const marker = await db.migrator.selectFrom('platform.system_setting').select('value').where('key', '=', SEED_MARKER_KEY).executeTakeFirstOrThrow();
      expect(marker.value).toMatchObject({ keys: 'gateway' });
    },
    SEED_TIMEOUT,
  );

  it('refuses to seed over an interrupted run, which --reset clears', async () => {
    await db.migrator.deleteFrom('platform.system_setting').where('key', '=', SEED_MARKER_KEY).execute();
    const config = db.config({}, 'cli');
    const error = await seedDemo(config, { keys: LocalKeyService.fromConfig(config), log }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeedError);
    expect((error as Error).message).toMatch(/already holds organisations ndt, bsd, rmn, tst but no finished seed: run "mscd-server seed demo --reset"/);
  });

  it('chooses the gateway when it answers and the local key file when it does not (--keys auto)', async () => {
    const reachable = db.config({ MSCD__STORAGE__GATEWAY__URL: gateway!.url }, 'cli');
    const viaGateway = await chooseKeyService(reachable, 'auto', log);
    expect(viaGateway.mode).toBe('gateway');
    await viaGateway.close();
    lines.length = 0;
    const unreachable = db.config({ MSCD__STORAGE__GATEWAY__URL: 'http://127.0.0.1:9' }, 'cli');
    const local = await chooseKeyService(unreachable, 'auto', log);
    expect(local.mode).toBe('local');
    expect(lines.join('\n')).toMatch(/is not reachable; using the gateway key file/);
    await local.close();
    for (const mode of ['gateway', 'local'] as const) {
      const chosen = await chooseKeyService(unreachable, mode);
      expect(chosen.mode).toBe(mode);
      await chosen.close();
    }
  });
});
