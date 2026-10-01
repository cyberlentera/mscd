// Stores a link health observation of one storage object (E.4): the new status with `link_status_since`, a
// `link_health_result` row and the audit entry `link_status.changed` on a change, BR-32 `evidence_anomaly` to the
// evidence owner and `document_new_version` to the document owner when a newer provider version appears. Shared by
// `link-health.check` and `integrity.rehash` (A-08).
import { Inject, Injectable } from '@nestjs/common';
import type { LinkCheckOutcome, LinkStatus } from '@mscd/shared';
import { sql } from 'kysely';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import type { LinkReason } from './link-status';

/** The columns of `storage_object` the link health jobs read. */
export interface LinkObjectRow {
  id: string;
  storage_repository_id: string;
  external_item_id: string;
  external_version_id: string | null;
  display_name: string | null;
  hash_algorithm: 'sha256' | 'sha1' | 'md5' | 'quickxor' | 'none';
  hash_value: string | null;
  hash_source: 'computed' | 'provider' | 'none';
  folder_path: string | null;
  link_status: LinkStatus;
  link_status_since: Date;
  link_status_reason: LinkReason;
}

export const LINK_OBJECT_COLUMNS = [
  'id',
  'storage_repository_id',
  'external_item_id',
  'external_version_id',
  'display_name',
  'hash_algorithm',
  'hash_value',
  'hash_source',
  'folder_path',
  'link_status',
  'link_status_since',
  'link_status_reason',
] as const;

export interface Observation {
  outcome: LinkCheckOutcome;
  status: LinkStatus;
  reason: LinkReason;
  /** The provider answered, so the check counts as verified (false for errors). */
  verified: boolean;
  /** The provider returned the item (`last_good_check_at`). */
  found: boolean;
  /** A new folder path to store (the item is elsewhere), else null. */
  folderPath: string | null;
  observedVersionId?: string | null;
  observedHash?: string | null;
  observedFolderPath?: string | null;
  detail?: Record<string, unknown> | null;
  /** Writes a `link_health_result` row even when the status stays (the weekly re-hash keeps its history). */
  alwaysRecord?: boolean;
  /** The instant of the check (`windowNow`, so demo windows agree with the fixed date). */
  at: Date;
  jobId: string | null;
  /** Where the observation comes from, for the audit entry (`link-health.check`, `integrity.rehash`). */
  source: string;
}

export interface AppliedObservation {
  changed: boolean;
  /** Status or reason changed: the freshness and integrity of the evidence must be derived again. */
  affectsValidity: boolean;
  /** Systems of the evidence that references the object. */
  msIds: string[];
  evidenceIds: string[];
}

function uuids(ids: readonly string[]) {
  return sql`${[...ids]}::uuid[]`;
}

