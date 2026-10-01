// The pack routes of D.3 and the pack jobs of E.2: GET /admin/packs, POST /admin/packs/import (verification, 400,
// 413, 422, idempotency claimed with the bundle digest, the pack.install job), POST /admin/packs/check-updates on the
// offline, managed and online channels, the multi-tenancy rules (D-17), and packs.lifecycle with
// edition.withdrawn-alerts (TS 6.3, BR-33).
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { PutHeader, PutResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/jobs/job-queue';
import { GATEWAY_CLIENT, type GatewayClient } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { FAKE_PRINCIPAL_HEADER, type FakeIdentity } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { addManagementSystem, inScope } from '../db/helpers';
import { infoOf } from '../platform/helpers';
import {
  addMember,
  archiveEntries,
  archiveOf,
  changedPack,
  createPackApp,
  devLicence,
  devPack,
  grantRole,
  importForm,
  installDevPacks,
  orgIdentities,
  type PackApp,
} from './fixtures';

const as = (who: string) => ({ [FAKE_PRINCIPAL_HEADER]: who });

async function auditRows(db: TestDatabase, action: string) {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const { rows } = await sql<{ entity_code: string | null; entity_id: string | null; organization_id: string | null; actor_kind: string; after_data: Record<string, unknown> | null }>`
      select entity_code, entity_id, organization_id, actor_kind, after_data from platform.audit_log where action = ${action} order by seq`.execute(trx);
    return rows;
  });
}

function postImport(app: PackApp, who: string, bundle: Buffer, options: { key?: string; extra?: Record<string, string> } = {}) {
  const form = importForm(bundle, options.extra);
  return app.app.inject({
    method: 'POST',
    url: '/api/v1/admin/packs/import',
    headers: { ...as(who), 'content-type': form.contentType, ...(options.key ? { 'idempotency-key': options.key } : {}) },
    payload: form.payload,
  });
}

