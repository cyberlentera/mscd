// Licences (D-15, D-16, D-32, BR-37, J.5): the derived state across dates, binding and trial rules, the clock
// rollback rule, GET /license and PUT /admin/license, read-only mode on write routes, the LicenceGate limits and
// features, the daily license.check job, and the trust anchors of a release-flavour build.
import { execFile } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { licenceSigningPayload } from '@mscd/shared';
import { DEV_KEY_IDS, generateSigningKeyPair, signLicence } from '@mscd/pack-tools';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LICENCE_GATE, type LicenceGate } from '../../../src/common/tokens';
import { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { evaluateLicenceState, licenceStateOn } from '../../../src/modules/license/licence-state';
import { TRUST_ANCHORS, trustAnchorsOf, type BuildInfoTrust } from '../../../src/modules/license/trust-anchors';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { TEST_PROFILE_FILE, useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { addManagementSystem, inScope } from '../db/helpers';
import {
  DEV_KEYS_DIR,
  DEV_LICENCE_KEY,
  addMember,
  changedPack,
  createPackApp,
  devLicence,
  importForm,
  licenceFields,
  installDevPacks,
  orgIdentities,
  type PackApp,
} from '../packs/fixtures';

const run = promisify(execFile);
const as = (who: string) => ({ [FAKE_PRINCIPAL_HEADER]: who });
const SERVER_DIR = path.resolve(__dirname, '../../..');

async function auditRows(db: TestDatabase, action: string, orgId?: string) {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    let query = trx.selectFrom('platform.audit_log').select(['action', 'organization_id', 'entity_code', 'actor_kind', 'before_data', 'after_data']).where('action', '=', action);
    if (orgId) query = query.where('organization_id', '=', orgId);
    return query.orderBy('seq').execute();
  });
}

async function licenceRows(db: TestDatabase, orgId: string) {
  return inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.licence').select(['license_id', 'superseded_at']).where('organization_id', '=', orgId).orderBy('installed_at').execute(),
  );
}

/** A licence signed directly over the canonical payload with the development key (bypasses the signing tool's checks). */
function rawSigned(doc: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...doc, key_id: 'f83c3c5b683ceb05' };
  const signature = sign(null, Buffer.from(licenceSigningPayload(unsigned), 'utf8'), DEV_LICENCE_KEY);
  return { ...unsigned, signature: `ed25519:${signature.toString('base64')}` };
}

describe('licence state (D-15)', () => {
  const doc = { valid_from: '2026-04-01', valid_until: '2027-03-31', grace_days: 30 };

  it('is valid inside the validity, in grace for grace_days after it, then read-only (BR-37)', () => {
    expect(licenceStateOn(doc, '2026-03-31')).toBe('grace');
    expect(licenceStateOn(doc, '2026-04-01')).toBe('valid');
    expect(licenceStateOn(doc, '2027-03-31')).toBe('valid');
    expect(licenceStateOn(doc, '2027-04-01')).toBe('grace');
    expect(licenceStateOn(doc, '2027-04-30')).toBe('grace');
    expect(licenceStateOn(doc, '2027-05-01')).toBe('read_only');
  });

  it('evaluates at the high-water mark and at least in grace when the clock is more than 24 hours behind it', () => {
    const highWater = new Date('2027-06-01T10:00:00Z');
    const behind = evaluateLicenceState(doc, { today: '2026-10-01', now: new Date('2026-10-01T10:00:00Z'), highWater, timeZone: 'Asia/Jakarta' });
    expect(behind).toMatchObject({ clockRollback: true, evaluatedOn: '2027-06-01', state: 'read_only' });
    const slightly = evaluateLicenceState(doc, { today: '2026-10-01', now: new Date('2026-10-01T10:00:00Z'), highWater: new Date('2026-10-02T09:00:00Z'), timeZone: 'Asia/Jakarta' });
    expect(slightly).toMatchObject({ clockRollback: false, state: 'valid' });
    const rolledBackValid = evaluateLicenceState(doc, { today: '2026-10-01', now: new Date('2026-10-01T10:00:00Z'), highWater: new Date('2026-10-02T11:00:00Z'), timeZone: 'UTC' });
    expect(rolledBackValid).toMatchObject({ clockRollback: true, evaluatedOn: '2026-10-02', state: 'grace' });
  });
});

