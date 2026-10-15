// The pack routes of D.3: the installed packs, the offline bundle import (verified here, installed by the worker's
// `pack.install` job as `mscd_pack_installer`, D-17) and the update check of the configured channel.
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MAX_PACK_IMPORT_BYTES,
  canonicalJson,
  compareSemver,
  type CheckUpdatesResult,
  type CommandResult,
  type PackSummary,
  type PackUpdate,
} from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, DependencyUnavailableError, PayloadTooLargeError, ProblemError, ValidationError } from '../../common/problems';
import type { StreamedIdempotency } from '../../common/route-state';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { TenantScope } from '../tenancy/tenant-scope';
import { PackBundleStore } from './pack-bundle-store';
import { PackInstallService } from './pack-installer.service';
import { PackRejectedError } from './pack-verification';
import { rejectionAuditEntry } from './pack-installer';

/** `catalog.json` of the online pack channel (`<packs.channel_url>/catalog.json`). */
export const OnlineCatalog = z.object({
  packs: z
    .array(
      z.object({
        pack_id: z.string().regex(/^[A-Z][A-Z0-9]{1,19}-[A-Za-z0-9.]{1,19}$/),
        pack_version: z.string().max(20),
        note_en: z.string().max(2000).default(''),
        note_id: z.string().max(2000).default(''),
        published_at: z.iso.date().nullable().optional(),
      }),
    )
    .max(1000),
});
export type OnlineCatalog = z.infer<typeof OnlineCatalog>;

/** Largest catalogue document read from the online channel. */
const CATALOG_MAX_BYTES = 1024 * 1024;
const CATALOG_TIMEOUT_MS = 10_000;

/** Reads `<channel_url>/catalog.json` (online channel); 503 when the channel cannot be read. */
export async function fetchOnlineCatalog(channelUrl: string, fetchImpl: typeof fetch = fetch): Promise<OnlineCatalog> {
  const url = new URL('catalog.json', channelUrl.endsWith('/') ? channelUrl : `${channelUrl}/`);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS), headers: { accept: 'application/json' }, redirect: 'error' });
  } catch (error) {
    throw new DependencyUnavailableError(`The pack channel ${url.origin} cannot be reached`, { cause: error });
  }
  if (!response.ok) throw new DependencyUnavailableError(`The pack channel answered ${response.status}`);
  const text = await readCapped(response, CATALOG_MAX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DependencyUnavailableError('The pack channel catalogue is not JSON');
  }
  const parsed = OnlineCatalog.safeParse(json);
  if (!parsed.success) throw new DependencyUnavailableError('The pack channel catalogue does not have the expected form');
  return parsed.data;
}