@Injectable()
export class LinkStatusWriter {
  constructor(
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async apply(trx: Trx, object: LinkObjectRow, observation: Observation): Promise<AppliedObservation> {
    const changed = observation.status !== object.link_status;
    const affectsValidity = changed || observation.reason !== object.link_status_reason;
    const set: Record<string, unknown> = { updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID };
    if (changed) {
      set.link_status = observation.status;
      set.link_status_since = observation.at;
    }
    if (observation.reason !== object.link_status_reason) set.link_status_reason = observation.reason;
    if (observation.verified) set.last_verified_at = observation.at;
    if (observation.found) set.last_good_check_at = observation.at;
    if (observation.folderPath !== null) set.folder_path = observation.folderPath;
    await trx.updateTable('storage_object').set(set).where('id', '=', object.id).execute();

    const evidence = await trx
      .selectFrom('evidence as e')
      .leftJoin('evidence_target as t', (join) => join.onRef('t.evidence_id', '=', 'e.id').on('t.deleted_at', 'is', null))
      .select(['e.id', 'e.evidence_code', 'e.title', 'e.owner_user_id', sql<string[]>`coalesce(array_agg(distinct t.management_system_id) filter (where t.management_system_id is not null), '{}')`.as('ms_ids')])
      .where('e.storage_object_id', '=', object.id)
      .where('e.deleted_at', 'is', null)
      .groupBy(['e.id', 'e.evidence_code', 'e.title', 'e.owner_user_id'])
      .execute();
    const msIds = [...new Set(evidence.flatMap((e) => e.ms_ids))].sort();

    if (changed || observation.alwaysRecord) {
      await trx
        .insertInto('link_health_result')
        .values({
          storage_object_id: object.id,
          checked_at: observation.at,
          outcome: observation.outcome,
          status_before: object.link_status,
          status_after: observation.status,
          observed_version_id: observation.observedVersionId ?? null,
          observed_hash: observation.observedHash ?? null,
          observed_folder_path: observation.observedFolderPath ?? null,
          detail: observation.detail ? JSON.stringify(observation.detail) : null,
          job_id: observation.jobId,
        })
        .execute();
    }
    if (!changed) return { changed, affectsValidity, msIds, evidenceIds: evidence.map((e) => e.id) };

    await this.audit.record(trx, {
      action: 'link_status.changed',
      actor: { userId: SYSTEM_USER_ID, kind: 'system' },
      msId: msIds[0] ?? null,
      entityType: 'storage_object',
      entityId: object.id,
      entityCode: (object.display_name ?? object.external_item_id).slice(0, 80),
      before: { linkStatus: object.link_status, linkStatusReason: object.link_status_reason },
      after: { linkStatus: observation.status, linkStatusReason: observation.reason, outcome: observation.outcome, source: observation.source },
    });

    if (observation.status === 'version_changed') {
      for (const e of evidence) {
        if (!e.owner_user_id) continue;
        await this.notifications.create(trx, {
          recipientUserId: e.owner_user_id,
          kind: 'evidence_anomaly',
          msId: e.ms_ids[0] ?? null,
          digest: true,
          createdBy: SYSTEM_USER_ID,
          title: { en: `New file version for evidence ${e.evidence_code}`, id: `Versi berkas baru untuk bukti ${e.evidence_code}` },
          body: {
            en: `The file of ${e.evidence_code} ${e.title} has a newer version than the one linked as evidence. The evidence stays valid; review the new version and link it if it should replace the evidence (BR-32).`,
            id: `Berkas ${e.evidence_code} ${e.title} memiliki versi yang lebih baru daripada yang ditautkan sebagai bukti. Bukti tetap berlaku; tinjau versi baru dan tautkan bila harus menggantikan bukti (BR-32).`,
          },
          ref: { module: 'implementation', entityType: 'evidence', id: e.id, code: e.evidence_code },
        });
      }
      const documents = await trx
        .selectFrom('document_version as v')
        .innerJoin('document as d', 'd.id', 'v.document_id')
        .select(['d.id', 'd.doc_code', 'd.title', 'd.owner_user_id', 'v.version_label'])
        .where('v.storage_object_id', '=', object.id)
        .where('v.deleted_at', 'is', null)
        .where('d.deleted_at', 'is', null)
        .execute();
      for (const d of documents) {
        if (!d.owner_user_id) continue;
        const linked = await trx
          .selectFrom('entity_ms_link')
          .select('management_system_id')
          .where('entity_type', '=', 'document')
          .where('entity_id', '=', d.id)
          .where('deleted_at', 'is', null)
          .orderBy('is_primary', 'desc')
          .limit(1)
          .executeTakeFirst();
        await this.notifications.create(trx, {
          recipientUserId: d.owner_user_id,
          kind: 'document_new_version',
          msId: linked?.management_system_id ?? null,
          digest: true,
          createdBy: SYSTEM_USER_ID,
          title: { en: `New version available for ${d.doc_code}`, id: `Versi baru tersedia untuk ${d.doc_code}` },
          body: {
            en: `The file of ${d.doc_code} ${d.title} (${d.version_label}) has a newer version in the repository. Register it as a new document version if it should be reviewed.`,
            id: `Berkas ${d.doc_code} ${d.title} (${d.version_label}) memiliki versi lebih baru di repositori. Daftarkan sebagai versi dokumen baru bila perlu ditinjau.`,
          },
          ref: { module: 'implementation', entityType: 'document', id: d.id, code: d.doc_code },
        });
      }
    }
    return { changed, affectsValidity, msIds, evidenceIds: evidence.map((e) => e.id) };
  }

  /** Storage objects by id with the columns the jobs read (deleted ones left out). */
  async objects(trx: Trx, ids: readonly string[]): Promise<LinkObjectRow[]> {
    if (ids.length === 0) return [];
    const rows = await trx
      .selectFrom('storage_object')
      .select([...LINK_OBJECT_COLUMNS])
      .where(sql<boolean>`id = any(${uuids(ids)})`)
      .where('deleted_at', 'is', null)
      .execute();
    return rows as LinkObjectRow[];
  }
}
