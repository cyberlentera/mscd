// File serving and provider calls of the full api application (build plan J.5 "HTTP", F.13, TS 5.3):
// - `text/html` and `image/svg+xml` evidence uploaded to the Managed Vault comes back as
//   `application/octet-stream`, `Content-Disposition: attachment` and `Content-Security-Policy: default-src 'none'; sandbox`,
//   also when the request asks for inline display;
// - linking a Google Drive item pins its revision (`/v1/pin-version`) while no transaction holds a lock on the
//   evidence row, and a failed pin answers BR-29 with nothing recorded (WP-30 follow-up on WP-21).
import type { CommandResult, ObjectMetadata, UploadIntent, UploadResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GATEWAY_CLIENT, type GatewayClient } from '../../../src/common/tokens';
import { GatewayProblemError } from '../../../src/modules/storage/gateway-client';
import { useTestDatabase } from '../../setup/test-db';
import { createFullApp, demoSession, inOrg, rowsIn, type Client, type FullApp } from '../contract/harness';
import { startStorageStack, type StorageStack } from '../files/helpers';

describe('J.5 file responses and provider calls', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let full: FullApp;

  beforeAll(async () => {
    stack = await startStorageStack();
    full = await createFullApp(db, { MSCD__STORAGE__GATEWAY__URL: stack.gateway.url });
  });

  afterAll(async () => {
    await full?.close();
    await stack?.close();
  });

  it('serves text/html and image/svg+xml vault uploads as octet-stream attachments with the sandbox CSP', async () => {
    const [evidence] = await rowsIn<{ id: string }>(db, 'ndt', sql`select e.id from evidence e
      join entity_ms_link l on l.entity_type = 'evidence' and l.entity_id = e.id and l.deleted_at is null
      join management_system m on m.id = l.management_system_id and m.slug = 'qms'
      join storage_object o on o.id = e.storage_object_id join storage_repository r on r.id = o.storage_repository_id and r.slug = 'vault'
      join platform.app_user u on u.id = e.owner_user_id and u.handle = 'sari'
      where e.deleted_at is null order by e.evidence_code limit 1`);
    const sari = await demoSession(full, db, 'sari', 'ndt');
    for (const [name, content] of [
      ['report.html', Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')],
      ['diagram.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4"/></svg>')],
    ] as const) {
      const intent = await sari.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'evidence', recordId: evidence!.id, fileName: name, size: content.length });
      expect(intent.status, intent.text).toBe(201);
      const put = await sari.request<UploadResult>('PUT', intent.body.contentUrl!, { body: content, headers: { 'content-type': 'application/octet-stream' } });
      expect(put.status, put.text).toBe(200);
      const attached = await sari.post<CommandResult>(`/api/v1/ms/qms/evidence/${evidence!.id}/files`, { source: 'upload', uploadIntentId: intent.body.intentId, mode: 'submit' });
      expect(attached.status, attached.text).toBe(200);
      for (const url of [`/api/v1/storage/objects/${put.body.storageObjectId}/content?ms=qms`, `/api/v1/storage/objects/${put.body.storageObjectId}/content?ms=qms&inline=true`]) {
        const read = await sari.get(url);
        expect(read.status).toBe(200);
        expect(read.headers['content-type']).toBe('application/octet-stream');
        expect(String(read.headers['content-disposition'])).toMatch(/^attachment; filename="/);
        expect(read.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
        expect(read.headers['x-content-type-options']).toBe('nosniff');
        expect(read.headers['cache-control']).toBe('no-store');
        expect(read.raw.rawPayload.equals(content)).toBe(true);
      }
    }
  });

  describe('Google Drive version pins', () => {
    let manager: Client;
    let evidenceId: string;
    let gateway: GatewayClient;
    let original: GatewayClient['post'];

    const metadata = (id: string): ObjectMetadata => ({
      externalItemId: id, externalVersionId: 'rev-7', versionLabel: 'rev-7', name: 'BIA-2026.pdf', mimeType: 'application/pdf',
      sizeBytes: 1024, hashAlgorithm: 'md5', hashValue: '0123456789abcdef0123456789abcdef', hashSource: 'provider',
      providerCreatedAt: '2026-09-01T02:00:00Z', providerModifiedAt: '2026-09-02T02:00:00Z', modifiedBy: 'Tono Hartono',
      createdByEmail: 'tono.hartono@nusantaradigital.co.id', folderPath: 'Compliance BCMS/Evidence', folderId: 'demo-gd-compliance-bcms', webUrl: null,
    });
    const evidenceRow = () =>
      inOrg(db, 'ndt', (trx) => trx.selectFrom('evidence').select(['file_sequence', 'storage_object_id']).where('id', '=', evidenceId).executeTakeFirstOrThrow());

    beforeAll(async () => {
      // The demo Google repository is revoked (G.8); the gateway answers of this suite are stubbed, so it is usable.
      await rowsIn(db, 'ndt', sql`update storage_repository set connection_status = 'ok', read_only = false where slug = 'gd'`);
      const [mm] = await rowsIn<{ handle: string }>(db, 'ndt', sql`select u.handle from user_ms_role r join platform.app_user u on u.id = r.user_id
        join management_system m on m.id = r.management_system_id and m.slug = 'bcms'
        where r.role = 'ms_manager' and r.approval_status = 'active' and r.deleted_at is null limit 1`);
      manager = await demoSession(full, db, mm!.handle, 'ndt');
      const [evidence] = await rowsIn<{ id: string }>(db, 'ndt', sql`select e.id from evidence e
        join entity_ms_link l on l.entity_type = 'evidence' and l.entity_id = e.id and l.deleted_at is null
        join management_system m on m.id = l.management_system_id and m.slug = 'bcms'
        where e.deleted_at is null order by e.evidence_code limit 1`);
      evidenceId = evidence!.id;
      gateway = full.get<GatewayClient>(GATEWAY_CLIENT);
      original = gateway.post.bind(gateway);
    });

    afterAll(() => {
      vi.restoreAllMocks();
    });

    /** Stubs `/v1/link` and `/v1/pin-version`; `onPin` runs while the api waits for the pin. */
    const stubGateway = (onPin: () => Promise<unknown>) => {
      const calls: string[] = [];
      vi.spyOn(gateway, 'post').mockImplementation(async <T,>(path: string, body: unknown, options?: Parameters<GatewayClient['post']>[2]) => {
        calls.push(path);
        if (path === '/v1/link') return metadata((body as { externalItemId: string }).externalItemId) as T;
        if (path === '/v1/pin-version') return (await onPin()) as T;
        return original<T>(path, body, options);
      });
      return calls;
    };

    it('pins the linked revision while no lock is held on the evidence row', async () => {
      let lockFree: boolean | null = null;
      const calls = stubGateway(async () => {
        // Another connection must be able to lock the record at once: the api holds no FOR UPDATE across the call.
        lockFree = await inOrg(db, 'ndt', async (trx) => {
          try {
            await sql`set local lock_timeout = '200ms'`.execute(trx);
            await sql`select id from evidence where id = ${evidenceId} for update nowait`.execute(trx);
            return true;
          } catch {
            return false;
          }
        });
        return { result: 'ok' };
      });
      const before = await evidenceRow();
      const linked = await manager.post<CommandResult>(`/api/v1/ms/bcms/evidence/${evidenceId}/files`, { source: 'link', repository: 'gd', externalItemId: 'gd-bia-2026', mode: 'submit' });
      expect(linked.status, linked.text).toBe(200);
      expect(calls).toContain('/v1/pin-version');
      expect(calls.indexOf('/v1/link')).toBeLessThan(calls.indexOf('/v1/pin-version'));
      expect(lockFree).toBe(true);
      const after = await evidenceRow();
      expect(after.file_sequence).toBe(before.file_sequence + 1);
      expect(after.storage_object_id).not.toBe(before.storage_object_id);
      vi.restoreAllMocks();
    });

    it('answers BR-29 and records nothing when the pin fails', async () => {
      stubGateway(async () => {
        throw new GatewayProblemError('unreachable', 503, 'Google Drive did not answer', undefined, undefined);
      });
      const before = await evidenceRow();
      const objects = async () => (await rowsIn<{ n: number }>(db, 'ndt', sql`select count(*)::int as n from storage_object where external_item_id = 'gd-bia-2027'`))[0]!.n;
      const failed = await manager.post(`/api/v1/ms/bcms/evidence/${evidenceId}/files`, { source: 'link', repository: 'gd', externalItemId: 'gd-bia-2027', mode: 'submit' });
      expect(failed.status, failed.text).toBe(422);
      expect(failed.body).toMatchObject({ rule: 'BR-29' });
      expect(await evidenceRow()).toEqual(before);
      expect(await objects()).toBe(0);
      vi.restoreAllMocks();
    });
  });
});