/** The body of a response as UTF-8 text, refusing more than `max` bytes without reading further. */
async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new DependencyUnavailableError('The pack channel catalogue is too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof DependencyUnavailableError) throw error;
    throw new DependencyUnavailableError('The pack channel catalogue could not be read', { cause: error });
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The problem a rejected pack answers with (D.3: 400 bad signature or checksum, 422 engine version or downgrade). */
export function packProblem(error: PackRejectedError): ProblemError {
  if (error.status === 400) {
    const errors = [{ path: 'body.bundle', message: error.message }, ...error.issues.slice(0, 50).map((message) => ({ path: 'body.bundle', message }))];
    return new ValidationError(errors, `The pack was rejected (${error.code}): ${error.message}`);
  }
  return new ProblemError('business-rule', {
    messageKey: `pack.${error.code}`,
    detail: error.message,
    messages: {
      en: error.code === 'downgrade' ? `${error.message}: an older version is never installed.` : error.message,
      id:
        error.code === 'downgrade'
          ? 'Versi Framework Pack lebih lama dari versi yang terpasang: versi lama tidak pernah dipasang.'
          : error.code === 'engine_version'
            ? 'Framework Pack ini membutuhkan versi server yang lebih baru.'
            : 'Framework Pack ini tidak dapat memperbarui edisi yang terpasang.',
    },
  });
}

@Injectable()
export class PacksService {
  private readonly logger = new Logger('Packs');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly installer: PackInstallService,
    private readonly bundles: PackBundleStore,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** Reads platform tables as the caller: in its organisation, or with operator scope for an operator without one. */
  private read<T>(principal: Principal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    if (principal.org) return this.scope.withTenant({ orgId: principal.org.id, schema: principal.org.schema, userId: principal.user.id }, fn);
    return this.scope.withPlatform(fn, { scope: 'operator', userId: principal.user.id });
  }

  /** `GET /admin/packs`: every installation of `platform.pack_install`, newest first per pack. */
  async list(principal: Principal): Promise<PackSummary[]> {
    const rows = await this.read(principal, (trx) =>
      trx
        .selectFrom('platform.pack_install')
        .select(['pack_id', 'pack_version', 'framework_code', 'edition', 'status', 'pre_release', 'installed_at', 'archive_sha256', 'signature_key_id', 'created_at'])
        .orderBy('pack_id')
        .orderBy('created_at', 'desc')
        .execute(),
    );
    return rows.map((r) => ({
      packId: r.pack_id,
      version: r.pack_version,
      frameworkCode: r.framework_code,
      edition: r.edition,
      status: r.status,
      preRelease: r.pre_release,
      installedAt: r.installed_at ? r.installed_at.toISOString() : null,
      checksum: r.archive_sha256,
      signatureKeyId: r.signature_key_id,
    }));
  }

  /** Highest installed version of a pack, or null. */
  private async installedVersion(principal: Principal, packId: string): Promise<string | null> {
    const rows = await this.read(principal, (trx) =>
      trx.selectFrom('platform.pack_install').select('pack_version').where('pack_id', '=', packId).where('status', '=', 'installed').execute(),
    );
    let best: string | null = null;
    for (const r of rows) if (best === null || compareSemver(r.pack_version, best) > 0) best = r.pack_version;
    return best;
  }

  /**
   * `POST /admin/packs/import`: refuses (503) an importer whose bundle the worker could not read (no Managed Vault
   * for it and a worker in another process), reads the multipart form (one file field `bundle`, at most 50 MiB),
   * claims the idempotency key with the SHA-256 of the bundle and the form fields, verifies the bundle (E.8 steps 1
   * to 4, at most 16 MiB decompressed, checked off the event loop: 400 for archive, signature, checksum or content
   * problems, 422 for the engine version or a downgrade), stores it and queues `pack.install`. The same version as
   * the installed one changes nothing.
   */
  async import(request: FastifyRequest, principal: Principal, idempotency: StreamedIdempotency): Promise<CommandResult> {
    // 503 before the body is read when the worker could never read the stored bundle (no Managed Vault for it).
    this.bundles.assertJobCanRead(principal.org, this.jobs);
    const { bundle, fields } = await readImportForm(request);
    const digest = createHash('sha256')
      .update(canonicalJson({ bundle: createHash('sha256').update(bundle).digest('hex'), fields }), 'utf8')
      .digest('hex');
    await idempotency.claim(digest);

    const installId = randomUUID();
    const actor = { userId: principal.user.id, kind: principal.org ? ('user' as const) : ('operator' as const) };
    const orgId = this.config.profile.tenancy.mode === 'single' ? (principal.org?.id ?? null) : null;
    let verified;
    try {
      verified = await this.installer.verifyImport(bundle);
    } catch (error) {
      if (error instanceof PackRejectedError) {
        await this.auditRejection(error, actor, orgId, installId);
        throw packProblem(error);
      }
      throw error;
    }
    const manifest = verified.manifest;
    const installed = await this.installedVersion(principal, manifest.pack_id);
    if (installed !== null) {
      const order = compareSemver(manifest.pack_version, installed);
      if (order < 0) {
        const error = new PackRejectedError('downgrade', `pack ${manifest.pack_id} ${manifest.pack_version} is older than the installed version ${installed}`, [], {
          packId: manifest.pack_id,
          version: manifest.pack_version,
        });
        await this.auditRejection(error, actor, orgId, installId);
        throw packProblem(error);
      }
      if (order === 0) {
        return {
          ok: true,
          changed: [],
          message: [`${manifest.pack_id} ${manifest.pack_version} is already installed`, `${manifest.pack_id} ${manifest.pack_version} sudah terpasang`],
          data: { packId: manifest.pack_id, version: manifest.pack_version, status: 'unchanged' },
        };
      }
    }

    const objectKey = await this.bundles.put(bundle, { installId, org: principal.org });
    await this.jobs.send(
      'pack.install',
      {
        orgId,
        requestedBy: principal.user.id,
        payload: { installId, objectKey, requestedBy: principal.user.id, ...(orgId ? { orgId } : {}) },
      },
      { singletonKey: `pi:${installId}`, retryLimit: 0 },
    );
    this.logger.log({ installId, packId: manifest.pack_id, version: manifest.pack_version }, 'Pack import queued for installation');
    return {
      ok: true,
      changed: [],
      taskId: installId,
      message: [
        `${manifest.pack_id} ${manifest.pack_version} was verified and is being installed`,
        `${manifest.pack_id} ${manifest.pack_version} telah diverifikasi dan sedang dipasang`,
      ],
      data: { installId, packId: manifest.pack_id, version: manifest.pack_version, status: 'queued' },
    };
  }

  /** `pack.rejected` for an import refused before anything was queued. */
  private async auditRejection(error: PackRejectedError, actor: { userId: string; kind: 'user' | 'operator' }, orgId: string | null, installId: string): Promise<void> {
    try {
      await this.scope.withPlatform((trx) => this.audit.record(trx, rejectionAuditEntry(error, { actor, orgId, installId })), {
        scope: 'operator',
        orgId,
        userId: actor.userId,
      });
    } catch (auditError) {
      this.logger.error(`Could not audit a rejected pack: ${(auditError as Error).message}`);
    }
  }

  /**
   * `POST /admin/packs/check-updates` (D.3): the offline channel answers 409 (import a bundle instead); the online
   * channel reads `<packs.channel_url>/catalog.json`; the managed channel reads `platform.pack_catalog`. Nothing is
   * stored.
   */
  async checkUpdates(principal: Principal): Promise<CheckUpdatesResult> {
    const packs = this.config.profile.packs;
    if (packs.channel === 'offline') {
      throw new ConflictError('This installation uses the offline pack channel: import a signed pack bundle instead', {
        messageKey: 'packs.offline_channel',
        messages: {
          en: 'Updates come as signed offline bundles on this installation. Import a pack bundle to update.',
          id: 'Pembaruan pada instalasi ini datang sebagai bundel luring yang ditandatangani. Impor bundel Framework Pack untuk memperbarui.',
        },
      });
    }
    let entries: { packId: string; version: string; noteEn: string; noteId: string; publishedAt: string | null }[];
    if (packs.channel === 'online') {
      if (!packs.channel_url) throw new DependencyUnavailableError('packs.channel_url is not set');
      const catalog = await fetchOnlineCatalog(packs.channel_url);
      entries = catalog.packs.map((p) => ({ packId: p.pack_id, version: p.pack_version, noteEn: p.note_en, noteId: p.note_id, publishedAt: p.published_at ?? null }));
    } else {
      const rows = await this.read(principal, (trx) =>
        trx.selectFrom('platform.pack_catalog').select(['pack_id', 'pack_version', 'note_en', 'note_id', 'published_at']).where('channel', '=', 'managed').execute(),
      );
      entries = rows.map((r) => ({ packId: r.pack_id, version: r.pack_version, noteEn: r.note_en, noteId: r.note_id, publishedAt: r.published_at }));
    }
    const installed = await this.read(principal, (trx) =>
      trx.selectFrom('platform.pack_install').select(['pack_id', 'pack_version']).where('status', '=', 'installed').execute(),
    );
    const highest = new Map<string, string>();
    for (const r of installed) {
      const current = highest.get(r.pack_id);
      if (!current || compareSemver(r.pack_version, current) > 0) highest.set(r.pack_id, r.pack_version);
    }
    const available: PackUpdate[] = [];
    for (const entry of entries) {
      let newer: boolean;
      try {
        const current = highest.get(entry.packId);
        newer = current === undefined || compareSemver(entry.version, current) > 0;
      } catch {
        continue; // a version that is not semantic is ignored
      }
      if (newer && !available.some((a) => a.packId === entry.packId && a.version === entry.version)) {
        available.push({ packId: entry.packId, version: entry.version, note: [entry.noteEn, entry.noteId], publishedAt: entry.publishedAt });
      }
    }
    available.sort((a, b) => a.packId.localeCompare(b.packId) || compareSemver(a.version, b.version));
    const n = available.length;
    return {
      ok: true,
      changed: [],
      message: n === 0 ? ['All packs are up to date', 'Semua Framework Pack sudah terbaru'] : [`${n} update${n === 1 ? '' : 's'} available`, `${n} pembaruan tersedia`],
      data: { available },
    };
  }
}

/**
 * Reads the import form: exactly one file part named `bundle` (at most `MAX_PACK_IMPORT_BYTES`, else 413) and no
 * other parts. Form fields are returned for the idempotency digest; any field is refused (the form has none).
 */
export async function readImportForm(request: FastifyRequest): Promise<{ bundle: Buffer; fields: Record<string, string> }> {
  if (!request.isMultipart()) {
    throw new ValidationError([{ path: 'body', message: 'Send the pack as multipart/form-data with the file in the field bundle' }]);
  }
  let bundle: Buffer | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_PACK_IMPORT_BYTES, files: 1, fields: 4, parts: 5 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'bundle') {
          await part.toBuffer().catch(() => undefined);
          throw new ValidationError([{ path: `body.${part.fieldname}`, message: 'Unknown file field: the pack goes in the field bundle' }]);
        }
        bundle = await part.toBuffer();
        if (part.file.truncated) throw new PayloadTooLargeError(`The pack bundle is larger than ${MAX_PACK_IMPORT_BYTES} bytes`);
      } else {
        fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
      }
    }
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
      throw new PayloadTooLargeError(`The pack import accepts one bundle of at most ${MAX_PACK_IMPORT_BYTES} bytes`);
    }
    throw error;
  }
  const unknownFields = Object.keys(fields);
  if (unknownFields.length > 0) {
    throw new ValidationError(unknownFields.map((name) => ({ path: `body.${name}`, message: 'Unknown form field: the import form has only the file field bundle' })));
  }
  if (!bundle || bundle.length === 0) throw new ValidationError([{ path: 'body.bundle', message: 'The file field bundle is missing or empty' }]);
  return { bundle, fields };
}
