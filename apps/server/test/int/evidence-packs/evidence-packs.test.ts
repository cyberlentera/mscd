// Evidence packs on the demo data with a real storage gateway, SeaweedFS and the mock providers (build plan E.7,
// D-34, F.13, A-09, A-10, J.7): the ISMS pack lists the sample's non-valid evidence as exceptions and copies the
// rest into the pack folder of the mock SharePoint library, manifests are stored and downloadable, a QMS pack in the
// Managed Vault has an archive, and the read paths follow ScopePolicy (external auditors see ready packs only, open
// pack copies only and never receive a provider URL; Top Management downloads nothing).
import { gunzipSync } from 'node:zlib';
import type { CommandResult, EvidencePackView, ObjectOpenResponse, Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, mockAdmin, signIn, startStorageStack, type FilesClient, type StorageStack } from '../files/helpers';
import { putObject } from '../gateway/helpers';
import { createPackApp, ORG_IDS, type PackApp } from './helpers';

/** The ISMS evidence of the sample whose files are not intact (G.8: changed, revoked OneDrive, missing). */
const ISMS_NOT_VALID = ['EV-0124', 'EV-0271', 'EV-0313'];

/** Entries of an uncompressed tar archive: name and content. */
function untar(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    expect(parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim(), 8)).toBe(sum);
    entries.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('evidence packs (E.7, D-34, F.13)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: PackApp;
  let rina: FilesClient;
  let bagus: FilesClient;
  let hendra: FilesClient;
  let ismsPack: EvidencePackView;

  const pack = async (client: FilesClient, ms: string, id: string) => client.get<EvidencePackView>(`/api/v1/ms/${ms}/evidence-packs/${id}`);

  const requestAndBuild = async (client: FilesClient, org: keyof typeof ORG_IDS, ms: string, body: Record<string, unknown> = {}): Promise<{ result: CommandResult; view: EvidencePackView }> => {
    const answer = await client.post<CommandResult>(`/api/v1/ms/${ms}/evidence-packs`, body);
    expect(answer.status).toBe(202);
    const packId = (answer.body.data as { packId: string }).packId;
    const built = await ctx.build(ORG_IDS[org], packId);
    expect(built.status).toBe('ready');
    const view = await pack(client, ms, packId);
    expect(view.status).toBe(200);
    return { result: answer.body, view: view.body };
  };

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createPackApp(db, { gatewayUrl: stack.gateway.url });
    rina = await signIn(ctx, db, 'rina', 'ndt');
    bagus = await signIn(ctx, db, 'bagus', 'ndt');
    hendra = await signIn(ctx, db, 'hendra', 'ndt');
  });

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('builds the ISMS pack: the non-valid sample evidence are exceptions, the rest is copied into the mock SharePoint pack folder', async () => {
    const { result, view } = await requestAndBuild(rina, 'ndt', 'isms');
    ismsPack = view;
    expect(result.taskId).toBeTruthy();
    expect(result.changed).toEqual(['isms']);
    expect(result.message?.[0]).toMatch(/SharePoint|Compliance/);

    const expected = await inOrg(db, 'ndt', async (trx) => {
      const { rows } = await sql<{ code: string }>`
        select distinct e.evidence_code as code from evidence e
        join evidence_target t on t.evidence_id = e.id and t.deleted_at is null
        join management_system m on m.id = t.management_system_id and m.slug = 'isms'
        where e.deleted_at is null and e.produced_at is not null`.execute(trx);
      return rows.map((r) => r.code).sort();
    });
    expect(view.items.map((i) => i.evidenceCode).sort()).toEqual(expected);
    expect(view.itemCount).toBe(expected.length);
    expect(view.exceptionCount).toBe(ISMS_NOT_VALID.length);
    const exceptions = view.items.filter((i) => i.exceptionReason !== null);
    expect(exceptions.map((i) => i.evidenceCode).sort()).toEqual(ISMS_NOT_VALID);
    expect(exceptions.find((i) => i.evidenceCode === 'EV-0313')).toMatchObject({ linkStatus: 'missing', exceptionReason: 'File missing at the pinned location', copyLocation: null });
    expect(exceptions.find((i) => i.evidenceCode === 'EV-0124')).toMatchObject({ linkStatus: 'version_changed' });
    expect(exceptions.find((i) => i.evidenceCode === 'EV-0271')).toMatchObject({ linkStatus: 'access_denied' });
    expect(view.packFolder).toBe('/Compliance/_packs/ISMS/2026-09-29/');
    expect(view.manifestUrls.csv).toBe(`/api/v1/ms/isms/evidence-packs/${view.id}/download?file=manifest_csv`);
    expect(view.archiveUrl).toBeUndefined();

    // Every copy exists in the mock SharePoint library, in the pack folder, with the bytes of the pinned version.
    const copied = view.items.filter((i) => i.exceptionReason === null);
    expect(copied.length).toBe(expected.length - ISMS_NOT_VALID.length);
    const objects = await inOrg(db, 'ndt', (trx) =>
      trx
        .selectFrom('storage_object')
        .select(['id', 'external_item_id', 'folder_path', 'hash_value'])
        .where(
          'id',
          'in',
          copied.map((i) => i.copyObjectId!),
        )
        .execute(),
    );
    expect(objects).toHaveLength(copied.length);
    for (const object of objects) {
      const item = await mockAdmin<{ folderPath: string; kind: string; name: string }>(stack.mock, `/_admin/items/${encodeURIComponent(object.external_item_id)}`);
      expect(item.kind).toBe('file');
      expect(item.folderPath).toBe('/Compliance/_packs/ISMS/2026-09-29');
      expect(object.folder_path).toBe('/Compliance/_packs/ISMS/2026-09-29');
    }
    const first = copied[0]!;
    expect(first.copyLocation).toMatch(/^\/Compliance\/_packs\/ISMS\/2026-09-29\//);
  });

  it('stores both manifests as storage objects and serves them as attachments (F.13), audited', async () => {
    const stored = await inOrg(db, 'ndt', (trx) =>
      trx.selectFrom('evidence_pack').select(['manifest_csv_object_id', 'manifest_pdf_object_id', 'archive_object_id', 'background_task_id', 'status']).where('id', '=', ismsPack.id).executeTakeFirstOrThrow(),
    );
    expect(stored.status).toBe('ready');
    expect(stored.archive_object_id).toBeNull();
    const manifests = await inOrg(db, 'ndt', (trx) =>
      trx.selectFrom('storage_object').select(['id', 'display_name', 'folder_path', 'hash_algorithm']).where('id', 'in', [stored.manifest_csv_object_id!, stored.manifest_pdf_object_id!]).execute(),
    );
    expect(manifests.map((m) => m.display_name).sort()).toEqual(['manifest.csv', 'manifest.pdf']);
    for (const m of manifests) expect(m.hash_algorithm).toBe('sha256');

    const csv = await rina.get(ismsPack.manifestUrls.csv);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(String(csv.headers['content-disposition'])).toMatch(/^attachment; filename="ISMS-evidence-pack-2026-09-29-manifest.csv"/);
    expect(csv.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const rows = parseCsv(csv.raw.toString('utf8'));
    expect(rows[0]).toEqual(['evidence_code', 'requirement_codes', 'produced_at', 'external_version_id', 'hash_algorithm', 'hash_value', 'link_status', 'copy_location', 'deleted', 'exception_reason']);
    const data = rows.slice(1).filter((r) => r.length > 1);
    expect(data).toHaveLength(ismsPack.itemCount);
    const missing = data.find((r) => r[0] === 'EV-0313')!;
    expect(missing[6]).toBe('missing');
    expect(missing[9]).toBe('File missing at the pinned location');

    const pdf = await rina.get(ismsPack.manifestUrls.pdf);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const task = await inOrg(db, 'ndt', (trx) => trx.selectFrom('background_task').selectAll().where('id', '=', stored.background_task_id!).executeTakeFirstOrThrow());
    expect(task.status).toBe('succeeded');
    expect(task.kind).toBe('evidence_pack');
    const audit = await inOrg(db, 'ndt', async (trx) => {
      const { rows } = await sql<{ action: string; actor_kind: string }>`select action, actor_kind from audit_trail where entity_id = ${ismsPack.id}::uuid order by seq`.execute(trx);
      return rows;
    });
    expect(audit.map((a) => a.action)).toEqual(['evidence_pack.built', 'evidence_pack.downloaded', 'evidence_pack.downloaded']);
    expect(audit[0]!.actor_kind).toBe('system');
    const notified = await inOrg(db, 'ndt', (trx) =>
      trx.selectFrom('notification').select(['kind']).where('kind', '=', 'evidence_pack_ready').where(sql<string>`entity_ref->>'id'`, '=', ismsPack.id).execute(),
    );
    expect(notified).toHaveLength(1);
  });

  it('builds a QMS pack in the Managed Vault with a .tar.gz archive of the copies and both manifests', async () => {
    // The demo seed records vault objects without bytes; put real files for the QMS evidence first.
    const contents = new Map<string, Buffer>();
    await inOrg(db, 'ndt', async (trx) => {
      const tenantKey = await trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', ORG_IDS.ndt).executeTakeFirstOrThrow();
      const vault = await trx.selectFrom('storage_repository').selectAll().where('adapter', '=', 'managed_vault').executeTakeFirstOrThrow();
      const { rows } = await sql<{ code: string; object_id: string; name: string }>`
        select distinct e.evidence_code as code, o.id as object_id, o.display_name as name from evidence e
        join evidence_target t on t.evidence_id = e.id
        join management_system m on m.id = t.management_system_id and m.slug = 'qms'
        join storage_object o on o.id = e.storage_object_id and o.storage_repository_id = ${vault.id}
        where e.deleted_at is null`.execute(trx);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const content = Buffer.from(`QMS evidence ${row.code}\n`.repeat(50), 'utf8');
        contents.set(row.code, content);
        const answer = await putObject(
          stack.gateway.url,
          {
            tenant: { orgId: ORG_IDS.ndt, wrappedDek: tenantKey.wrapped_dek },
            repository: { id: vault.id, slug: vault.slug, adapter: 'managed_vault', modes: vault.modes, config: vault.config },
            scopeRoot: { folderId: null, path: 'QMS' },
            folderPath: 'Evidence',
            fileName: row.name ?? `${row.code}.txt`,
            maxBytes: 1_000_000,
            metadataMinimization: false,
          },
          content,
        );
        expect(answer.status).toBe(200);
        const put = answer.json<{ externalItemId: string; hashValue: string; sizeBytes: number; encryption?: unknown }>();
        await trx
          .updateTable('storage_object')
          .set({ external_item_id: put.externalItemId, hash_algorithm: 'sha256', hash_value: put.hashValue, hash_source: 'computed', size_bytes: String(put.sizeBytes), encryption: put.encryption ? JSON.stringify(put.encryption) : null })
          .where('id', '=', row.object_id)
          .execute();
      }
    });

    const sari = await signIn(ctx, db, 'sari', 'ndt');
    const { view } = await requestAndBuild(sari, 'ndt', 'qms');
    expect(view.archiveUrl).toBe(`/api/v1/ms/qms/evidence-packs/${view.id}/download?file=archive`);
    expect(view.exceptionCount).toBe(0);
    expect(view.packFolder).toBe('/Compliance/_packs/QMS/2026-09-29/');
    const copied = view.items.filter((i) => i.copyObjectId);
    expect(copied.length).toBe(contents.size);

    const archive = await sari.get(view.archiveUrl!);
    expect(archive.status).toBe(200);
    expect(archive.headers['content-type']).toBe('application/octet-stream');
    expect(String(archive.headers['content-disposition'])).toMatch(/^attachment; filename="QMS-evidence-pack-2026-09-29.tar.gz"/);
    const entries = untar(gunzipSync(archive.raw));
    expect(entries.has('manifest.csv')).toBe(true);
    expect(entries.get('manifest.pdf')!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const files = [...entries.keys()].filter((name) => name.startsWith('evidence/'));
    expect(files).toHaveLength(contents.size);
    for (const [code, content] of contents) {
      const name = files.find((f) => f.startsWith(`evidence/${code}-`));
      expect(name, code).toBeTruthy();
      expect(entries.get(name!)!.equals(content)).toBe(true);
    }
  });

  it('a second pack of the same day gets its own folder; a pack can be scoped by clause or code', async () => {
    const { view } = await requestAndBuild(rina, 'ndt', 'isms', { scope: { codes: ['A.8.13'] } });
    expect(view.packFolder).toBe('/Compliance/_packs/ISMS/2026-09-29 (2)/');
    expect(view.items.length).toBeGreaterThan(0);
    for (const item of view.items) expect(item.requirementCodes).toContain('A.8.13');
    const event = await inOrg(db, 'ndt', (trx) =>
      trx
        .selectFrom('audit_event as a')
        .innerJoin('management_system as m', 'm.id', 'a.management_system_id')
        .select(['a.id', 'a.short_label'])
        .where('m.slug', '=', 'isms')
        .orderBy('a.scheduled_at', 'desc')
        .executeTakeFirstOrThrow(),
    );
    const withEvent = await requestAndBuild(rina, 'ndt', 'isms', { auditEventId: event.id, scope: { clauses: ['5'] } });
    expect(withEvent.view.auditEventId).toBe(event.id);
    expect(withEvent.view.packFolder).toContain(`/_packs/ISMS/`);
    expect(withEvent.view.items.every((i) => i.requirementCodes.some((c) => c === '5' || c.startsWith('5.') || c.startsWith('A.5.')))).toBe(true);
    const unknown = await rina.post('/api/v1/ms/isms/evidence-packs', { auditEventId: '00000000-0000-4000-8000-000000000999' });
    expect(unknown.status).toBe(404);
  });

  it('permissions: a Domain Owner cannot build; Top Management reads packs but downloads nothing', async () => {
    expect((await bagus.post('/api/v1/ms/isms/evidence-packs', {})).status).toBe(403);
    const list = await hendra.get<Page<EvidencePackView>>('/api/v1/ms/isms/evidence-packs');
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect((await hendra.get(ismsPack.manifestUrls.csv)).status).toBe(403);
    expect((await bagus.get(ismsPack.manifestUrls.csv)).status).toBe(403);
    // A Domain Owner sees only the items of their own evidence.
    const own = await pack(bagus, 'isms', ismsPack.id);
    expect(own.status).toBe(200);
    const bagusId = await inOrg(db, 'ndt', async (trx) => (await trx.selectFrom('platform.app_user').select('id').where('handle', '=', 'bagus').executeTakeFirstOrThrow()).id);
    const owned = await inOrg(db, 'ndt', async (trx) =>
      (await trx.selectFrom('evidence').select('evidence_code').where('owner_user_id', '=', bagusId).execute()).map((r) => r.evidence_code),
    );
    for (const item of own.body.items) expect(owned).toContain(item.evidenceCode);
  });

  it('external auditors (guest of tst): ready packs only, pack copies only, never a provider URL', async () => {
    const tstRina = await signIn(ctx, db, 'rina', 'tst');
    const { view } = await requestAndBuild(tstRina, 'tst', 'isms');
    // A queued pack that the auditor must not see.
    const queued = await tstRina.post<CommandResult>('/api/v1/ms/isms/evidence-packs', {});
    expect(queued.status).toBe(202);
    const queuedId = (queued.body.data as { packId: string }).packId;

    const auditor = await signIn(ctx, db, 'ext.auditor', 'tst');
    const list = await auditor.get<Page<EvidencePackView>>('/api/v1/ms/isms/evidence-packs');
    expect(list.status).toBe(200);
    expect(list.body.items.map((p) => p.id)).toEqual([view.id]);
    expect((await auditor.get(`/api/v1/ms/isms/evidence-packs/${queuedId}`)).status).toBe(404);
    const one = await pack(auditor, 'isms', view.id);
    expect(one.status).toBe(200);
    const csv = await auditor.get(view.manifestUrls.csv);
    expect(csv.status).toBe(200);
    for (const body of [list.raw, one.raw, csv.raw]) {
      const text = body.toString('utf8');
      expect(text).not.toMatch(/web_?url/i);
      expect(text).not.toMatch(/sharepoint\.com/i);
    }

    // A pack copy opens; the original evidence file and a manifest object do not.
    const copy = one.body.items.find((i) => i.copyObjectId)!;
    const opened = await auditor.get<ObjectOpenResponse>(`/api/v1/storage/objects/${copy.copyObjectId}/open?ms=isms`);
    expect(opened.status).toBe(200);
    expect(opened.raw.toString('utf8')).not.toMatch(/sharepoint\.com/i);
    const original = await inOrg(db, 'tst', (trx) =>
      trx.selectFrom('evidence').select('storage_object_id').where('evidence_code', '=', copy.evidenceCode).where('deleted_at', 'is', null).executeTakeFirstOrThrow(),
    );
    expect((await auditor.get(`/api/v1/storage/objects/${original.storage_object_id}/open?ms=isms`)).status).toBe(404);
    const manifest = await inOrg(db, 'tst', (trx) => trx.selectFrom('evidence_pack').select('manifest_csv_object_id').where('id', '=', view.id).executeTakeFirstOrThrow());
    expect((await auditor.get(`/api/v1/storage/objects/${manifest.manifest_csv_object_id}/content?ms=isms`)).status).toBe(404);

    // The guest cannot write, and every read is logged as auditor.read.
    expect((await auditor.post('/api/v1/ms/isms/evidence-packs', {})).status).toBe(403);
    const reads = await inOrg(db, 'tst', async (trx) => {
      const { rows } = await sql<{ after_data: { routeId?: string } | null }>`select after_data from audit_trail where action = 'auditor.read' order by seq`.execute(trx);
      return rows.map((r) => r.after_data?.routeId);
    });
    expect(reads).toEqual(expect.arrayContaining(['evidence-packs.list', 'evidence-packs.get', 'evidence-packs.download']));
  });

  it('an unknown pack is 404, a pack of another system is 404, a pack that is not ready is 409 for downloads', async () => {
    expect((await rina.get('/api/v1/ms/isms/evidence-packs/00000000-0000-4000-8000-000000000999')).status).toBe(404);
    expect((await rina.get(`/api/v1/ms/qms/evidence-packs/${ismsPack.id}`)).status).toBe(404);
    const queued = await rina.post<CommandResult>('/api/v1/ms/isms/evidence-packs', {});
    const queuedId = (queued.body.data as { packId: string }).packId;
    expect((await rina.get(`/api/v1/ms/isms/evidence-packs/${queuedId}/download?file=manifest_csv`)).status).toBe(409);
    expect((await rina.get(`${ismsPack.manifestUrls.csv.replace('manifest_csv', 'archive')}`)).status).toBe(404);
  });
});
