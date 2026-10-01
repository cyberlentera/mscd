// Key administration (D-01, D-09, F.11, D.5): `keys generate` writes the five files with tight modes; `keys rewrap`
// re-wraps tenant data keys under a new storage.key and re-seals platform secrets under a new platform.key, using
// the previous keys of the profile; the gateway refuses to start without its key or token.
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { generateKeys, register, resealPlatformSecrets, rewrapTenantKeys, rotateGatewayToken, runRewrap } from '../../../src/cli/keys';
import { ConfigError } from '../../../src/config/mscd-config';
import { DataKeyService } from '../../../src/gateway/crypto/data-keys';
import { anchorKeyId } from '../../../src/modules/audit/anchors';
import { FileKeyProvider, kekIdOf, readKekFile, sealWithKek } from '../../../src/modules/keys/file-key-provider';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser, inScope } from '../db/helpers';
import { SECRETS_DIR, gatewayConfig, startGateway, tempDir } from './helpers';

describe('keys generate and rotate-gateway-token', () => {
  it('writes the KEKs, the gateway token and the anchor key pair with owner-only modes', () => {
    const dir = path.join(tempDir(), 'secrets');
    const result = generateKeys(dir);
    const file = (name: string) => path.join(dir, name);
    expect(readKekFile(file('platform.key'))).toHaveLength(32);
    expect(readKekFile(file('storage.key'))).toHaveLength(32);
    expect(result.platformKekId).toBe(kekIdOf(readKekFile(file('platform.key'))));
    expect(result.storageKekId).toBe(kekIdOf(readKekFile(file('storage.key'))));
    expect(result.platformKekId).not.toBe(result.storageKekId);
    expect(readFileSync(file('gateway.token'), 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const privateKey = createPrivateKey(readFileSync(file('audit-anchor.key'), 'utf8'));
    expect(privateKey.asymmetricKeyType).toBe('ed25519');
    expect(anchorKeyId(createPublicKey(readFileSync(file('audit-anchor.pub'), 'utf8')))).toBe(result.anchorKeyId);
    for (const name of ['platform.key', 'storage.key', 'gateway.token', 'audit-anchor.key']) {
      expect(statSync(file(name)).mode & 0o777, name).toBe(0o400);
    }
    expect(statSync(file('audit-anchor.pub')).mode & 0o777).toBe(0o444);
    expect(() => generateKeys(dir)).toThrow(/already exist/);
    const again = generateKeys(dir, { force: true });
    expect(again.storageKekId).not.toBe(result.storageKekId);
  });

  it('prints the key ids through the command line', async () => {
    const lines: string[] = [];
    const program = new Command().exitOverride();
    register(program, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    await program.parseAsync(['keys', 'generate', '--out', path.join(tempDir(), 'k')], { from: 'user' });
    expect(lines.join('\n')).toMatch(/Wrote 5 files to .*\nplatform\.key [0-9a-f]{8}, storage\.key [0-9a-f]{8}, audit anchor key [0-9a-f]{16}/);
  });

  it('rotates the gateway token, keeping the old one as previous', () => {
    const dir = tempDir();
    const current = path.join(dir, 'gateway.token');
    const previous = path.join(dir, 'gateway.token.previous');
    const old = randomBytes(32).toString('base64url');
    writeFileSync(current, `${old}\n`, { mode: 0o400 });
    rotateGatewayToken(current, previous);
    expect(readFileSync(previous, 'utf8').trim()).toBe(old);
    const next = readFileSync(current, 'utf8').trim();
    expect(next).not.toBe(old);
    expect(statSync(current).mode & 0o777).toBe(0o400);
    expect(() => rotateGatewayToken(current, current)).toThrow(ConfigError);
    expect(() => rotateGatewayToken(path.join(dir, 'missing'), previous)).toThrow(ConfigError);
  });
});

describe('keys rewrap (F.11)', () => {
  const db = useTestDatabase('empty');

  it('re-wraps tenant data keys under the new storage.key and re-seals platform secrets', async () => {
    const tenant = await createTenant(db, 'rewrap');
    const oldStorage = readKekFile(path.join(SECRETS_DIR, 'storage.key'));
    const newStorage = randomBytes(32);
    const dir = tempDir();
    writeFileSync(path.join(dir, 'storage.key'), newStorage.toString('base64'), { mode: 0o400 });
    const before = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.tenant_key').select(['wrapped_dek', 'kek_id']).where('organization_id', '=', tenant.id).executeTakeFirstOrThrow(),
    );
    expect(before.kek_id).toBe(kekIdOf(oldStorage));
    const original = await new DataKeyService(new FileKeyProvider(oldStorage)).unwrap(tenant.id, before.wrapped_dek);

    // Platform secrets sealed with the development platform.key.
    const oldPlatform = readKekFile(path.join(SECRETS_DIR, 'platform.key'));
    const userId = await addUser(db.migrator, 'rewrap.user', [tenant.id]);
    await inScope(db.migrator, { platformScope: true }, async (trx) => {
      await trx
        .insertInto('platform.mfa_factor')
        .values({ user_id: userId, secret_sealed: sealWithKek(oldPlatform, Buffer.from('JBSWY3DPEHPK3PXP'), `mfa:${userId}`), confirmed_at: sql<Date>`now()` })
        .execute();
    });
    const newPlatform = randomBytes(32);
    writeFileSync(path.join(dir, 'platform.key'), newPlatform.toString('base64'), { mode: 0o400 });

    const config = db.config({
      MSCD__GATEWAY__KMS__FILE__PATH: path.join(dir, 'storage.key'),
      MSCD__GATEWAY__KMS__FILE__PREVIOUS_PATHS: `[${path.join(SECRETS_DIR, 'storage.key')}]`,
      MSCD__KMS__FILE__PATH: path.join(dir, 'platform.key'),
      MSCD__KMS__FILE__PREVIOUS_PATHS: `[${path.join(SECRETS_DIR, 'platform.key')}]`,
    });
    const report = await runRewrap({}, config);
    expect(report.tenantKeys).toEqual({ checked: 1, rewrapped: 1 });
    expect(report.platformSecrets).toEqual({ checked: 1, resealed: 1 });

    const after = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.tenant_key').select(['wrapped_dek', 'kek_id', 'rotated_at']).where('organization_id', '=', tenant.id).executeTakeFirstOrThrow(),
    );
    expect(after.kek_id).toBe(kekIdOf(newStorage));
    expect(after.rotated_at).not.toBeNull();
    // The gateway with only the new storage.key opens the same data key.
    const reopened = await new DataKeyService(new FileKeyProvider(newStorage)).unwrap(tenant.id, after.wrapped_dek);
    expect(reopened.key.equals(original.key)).toBe(true);
    const factor = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.mfa_factor').select('secret_sealed').where('user_id', '=', userId).executeTakeFirstOrThrow(),
    );
    expect((await new FileKeyProvider(newPlatform).unwrap(factor.secret_sealed, `mfa:${userId}`)).toString()).toBe('JBSWY3DPEHPK3PXP');

    // A second run finds nothing to do.
    const again = await runRewrap({ storage: true }, config);
    expect(again.tenantKeys).toEqual({ checked: 1, rewrapped: 0 });
    const migrator = db.migrator;
    expect(await rewrapTenantKeys(migrator, new FileKeyProvider(newStorage))).toEqual({ checked: 1, rewrapped: 0 });
    expect(await resealPlatformSecrets(migrator, new FileKeyProvider(newPlatform))).toEqual({ checked: 1, resealed: 0 });
  });
});

describe('storage gateway start', () => {
  it('refuses to start without storage.key or with a token file that is missing', async () => {
    await expect(startGateway(gatewayConfig({ MSCD__GATEWAY__KMS__FILE__PATH: '/nonexistent/storage.key' }), { factories: [] })).rejects.toThrow(
      ConfigError,
    );
    await expect(startGateway(gatewayConfig({ MSCD__GATEWAY__TOKEN_FILES: '[/nonexistent/gateway.token]' }), { factories: [] })).rejects.toThrow(/gateway token file/);
  });
});