describe('pack routes with tenancy.mode single (D.3)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let app: PackApp;

  beforeAll(async () => {
    tenant = await createTenant(db, 'ndt');
    const ta = await addMember(db, 'ta.ndt', tenant.id, ['tenant_admin']);
    const mm = await addMember(db, 'mm.ndt', tenant.id);
    const owner = await addMember(db, 'do.ndt', tenant.id);
    await installDevPacks(db, ['ISO27001-2022', 'ISO9001-2015', 'ISO9001-2026']);
    app = await createPackApp(db, { identities: orgIdentities(tenant, { ta, mm, do: owner }) });
    await app.runJobs();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists the installed packs for pack.read holders only', async () => {
    const list = await app.app.inject({ method: 'GET', url: '/api/v1/admin/packs', headers: as('ta@ndt') });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((p: { packId: string; status: string }) => [p.packId, p.status])).toEqual([
      ['ISO27001-2022', 'installed'],
      ['ISO9001-2015', 'installed'],
      ['ISO9001-2026', 'installed'],
    ]);
    expect(list.json()[0]).toMatchObject({ version: '1.2.0', frameworkCode: 'ISO27001', edition: '2022', preRelease: false, checksum: devPack('ISO27001-2022').sha256 });
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/admin/packs', headers: as('mm@ndt') })).statusCode).toBe(200);
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/admin/packs', headers: as('do@ndt') })).statusCode).toBe(403);
  });

  it('verifies an imported bundle, queues pack.install with the task id and replays the same import key', async () => {
    const bundle = devPack('ISO22301-2019').bytes;
    const first = await postImport(app, 'ta@ndt', bundle, { key: 'import-0001' });
    expect(first.statusCode).toBe(202);
    const body = first.json();
    expect(body).toMatchObject({ ok: true, changed: [], data: { packId: 'ISO22301-2019', version: '1.0.0', status: 'queued' } });
    await app.runJobs();
    const installed = await sql<{ id: string; status: string; installed_by: string | null }>`
      select id, status, installed_by from platform.pack_install where pack_id = 'ISO22301-2019'`.execute(db.migrator);
    expect(installed.rows).toEqual([{ id: body.taskId, status: 'installed', installed_by: expect.any(String) }]);
    const audited = (await auditRows(db, 'pack.installed')).filter((r) => r.entity_code === 'ISO22301-2019 1.0.0');
    expect(audited).toEqual([expect.objectContaining({ entity_id: body.taskId, organization_id: tenant.id, actor_kind: 'user' })]);

    const again = await postImport(app, 'ta@ndt', bundle, { key: 'import-0001' });
    expect(again.statusCode).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(body);
    const otherBundle = await postImport(app, 'ta@ndt', devPack('ISO27001-2022').bytes, { key: 'import-0001' });
    expect(otherBundle.statusCode).toBe(409);
    const otherField = await postImport(app, 'ta@ndt', bundle, { key: 'import-0001', extra: { note: 'x' } });
    expect(otherField.statusCode).toBe(400);

    // The same version again changes nothing and queues nothing.
    const same = await postImport(app, 'ta@ndt', bundle);
    expect(same.statusCode).toBe(202);
    expect(same.json()).toMatchObject({ data: { status: 'unchanged' } });
    expect(same.json().taskId).toBeUndefined();
  });

  it('answers 400 for a tampered, unreadable or oversized bundle, 422 for a downgrade and 413 above 50 MiB', async () => {
    const tampered = archiveOf(
      archiveEntries(devPack('ISO27001-2022').bytes).map((e) =>
        e.path === 'catalogue.csv' ? { ...e, data: Buffer.from(e.data!.toString('utf8').replace('Policies', 'Politics')) } : e,
      ),
    );
    const bad = await postImport(app, 'ta@ndt', tampered);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/validation', errors: expect.arrayContaining([expect.objectContaining({ path: 'body.bundle', message: 'catalogue.csv' })]) });
    expect((await postImport(app, 'ta@ndt', Buffer.from('not a pack'))).statusCode).toBe(400);
    // The api checks at most 16 MiB decompressed, off the event loop, before the synchronous verification.
    const bomb = await postImport(app, 'ta@ndt', gzipSync(Buffer.alloc(17 * 1024 * 1024)));
    expect(bomb.statusCode).toBe(400);
    expect(bomb.json().detail).toContain('archive is larger than 16777216 bytes when decompressed');
    const rejected = await auditRows(db, 'pack.rejected');
    expect(rejected.at(-1)).toMatchObject({ organization_id: tenant.id, after_data: { reason: 'archive' } });
    expect(rejected.some((r) => (r.after_data as { reason?: string }).reason === 'checksum')).toBe(true);

    const older = changedPack('ISO27001-2022', (s) => {
      s.manifest.pack_version = '1.0.0';
    });
    const downgrade = await postImport(app, 'ta@ndt', older.bytes);
    expect(downgrade.statusCode).toBe(422);
    expect(downgrade.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/business-rule', messageKey: 'pack.downgrade' });

    const huge = await postImport(app, 'ta@ndt', Buffer.alloc(50 * 1024 * 1024 + 1, 1));
    expect(huge.statusCode).toBe(413);
    const json = await app.app.inject({ method: 'POST', url: '/api/v1/admin/packs/import', headers: as('ta@ndt'), payload: { bundle: 'x' } });
    expect(json.statusCode).toBe(400);
    expect((await postImport(app, 'mm@ndt', devPack('ISO22301-2019').bytes)).statusCode).toBe(403);
    const installs = await sql<{ n: string }>`select count(*) as n from platform.pack_install`.execute(db.migrator);
    expect(Number(installs.rows[0]!.n)).toBe(4);
  });

  it('answers 409 for update checks on the offline channel', async () => {
    const response = await app.app.inject({ method: 'POST', url: '/api/v1/admin/packs/check-updates', headers: as('ta@ndt') });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageKey: 'packs.offline_channel' });
  });

  describe('update checks of the managed and online channels', () => {
    let channel: Server;
    let channelUrl: string;
    let catalogueBody = '';

    beforeAll(async () => {
      channel = createServer((request, response) => {
        if (request.url === '/channel/catalog.json') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(catalogueBody);
        } else {
          response.writeHead(404);
          response.end();
        }
      });
      await new Promise<void>((resolve) => channel.listen(0, '127.0.0.1', resolve));
      channelUrl = `http://127.0.0.1:${(channel.address() as AddressInfo).port}/channel`;
      await inScope(db.packInstaller, { platformScope: true }, async (trx) => {
        await trx
          .insertInto('platform.pack_catalog')
          .values([
            { pack_id: 'ISO27001-2022', pack_version: '1.3.0', channel: 'managed', note_en: 'Titles reviewed', note_id: 'Judul ditinjau', published_at: '2026-09-25' },
            { pack_id: 'ISO22301-2019', pack_version: '1.0.0', channel: 'managed', note_en: 'Installed', note_id: 'Terpasang', published_at: null },
          ])
          .execute();
      });
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => channel.close(() => resolve()));
    });

    it('offers newer versions from platform.pack_catalog on the managed channel and stores nothing', async () => {
      const managed = await createPackApp(db, { identities: orgIdentities(tenant, { ta: (await userOf(db, 'ta.ndt'))!, mm: (await userOf(db, 'mm.ndt'))! }), env: { MSCD__PACKS__CHANNEL: 'managed' } });
      try {
        const response = await managed.app.inject({ method: 'POST', url: '/api/v1/admin/packs/check-updates', headers: as('mm@ndt') });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ok: true,
          changed: [],
          message: ['1 update available', '1 pembaruan tersedia'],
          data: { available: [{ packId: 'ISO27001-2022', version: '1.3.0', note: ['Titles reviewed', 'Judul ditinjau'], publishedAt: '2026-09-25' }] },
        });
      } finally {
        await managed.close();
      }
    });

    it('reads <channel_url>/catalog.json on the online channel, and answers 503 when it cannot', async () => {
      const online = await createPackApp(db, {
        identities: orgIdentities(tenant, { ta: (await userOf(db, 'ta.ndt'))!, mm: (await userOf(db, 'mm.ndt'))! }),
        env: { MSCD__PACKS__CHANNEL: 'online', MSCD__PACKS__CHANNEL_URL: channelUrl },
      });
      try {
        catalogueBody = JSON.stringify({
          packs: [
            { pack_id: 'ISO9001-2026', pack_version: '1.0.0', note_en: 'Published edition', note_id: 'Edisi terbit', published_at: '2026-09-30' },
            { pack_id: 'ISO9001-2015', pack_version: '1.4.2', note_en: 'Same', note_id: 'Sama' },
          ],
        });
        const response = await online.app.inject({ method: 'POST', url: '/api/v1/admin/packs/check-updates', headers: as('ta@ndt') });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.available).toEqual([{ packId: 'ISO9001-2026', version: '1.0.0', note: ['Published edition', 'Edisi terbit'], publishedAt: '2026-09-30' }]);
        catalogueBody = '{"packs": "broken"';
        expect((await online.app.inject({ method: 'POST', url: '/api/v1/admin/packs/check-updates', headers: as('ta@ndt') })).statusCode).toBe(503);
        const rows = await sql<{ n: string }>`select count(*) as n from platform.pack_catalog where channel = 'online'`.execute(db.migrator);
        expect(rows.rows[0]!.n).toBe('0');
      } finally {
        await online.close();
      }
    });
  });
});

