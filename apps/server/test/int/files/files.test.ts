// File commands against the demo data with a real storage gateway, SeaweedFS and the mock providers (build plan
// D.3, D.5, D-28, D-34, F.7, F.13, BR-23, BR-29, BR-30, BR-35, BR-36, J.4, J.7): browse and link from the mock
// SharePoint (quickXorHash, intact), Managed Vault uploads with the SHA-256 of the file, relink after `missing`,
// BR-29 for the revoked Google repository, the system root of a shared library, pass-through and zero-transit
// uploads, document versions in review, safe file responses, open and redirect, external auditors and Top
// Management, and command parity with the sample data source.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PickerListing, UploadIntent, UploadResult, type CommandResult, type ObjectOpenResponse, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { addUser } from '../db/helpers';
import {
  createFilesApp,
  inOrg,
  mockAdmin,
  signIn,
  startStorageStack,
  userId,
  type FilesApp,
  type FilesClient,
  type StorageStack,
} from './helpers';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const WEB_SAMPLE_SOURCE = path.resolve(__dirname, '../../../../web/src/data/SampleDataSource.js');

interface EvidenceFacts {
  id: string;
  code: string;
  objectId: string | null;
  fileSequence: number;
}

describe('file commands (D.3, D.5, F.13)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: FilesApp;
  let rina: FilesClient;
  let bagus: FilesClient;
  let hendra: FilesClient;
  let tono: FilesClient;

  /** An evidence record of a system, by repository and owner. */
  const evidenceOf = async (org: 'ndt' | 'tst', ms: string, filter: { repo?: string; owner?: string; status?: string } = {}): Promise<EvidenceFacts> => {
    const rows = await inOrg(db, org, async (trx) => {
      const { rows } = await sql<{ id: string; code: string; object_id: string | null; file_sequence: number }>`
        select e.id, e.evidence_code as code, e.storage_object_id as object_id, e.file_sequence
          from evidence e
          join entity_ms_link l on l.entity_type = 'evidence' and l.entity_id = e.id and l.deleted_at is null
          join management_system m on m.id = l.management_system_id and m.slug = ${ms}
          left join storage_object o on o.id = e.storage_object_id
          left join storage_repository r on r.id = o.storage_repository_id
          left join platform.app_user u on u.id = e.owner_user_id
         where e.deleted_at is null
           ${filter.repo ? sql`and r.slug = ${filter.repo}` : sql``}
           ${filter.owner ? sql`and u.handle = ${filter.owner}` : sql``}
           ${filter.status ? sql`and o.link_status = ${filter.status}` : sql``}
         order by e.evidence_code`.execute(trx);
      return rows;
    });
    const row = rows[0];
    if (!row) throw new Error(`No evidence in ${org}/${ms} for ${JSON.stringify(filter)}`);
    return { id: row.id, code: row.code, objectId: row.object_id, fileSequence: row.file_sequence };
  };
  const objectRow = (org: 'ndt' | 'tst', id: string) =>
    inOrg(db, org, (trx) => trx.selectFrom('storage_object').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const evidenceRow = (org: 'ndt' | 'tst', id: string) =>
    inOrg(db, org, (trx) => trx.selectFrom('evidence').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const evOfSnapshot = async (client: FilesClient, ms: string, code: string) => {
    const snapshot = await client.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
    expect(snapshot.status).toBe(200);
    return snapshot.body.bundle.evs.find((e) => e.code === code)!;
  };
  const routeTo = (org: 'ndt' | 'tst', ms: string, repo: string, mode: string, objectKind: 'evidence' | 'document') =>
    inOrg(db, org, async (trx) => {
      const system = await trx.selectFrom('management_system').select('id').where('slug', '=', ms).executeTakeFirstOrThrow();
      const repository = await trx.selectFrom('storage_repository').select('id').where('slug', '=', repo).where('deleted_at', 'is', null).executeTakeFirstOrThrow();
      await trx
        .updateTable('storage_routing_rule')
        .set({ deleted_at: new Date() })
        .where('management_system_id', '=', system.id)
        .where('object_kind', '=', objectKind)
        .where('classification', 'is', null)
        .where('deleted_at', 'is', null)
        .execute();
      await trx
        .insertInto('storage_routing_rule')
        .values({ management_system_id: system.id, object_kind: objectKind, storage_repository_id: repository.id, mode: mode as 'stored', priority: 1 })
        .execute();
    });
  const uploadToVault = async (client: FilesClient, ms: string, recordId: string, fileName: string, content: Buffer, kind: 'evidence' | 'document' = 'evidence') => {
    const intent = await client.post<UploadIntent>('/api/v1/storage/upload-intents', { ms, kind, recordId, fileName, size: content.length });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const put = await client.put<UploadResult>(intent.body.contentUrl!, content);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    return { intent: UploadIntent.parse(intent.body), result: UploadResult.parse(put.body) };
  };

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createFilesApp(db, stack.gateway.url);
    rina = await signIn(ctx, db, 'rina', 'ndt');
    bagus = await signIn(ctx, db, 'bagus', 'ndt');
    hendra = await signIn(ctx, db, 'hendra', 'ndt');
    tono = await signIn(ctx, db, 'tono', 'ndt');
  });

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  describe('link from the mock SharePoint', () => {
    it('lists the files of the system folder and links one with its quickXorHash; the link is intact', async () => {
      const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'bagus', status: 'intact' });
      const listing = await bagus.get<PickerListing>(`/api/v1/storage/repositories/sp/browse?ms=isms&kind=evidence&recordId=${evidence.id}&path=Evidence/2026/Q3`);
      expect(listing.status, JSON.stringify(listing.body)).toBe(200);
      const parsed = PickerListing.parse(listing.body);
      expect(parsed.path).toBe('Compliance / ISMS / Evidence / 2026 / Q3');
      const index = parsed.files.findIndex((f) => f[0] === 'Backup-Job-Log-Sep-2026.xlsx');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(parsed.files[index]![3]).toBe('quickXorHash');
      expect(parsed.refs[index]).toMatchObject({ repositoryId: 'sp', externalItemId: 'demo-sp-pick-1' });

      const linked = await bagus.post<CommandResult>(`/api/v1/ms/isms/evidence/${evidence.id}/files`, {
        source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-1', producedAt: '2026-09-28', mode: 'submit',
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      expect(linked.body.changed).toContain('isms');
      expect(linked.body.ref).toMatchObject({ entityType: 'evidence', id: evidence.id, code: evidence.code });
      // BR-36: the file was created on 20 Sep, the evidence says 28 Sep.
      expect(linked.body.warnings?.map((w) => w.rule)).toEqual(['BR-36']);

      const row = await evidenceRow('ndt', evidence.id);
      expect(row.produced_at).toBe('2026-09-28');
      expect(row.file_sequence).toBe(evidence.fileSequence + 1);
      expect(row.integrity_status).toBe('ok');
      const object = await objectRow('ndt', row.storage_object_id!);
      expect(object).toMatchObject({
        external_item_id: 'demo-sp-pick-1', external_version_id: '3.0', version_label: 'v3.0', hash_algorithm: 'quickxor', hash_source: 'provider', link_status: 'intact',
      });
      expect(object.hash_value).toMatch(/^[A-Za-z0-9+/]{27}=$/);
      const ev = await evOfSnapshot(rina, 'isms', evidence.code);
      expect(ev).toMatchObject({ prod: '2026-09-28', integ: 'ok', ver: 'v3.0', hashAlg: 'quickXorHash', loc: 'sp' });

      const audit = await inOrg(db, 'ndt', (trx) =>
        trx.selectFrom('audit_trail').select(['action', 'after_data']).where('entity_id', '=', evidence.id).orderBy('seq', 'desc').executeTakeFirstOrThrow(),
      );
      expect(audit.action).toBe('evidence.file_linked');
      expect(audit.after_data).toMatchObject({ source: 'link', repository: 'sp', versionLabel: 'v3.0' });
      const stats = await ctx.jobs.stats();
      expect(stats.find((s) => s.name === 'freshness.recompute')?.waiting ?? 0).toBeGreaterThan(0);
    });

    it('relinks a missing file, and refuses a relink of an intact one', async () => {
      const missing = await evidenceOf('ndt', 'isms', { repo: 'sp', status: 'missing' });
      const before = await evidenceRow('ndt', missing.id);
      const relinked = await rina.post<CommandResult>(`/api/v1/ms/isms/evidence/${missing.id}/files`, {
        source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-2', producedAt: '2026-09-26', mode: 'relink',
      });
      expect(relinked.status, JSON.stringify(relinked.body)).toBe(200);
      const after = await evidenceRow('ndt', missing.id);
      expect(after.storage_object_id).not.toBe(before.storage_object_id);
      expect(after.file_sequence).toBe(Math.max(before.file_sequence, 1));
      expect((await objectRow('ndt', after.storage_object_id!)).link_status).toBe('intact');
      expect((await evOfSnapshot(rina, 'isms', missing.code)).integ).toBe('ok');

      const again = await rina.post(`/api/v1/ms/isms/evidence/${missing.id}/files`, {
        source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-3', mode: 'relink',
      });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ messageKey: 'files.relink_not_needed' });
    });

    it('answers 422 for an item outside the system folder and 404 for an unknown item', async () => {
      const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'rina' });
      await mockAdmin(stack.mock, '/_admin/items', {
        driveId: 'drive-sp-compliance', id: 'demo-sp-qms-manual', path: 'Compliance/QMS', name: 'Quality-Manual.docx', content: 'quality manual',
        createdBy: { displayName: 'Sari Wulandari', email: 'sari.wulandari@nusantaradigital.co.id' },
      });
      const outside = await rina.post(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-qms-manual', mode: 'submit' });
      expect(outside.status).toBe(422);
      expect(outside.body).toMatchObject({ messageKey: 'files.outside_root' });
      const unknown = await rina.post(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-nothing', mode: 'submit' });
      expect(unknown.status).toBe(404);
    });
  });

  describe('Managed Vault uploads', () => {
    it('stores the SHA-256 of the file and labels the vault version v<file_sequence>', async () => {
      const evidence = await evidenceOf('ndt', 'qms', { repo: 'vault', owner: 'sari' });
      const sari = await signIn(ctx, db, 'sari', 'ndt');
      const { intent, result } = await uploadToVault(sari, 'qms', evidence.id, 'Supplier evaluation Q3.pdf', PDF);
      expect(intent).toMatchObject({ mode: 'stored', repository: { slug: 'vault', adapter: 'managed_vault' }, maxBytes: PDF.length });
      expect(intent.correlationCode).toMatch(/^MSCD-[A-Z0-9-]+-[0-9A-F]{8}$/);
      expect(result.hashAlgorithm).toBe('sha256');
      expect(result.hashValue).toBe(sha256(PDF));
      expect(result.sizeBytes).toBe(PDF.length);

      const attached = await sari.post<CommandResult>(`/api/v1/ms/qms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: intent.intentId, mode: 'submit' });
      expect(attached.status, JSON.stringify(attached.body)).toBe(200);
      const row = await evidenceRow('ndt', evidence.id);
      expect(row.produced_at).toBe('2026-09-29');
      expect(row.file_sequence).toBe(evidence.fileSequence + 1);
      const object = await objectRow('ndt', row.storage_object_id!);
      expect(object).toMatchObject({
        hash_algorithm: 'sha256', hash_source: 'computed', hash_value: sha256(PDF), mime_type: 'application/pdf', version_label: `v${evidence.fileSequence + 1}`,
      });
      expect((await evOfSnapshot(sari, 'qms', evidence.code)).ver).toBe(`v${evidence.fileSequence + 1}`);

      // The upload is attached once; the same intent cannot be used again.
      const twice = await sari.post(`/api/v1/ms/qms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: intent.intentId, mode: 'submit' });
      expect(twice.status).toBe(409);

      const opened = await sari.get<ObjectOpenResponse>(`/api/v1/storage/objects/${object.id}/open?ms=qms`);
      expect(opened.status).toBe(200);
      expect(opened.body.url).toBe(`/api/v1/storage/objects/${object.id}/content?ms=qms`);
      const content = await sari.get(opened.body.url);
      expect(content.status).toBe(200);
      expect(sha256(content.raw)).toBe(sha256(PDF));
      expect(content.headers['content-type']).toBe('application/pdf');
      expect(String(content.headers['content-disposition'])).toMatch(/^attachment; filename="Supplier evaluation Q3\.pdf"/);
      const inline = await sari.get(`${opened.body.url}&inline=true`);
      expect(String(inline.headers['content-disposition'])).toMatch(/^inline; /);
      const actions = await inOrg(db, 'ndt', (trx) =>
        trx.selectFrom('audit_trail').select('action').where('entity_id', '=', object.id).orderBy('seq').execute(),
      );
      expect(actions.map((a) => a.action)).toEqual(['file.opened', 'file.downloaded', 'file.downloaded']);
    });

    it('serves text/html and image/svg+xml uploads as octet-stream attachments with the sandbox CSP', async () => {
      const evidence = await evidenceOf('ndt', 'qms', { repo: 'vault', owner: 'sari' });
      const sari = await signIn(ctx, db, 'sari', 'ndt');
      for (const [name, content] of [
        ['report.html', Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')],
        ['diagram.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4"/></svg>')],
      ] as const) {
        const { intent, result } = await uploadToVault(sari, 'qms', evidence.id, name, content);
        const attached = await sari.post(`/api/v1/ms/qms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: intent.intentId, mode: 'submit' });
        expect(attached.status).toBe(200);
        expect((await objectRow('ndt', result.storageObjectId)).mime_type).toBe('application/octet-stream');
        const read = await sari.get(`/api/v1/storage/objects/${result.storageObjectId}/content?ms=qms&inline=true`);
        expect(read.status).toBe(200);
        expect(read.headers['content-type']).toBe('application/octet-stream');
        expect(String(read.headers['content-disposition'])).toMatch(/^attachment; /);
        expect(read.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
        expect(read.headers['x-content-type-options']).toBe('nosniff');
        expect(read.raw.equals(content)).toBe(true);
      }
    });

    it('checks the intent: creator only, size limit, open status, and the record of the intent', async () => {
      const evidence = await evidenceOf('ndt', 'qms', { repo: 'vault', owner: 'sari' });
      const sari = await signIn(ctx, db, 'sari', 'ndt');
      const intent = await sari.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'evidence', recordId: evidence.id, fileName: 'x.pdf', size: 10 });
      expect(intent.status).toBe(201);
      expect((await rina.put(intent.body.contentUrl!, PDF.subarray(0, 10))).status).toBe(404);
      expect((await sari.put(intent.body.contentUrl!, PDF)).status).toBe(413);
      const tooBig = await sari.post('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'evidence', recordId: evidence.id, fileName: 'x.pdf', size: 104857601 });
      expect(tooBig.status).toBe(413);
      // Another system's record is not found through this system (RecordResolver).
      const foreign = await evidenceOf('ndt', 'isms', { repo: 'sp' });
      expect((await rina.post('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'evidence', recordId: foreign.id, fileName: 'x.pdf', size: 10 })).status).toBe(404);
      // An upload intent of another record cannot be attached here.
      const other = await evidenceOf('ndt', 'qms', { repo: 'vault' });
      const otherCode = (await inOrg(db, 'ndt', (trx) => trx.selectFrom('evidence').select('evidence_code').where('id', '!=', other.id).where('evidence_code', 'like', 'EQ-%').orderBy('evidence_code').executeTakeFirstOrThrow())).evidence_code;
      const otherId = (await inOrg(db, 'ndt', (trx) => trx.selectFrom('evidence').select('id').where('evidence_code', '=', otherCode).executeTakeFirstOrThrow())).id;
      const done = await uploadToVault(rina, 'qms', other.id, 'y.pdf', PDF);
      const mismatch = await rina.post(`/api/v1/ms/qms/evidence/${otherId}/files`, { source: 'upload', uploadIntentId: done.intent.intentId, mode: 'submit' });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body).toMatchObject({ messageKey: 'files.intent_mismatch' });
      // A finished intent takes no second upload.
      expect((await rina.put(done.intent.contentUrl!, PDF)).status).toBe(409);
    });

    it('names stored files by code and sequence under metadata minimisation and keeps no original name', async () => {
      await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_repository').set({ metadata_minimization: true }).where('slug', '=', 'vault').execute());
      try {
        const evidence = await evidenceOf('ndt', 'qms', { repo: 'vault', owner: 'sari' });
        const sari = await signIn(ctx, db, 'sari', 'ndt');
        const row = await evidenceRow('ndt', evidence.id);
        const { intent } = await uploadToVault(sari, 'qms', evidence.id, 'Confidential supplier list.xlsx', PDF);
        const stored = await inOrg(db, 'ndt', (trx) => trx.selectFrom('upload_intent').select(['stored_name', 'original_name']).where('id', '=', intent.intentId).executeTakeFirstOrThrow());
        expect(stored).toEqual({ stored_name: `${evidence.code}-${row.file_sequence + 1}.xlsx`, original_name: null });
      } finally {
        await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_repository').set({ metadata_minimization: false }).where('slug', '=', 'vault').execute());
      }
    });
  });

  describe('BR-29 and the system root', () => {
    it('refuses the revoked Google repository with BR-29 (browse and link)', async () => {
      const evidence = await evidenceOf('ndt', 'bcms', { repo: 'gd', owner: 'tono' });
      const browse = await tono.get(`/api/v1/storage/repositories/gd/browse?ms=bcms&kind=evidence&recordId=${evidence.id}`);
      expect(browse.status).toBe(422);
      expect(browse.body).toMatchObject({ rule: 'BR-29', messages: { en: expect.stringContaining('Google') } });
      const link = await tono.post(`/api/v1/ms/bcms/evidence/${evidence.id}/files`, { source: 'link', repository: 'gd', externalItemId: 'demo-gd-pick-3', mode: 'submit' });
      expect(link.status).toBe(422);
      expect(link.body).toMatchObject({ rule: 'BR-29' });
    });

    it('refuses an adapter the installation does not enable (BR-29)', async () => {
      const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'rina' });
      const limited = await createFilesApp(db, stack.gateway.url, { MSCD__STORAGE__ADAPTERS__ENABLED: '[managed_vault]' });
      try {
        const client = await signIn(limited, db, 'rina', 'ndt');
        const link = await client.post(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-4', mode: 'submit' });
        expect(link.status).toBe(422);
        expect(link.body).toMatchObject({ rule: 'BR-29' });
      } finally {
        await limited.close();
      }
    });

    it('keeps an ISMS-only Domain Owner out of the QMS files of the same library', async () => {
      const ownerId = await addUser(db.migrator, 'isms.only', ['00000000-0000-4000-8000-00000000a001']);
      const evidenceId = await inOrg(db, 'ndt', async (trx) => {
        const isms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow();
        await trx.insertInto('user_ms_role').values({ user_id: ownerId, management_system_id: isms.id, role: 'domain_owner' }).execute();
        const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'andi' });
        await trx.updateTable('evidence').set({ owner_user_id: ownerId }).where('id', '=', evidence.id).execute();
        return evidence.id;
      });
      const owner = await signIn(ctx, db, 'isms.only', 'ndt');
      const qmsEvidence = await evidenceOf('ndt', 'qms', { repo: 'vault' });
      expect((await owner.get(`/api/v1/storage/repositories/sp/browse?ms=qms&kind=evidence&recordId=${qmsEvidence.id}`)).status).toBe(403);
      const listing = await owner.get<PickerListing>(`/api/v1/storage/repositories/sp/browse?ms=isms&kind=evidence&recordId=${evidenceId}`);
      expect(listing.status, JSON.stringify(listing.body)).toBe(200);
      expect(listing.body.path).toBe('Compliance / ISMS');
      expect(listing.body.refs.map((r) => r.externalItemId)).not.toContain('demo-sp-qms-manual');
      const traverse = await owner.get(`/api/v1/storage/repositories/sp/browse?ms=isms&kind=evidence&recordId=${evidenceId}&path=..%2FQMS`);
      expect([400, 422]).toContain(traverse.status);
      const link = await owner.post(`/api/v1/ms/isms/evidence/${evidenceId}/files`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-qms-manual', mode: 'submit' });
      expect(link.status).toBe(422);
      expect(link.body).toMatchObject({ messageKey: 'files.outside_root' });
      // Own grants: the evidence of someone else is closed to this owner.
      const notOwn = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'rina' });
      expect((await owner.get(`/api/v1/storage/repositories/sp/browse?ms=isms&kind=evidence&recordId=${notOwn.id}`)).status).toBe(403);
      expect((await owner.post(`/api/v1/ms/isms/evidence/${notOwn.id}/files`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-5', mode: 'submit' })).status).toBe(403);
    });

    it('warns with BR-30 for a personal repository', async () => {
      await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_repository').set({ ownership_type: 'personal' }).where('slug', '=', 'sp').execute());
      try {
        const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'rina' });
        const linked = await rina.post<CommandResult>(`/api/v1/ms/isms/evidence/${evidence.id}/files`, {
          source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-4', producedAt: '2026-09-22', mode: 'submit',
        });
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);
        expect(linked.body.warnings?.map((w) => w.rule)).toEqual(['BR-30']);
      } finally {
        await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_repository').set({ ownership_type: 'organizational' }).where('slug', '=', 'sp').execute());
      }
    });
  });

  describe('pass-through, zero-transit and document versions', () => {
    it('streams a pass-through upload to SharePoint and creates a document version in review', async () => {
      await routeTo('ndt', 'isms', 'sp', 'pass_through', 'document');
      const document = await inOrg(db, 'ndt', (trx) =>
        trx.selectFrom('document').select(['id', 'doc_code', 'status']).where('doc_code', '=', 'PRC-08').executeTakeFirstOrThrow(),
      );
      const intent = await rina.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'isms', kind: 'document', recordId: document.id, fileName: 'PRC-08 Change management.pdf', size: PDF.length });
      expect(intent.status, JSON.stringify(intent.body)).toBe(201);
      expect(intent.body).toMatchObject({ mode: 'pass_through', repository: { slug: 'sp', adapter: 'm365' }, folderPath: 'Compliance/ISMS/Documents' });
      const put = await rina.put<UploadResult>(intent.body.contentUrl!, PDF);
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body).toMatchObject({ hashAlgorithm: 'sha256', hashValue: sha256(PDF), sizeBytes: PDF.length, versionLabel: 'v1.0' });

      const version = await rina.post<CommandResult>(`/api/v1/ms/isms/documents/${document.id}/versions`, { source: 'upload', uploadIntentId: intent.body.intentId });
      expect(version.status, JSON.stringify(version.body)).toBe(200);
      expect(version.body.changed).toContain('isms');
      const stored = await inOrg(db, 'ndt', (trx) =>
        trx.selectFrom('document_version').select(['version_label', 'status', 'storage_object_id']).where('document_id', '=', document.id).where('status', '=', 'in_review').executeTakeFirstOrThrow(),
      );
      expect(stored.version_label).toBe('1.0');
      const doc = await inOrg(db, 'ndt', (trx) => trx.selectFrom('document').select('status').where('id', '=', document.id).executeTakeFirstOrThrow());
      expect(doc.status).toBe('in_review');
      const object = await objectRow('ndt', stored.storage_object_id);
      expect(object).toMatchObject({ hash_source: 'computed', hash_value: sha256(PDF), mime_type: 'application/pdf' });

      // A pass-through file streams through the api.
      const opened = await rina.get<ObjectOpenResponse>(`/api/v1/storage/objects/${object.id}/open?ms=isms`);
      expect(opened.body.url).toContain('/content?ms=isms');
      const content = await rina.get(opened.body.url);
      expect(content.status).toBe(200);
      expect(content.raw.equals(PDF)).toBe(true);

      const second = await rina.post(`/api/v1/ms/isms/documents/${document.id}/versions`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-PRC-08' });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ messageKey: 'files.version_in_review' });
    });

    it('registers a zero-transit upload only for the creator, the folder and the correlation code', async () => {
      await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_repository').set({ modes: ['link', 'pass_through', 'zero_transit'] }).where('slug', '=', 'sp').execute());
      await routeTo('ndt', 'isms', 'sp', 'zero_transit', 'evidence');
      const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'bagus', status: 'intact' });
      const intent = await bagus.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'isms', kind: 'evidence', recordId: evidence.id, fileName: 'Firewall review.pdf', size: 2048 });
      expect(intent.status, JSON.stringify(intent.body)).toBe(201);
      expect(intent.body.mode).toBe('zero_transit');
      expect(intent.body.contentUrl).toBeUndefined();
      expect(intent.body.folderPath).toBe('Compliance/ISMS/Evidence/2026/Q3');
      // Not the creator of the item.
      await mockAdmin(stack.mock, '/_admin/items', {
        driveId: 'drive-sp-compliance', id: 'zt-foreign', path: intent.body.folderPath, name: `Review ${intent.body.correlationCode}.pdf`, content: 'review',
        createdBy: { displayName: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id' },
      });
      const foreign = await bagus.post(`/api/v1/storage/upload-intents/${intent.body.intentId}/complete`, { externalItemId: 'zt-foreign' });
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
      // Without the correlation code.
      await mockAdmin(stack.mock, '/_admin/items', {
        driveId: 'drive-sp-compliance', id: 'zt-nocode', path: intent.body.folderPath, name: 'Review.pdf', content: 'review',
        createdBy: { displayName: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id' },
      });
      expect((await bagus.post(`/api/v1/storage/upload-intents/${intent.body.intentId}/complete`, { externalItemId: 'zt-nocode' })).status).toBe(422);
      // The browser's own upload.
      await mockAdmin(stack.mock, '/_admin/items', {
        driveId: 'drive-sp-compliance', id: 'zt-good', path: intent.body.folderPath, name: `Firewall review ${intent.body.correlationCode}.pdf`, content: 'firewall review',
        createdBy: { displayName: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id' },
      });
      expect((await rina.post(`/api/v1/storage/upload-intents/${intent.body.intentId}/complete`, { externalItemId: 'zt-good' })).status).toBe(404);
      const done = await bagus.post<UploadResult>(`/api/v1/storage/upload-intents/${intent.body.intentId}/complete`, { externalItemId: 'zt-good' });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.hashAlgorithm).toBe('quickxor');
      // A zero-transit intent cannot be attached as a server upload, only as a client upload.
      expect((await bagus.post(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: intent.body.intentId, mode: 'submit' })).status).toBe(409);
      const attached = await bagus.post<CommandResult>(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'client_upload', uploadIntentId: intent.body.intentId, mode: 'submit' });
      expect(attached.status, JSON.stringify(attached.body)).toBe(200);
      // BR-35: a zero-transit file opens in the repository, never as an in-app preview.
      const objectId = done.body.storageObjectId;
      const preview = await bagus.get(`/api/v1/storage/objects/${objectId}/content?ms=isms&inline=true`);
      expect(preview.status).toBe(422);
      expect(preview.body).toMatchObject({ rule: 'BR-35' });
      const opened = await bagus.get<ObjectOpenResponse>(`/api/v1/storage/objects/${objectId}/open?ms=isms`);
      expect(opened.body.url).toContain('/redirect?t=');
    });
  });

  describe('open, redirect and readers', () => {
    it('redirects to the provider after checking the token, the user and the permission again', async () => {
      const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'rina', status: 'intact' });
      const opened = await rina.get<ObjectOpenResponse>(`/api/v1/storage/objects/${evidence.objectId}/open?ms=isms`);
      expect(opened.status).toBe(200);
      expect(opened.body.url).toMatch(new RegExp(`^/api/v1/storage/objects/${evidence.objectId}/redirect\\?t=[A-Za-z0-9_.-]+$`));
      expect(new Date(opened.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
      const redirect = await rina.get(opened.body.url);
      expect(redirect.status).toBe(302);
      expect(String(redirect.headers.location)).toMatch(/^https?:\/\//);
      // The token belongs to Rina and to this object.
      expect((await bagus.get(opened.body.url)).status).toBe(403);
      const token = opened.body.url.split('t=')[1]!;
      const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
      expect((await rina.get(`/api/v1/storage/objects/${evidence.objectId}/redirect?t=${tampered}`)).status).toBe(403);
      const other = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'bagus', status: 'intact' });
      expect((await rina.get(`/api/v1/storage/objects/${other.objectId}/redirect?t=${token}`)).status).toBe(403);
      // A linked file is not proxied (BR-35 message: it opens in the repository).
      const content = await rina.get(`/api/v1/storage/objects/${evidence.objectId}/content?ms=isms`);
      expect(content.status).toBe(422);
      expect(content.body).toMatchObject({ rule: 'BR-35' });
    });

    it('scopes objects: owners see their own, Top Management gets 403, other systems 404', async () => {
      const own = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'bagus', status: 'intact' });
      const notOwn = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'rina', status: 'intact' });
      expect((await bagus.get(`/api/v1/storage/objects/${own.objectId}/open?ms=isms`)).status).toBe(200);
      expect((await bagus.get(`/api/v1/storage/objects/${notOwn.objectId}/open?ms=isms`)).status).toBe(404);
      expect((await hendra.get(`/api/v1/storage/objects/${own.objectId}/open?ms=isms`)).status).toBe(403);
      expect((await hendra.get(`/api/v1/storage/objects/${own.objectId}/content?ms=isms`)).status).toBe(403);
      // The object belongs to an ISMS record: through QMS it is not found.
      expect((await rina.get(`/api/v1/storage/objects/${own.objectId}/open?ms=qms`)).status).toBe(404);
    });

    it('gives external auditors pack copies only, through the api, and never a provider URL', async () => {
      const tstRina = await signIn(ctx, db, 'rina', 'tst');
      const auditor = await signIn(ctx, db, 'ext.auditor', 'tst');
      const evidence = await evidenceOf('tst', 'isms', {});
      const attached = await uploadToVault(tstRina, 'isms', evidence.id, 'access review.pdf', PDF);
      // An upload that stays unattached stands in for the pack copy made by copy-within (E.7).
      const copy = await uploadToVault(tstRina, 'isms', evidence.id, 'access review copy.pdf', PDF);
      await tstRina.post(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: attached.intent.intentId, mode: 'submit' });
      await inOrg(db, 'tst', async (trx) => {
        const isms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow();
        const pack = await trx.insertInto('evidence_pack').values({ management_system_id: isms.id, status: 'ready' }).returning('id').executeTakeFirstOrThrow();
        await trx
          .insertInto('evidence_pack_item')
          .values({ evidence_pack_id: pack.id, evidence_id: evidence.id, evidence_code: evidence.code, requirement_codes: ['A.5.15'], copy_storage_object_id: copy.result.storageObjectId })
          .execute();
      });
      // The evidence's own file is not a pack copy: 404.
      expect((await auditor.get(`/api/v1/storage/objects/${attached.result.storageObjectId}/open?ms=isms`)).status).toBe(404);
      expect((await auditor.get(`/api/v1/storage/objects/${attached.result.storageObjectId}/content?ms=isms`)).status).toBe(404);
      const opened = await auditor.get<ObjectOpenResponse>(`/api/v1/storage/objects/${copy.result.storageObjectId}/open?ms=isms`);
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      expect(opened.body.url).toContain('/content?ms=isms');
      const content = await auditor.get(opened.body.url);
      expect(content.status).toBe(200);
      expect(content.raw.equals(PDF)).toBe(true);
      // A redirect token issued to someone else never works for the auditor, and the auditor gets no redirect.
      const linked = await evidenceOf('tst', 'isms', { repo: 'sp' }).catch(() => null);
      if (linked?.objectId) {
        const rinaOpen = await tstRina.get<ObjectOpenResponse>(`/api/v1/storage/objects/${linked.objectId}/open?ms=isms`);
        if (rinaOpen.body.url.includes('/redirect?')) expect((await auditor.get(rinaOpen.body.url)).status).toBe(403);
        expect((await auditor.get(`/api/v1/storage/objects/${linked.objectId}/open?ms=isms`)).status).toBe(404);
      }
      // Every auditor read is logged with the record behind the file (F.7, BR-20).
      const reads = await inOrg(db, 'tst', (trx) =>
        trx.selectFrom('audit_trail').select(['action', 'after_data']).where('action', '=', 'auditor.read').orderBy('seq', 'desc').limit(1).execute(),
      );
      expect(JSON.stringify(reads[0]?.after_data)).toContain(evidence.code);
      // Writes stay closed to auditors.
      expect((await auditor.post('/api/v1/storage/upload-intents', { ms: 'isms', kind: 'evidence', recordId: evidence.id, fileName: 'x.pdf', size: 1 })).status).toBe(403);
    });
  });

  describe('command parity with the sample data source (J.4)', () => {
    interface SampleSource {
      load(org?: string): Promise<{ bundles: Record<string, { evs: { code: string }[]; chain: { items: { key: string }[] } }> }>;
      reload<T>(snapshot: T, ms: string[]): Promise<T>;
      linkFile(key: string, file: { src: string; index: number }): Promise<{ ok: boolean }>;
      uploadFile(key: string, file: null): Promise<{ ok: boolean }>;
    }
    const sampleSource = async (): Promise<SampleSource> => {
      const module = (await import(WEB_SAMPLE_SOURCE)) as { createSampleDataSource(options: { org: string; persona: string }): SampleSource };
      return module.createSampleDataSource({ org: 'ndt', persona: 'manager' });
    };
    const FIELDS = ['code', 'prod', 'integ', 'ver', 'hashAlg', 'loc', 'fresh', 'next'] as const;
    const pick = (row: Record<string, unknown>) => Object.fromEntries(FIELDS.map((f) => [f, row[f]]));

    it('linkFile: the evidence row and its chain item match the sample', async () => {
      const parity = await createFilesApp(db, stack.gateway.url);
      try {
        const client = await signIn(parity, db, 'rina', 'ndt');
        const evidence = await evidenceOf('ndt', 'isms', { repo: 'sp', owner: 'dewi', status: 'intact' });
        const sample = await sampleSource();
        const before = await sample.load('ndt');
        expect((await sample.linkFile(`isms:ev:${evidence.code}`, { src: 'sp', index: 0 })).ok).toBe(true);
        const after = await sample.reload(before, ['isms']);
        const sampleRow = after.bundles.isms!.evs.find((e) => e.code === evidence.code)! as unknown as Record<string, unknown>;

        const linked = await client.post(`/api/v1/ms/isms/evidence/${evidence.id}/files`, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-pick-1', mode: 'submit' });
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);
        const snapshot = (await client.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
        const apiRow = snapshot.bundle.evs.find((e) => e.code === evidence.code)! as unknown as Record<string, unknown>;
        expect(pick(apiRow)).toEqual(pick(sampleRow));
        const key = `isms:ev:${evidence.code}`;
        const sampleItem = after.bundles.isms!.chain.items.find((i) => i.key === key);
        const apiItem = snapshot.bundle.chain.items.find((i) => i.key === key);
        expect(Boolean(apiItem)).toBe(Boolean(sampleItem));
      } finally {
        await parity.close();
      }
    });

    it('uploadFile to the Managed Vault: the next version with SHA-256 matches the sample (documented difference: none)', async () => {
      const sari = await signIn(ctx, db, 'sari', 'ndt');
      const evidence = await evidenceOf('ndt', 'qms', { repo: 'vault', owner: 'lina' });
      const sample = await sampleSource();
      const before = await sample.load('ndt');
      expect((await sample.uploadFile(`qms:ev:${evidence.code}`, null)).ok).toBe(true);
      const after = await sample.reload(before, ['qms']);
      const sampleRow = after.bundles.qms!.evs.find((e) => e.code === evidence.code)! as unknown as Record<string, unknown>;

      const { intent } = await uploadToVault(sari, 'qms', evidence.id, 'evidence.pdf', PDF);
      const attached = await sari.post(`/api/v1/ms/qms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: intent.intentId, mode: 'submit' });
      expect(attached.status, JSON.stringify(attached.body)).toBe(200);
      const apiRow = (await evOfSnapshot(sari, 'qms', evidence.code)) as unknown as Record<string, unknown>;
      expect(pick(apiRow)).toEqual(pick(sampleRow));
    });

    it('document upload differs as A.4 5.7 decides: the sample approves, the API puts the version in review', async () => {
      await routeTo('ndt', 'qms', 'vault', 'stored', 'document');
      const sari = await signIn(ctx, db, 'sari', 'ndt');
      const document = await inOrg(db, 'ndt', async (trx) => {
        const { rows } = await sql<{ id: string; doc_code: string }>`
          select d.id, d.doc_code from document d
            join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.is_primary and l.deleted_at is null
            join management_system m on m.id = l.management_system_id and m.slug = 'qms'
           where d.deleted_at is null and d.status = 'approved'
             and not exists (select 1 from document_version v where v.document_id = d.id and v.status = 'in_review')
           order by d.doc_code limit 1`.execute(trx);
        return rows[0]!;
      });
      const sample = await sampleSource();
      const before = await sample.load('ndt');
      await sample.uploadFile(`qms:doc:${document.doc_code}`, null);
      const after = (await sample.reload(before, ['qms'])) as unknown as { bundles: { qms: { docs: { id: string; ver: string; st: string }[] } } };
      const sampleDoc = after.bundles.qms.docs.find((d) => d.id === document.doc_code)!;
      expect(sampleDoc.st).toBe('approved');

      const { intent } = await uploadToVault(sari, 'qms', document.id, 'manual.pdf', PDF, 'document');
      const created = await sari.post<CommandResult>(`/api/v1/ms/qms/documents/${document.id}/versions`, { source: 'upload', uploadIntentId: intent.intentId });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const versionLabel = (created.body.data as { versionLabel: string }).versionLabel;
      expect(versionLabel).toBe(sampleDoc.ver);
      const snapshot = (await sari.get<UiMsSnapshot>('/api/v1/ui/ms/qms')).body;
      expect(snapshot.bundle.docs.find((d) => d.id === document.doc_code)!.st).toBe('review');
    });
  });

  it('keeps the audit chain verifiable after the file commands', async () => {
    const { rows } = await inOrg(db, 'ndt', (trx) =>
      sql<{ n: string }>`select count(*)::text as n from audit_trail where action in ('evidence.file_linked', 'evidence.file_uploaded', 'document.version_created', 'file.opened', 'file.downloaded')`.execute(trx),
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(5);
    expect(await userId(db, 'rina')).toBe(rina.userId);
  });
});
