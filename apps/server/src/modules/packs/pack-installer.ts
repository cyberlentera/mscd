// Pack installation (build plan E.8 steps 1 to 5, D-14, D-17, D-30). Runs on a connection of role
// `mscd_pack_installer`, the only role that may write `ref`: from `migrate` (C.3 step 5), `mscd-server packs install`
// and the worker's `pack.install` job.
//
// Steps 1 to 3 are `verifyPackForServer` (archive rules, signature with the compiled pack keys, checksums, datasets,
// engine version, chain entity types). Step 4 refuses a lower `pack_version` than the installed one of the same pack
// and treats the same version as a no-op. Step 5 writes everything in one transaction: the framework, the framework
// version (a newer version of an installed edition updates titles, labels, lookups and templates in place and adds
// rows; it never deletes a row, and tenant activity copies are never touched, D-30), the child rows, the superseded
// edition moved to `transition`, `platform.pack_install` and `pack.installed` in the platform audit log. A failure in
// step 5 rolls everything back and records a `failed` install with `pack.install_failed` in a separate transaction.
import { randomUUID } from 'node:crypto';
import { compareSemver, type ActorKind } from '@mscd/shared';
import type { VerifiedPack } from '@mscd/pack-tools';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { AuditWriter, Trx } from '../../common/tokens';
import { SYSTEM_USER_ID } from '../../common/tokens';
import type { DB } from '../../db/types';
import type { TrustAnchors } from '../license/trust-anchors';
import { PackRejectedError, verifyPackForServer } from './pack-verification';

type FrameworkVersionStatus = 'current' | 'transition' | 'withdrawn';
const STATUS_ORDER: Readonly<Record<FrameworkVersionStatus, number>> = { current: 0, transition: 1, withdrawn: 2 };

/** Who asked for an installation, for `pack_install.installed_by` and the audit entry. */
export interface PackInstallActor {
  userId: string | null;
  kind: ActorKind;
}

export interface PackInstallRequest {
  actor: PackInstallActor;
  /** The requesting Tenant Admin's organisation with `tenancy.mode = single`; null with `multi` and on the command line. */
  orgId?: string | null;
  /** Id of the `platform.pack_install` row to write (the task id of `POST /admin/packs/import`). */
  installId?: string;
  /** Request id for the transaction settings and the audit entries. */
  requestId?: string;
}

/** Rows written or updated per dataset by one installation. */
export type PackRowCounts = Record<string, number>;

export type PackInstallOutcome =
  | {
      status: 'installed';
      installId: string;
      packId: string;
      version: string;
      frameworkVersionId: string;
      /** True when an installed edition was updated in place by a newer version. */
      updatedEdition: boolean;
      /** The previous version of the same pack, when there was one. */
      previousVersion: string | null;
      rows: PackRowCounts;
      /** Mapping rows whose source or target requirement is not installed (skipped, not an error). */
      skippedMappings: number;
      archiveSha256: string;
    }
  | { status: 'unchanged'; installId: string | null; packId: string; version: string; archiveSha256: string };

/** Step 5 failed; everything was rolled back and a `failed` install recorded. */
export class PackInstallFailedError extends Error {
  constructor(
    message: string,
    readonly installId: string,
    readonly pack: { packId: string; version: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PackInstallFailedError';
  }
}

export interface PackInstallerDeps {
  /** Kysely on a pool or connection of role `mscd_pack_installer`. */
  db: Kysely<DB>;
  /** Writes `pack.*` entries into `platform.audit_log` (platform actions). */
  audit: Pick<AuditWriter, 'record'>;
  trust: TrustAnchors;
  /** The server version that `engine_min_version` is compared with. */
  serverVersion: string;
  logger?: { warn(message: string): void };
}

/** `excluded.<column>` for every column of an `ON CONFLICT DO UPDATE`. */
function excluded(columns: readonly string[]): Record<string, RawBuilder<unknown>> {
  return Object.fromEntries(columns.map((column) => [column, sql.ref(`excluded.${column}`)]));
}

function moreAdvanced(a: FrameworkVersionStatus, b: FrameworkVersionStatus): FrameworkVersionStatus {
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}

/** Highest semantic version of a list (null for an empty list). */
function highestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of versions) if (best === null || compareSemver(version, best) > 0) best = version;
  return best;
}