async function userOf(db: TestDatabase, handle: string): Promise<string | undefined> {
  const row = await db.migrator.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirst();
  return row?.id;
}

describe('pack import and licence upload with tenancy.mode multi (D-17, D-32)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let app: PackApp;

  beforeAll(async () => {
    tenant = await createTenant(db, 'ndt');
    const ta = await addMember(db, 'ta.ndt', tenant.id, ['tenant_admin']);
    const operator = await inScope(db.migrator, { platformScope: true }, async (trx) => {
      const user = await trx.insertInto('platform.app_user').values({ handle: 'operator', email: 'operator@test.invalid', display_name: 'Operator' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator' }).execute();
      return user.id;
    });
    const identities: Record<string, FakeIdentity> = {
      ta: { user: { id: ta, handle: 'ta-ndt' }, org: infoOf(tenant), orgRoles: ['tenant_admin'] },
      op: { user: { id: operator, handle: 'operator' }, org: null, platformRoles: ['platform_operator'] },
    };
    app = await createPackApp(db, { identities, tenancy: 'multi' });
    await app.runJobs();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('refuses pack import and licence upload to a Tenant Admin (403) and lets the platform operator do both', async () => {
    expect((await postImport(app, 'ta', devPack('ISO22301-2019').bytes)).statusCode).toBe(403);
    const licence = devLicence(tenant.id);
    expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('ta'), payload: licence })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('ta'), payload: { org: 'ndt', licence } })).statusCode).toBe(403);

    const imported = await postImport(app, 'op', devPack('ISO22301-2019').bytes);
    expect(imported.statusCode).toBe(202);
    await app.runJobs();
    const audited = (await auditRows(db, 'pack.installed')).at(-1);
    expect(audited).toMatchObject({ entity_id: imported.json().taskId, organization_id: null, actor_kind: 'operator' });

    expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('op'), payload: licence })).statusCode).toBe(400);
    expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('op'), payload: { org: 'nope', licence } })).statusCode).toBe(404);
    const installed = await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('op'), payload: { org: 'ndt', licence } });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ licenseId: 'LIC-TEST-0001', state: 'valid', signature: { verified: true } });
    const licences = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.licence').select(['organization_id', 'license_id']).execute());
    expect(licences).toEqual([{ organization_id: tenant.id, license_id: 'LIC-TEST-0001' }]);
  });
});