describe('licence upload, view, read-only mode and the licence gate', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let users: { ta: string; mm: string; do: string; tm: string };
  let app: PackApp;
  let gate: LicenceGate;

  beforeAll(async () => {
    tenant = await createTenant(db, 'ndt');
    users = {
      ta: await addMember(db, 'ta.ndt', tenant.id, ['tenant_admin']),
      mm: await addMember(db, 'mm.ndt', tenant.id),
      do: await addMember(db, 'do.ndt', tenant.id),
      tm: await addMember(db, 'tm.ndt', tenant.id),
    };
    await installDevPacks(db, ['ISO27001-2022']);
    app = await createPackApp(db, { identities: orgIdentities(tenant, users) });
    gate = app.moduleRef.get<LicenceGate>(LICENCE_GATE);
  });
  afterAll(async () => {
    await app?.close();
  });

  const put = (payload: unknown, who = 'ta@ndt') => app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as(who), payload: payload as Record<string, unknown> });

  it('answers 404 before a licence is installed, then installs a verified licence and shows it to its readers', async () => {
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/license', headers: as('ta@ndt') })).statusCode).toBe(404);
    const installed = await put(devLicence(tenant.id));
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toEqual({
      licenseId: 'LIC-TEST-0001',
      organization: 'Test organisation',
      binding: { organizationId: tenant.id, trial: false },
      validFrom: '2026-04-01',
      validUntil: '2027-03-31',
      graceDays: 30,
      state: 'valid',
      clockRollback: false,
      frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'],
      maxManagementSystems: 10,
      maxUsers: 150,
      activeUsers: 4,
      managementSystems: 0,
      storageAdapters: ['managed_vault', 'm365', 'google_drive', 'smb'],
      features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
      signature: { alg: 'Ed25519', keyId: 'f83c3c5b683ceb05', verified: true, offline: true },
    });
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/license', headers: as('tm@ndt') })).json()).toEqual(installed.json());
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/license', headers: as('mm@ndt') })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/license', headers: as('do@ndt') })).statusCode).toBe(403);
    expect((await put(devLicence(tenant.id), 'mm@ndt')).statusCode).toBe(403);

    // The same document again changes nothing.
    expect((await put(devLicence(tenant.id))).statusCode).toBe(200);
    expect(await licenceRows(db, tenant.id)).toEqual([{ license_id: 'LIC-TEST-0001', superseded_at: null }]);
    expect(await auditRows(db, 'licence.installed', tenant.id)).toHaveLength(1);
  });

  it('enforces the binding and trial rules (422 LIC-BINDING) and refuses bad signatures (400)', async () => {
    const otherOrg = await put(devLicence('6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c'));
    expect(otherOrg.statusCode).toBe(422);
    expect(otherOrg.json()).toMatchObject({ rule: 'LIC-BINDING', messageKey: 'licence.binding' });
    expect((await put(devLicence(null, { installation_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' }))).statusCode).toBe(422);
    const unbound = await put(rawSigned(licenceFields(null)));
    expect(unbound.statusCode).toBe(422);
    expect(unbound.json()).toMatchObject({ rule: 'LIC-BINDING' });
    const longTrial = await put(rawSigned(licenceFields(null, { trial: true, valid_until: '2026-12-31' })));
    expect(longTrial.statusCode).toBe(422);
    expect(longTrial.json()).toMatchObject({ rule: 'LIC-BINDING' });

    const tampered = { ...devLicence(tenant.id), max_users: 9999 };
    const bad = await put(tampered);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/validation' });
    const stranger = generateSigningKeyPair();
    const foreign = signLicence(licenceFields(tenant.id), stranger.privateKeyPem);
    expect((await put(foreign)).statusCode).toBe(400);
    expect(await auditRows(db, 'licence.rejected', tenant.id)).toHaveLength(6);

    // A licence bound to this installation and a short trial are both accepted.
    const installation = await db.migrator.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow();
    const onInstallation = await put(devLicence(null, { license_id: 'LIC-INST-1', installation_id: installation.id }));
    expect(onInstallation.statusCode).toBe(200);
    expect(onInstallation.json().binding).toEqual({ installationId: installation.id, trial: false });
    const trial = await put(devLicence(null, { license_id: 'LIC-TRIAL-1', trial: true, valid_from: '2026-09-01', valid_until: '2026-11-29' }));
    expect(trial.statusCode).toBe(200);
    expect(trial.json()).toMatchObject({ binding: { trial: true }, state: 'valid' });
    expect((await put(devLicence(tenant.id))).statusCode).toBe(200);
    expect((await licenceRows(db, tenant.id)).map((r) => [r.license_id, r.superseded_at === null])).toEqual([
      ['LIC-TEST-0001', false],
      ['LIC-INST-1', false],
      ['LIC-TRIAL-1', false],
      ['LIC-TEST-0001', true],
    ]);
  });

  it('derives the state from the clock: valid, grace and read-only, where read-only blocks writes but not reads (BR-37)', async () => {
    const expired = devLicence(tenant.id, { license_id: 'LIC-OLD-1', valid_from: '2025-01-01', valid_until: '2026-09-20', grace_days: 30 });
    const graceView = await put(expired);
    expect(graceView.json()).toMatchObject({ state: 'grace' });
    const late = devLicence(tenant.id, { license_id: 'LIC-OLD-2', valid_from: '2025-01-01', valid_until: '2026-08-15', grace_days: 10 });
    const readOnlyView = await put(late);
    expect(readOnlyView.statusCode).toBe(200);
    expect(readOnlyView.json()).toMatchObject({ state: 'read_only' });

    const write = await app.app.inject({
      method: 'POST',
      url: '/api/v1/admin/management-systems',
      headers: as('ta@ndt'),
      payload: { slug: 'isms', code: 'ISMS', name: 'ISMS', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'All', defaultRepository: 'vault', color: '#e8731a' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/read-only-mode', rule: 'BR-37' });
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).statusCode).toBe(200);
    const form = importForm(Buffer.from('x'));
    expect((await app.app.inject({ method: 'POST', url: '/api/v1/admin/packs/import', headers: { ...as('ta@ndt'), 'content-type': form.contentType }, payload: form.payload })).statusCode).toBe(403);

    // The licence upload stays allowed in read-only mode (D.1) and ends it.
    expect((await put(devLicence(tenant.id))).json()).toMatchObject({ state: 'valid' });
    await expect(gate.assertWritable(tenant.id)).resolves.toBeUndefined();
  });

  it('treats a clock more than 24 hours behind the high-water mark as a rollback: grace, flagged and audited', async () => {
    await db.migrator.updateTable('platform.clock_mark').set({ high_water: sql`now() + interval '25 hours'` }).execute();
    try {
      const view = await app.app.inject({ method: 'GET', url: '/api/v1/license', headers: as('ta@ndt') });
      expect(view.json()).toMatchObject({ state: 'grace', clockRollback: true });
      const audited = await auditRows(db, 'licence.clock_rollback', tenant.id);
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ actor_kind: 'system' });
    } finally {
      await db.migrator.updateTable('platform.clock_mark').set({ high_water: sql`now()` }).execute();
    }
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/license', headers: as('ta@ndt') })).json()).toMatchObject({ state: 'valid', clockRollback: false });
  });

  it('limits users (LIC-USERS), management systems (LIC-MS), features (LIC-FEATURE) and adapters', async () => {
    const scope = app.moduleRef.get(TenantScope);
    const inTenant = <T>(fn: (trx: Parameters<Parameters<TenantScope['withTenant']>[1]>[0]) => Promise<T>) =>
      scope.withTenant({ orgId: tenant.id, schema: tenant.schemaName, userId: users.ta }, fn);

    await put(devLicence(tenant.id, { license_id: 'LIC-SMALL', max_users: 5, max_management_systems: 1, features: ['integrated_mode'], storage_adapters: ['managed_vault'] }));
    await expect(inTenant((trx) => gate.assertCanAddUser(trx, tenant.id))).resolves.toBeUndefined();
    await addMember(db, 'fifth.ndt', tenant.id);
    await expect(inTenant((trx) => gate.assertCanAddUser(trx, tenant.id))).rejects.toMatchObject({ slug: 'business-rule', extras: { rule: 'LIC-USERS' } });

    await expect(inTenant((trx) => gate.assertCanAddMs(trx, tenant.id))).resolves.toBeUndefined();
    const version = await db.migrator.selectFrom('ref.framework_version').select('id').where('pack_id', '=', 'ISO27001-2022').executeTakeFirstOrThrow();
    await addManagementSystem(db.migrator, tenant, version.id, 'isms');
    await expect(inTenant((trx) => gate.assertCanAddMs(trx, tenant.id))).rejects.toMatchObject({ extras: { rule: 'LIC-MS' } });

    await expect(gate.assertFeature(tenant.id, 'integrated_mode')).resolves.toBeUndefined();
    for (const feature of ['auditor_guest_access', 'link_health_monitor', 'edition_transition'] as const) {
      await expect(gate.assertFeature(tenant.id, feature)).rejects.toMatchObject({ extras: { rule: 'LIC-FEATURE', messageKey: `licence.feature.${feature}` } });
    }
    expect(await gate.isAdapterLicensed(tenant.id, 'managed_vault')).toBe(true);
    expect(await gate.isAdapterLicensed(tenant.id, 'm365')).toBe(false);

    // Without any licence the organisation may write and add its first member, and nothing else.
    const fresh = await createTenant(db, 'fresh');
    const freshScope = <T>(fn: (trx: Parameters<Parameters<TenantScope['withTenant']>[1]>[0]) => Promise<T>) =>
      scope.withTenant({ orgId: fresh.id, schema: fresh.schemaName, userId: users.ta }, fn);
    await expect(gate.assertWritable(fresh.id)).resolves.toBeUndefined();
    await expect(freshScope((trx) => gate.assertCanAddUser(trx, fresh.id))).resolves.toBeUndefined();
    await addMember(db, 'first.fresh', fresh.id, ['tenant_admin']);
    await expect(freshScope((trx) => gate.assertCanAddUser(trx, fresh.id))).rejects.toMatchObject({ extras: { rule: 'LIC-USERS', messageKey: 'licence.no_licence' } });
    await expect(freshScope((trx) => gate.assertCanAddMs(trx, fresh.id))).rejects.toMatchObject({ extras: { rule: 'LIC-MS' } });
    await expect(gate.assertFeature(fresh.id, 'integrated_mode')).rejects.toMatchObject({ extras: { rule: 'LIC-FEATURE' } });
    expect(await gate.isAdapterLicensed(fresh.id, 'managed_vault')).toBe(false);
  });
});

describe('license.check (E.2)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let ta: string;
  let app: PackApp;

  beforeAll(async () => {
    tenant = await createTenant(db, 'chk');
    ta = await addMember(db, 'ta.chk', tenant.id, ['tenant_admin']);
    const mm = await addMember(db, 'mm.chk', tenant.id);
    await installDevPacks(db, ['ISO27001-2022']);
    const version = await db.migrator.selectFrom('ref.framework_version').select('id').where('pack_id', '=', 'ISO27001-2022').executeTakeFirstOrThrow();
    await addManagementSystem(db.migrator, tenant, version.id, 'isms');
    await inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
      await trx.insertInto('storage_repository').values({ slug: 'sp', name: 'SharePoint', adapter: 'm365', modes: ['link'], config: JSON.stringify({ driveId: 'drive-sp' }) }).execute();
    });
    app = await createPackApp(db, { identities: orgIdentities(tenant, { ta, mm }) });
    await app.runJobs();
  });
  afterAll(async () => {
    await app?.close();
  });

  const check = async () => {
    await app.queue.send('license.check', { orgId: tenant.id, payload: {} });
    await app.runJobs();
    expect(app.queue.failed()).toEqual([]);
  };
  const install = (doc: Record<string, unknown>) =>
    app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('ta@chk'), payload: doc }).then(async (r) => {
      expect(r.statusCode).toBe(200);
      await app.runJobs();
    });
  const tenantRows = <T>(fn: (trx: Parameters<Parameters<typeof inScope>[2]>[0]) => Promise<T>) => inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, fn);

  it('warns Tenant Admins 60, 30 and 7 days before expiry, once', async () => {
    // demo.fixed_today is 2026-09-29: 60 days before 2026-11-28.
    await install(devLicence(tenant.id, { valid_until: '2026-11-28', storage_adapters: ['managed_vault'] }));
    await check();
    await check();
    const notes = await tenantRows((trx) => trx.selectFrom('notification').select(['recipient_user_id', 'kind', 'title_en']).where('kind', '=', 'licence_expiring').execute());
    expect(notes).toEqual([{ recipient_user_id: ta, kind: 'licence_expiring', title_en: 'Licence expires in 60 days' }]);
    // The m365 adapter is not licensed: its repository is read-only for the application (TS 5.7).
    const repositories = await tenantRows((trx) => trx.selectFrom('storage_repository').select(['slug', 'read_only']).orderBy('slug').execute());
    expect(repositories).toEqual([
      { slug: 'sp', read_only: true },
      { slug: 'vault', read_only: false },
    ]);
  });

  it('records state changes, raises and resolves the licence alert, and follows the licensed adapters', async () => {
    await install(devLicence(tenant.id, { license_id: 'LIC-GRACE', valid_from: '2025-01-01', valid_until: '2026-09-20', grace_days: 30 }));
    const alerts = await tenantRows((trx) => trx.selectFrom('ms_alert').select(['kind', 'tone', 'text_en', 'resolved_at']).where('kind', '=', 'licence').execute());
    expect(alerts).toEqual([
      {
        kind: 'licence',
        tone: 'warn',
        text_en: 'The licence expired on 20 Sep 2026. Everything works until the grace period ends on 20 Oct 2026; then the organisation becomes read-only.',
        resolved_at: null,
      },
    ]);
    const changed = await auditRows(db, 'licence.state_changed', tenant.id);
    expect(changed.map((c) => [c.before_data, c.after_data])).toEqual([[{ state: 'valid' }, expect.objectContaining({ state: 'grace' })]]);
    const notes = await tenantRows((trx) => trx.selectFrom('notification').select(['kind', 'title_en']).where('kind', '=', 'licence_state').execute());
    expect(notes).toEqual([{ kind: 'licence_state', title_en: 'Licence state: grace period' }]);

    await install(devLicence(tenant.id, { license_id: 'LIC-RENEWED' }));
    await check();
    const resolved = await tenantRows((trx) => trx.selectFrom('ms_alert').select(['kind', 'resolved_at']).where('kind', '=', 'licence').execute());
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolved_at).not.toBeNull();
    expect((await auditRows(db, 'licence.state_changed', tenant.id)).map((c) => (c.after_data as { state: string }).state)).toEqual(['grace', 'valid']);
    const repositories = await tenantRows((trx) => trx.selectFrom('storage_repository').select(['slug', 'read_only']).orderBy('slug').execute());
    expect(repositories).toEqual([
      { slug: 'sp', read_only: false },
      { slug: 'vault', read_only: false },
    ]);
    const repoAudit = await tenantRows((trx) => trx.selectFrom('audit_trail').select(['action', 'entity_code', 'after_data']).where('action', '=', 'storage.repository.updated').orderBy('seq').execute());
    expect(repoAudit.map((r) => [r.entity_code, (r.after_data as { read_only: boolean }).read_only])).toEqual([
      ['sp', true],
      ['sp', false],
    ]);
  });
});

