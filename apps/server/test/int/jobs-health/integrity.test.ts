// `integrity.rehash` (build plan E.2, A-08) on a copy of the demo template (organisation ndt) with the storage
// gateway on a SeaweedFS vault (A.3): stored content that still hashes the same is recorded as re-hashed and keeps its
// status; content changed in the object store gives `hash_mismatch` (audit, history row, evidence integrity broken
// after the recompute) and the daily link check keeps that finding; objects re-hashed within 7 days are not due;
// seeded objects without stored bytes keep their status.
import { Readable } from 'node:stream';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { PutResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_CLIENT, type GatewayClient } from '../../../src/common/tokens';
import { TenantJobRunner } from '../../../src/modules/jobs/tenant-job';
import { StorageGatewayContext } from '../../../src/modules/storage';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { VAULT_BUCKET, startSeaweed, type Seaweed } from '../gateway/helpers';
import { NOON, ORG_IDS, allStatuses, createHealthApp, objectState, repositoryId, rows, startProviderStack, type HealthApp, type ProviderStack } from './helpers';

const NDT = ORG_IDS.ndt;
const DAY = 24 * 3_600_000;

describe('integrity.rehash (A-08)', () => {
  const db = useTestDatabase('demo');
  let seaweed: Seaweed;
  let stack: ProviderStack;
  let ctx: HealthApp;
  const stored: { id: string; key: string; evidenceId: string }[] = [];

  const rehashRows = (objectId: string) =>
    rows<{ outcome: string; status_after: string; matches: string | null }>(
      db,
      'ndt',
      sql`SELECT outcome, status_after, detail->>'matches' AS matches FROM link_health_result
          WHERE storage_object_id = ${objectId}::uuid AND detail->>'check' = 'rehash' ORDER BY checked_at, id`,
    );
  const rehash = () => ctx.run('integrity.rehash', { orgId: NDT, payload: {} });

  /** Uploads `content` through the gateway into the ndt vault and points a QMS evidence record at it. */
  async function upload(name: string, content: string, evidenceCode: string): Promise<void> {
    const org = (await ctx.moduleRef.get(TenantResolver).resolveById(NDT))!;
    const gatewayContext = ctx.moduleRef.get(StorageGatewayContext);
    const { tenant, repository } = await ctx.moduleRef.get(TenantJobRunner).run(org, async (trx) => ({
      tenant: await gatewayContext.tenant(trx, NDT),
      repository: await gatewayContext.repository(trx, await gatewayContext.repositoryBySlug(trx, 'vault'), { withCredential: false }),
    }));
    const header = { tenant, repository, scopeRoot: { folderId: null, path: 'QMS' }, folderPath: 'Evidence/2026/Q3', fileName: name, maxBytes: 1_000_000, metadataMinimization: false };
    const result = await ctx.moduleRef.get<GatewayClient>(GATEWAY_CLIENT).putObject<PutResult>(header, Readable.from(Buffer.from(content)));
    const [object] = await rows<{ id: string }>(
      db,
      'ndt',
      sql`INSERT INTO storage_object (organization_id, storage_repository_id, external_item_id, external_version_id, version_label, display_name,
            mime_type, size_bytes, hash_algorithm, hash_value, hash_source, folder_path, link_status, link_status_since, last_verified_at, last_good_check_at)
          VALUES (${NDT}::uuid, ${await repositoryId(db, 'ndt', 'vault')}::uuid, ${result.externalItemId}, ${result.externalVersionId}, ${result.versionLabel}, ${name},
            ${result.detectedMimeType}, ${result.sizeBytes}, 'sha256', ${result.hashValue}, 'computed', ${result.folderPath}, 'intact', ${new Date(NOON)},
            ${new Date(NOON)}, ${new Date(NOON)})
          RETURNING id`,
    );
    const [evidence] = await rows<{ id: string }>(
      db,
      'ndt',
      sql`UPDATE evidence SET storage_object_id = ${object!.id}::uuid WHERE evidence_code = ${evidenceCode} AND deleted_at IS NULL RETURNING id`,
    );
    stored.push({ id: object!.id, key: result.externalItemId, evidenceId: evidence!.id });
  }

  beforeAll(async () => {
    seaweed = await startSeaweed();
    stack = await startProviderStack({ vaultEndpoint: seaweed.endpoint });
    ctx = await createHealthApp(db, stack);
    const codes = await rows<{ code: string }>(
      db,
      'ndt',
      sql`SELECT e.evidence_code AS code FROM evidence e JOIN storage_object o ON o.id = e.storage_object_id
          JOIN storage_repository r ON r.id = o.storage_repository_id WHERE r.slug = 'vault' AND e.deleted_at IS NULL ORDER BY e.evidence_code LIMIT 2`,
    );
    await upload('supplier-review.txt', 'supplier review, Q3 2026, approved', codes[0]!.code);
    await upload('calibration-log.txt', 'calibration log, September 2026', codes[1]!.code);
  }, 180_000);
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
    await seaweed?.stop();
  });

  it('records matching content as re-hashed and leaves every status as it is', async () => {
    const before = await allStatuses(db, 'ndt');
    await rehash();
    expect(ctx.queue.failed()).toEqual([]);
    for (const object of stored) expect(await rehashRows(object.id)).toEqual([{ outcome: 'found', status_after: 'intact', matches: 'true' }]);
    // The seeded vault objects have no stored bytes in this vault: not found, status kept, tried again next week.
    const [seededRow] = await rows<{ outcome: string; status_before: string; status_after: string }>(
      db,
      'ndt',
      sql`SELECT h.outcome, h.status_before, h.status_after FROM link_health_result h JOIN storage_object o ON o.id = h.storage_object_id
          WHERE h.detail->>'check' = 'rehash' AND NOT (o.id = ANY(${stored.map((s) => s.id)}::uuid[])) LIMIT 1`,
    );
    expect(seededRow).toEqual({ outcome: 'not_found', status_before: 'intact', status_after: 'intact' });
    expect(await allStatuses(db, 'ndt')).toEqual(before);
  });

  it('re-hashes an object only after 7 days', async () => {
    const count = (await rows(db, 'ndt', sql`SELECT 1 FROM link_health_result WHERE detail->>'check' = 'rehash'`)).length;
    await rehash();
    expect(await rows(db, 'ndt', sql`SELECT 1 FROM link_health_result WHERE detail->>'check' = 'rehash'`)).toHaveLength(count);
    await rows(db, 'ndt', sql`UPDATE link_health_result SET checked_at = ${new Date(new Date(NOON).getTime() - 8 * DAY)} WHERE storage_object_id = ${stored[0]!.id}::uuid`);
    await rehash();
    expect(await rehashRows(stored[0]!.id)).toHaveLength(2);
    expect(await rehashRows(stored[1]!.id)).toHaveLength(1);
  });

  it('content changed in the object store gives hash_mismatch, which the daily link check keeps', async () => {
    const target = stored[1]!;
    await seaweed.s3.send(new PutObjectCommand({ Bucket: VAULT_BUCKET, Key: target.key, Body: Buffer.from('tampered content that is not the encrypted original') }));
    await rows(db, 'ndt', sql`UPDATE link_health_result SET checked_at = ${new Date(new Date(NOON).getTime() - 8 * DAY)} WHERE storage_object_id = ${target.id}::uuid`);
    await rehash();
    expect((await objectState(db, 'ndt', target.id)).link_status).toBe('hash_mismatch');
    expect((await rehashRows(target.id)).at(-1)).toEqual({ outcome: 'found', status_after: 'hash_mismatch', matches: 'false' });
    const audit = await rows<{ action: string; actor_kind: string; after_data: { source: string } }>(
      db,
      'ndt',
      sql`SELECT action, actor_kind, after_data FROM audit_trail WHERE entity_id = ${target.id}::uuid`,
    );
    expect(audit).toEqual([{ action: 'link_status.changed', actor_kind: 'system', after_data: expect.objectContaining({ linkStatus: 'hash_mismatch', source: 'integrity.rehash' }) }]);
    // The re-hash queued freshness.recompute: the evidence is no longer valid.
    const [evidence] = await rows<{ integrity_status: string }>(db, 'ndt', sql`SELECT integrity_status FROM evidence WHERE id = ${target.evidenceId}::uuid`);
    expect(evidence!.integrity_status).toBe('broken');
    // The link check finds the object (same key, no versions in the vault) and keeps the finding.
    await ctx.run('link-health.check', { orgId: NDT, payload: { repositoryId: await repositoryId(db, 'ndt', 'vault'), storageObjectIds: [target.id] } });
    expect((await objectState(db, 'ndt', target.id)).link_status).toBe('hash_mismatch');
    // A broken object is no longer re-hashed.
    await rows(db, 'ndt', sql`UPDATE link_health_result SET checked_at = ${new Date(new Date(NOON).getTime() - 8 * DAY)} WHERE storage_object_id = ${target.id}::uuid`);
    const before = (await rehashRows(target.id)).length;
    await rehash();
    expect(await rehashRows(target.id)).toHaveLength(before);
    expect(ctx.queue.failed()).toEqual([]);
  });
});