describe('edition lifecycle (packs.lifecycle and edition.withdrawn-alerts, TS 6.3, BR-33)', () => {
  const db = useTestDatabase('empty');
  const tenants: CreatedTenant[] = [];
  const managers: Record<string, string> = {};
  let qmsOf: Record<string, string>;

  beforeAll(async () => {
    await installDevPacks(db, ['ISO9001-2015', 'ISO9001-2026']);
    const v2015 = await db.migrator.selectFrom('ref.framework_version').select('id').where('pack_id', '=', 'ISO9001-2015').executeTakeFirstOrThrow();
    qmsOf = {};
    for (const slug of ['aaa', 'bbb']) {
      const tenant = await createTenant(db, slug);
      tenants.push(tenant);
      managers[slug] = await addMember(db, `mm.${slug}`, tenant.id);
      qmsOf[slug] = await addManagementSystem(db.migrator, tenant, v2015.id, 'qms');
      await grantRole(db, tenant, qmsOf[slug]!, managers[slug]!);
    }
  });

  async function runLifecycle(today: string): Promise<PackApp> {
    const app = await createPackApp(db, {
      identities: { mm: { user: { id: managers.aaa!, handle: 'mm-aaa' }, org: infoOf(tenants[0]!), rolesByMs: { qms: ['ms_manager'] } } },
      env: { MSCD__DEMO__FIXED_TODAY: today },
    });
    await app.queue.send('packs.lifecycle', { orgId: null, payload: {} }, { singletonKey: `pl:${today}` });
    await app.runJobs();
    return app;
  }

  async function alertsOf(tenant: CreatedTenant) {
    return inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, (trx) =>
      trx.selectFrom('ms_alert').select(['kind', 'tone', 'text_en', 'resolved_at']).where('kind', '=', 'withdrawn_edition').execute(),
    );
  }

  async function notificationsOf(tenant: CreatedTenant) {
    return inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, (trx) =>
      trx.selectFrom('notification').select(['recipient_user_id', 'kind', 'title_en']).where('kind', '=', 'edition_withdrawn').execute(),
    );
  }

  it('keeps an edition in transition until transition_ends_at has passed', async () => {
    const app = await runLifecycle('2029-09-15');
    try {
      const version = await db.migrator.selectFrom('ref.framework_version').select('status').where('pack_id', '=', 'ISO9001-2015').executeTakeFirstOrThrow();
      expect(version.status).toBe('transition');
      expect(app.queue.completed('edition.withdrawn-alerts')).toHaveLength(2);
      for (const tenant of tenants) expect(await alertsOf(tenant)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('withdraws it afterwards and marks every system on it critical, once per organisation (BR-33)', async () => {
    for (let run = 0; run < 2; run += 1) {
      const app = await runLifecycle('2029-09-16');
      try {
        expect(app.queue.failed()).toEqual([]);
      } finally {
        await app.close();
      }
    }
    const version = await db.migrator.selectFrom('ref.framework_version').select('status').where('pack_id', '=', 'ISO9001-2015').executeTakeFirstOrThrow();
    expect(version.status).toBe('withdrawn');
    const audited = await auditRows(db, 'pack.edition_withdrawn');
    expect(audited).toEqual([expect.objectContaining({ entity_code: 'ISO9001-2015 1.4.2', organization_id: null, actor_kind: 'system' })]);
    for (const tenant of tenants) {
      const alerts = await alertsOf(tenant);
      expect(alerts).toEqual([
        {
          kind: 'withdrawn_edition',
          tone: 'bad',
          text_en: 'The edition of the standard in use is past its transition period. ISO 9001:2015 is withdrawn; move QMS to the current edition.',
          resolved_at: null,
        },
      ]);
      expect(await notificationsOf(tenant)).toEqual([
        { recipient_user_id: managers[tenant.slug], kind: 'edition_withdrawn', title_en: 'Edition withdrawn: ISO 9001:2015' },
      ]);
    }
  });
});

/** A storage gateway that keeps objects in memory (D.5 `PUT /v1/objects` and `POST /v1/stream`). */
class MemoryGateway implements GatewayClient {
  readonly objects = new Map<string, Buffer>();
  readonly puts: PutHeader[] = [];

  async post<T>(): Promise<T> {
    throw new Error('not used');
  }

  async putObject<T>(header: unknown, body: Readable): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    const put = header as PutHeader;
    this.puts.push(put);
    const id = `tenants/${put.tenant.orgId}/${randomUUID()}`;
    this.objects.set(id, bytes);
    const result: PutResult = {
      externalItemId: id, externalVersionId: null, versionLabel: 'v1', hashAlgorithm: 'sha256', hashValue: createHash('sha256').update(bytes).digest('hex'),
      hashSource: 'computed', sizeBytes: bytes.length, detectedMimeType: 'application/octet-stream', providerCreatedAt: null, folderPath: `/${put.scopeRoot.path}/${put.folderPath}`,
    };
    return result as T;
  }

  async stream(body: unknown): Promise<{ stream: Readable; size: number | null; detectedType: string }> {
    const bytes = this.objects.get((body as { object: { externalItemId: string } }).object.externalItemId);
    if (!bytes) throw new Error('not found');
    return { stream: Readable.from([bytes]), size: bytes.length, detectedType: 'application/octet-stream' };
  }
}

describe('pack import through the Managed Vault (storage gateway client present)', () => {
  const db = useTestDatabase('empty');
  const gateway = new MemoryGateway();
  let tenant: CreatedTenant;
  let app: PackApp;

  beforeAll(async () => {
    tenant = await createTenant(db, 'vlt');
    const ta = await addMember(db, 'ta.vlt', tenant.id, ['tenant_admin']);
    const mm = await addMember(db, 'mm.vlt', tenant.id);
    app = await createPackApp(db, { identities: orgIdentities(tenant, { ta, mm }), metadata: { providers: [{ provide: GATEWAY_CLIENT, useValue: gateway }] } });
    await app.runJobs();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("stores the bundle in the organisation's vault and installs it from there", async () => {
    const response = await postImport(app, 'ta@vlt', devPack('ISO22301-2019').bytes);
    expect(response.statusCode).toBe(202);
    await app.runJobs();
    expect(gateway.puts).toHaveLength(1);
    const key = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', tenant.id).executeTakeFirstOrThrow(),
    );
    expect(gateway.puts[0]).toMatchObject({
      tenant: { orgId: tenant.id, wrappedDek: key.wrapped_dek },
      repository: { id: tenant.vaultRepositoryId, slug: 'vault', adapter: 'managed_vault', modes: ['stored'] },
      fileName: `${response.json().taskId}.pack`,
      maxBytes: 50 * 1024 * 1024,
    });
    const installed = await sql<{ id: string; status: string }>`select id, status from platform.pack_install where pack_id = 'ISO22301-2019'`.execute(db.migrator);
    expect(installed.rows).toEqual([{ id: response.json().taskId, status: 'installed' }]);
    expect(app.queue.failed()).toEqual([]);
  });
});

/** The job queue of a separate worker process (pg-boss or BullMQ, D.4): jobs never run here; it records what is sent. */
class WorkerProcessQueue implements JobQueue {
  readonly sent: string[] = [];

  async send(name: string): Promise<string> {
    this.sent.push(name);
    return randomUUID();
  }

  async schedule(): Promise<void> {}

  async work(): Promise<void> {}

  async stats(): Promise<[]> {
    return [];
  }

  async stop(): Promise<void> {}
}

describe('pack import with the job queue of a separate worker process', () => {
  const db = useTestDatabase('empty');
  const gateway = new MemoryGateway();
  const queue = new WorkerProcessQueue();
  let app: PackApp;

  beforeAll(async () => {
    const tenant = await createTenant(db, 'wrk');
    const ta = await addMember(db, 'ta.wrk', tenant.id, ['tenant_admin']);
    const operator = await inScope(db.migrator, { platformScope: true }, async (trx) => {
      const user = await trx.insertInto('platform.app_user').values({ handle: 'operator', email: 'operator@test.invalid', display_name: 'Operator' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator' }).execute();
      return user.id;
    });
    const identities: Record<string, FakeIdentity> = {
      ta: { user: { id: ta, handle: 'ta-wrk' }, org: infoOf(tenant), orgRoles: ['tenant_admin'] },
      op: { user: { id: operator, handle: 'operator' }, org: null, platformRoles: ['platform_operator'] },
    };
    app = await createPackApp(db, {
      identities,
      tenancy: 'multi',
      metadata: { providers: [{ provide: GATEWAY_CLIENT, useValue: gateway }] },
      overrides: (builder) => builder.overrideProvider(JOB_QUEUE).useValue(queue),
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('refuses an operator import without an organisation (503) instead of keeping a bundle the worker cannot read', async () => {
    const response = await postImport(app, 'op', devPack('ISO22301-2019').bytes, { key: 'operator-import-0001' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/dependency-unavailable', messageKey: 'packs.import_unavailable' });
    expect(response.json().messages.en).toContain('mscd-server packs install');
    expect(queue.sent).toEqual([]);
    expect(gateway.puts).toEqual([]);
    const installs = await sql<{ n: string }>`select count(*) as n from platform.pack_install`.execute(db.migrator);
    expect(installs.rows[0]!.n).toBe('0');
    expect(await auditRows(db, 'pack.rejected')).toEqual([]);
    // The key was never claimed: the same request answers the same way.
    expect((await postImport(app, 'op', devPack('ISO22301-2019').bytes, { key: 'operator-import-0001' })).statusCode).toBe(503);
  });
});