describe('trust anchors of a release-flavour build (D-16, J.5)', () => {
  const db = useTestDatabase('empty');
  let tmp: string;
  let releaseInfo: BuildInfoTrust;
  let rehearsalLicenceKey: string;
  let tenant: CreatedTenant;
  let app: PackApp;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mscd-release-'));
    const keysDir = path.join(tmp, 'trusted-keys');
    await mkdir(keysDir);
    const licenceKey = generateSigningKeyPair();
    const packKey = generateSigningKeyPair();
    rehearsalLicenceKey = licenceKey.privateKeyPem;
    await writeFile(path.join(keysDir, 'licence-rehearsal.pub'), licenceKey.publicKeyPem);
    await writeFile(path.join(keysDir, 'pack-rehearsal.pub'), packKey.publicKeyPem);
    const out = path.join(tmp, 'build-info.ts');
    await run(process.execPath, [path.join(SERVER_DIR, 'scripts/gen-build-info.mjs'), '--out', out], {
      env: { ...process.env, MSCD_BUILD_FLAVOR: 'release', MSCD_TRUSTED_KEYS_DIR: keysDir, MSCD_REVISION: 'rehearsal' },
    });
    const text = await readFile(out, 'utf8');
    const flavour = /export const BUILD_FLAVOR: BuildFlavor = "(\w+)";/.exec(text)?.[1];
    const keys = [...text.matchAll(/\{ kind: "(\w+)", keyId: "([0-9a-f]{16})", publicKeyPem: ("[^"]*") \}/g)].map((m) => ({
      kind: m[1] as 'licence' | 'pack' | 'anchor',
      keyId: m[2]!,
      publicKeyPem: JSON.parse(m[3]!) as string,
    }));
    releaseInfo = { BUILD_FLAVOR: flavour as 'release', TRUSTED_KEYS: keys };

    tenant = await createTenant(db, 'rel');
    const ta = await addMember(db, 'ta.rel', tenant.id, ['tenant_admin']);
    const mm = await addMember(db, 'mm.rel', tenant.id);
    app = await createPackApp(db, {
      identities: orgIdentities(tenant, { ta, mm }),
      overrides: (builder) => builder.overrideProvider(TRUST_ANCHORS).useValue(trustAnchorsOf(releaseInfo)),
    });
  });
  afterAll(async () => {
    await app?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('compiles only the rehearsal keys and refuses the development key ids', () => {
    expect(releaseInfo.BUILD_FLAVOR).toBe('release');
    expect(releaseInfo.TRUSTED_KEYS.map((k) => k.kind).sort()).toEqual(['licence', 'pack']);
    const anchors = trustAnchorsOf(releaseInfo);
    expect(anchors.rejectKeyIds).toEqual([...new Set(DEV_KEY_IDS)]);
    expect(anchors.keys.some((k) => DEV_KEY_IDS.includes(k.keyId))).toBe(false);
  });

  it('rejects a development-signed licence and pack, also when a development key were compiled in', async () => {
    const devSigned = await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('ta@rel'), payload: devLicence(tenant.id) });
    expect(devSigned.statusCode).toBe(400);
    const form = importForm(changedPack('ISO22301-2019', () => undefined).bytes);
    const pack = await app.app.inject({ method: 'POST', url: '/api/v1/admin/packs/import', headers: { ...as('ta@rel'), 'content-type': form.contentType }, payload: form.payload });
    expect(pack.statusCode).toBe(400);
    expect(JSON.stringify(pack.json())).toMatch(/development key/);
    expect(JSON.stringify(devSigned.json())).toMatch(/development key/);

    // A build that had compiled the development keys would still refuse them (rejectKeyIds).
    const devKeys = await Promise.all(
      (['licence', 'pack'] as const).map(async (kind) => ({
        kind,
        publicKeyPem: await readFile(path.join(DEV_KEYS_DIR, `${kind}-signing.pub`), 'utf8'),
        keyId: kind === 'licence' ? 'f83c3c5b683ceb05' : 'f4c7f82942491de1',
      })),
    );
    const leaky = trustAnchorsOf({ BUILD_FLAVOR: 'release', TRUSTED_KEYS: [...releaseInfo.TRUSTED_KEYS, ...devKeys] });
    expect(leaky.keys).toHaveLength(2);
    const { verifyLicence } = await import('@mscd/pack-tools');
    expect(() => verifyLicence(devLicence(tenant.id), [...releaseInfo.TRUSTED_KEYS, ...devKeys], { rejectKeyIds: leaky.rejectKeyIds })).toThrow(/development key/);

    // A licence signed with the release (rehearsal) key is accepted.
    const accepted = await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('ta@rel'), payload: devLicence(tenant.id, {}, rehearsalLicenceKey) });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().signature.keyId).toBe(releaseInfo.TRUSTED_KEYS.find((k) => k.kind === 'licence')!.keyId);
  });

  it('refuses trusted keys in the profile or the environment (keys are compiled in)', async () => {
    expect(() =>
      MscdConfig.load({ runMode: 'api', env: { MSCD_PROFILE_FILE: TEST_PROFILE_FILE, MSCD__LICENSE__TRUSTED_KEYS: '[f83c3c5b683ceb05]' } }),
    ).toThrow(/trusted keys are compiled into the build \(D-16\)/);
    expect(() => MscdConfig.load({ runMode: 'api', env: { MSCD_PROFILE_FILE: TEST_PROFILE_FILE, MSCD__PACKS__TRUSTED_KEYS: '[x]' } })).toThrow(/D-16/);
  });

  it('cannot generate a release build that trusts the development keys', async () => {
    await expect(
      run(process.execPath, [path.join(SERVER_DIR, 'scripts/gen-build-info.mjs'), '--out', path.join(tmp, 'leaky.ts')], {
        env: { ...process.env, MSCD_BUILD_FLAVOR: 'release', MSCD_TRUSTED_KEYS_DIR: DEV_KEYS_DIR },
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/holds development keys/) });
  });
});