export class PackInstaller {
  constructor(private readonly deps: PackInstallerDeps) {}

  /** E.8 steps 1 to 3 without touching the database (the api's import check). */
  verify(bytes: Buffer): VerifiedPack {
    return verifyPackForServer(bytes, this.deps.trust, this.deps.serverVersion);
  }

  /**
   * Installs a pack archive (E.8). Throws `PackRejectedError` (nothing written except a `pack.rejected` audit entry)
   * or `PackInstallFailedError` (rolled back; a `failed` install and `pack.install_failed` recorded).
   */
  async install(bytes: Buffer, request: PackInstallRequest): Promise<PackInstallOutcome> {
    let verified: VerifiedPack;
    try {
      verified = this.verify(bytes);
    } catch (error) {
      if (error instanceof PackRejectedError) await this.recordRejection(error, request);
      throw error;
    }
    return this.installVerified(verified, request);
  }

  /** E.8 steps 4 and 5 for a pack that passed `verify`. */
  async installVerified(verified: VerifiedPack, request: PackInstallRequest): Promise<PackInstallOutcome> {
    const manifest = verified.manifest;
    const installId = request.installId ?? randomUUID();
    const pack = { packId: manifest.pack_id, version: manifest.pack_version };
    try {
      return await this.inTransaction(request, async (trx) => {
        // One installation per framework at a time: supersession touches the other editions of the framework.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`pack-install:${manifest.framework_code}`}, 0))`.execute(trx);
        const installed = await trx
          .selectFrom('platform.pack_install')
          .select(['id', 'pack_version', 'archive_sha256'])
          .where('pack_id', '=', manifest.pack_id)
          .where('status', '=', 'installed')
          .execute();
        const previous = highestVersion(installed.map((r) => r.pack_version));
        if (previous !== null) {
          const order = compareSemver(manifest.pack_version, previous);
          if (order < 0) {
            throw new PackRejectedError(
              'downgrade',
              `pack ${manifest.pack_id} ${manifest.pack_version} is older than the installed version ${previous}`,
              [],
              pack,
            );
          }
          if (order === 0) {
            const same = installed.find((r) => r.pack_version === previous)!;
            if (same.archive_sha256 !== verified.sha256) {
              this.deps.logger?.warn(
                `Pack ${manifest.pack_id} ${manifest.pack_version} is already installed from another archive (${same.archive_sha256}); the new archive (${verified.sha256}) is ignored`,
              );
            }
            return { status: 'unchanged', installId: same.id, packId: manifest.pack_id, version: manifest.pack_version, archiveSha256: verified.sha256 } as const;
          }
        }
        return this.write(trx, verified, installId, previous, request);
      });
    } catch (error) {
      if (error instanceof PackRejectedError) {
        await this.recordRejection(error, request);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(verified, installId, message, request);
      throw new PackInstallFailedError(`Installing pack ${manifest.pack_id} ${manifest.pack_version} failed: ${message}`, installId, pack, { cause: error });
    }
  }

  /** E.8 step 5 inside the installation transaction. */
  private async write(
    trx: Trx,
    verified: VerifiedPack,
    installId: string,
    previous: string | null,
    request: PackInstallRequest,
  ): Promise<PackInstallOutcome> {
    const { manifest, datasets } = verified;
    const rows: PackRowCounts = {};
    const manifestJson = JSON.stringify(manifest);

    const framework = await trx
      .insertInto('ref.framework')
      .values({ code: manifest.framework_code, name: manifest.framework_name })
      .onConflict((oc) => oc.column('code').doUpdateSet(excluded(['name']) as never))
      .returning('id')
      .executeTakeFirstOrThrow();

    const existing = await trx
      .selectFrom('ref.framework_version')
      .select(['id', 'pack_id', 'status', 'applicability_target', 'pack_version'])
      .where('framework_id', '=', framework.id)
      .where('edition', '=', manifest.edition)
      .executeTakeFirst();

    let versionId: string;
    let status: FrameworkVersionStatus = manifest.status;
    if (existing) {
      if (existing.pack_id !== manifest.pack_id) {
        throw new PackRejectedError('incompatible', `edition ${manifest.edition} of ${manifest.framework_code} is installed from pack ${existing.pack_id}, not ${manifest.pack_id}`, [], {
          packId: manifest.pack_id,
          version: manifest.pack_version,
        });
      }
      if (existing.applicability_target !== manifest.applicability_target) {
        throw new PackRejectedError(
          'incompatible',
          `pack ${manifest.pack_id} ${manifest.pack_version} changes the applicability target from ${existing.applicability_target} to ${manifest.applicability_target}; an edition cannot change it`,
          [],
          { packId: manifest.pack_id, version: manifest.pack_version },
        );
      }
      // A status moved on by supersession or the lifecycle job is never moved back by a minor update.
      status = moreAdvanced(existing.status, manifest.status);
      await trx
        .updateTable('ref.framework_version')
        .set({
          pack_version: manifest.pack_version,
          status,
          pre_release: manifest.pre_release,
          pack_checksum: verified.sha256,
          manifest: manifestJson,
          installed_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      versionId = existing.id;
    } else {
      const inserted = await trx
        .insertInto('ref.framework_version')
        .values({
          framework_id: framework.id,
          edition: manifest.edition,
          pack_id: manifest.pack_id,
          pack_version: manifest.pack_version,
          status,
          pre_release: manifest.pre_release,
          applicability_target: manifest.applicability_target,
          pack_checksum: verified.sha256,
          manifest: manifestJson,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      versionId = inserted.id;
    }

    await this.applySupersession(trx, framework.id, versionId, manifest.edition, manifest.supersedes ?? null);

    // Requirements first: catalogue items and mappings refer to them.
    const requirementIds = new Map<string, string>();
    if (datasets.requirements.length > 0) {
      const written = await trx
        .insertInto('ref.requirement')
        .values(
          datasets.requirements.map((r) => ({
            framework_version_id: versionId,
            requirement_code: r.requirement_code,
            title_short: r.title_short,
            clause_group: r.clause_group,
            is_hs_common: r.is_hs_common,
            documented_info_mandatory: r.documented_info_mandatory,
            applicability_assessable: r.applicability_assessable,
            default_frequency_code: r.default_frequency_code,
            evidence_example: r.evidence_example,
            sort_order: r.sort_order,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'requirement_code']).doUpdateSet(
            excluded(['title_short', 'clause_group', 'is_hs_common', 'documented_info_mandatory', 'applicability_assessable', 'default_frequency_code', 'evidence_example', 'sort_order']) as never,
          ),
        )
        .returning(['id', 'requirement_code'])
        .execute();
      for (const row of written) requirementIds.set(row.requirement_code, row.id);
      for (const r of datasets.requirements) {
        const parentId = r.parent_code ? (requirementIds.get(r.parent_code) ?? null) : null;
        await trx
          .updateTable('ref.requirement')
          .set({ parent_id: parentId })
          .where('id', '=', requirementIds.get(r.requirement_code)!)
          .where((eb) => (parentId === null ? eb('parent_id', 'is not', null) : eb.or([eb('parent_id', 'is', null), eb('parent_id', '<>', parentId)])))
          .execute();
      }
    }
    rows.requirements = datasets.requirements.length;

    if (datasets.catalogue.length > 0) {
      await trx
        .insertInto('ref.catalogue_item')
        .values(
          datasets.catalogue.map((c) => ({
            framework_version_id: versionId,
            item_code: c.item_code,
            theme_code: c.theme_code,
            title_short: c.title_short,
            requirement_id: c.requirement_code ? (requirementIds.get(c.requirement_code) ?? null) : null,
            default_frequency_code: c.default_frequency_code,
            evidence_example: c.evidence_example,
            sort_order: c.sort_order,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'item_code']).doUpdateSet(
            excluded(['theme_code', 'title_short', 'requirement_id', 'default_frequency_code', 'evidence_example', 'sort_order']) as never,
          ),
        )
        .execute();
    }
    rows.catalogue = datasets.catalogue.length;

    if (datasets.chain.length > 0) {
      await trx
        .insertInto('ref.traceability_chain_def')
        .values(
          datasets.chain.map((c) => ({
            framework_version_id: versionId,
            stage_key: c.stage_key,
            position: c.position,
            label_en: c.label_en,
            label_id: c.label_id,
            auditor_question_en: c.question_en,
            auditor_question_id: c.question_id,
            source: c.source,
            entity_type: c.entity_type,
            risk_profile_code: c.risk_profile_code,
            is_mandatory: c.is_mandatory,
            clause_at_risk: c.clause_at_risk,
            overview_clause: c.overview_clause,
            gate_type_label_en: c.gate_type_label_en,
            gate_type_label_id: c.gate_type_label_id,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'stage_key']).doUpdateSet(
            excluded([
              'position', 'label_en', 'label_id', 'auditor_question_en', 'auditor_question_id', 'source', 'entity_type', 'risk_profile_code',
              'is_mandatory', 'clause_at_risk', 'overview_clause', 'gate_type_label_en', 'gate_type_label_id',
            ]) as never,
          ),
        )
        .execute();
    }
    rows.chain = datasets.chain.length;

    if (datasets.activities.length > 0) {
      await trx
        .insertInto('ref.activity_template')
        .values(
          datasets.activities.map((a) => ({
            framework_version_id: versionId,
            phase_no: a.phase_no,
            phase_name_en: a.phase_name_en,
            phase_name_id: a.phase_name_id,
            is_gate_phase: a.is_gate_phase,
            activity_no: a.activity_no,
            title: a.title,
            clause_ref: a.clause_ref,
            output_document_code: a.output_document_code,
            expected_outcome: a.expected_outcome,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'phase_no', 'activity_no']).doUpdateSet(
            excluded(['phase_name_en', 'phase_name_id', 'is_gate_phase', 'title', 'clause_ref', 'output_document_code', 'expected_outcome']) as never,
          ),
        )
        .execute();
    }
    rows.activities = datasets.activities.length;

    if (datasets.frequencies.length > 0) {
      await trx
        .insertInto('ref.evidence_frequency_rule')
        .values(datasets.frequencies.map((f) => ({ framework_version_id: versionId, ...f })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['label_en', 'label_id', 'period_days', 'sort_order']) as never))
        .execute();
    }
    rows.frequencies = datasets.frequencies.length;

    const labels = [
      ...Object.entries(datasets.labels.en).map(([key, value]) => ({ framework_version_id: versionId, key, lang: 'en' as const, value })),
      ...Object.entries(datasets.labels.id).map(([key, value]) => ({ framework_version_id: versionId, key, lang: 'id' as const, value })),
    ];
    if (labels.length > 0) {
      await trx
        .insertInto('ref.label')
        .values(labels)
        .onConflict((oc) => oc.columns(['framework_version_id', 'key', 'lang']).doUpdateSet(excluded(['value']) as never))
        .execute();
    }
    rows.labels = labels.length;

    if (datasets.cycleRequirements.length > 0) {
      await trx
        .insertInto('ref.cycle_requirement_def')
        .values(
          datasets.cycleRequirements.map((c) => ({
            framework_version_id: versionId,
            code: c.code,
            requirement_code: c.requirement_code,
            title: c.title,
            derivation: c.derivation === null ? null : JSON.stringify(c.derivation),
            sort_order: c.sort_order,
          })),
        )
        .onConflict((oc) => oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['requirement_code', 'title', 'derivation', 'sort_order']) as never))
        .execute();
    }
    rows.cycleRequirements = datasets.cycleRequirements.length;

    if (datasets.driftRules.length > 0) {
      await trx
        .insertInto('ref.drift_rule_def')
        .values(
          datasets.driftRules.map((d) => ({
            framework_version_id: versionId,
            code: d.code,
            label_en: d.label_en,
            label_id: d.label_id,
            severity: d.severity,
            source_stage: d.source_stage ?? null,
            source_kind: d.source_kind,
            predicate: JSON.stringify(d.predicate),
            message: d.message,
            sort_order: d.sort_order,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'code']).doUpdateSet(
            excluded(['label_en', 'label_id', 'severity', 'source_stage', 'source_kind', 'predicate', 'message', 'sort_order']) as never,
          ),
        )
        .execute();
    }
    rows.driftRules = datasets.driftRules.length;

    if (datasets.prepTasks.length > 0) {
      await trx
        .insertInto('ref.prep_task_template')
        .values(datasets.prepTasks.map((p) => ({ framework_version_id: versionId, ...p })))
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['title', 'days_before_audit', 'skip_on_first_audit', 'sort_order']) as never),
        )
        .execute();
    }
    rows.prepTasks = datasets.prepTasks.length;

    if (datasets.reviewInputs.length > 0) {
      await trx
        .insertInto('ref.review_input_def')
        .values(datasets.reviewInputs.map((r) => ({ framework_version_id: versionId, ...r })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['title', 'mandatory', 'sort_order']) as never))
        .execute();
    }
    rows.reviewInputs = datasets.reviewInputs.length;

    if (datasets.findingConditions.length > 0) {
      await trx
        .insertInto('ref.finding_condition')
        .values(datasets.findingConditions.map((f) => ({ framework_version_id: versionId, ...f })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['classification', 'requirement_code', 'text']) as never))
        .execute();
    }
    rows.findingConditions = datasets.findingConditions.length;

    if (datasets.documentTemplates.length > 0) {
      await trx
        .insertInto('ref.document_template')
        .values(datasets.documentTemplates.map((d) => ({ framework_version_id: versionId, ...d })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['title', 'doc_type']) as never))
        .execute();
    }
    rows.documentTemplates = datasets.documentTemplates.length;

    if (datasets.auditActivities.length > 0) {
      await trx
        .insertInto('ref.audit_activity_template')
        .values(datasets.auditActivities.map((a) => ({ framework_version_id: versionId, ...a })))
        .onConflict((oc) =>
          oc.columns(['framework_version_id', 'code']).doUpdateSet(
            excluded(['event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions', 'evidence_to_request', 'sort_order']) as never,
          ),
        )
        .execute();
    }
    rows.auditActivities = datasets.auditActivities.length;

    if (datasets.lookups.length > 0) {
      await trx
        .insertInto('ref.lookup_value')
        .values(datasets.lookups.map((l) => ({ framework_version_id: versionId, ...l })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'domain', 'code']).doUpdateSet(excluded(['label_en', 'label_id', 'sort_order']) as never))
        .execute();
    }
    rows.lookups = datasets.lookups.length;

    if (datasets.rules.length > 0) {
      await trx
        .insertInto('ref.rule_activation')
        .values(datasets.rules.map((r) => ({ framework_version_id: versionId, rule_id: r.rule_id, active: r.active, params: JSON.stringify(r.params) })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'rule_id']).doUpdateSet(excluded(['active', 'params']) as never))
        .execute();
    }
    rows.rules = datasets.rules.length;

    if (datasets.riskProfiles.length > 0) {
      await trx
        .insertInto('ref.risk_profile')
        .values(datasets.riskProfiles.map((r) => ({ framework_version_id: versionId, code: r.code, definition: JSON.stringify(r.definition) })))
        .onConflict((oc) => oc.columns(['framework_version_id', 'code']).doUpdateSet(excluded(['definition']) as never))
        .execute();
    }
    rows.riskProfiles = datasets.riskProfiles.length;

    const { added, skipped } = await this.writeMappings(trx, verified, requirementIds);
    rows.mappings = added;

    // platform.pack_install: older installed versions of the same pack are superseded by this one.
    await trx
      .updateTable('platform.pack_install')
      .set({ status: 'superseded' })
      .where('pack_id', '=', manifest.pack_id)
      .where('status', '=', 'installed')
      .execute();
    await trx
      .insertInto('platform.pack_install')
      .values({
        id: installId,
        pack_id: manifest.pack_id,
        pack_version: manifest.pack_version,
        framework_code: manifest.framework_code,
        edition: manifest.edition,
        framework_version_id: versionId,
        status: 'installed',
        pre_release: manifest.pre_release,
        manifest: manifestJson,
        archive_sha256: verified.sha256,
        signature_key_id: verified.keyId,
        installed_at: new Date(),
        installed_by: request.actor.userId,
      })
      .execute();

    await this.deps.audit.record(trx, {
      action: 'pack.installed',
      actor: { userId: request.actor.userId ?? (request.actor.kind === 'system' ? SYSTEM_USER_ID : null), kind: request.actor.kind },
      organizationId: request.orgId ?? null,
      entityType: 'pack_install',
      entityId: installId,
      entityCode: `${manifest.pack_id} ${manifest.pack_version}`.slice(0, 80),
      before: previous ? { pack_version: previous } : null,
      after: {
        pack_id: manifest.pack_id,
        pack_version: manifest.pack_version,
        edition: manifest.edition,
        status,
        pre_release: manifest.pre_release,
        archive_sha256: verified.sha256,
        signature_key_id: verified.keyId,
        rows,
      },
      edition: `${manifest.pack_id} ${manifest.pack_version}`,
      requestId: request.requestId,
    });

    return {
      status: 'installed',
      installId,
      packId: manifest.pack_id,
      version: manifest.pack_version,
      frameworkVersionId: versionId,
      updatedEdition: existing !== undefined,
      previousVersion: previous,
      rows,
      skippedMappings: skipped,
      archiveSha256: verified.sha256,
    };
  }

  /**
   * TS 6.3: an edition named by a newer edition's `supersedes` moves from `current` to `transition` with the
   * transition end date. Works in both orders: the newer edition installed after or before the superseded one.
   */
  private async applySupersession(
    trx: Trx,
    frameworkId: string,
    versionId: string,
    edition: string,
    supersedes: { edition: string; transition_ends: string } | null,
  ): Promise<void> {
    if (supersedes) {
      const old = await trx
        .selectFrom('ref.framework_version')
        .select(['id', 'status', 'transition_ends_at'])
        .where('framework_id', '=', frameworkId)
        .where('edition', '=', supersedes.edition)
        .executeTakeFirst();
      if (old && old.id !== versionId) {
        await trx
          .updateTable('ref.framework_version')
          .set({
            status: moreAdvanced(old.status, 'transition'),
            transition_ends_at: old.transition_ends_at ?? supersedes.transition_ends,
          })
          .where('id', '=', old.id)
          .execute();
        await trx.updateTable('ref.framework_version').set({ supersedes_version_id: old.id }).where('id', '=', versionId).execute();
      }
    }
    // A newer edition installed earlier may already name this one.
    const newer = await trx
      .selectFrom('ref.framework_version')
      .select(['id', 'manifest'])
      .where('framework_id', '=', frameworkId)
      .where('id', '<>', versionId)
      .execute();
    for (const candidate of newer) {
      const named = (candidate.manifest as { supersedes?: { edition?: unknown; transition_ends?: unknown } }).supersedes;
      if (!named || named.edition !== edition || typeof named.transition_ends !== 'string') continue;
      const self = await trx
        .selectFrom('ref.framework_version')
        .select(['status', 'transition_ends_at'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('ref.framework_version')
        .set({ status: moreAdvanced(self.status, 'transition'), transition_ends_at: self.transition_ends_at ?? named.transition_ends })
        .where('id', '=', versionId)
        .execute();
      await trx
        .updateTable('ref.framework_version')
        .set({ supersedes_version_id: versionId })
        .where('id', '=', candidate.id)
        .where('supersedes_version_id', 'is', null)
        .execute();
    }
  }

  /** `mappings/*.csv` into `ref.requirement_mapping`; rows whose requirements are not installed are skipped. */
  private async writeMappings(trx: Trx, verified: VerifiedPack, requirementIds: ReadonlyMap<string, string>): Promise<{ added: number; skipped: number }> {
    let added = 0;
    let skipped = 0;
    const targets = new Map<string, Map<string, string>>();
    for (const rows of Object.values(verified.datasets.mappings)) {
      for (const row of rows) {
        let target = targets.get(row.target_pack_id);
        if (!target) {
          const found = await trx
            .selectFrom('ref.requirement as r')
            .innerJoin('ref.framework_version as v', 'v.id', 'r.framework_version_id')
            .select(['r.id', 'r.requirement_code'])
            .where('v.pack_id', '=', row.target_pack_id)
            .execute();
          target = new Map(found.map((r) => [r.requirement_code, r.id]));
          targets.set(row.target_pack_id, target);
        }
        const sourceId = requirementIds.get(row.source_code);
        const targetId = target.get(row.target_code);
        if (!sourceId || !targetId) {
          skipped += 1;
          continue;
        }
        const exists = await trx
          .selectFrom('ref.requirement_mapping')
          .select('id')
          .where('source_requirement_id', '=', sourceId)
          .where('target_requirement_id', '=', targetId)
          .where('mapping_type', '=', row.mapping_type)
          .executeTakeFirst();
        if (exists) {
          await trx
            .updateTable('ref.requirement_mapping')
            .set({ evidence_reusable: row.evidence_reusable, note: row.note })
            .where('id', '=', exists.id)
            .execute();
        } else {
          await trx
            .insertInto('ref.requirement_mapping')
            .values({ source_requirement_id: sourceId, target_requirement_id: targetId, mapping_type: row.mapping_type, evidence_reusable: row.evidence_reusable, note: row.note })
            .execute();
        }
        added += 1;
      }
    }
    return { added, skipped };
  }

  /** A transaction of the installer role with platform scope (D-31: `platform.audit_log`) and the request settings. */
  private async inTransaction<T>(request: PackInstallRequest, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.deps.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true),
                       set_config('app.org_id', ${request.orgId ?? ''}, true),
                       set_config('app.user_id', ${request.actor.userId ?? ''}, true),
                       set_config('app.request_id', ${request.requestId ?? randomUUID()}, true)`.execute(trx);
      return fn(trx);
    });
  }

  /** `pack.rejected` in the platform audit log (no other row is written for a rejected pack). */
  async recordRejection(error: PackRejectedError, request: PackInstallRequest): Promise<void> {
    try {
      await this.inTransaction(request, (trx) =>
        this.deps.audit.record(trx, {
          action: 'pack.rejected',
          actor: { userId: request.actor.userId, kind: request.actor.kind },
          organizationId: request.orgId ?? null,
          entityType: 'pack_install',
          entityId: request.installId ?? null,
          entityCode: error.pack ? `${error.pack.packId} ${error.pack.version}`.slice(0, 80) : null,
          after: { reason: error.code, message: error.message.slice(0, 1000), issues: error.issues.slice(0, 20) },
          requestId: request.requestId,
        }),
      );
    } catch (auditError) {
      this.deps.logger?.warn(`Could not audit a rejected pack: ${(auditError as Error).message}`);
    }
  }

  /** A `failed` install row and `pack.install_failed`, in a transaction of their own (E.8 step 5). */
  private async recordFailure(verified: VerifiedPack, installId: string, message: string, request: PackInstallRequest): Promise<void> {
    const manifest = verified.manifest;
    try {
      await this.inTransaction(request, async (trx) => {
        await trx
          .insertInto('platform.pack_install')
          .values({
            id: installId,
            pack_id: manifest.pack_id,
            pack_version: manifest.pack_version,
            framework_code: manifest.framework_code,
            edition: manifest.edition,
            framework_version_id: null,
            status: 'failed',
            pre_release: manifest.pre_release,
            manifest: JSON.stringify(manifest),
            archive_sha256: verified.sha256,
            signature_key_id: verified.keyId,
            error: message.slice(0, 4000),
            installed_by: request.actor.userId,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
        await this.deps.audit.record(trx, {
          action: 'pack.install_failed',
          actor: { userId: request.actor.userId, kind: request.actor.kind },
          organizationId: request.orgId ?? null,
          entityType: 'pack_install',
          entityId: installId,
          entityCode: `${manifest.pack_id} ${manifest.pack_version}`.slice(0, 80),
          after: { error: message.slice(0, 1000) },
          requestId: request.requestId,
        });
      });
    } catch (recordError) {
      this.deps.logger?.warn(`Could not record the failed installation of ${manifest.pack_id} ${manifest.pack_version}: ${(recordError as Error).message}`);
    }
  }
}
