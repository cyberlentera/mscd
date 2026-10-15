// Management system administration (TS 6.2, C.13 `management_system.status`, D-30, D-15): the list, creation on an
// installed edition (BR-21, LIC-MS) with the activity templates copied into `implementation_activity_progress`, the
// changes of scope, certification body, colour and default repository, the `ms.admin` status moves (setup to
// implementing, archive), and the edition transitions of `POST /ms/{ms}/transitions` (feature `edition_transition`).
import { Inject, Injectable } from '@nestjs/common';
import {
  transitionsVia,
  type CommandResult,
  type ManagementSystemCreate,
  type ManagementSystemPatch,
  type ManagementSystemView,
  type MsStatus,
  type MsTransitionRequest,
} from '@mscd/shared';
import { fmtDay } from '../../common/dates';
import { ConflictError, NotFoundError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import { AUDIT_WRITER, LICENCE_GATE, type AuditWriter, type LicenceGate, type Principal, type Trx } from '../../common/tokens';
import { LicenceService } from '../license/licence.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';

const MACHINE = 'management_system.status' as const;

/** Clause groups of the readiness rows a new system starts with (G.5 `clauses`, 4 to 10). */
const CLAUSE_GROUPS = [4, 5, 6, 7, 8, 9, 10] as const;

interface MsRow {
  id: string;
  slug: string;
  code: string;
  name: string;
  status: MsStatus;
  framework_version_id: string;
  transition_target_version_id: string | null;
  scope_statement: string;
  certification_body: string | null;
  color: string;
  default_storage_repository_id: string;
  position: number;
  created_at: Date;
}

@Injectable()
export class ManagementSystemsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly licences: LicenceService,
    @Inject(LICENCE_GATE) private readonly gate: LicenceGate,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  private inOrg<T>(principal: Principal, fn: (trx: Trx, orgId: string) => Promise<T>): Promise<T> {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    const orgId = principal.org.id;
    return this.scope.withTenant(tenantContextOf(principal), (trx) => fn(trx, orgId));
  }

  /** `GET /admin/management-systems`: every system that is not deleted, archived ones included. */
  list(principal: Principal): Promise<ManagementSystemView[]> {
    return this.inOrg(principal, (trx) => this.views(trx));
  }

  private async views(trx: Trx, id?: string): Promise<ManagementSystemView[]> {
    let query = trx
      .selectFrom('management_system as ms')
      .innerJoin('ref.framework_version as fv', 'fv.id', 'ms.framework_version_id')
      .innerJoin('ref.framework as f', 'f.id', 'fv.framework_id')
      .leftJoin('ref.framework_version as target', 'target.id', 'ms.transition_target_version_id')
      .innerJoin('storage_repository as repo', 'repo.id', 'ms.default_storage_repository_id')
      .select([
        'ms.id', 'ms.slug', 'ms.code', 'ms.name', 'ms.status', 'ms.scope_statement', 'ms.certification_body', 'ms.color', 'ms.position',
        'ms.created_at', 'f.code as framework_code', 'f.name as framework_name', 'fv.edition', 'fv.pack_id', 'fv.pack_version',
        'fv.applicability_target', 'target.edition as target_edition', 'repo.slug as repository_slug',
      ])
      .where('ms.deleted_at', 'is', null);
    if (id) query = query.where('ms.id', '=', id);
    const rows = await query.orderBy('ms.position').orderBy('ms.slug').execute();
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      code: r.code,
      name: r.name,
      frameworkCode: r.framework_code,
      frameworkName: r.framework_name,
      edition: r.edition,
      packId: r.pack_id,
      packVersion: r.pack_version,
      transitionTargetEdition: r.target_edition ?? null,
      applicabilityTarget: r.applicability_target,
      status: r.status,
      scopeStatement: r.scope_statement,
      certificationBody: r.certification_body,
      color: r.color,
      defaultRepository: r.repository_slug,
      position: r.position,
      createdAt: r.created_at.toISOString(),
    }));
  }

  private async view(trx: Trx, id: string): Promise<ManagementSystemView> {
    const [view] = await this.views(trx, id);
    if (!view) throw new NotFoundError('Unknown management system');
    return view;
  }

  private async repositoryId(trx: Trx, slug: string, path: string): Promise<string> {
    const row = await trx.selectFrom('storage_repository').select('id').where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new ValidationError([{ path, message: `Unknown storage repository ${slug}` }]);
    return row.id;
  }

  /**
   * `POST /admin/management-systems` (TS 6.2 creation, D-30): the edition must be installed and not withdrawn, the
   * framework licensed (BR-21) and the system count within `max_management_systems` (LIC-MS). The activity templates
   * of the edition are copied into `implementation_activity_progress`, so later minor pack updates never rewrite them.
   */
  create(principal: Principal, body: ManagementSystemCreate): Promise<ManagementSystemView> {
    return this.inOrg(principal, async (trx, orgId) => {
      const version = await trx
        .selectFrom('ref.framework_version as fv')
        .innerJoin('ref.framework as f', 'f.id', 'fv.framework_id')
        .select(['fv.id', 'fv.status', 'fv.pre_release', 'fv.pack_id', 'fv.pack_version', 'fv.edition', 'f.code as framework_code', 'f.name as framework_name'])
        .where('fv.pack_id', '=', body.packId)
        .where('fv.edition', '=', body.edition)
        .executeTakeFirst();
      if (!version) {
        throw new ValidationError([{ path: 'body.edition', message: `Edition ${body.edition} of pack ${body.packId} is not installed` }]);
      }
      if (version.status === 'withdrawn') {
        throw new ConflictError(`Edition ${body.edition} of ${version.framework_name} is withdrawn; choose a current edition`, {
          messageKey: 'ms.edition_withdrawn',
          rule: 'BR-33',
          messages: {
            en: 'The edition of the standard is past its transition period; choose a current edition.',
            id: 'Edisi standar telah melewati masa transisinya; pilih edisi yang berlaku.',
          },
        });
      }
      this.licences.assertFrameworkLicensed(await this.licences.evaluate(trx, orgId), version.framework_code);
      await this.gate.assertCanAddMs(trx, orgId);
      const repositoryId = await this.repositoryId(trx, body.defaultRepository, 'body.defaultRepository');

      const clash = await trx
        .selectFrom('management_system')
        .select(['slug', 'code'])
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('slug', '=', body.slug), eb('code', '=', body.code)]))
        .executeTakeFirst();
      if (clash) {
        throw new ConflictError(clash.slug === body.slug ? `A management system with the slug ${body.slug} exists` : `A management system with the code ${body.code} exists`, {
          messageKey: 'ms.duplicate',
        });
      }
      const position = await trx
        .selectFrom('management_system')
        .select((eb) => eb.fn.max('position').as('max'))
        .executeTakeFirst();
      const today = await this.licences.today(orgId);
      const userId = principal.user.id;

      const ms = await trx
        .insertInto('management_system')
        .values({
          slug: body.slug,
          code: body.code,
          name: body.name,
          framework_version_id: version.id,
          scope_statement: body.scopeStatement,
          status: 'setup',
          default_storage_repository_id: repositoryId,
          certification_body: body.certificationBody ?? null,
          color: body.color,
          position: (position?.max ?? -1) + 1,
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('management_system_version')
        .values({ management_system_id: ms.id, framework_version_id: version.id, role: 'active', activated_at: today, created_by: userId, updated_by: userId })
        .execute();

      // D-30: activity templates are copied at activation.
      const templates = await trx
        .selectFrom('ref.activity_template')
        .select(['id', 'phase_no', 'activity_no', 'title', 'clause_ref', 'output_document_code', 'expected_outcome', 'is_gate_phase'])
        .where('framework_version_id', '=', version.id)
        .orderBy('phase_no')
        .orderBy('activity_no')
        .execute();
      if (templates.length > 0) {
        await trx
          .insertInto('implementation_activity_progress')
          .values(
            templates.map((t) => ({
              management_system_id: ms.id,
              activity_template_id: t.id,
              phase_no: t.phase_no,
              activity_no: t.activity_no,
              title: t.title,
              clause_ref: t.clause_ref,
              output_document_code: t.output_document_code,
              expected_outcome: t.expected_outcome,
              is_gate_phase: t.is_gate_phase,
              template_pack_version: version.pack_version,
              status: 'not_started' as const,
              created_by: userId,
              updated_by: userId,
            })),
          )
          .execute();
      }
      await trx
        .insertInto('clause_readiness')
        .values(CLAUSE_GROUPS.map((group) => ({ management_system_id: ms.id, clause_group: group, readiness_pct: 0, source: 'computed' as const, created_by: userId, updated_by: userId })))
        .execute();
      if (version.pre_release) {
        await trx
          .insertInto('ms_alert')
          .values({
            management_system_id: ms.id,
            kind: 'beta',
            tone: 'info',
            text_en: `${version.pack_id} ${version.pack_version} is a pre-release pack; its content may still change.`,
            text_id: `${version.pack_id} ${version.pack_version} adalah Framework Pack pra-rilis; isinya masih dapat berubah.`,
            source_ref: JSON.stringify({ frameworkVersionId: version.id }),
            created_by: userId,
            updated_by: userId,
          })
          .execute();
      }
      await this.audit.record(trx, {
        action: 'ms.created',
        msId: ms.id,
        entityType: 'management_system',
        entityId: ms.id,
        entityCode: body.code,
        after: {
          slug: body.slug,
          code: body.code,
          name: body.name,
          pack_id: version.pack_id,
          pack_version: version.pack_version,
          edition: version.edition,
          status: 'setup',
          default_repository: body.defaultRepository,
          activities_copied: templates.length,
        },
      });
      return this.view(trx, ms.id);
    });
  }

  /**
   * `PATCH /admin/management-systems/{id}`: scope, certification body, colour, default repository, and the `ms.admin`
   * moves of C.13 (setup to implementing with an MS Manager assigned; any state to archived without an active
   * certification cycle). An archived system no longer changes.
   */
  update(principal: Principal, id: string, patch: ManagementSystemPatch): Promise<ManagementSystemView> {
    return this.inOrg(principal, async (trx) => {
      const current = await this.row(trx, { id });
      if (current.status === 'archived') {
        throw new ConflictError('The management system is archived; its data stays stored but no longer changes', { messageKey: 'ms.archived' });
      }
      const changes: Partial<Record<keyof MsRow, unknown>> = {};
      if (patch.scopeStatement !== undefined) changes.scope_statement = patch.scopeStatement;
      if (patch.certificationBody !== undefined) changes.certification_body = patch.certificationBody;
      if (patch.color !== undefined) changes.color = patch.color;
      if (patch.defaultRepository !== undefined) {
        changes.default_storage_repository_id = await this.repositoryId(trx, patch.defaultRepository, 'body.defaultRepository');
      }
      if (patch.status !== undefined && patch.status !== current.status) {
        if (transitionsVia(MACHINE, current.status, patch.status, 'admin.ms.update').length === 0) {
          throw new TransitionNotAllowedError(current.status, patch.status);
        }
        if (patch.status === 'implementing') await this.assertManagerAssigned(trx, current.id);
        if (patch.status === 'archived') await this.assertNoActiveCycle(trx, current.id);
        changes.status = patch.status;
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changes)) {
        before[key] = current[key as keyof MsRow];
        after[key] = value;
      }
      if (Object.keys(changes).length > 0) {
        await trx
          .updateTable('management_system')
          .set({ ...(changes as Record<string, never>), updated_by: principal.user.id })
          .where('id', '=', current.id)
          .execute();
        if (changes.status === 'archived') {
          await trx
            .updateTable('ms_alert')
            .set({ resolved_at: new Date(), updated_by: principal.user.id })
            .where('management_system_id', '=', current.id)
            .where('resolved_at', 'is', null)
            .execute();
        }
        await this.audit.record(trx, {
          action: 'ms.updated',
          msId: current.id,
          entityType: 'management_system',
          entityId: current.id,
          entityCode: current.code,
          before,
          after,
        });
      }
      return this.view(trx, current.id);
    });
  }

  /**
   * `POST /ms/{ms}/transitions` (C.13, TS 6.2, feature `edition_transition`): `certified` to `transitioning` with a
   * newer edition of the same framework (TS 6.3: one that supersedes the edition in use, directly or through a chain
   * of supersessions, or the `current` edition when the one in use is in `transition` or `withdrawn`); `transitioning`
   * back to `certified` once a transition audit of this transition (created or scheduled after it started) recommended
   * certification, which makes the target the active edition.
   */
  transition(principal: Principal, msSlug: string, body: MsTransitionRequest): Promise<CommandResult> {
    return this.inOrg(principal, async (trx, orgId) => {
      const current = await this.row(trx, { slug: msSlug });
      // Only the ms.transition rows count: the system-only row implementing to certified (permission null, set when
      // the certification cycle is certified) is not a move this user route performs.
      if (transitionsVia(MACHINE, current.status, body.to, null).filter((t) => t.permission !== null).length === 0) {
        throw new TransitionNotAllowedError(current.status, body.to);
      }
      await this.gate.assertFeature(orgId, 'edition_transition', trx);
      const today = await this.licences.today(orgId);
      const userId = principal.user.id;
      const active = await trx
        .selectFrom('ref.framework_version as fv')
        .innerJoin('ref.framework as f', 'f.id', 'fv.framework_id')
        .select(['fv.id', 'fv.framework_id', 'fv.edition', 'fv.status', 'fv.pack_id', 'fv.transition_ends_at', 'f.name as framework_name'])
        .where('fv.id', '=', current.framework_version_id)
        .executeTakeFirstOrThrow();

      if (body.to === 'transitioning') {
        const target = await trx
          .selectFrom('ref.framework_version')
          .select(['id', 'edition', 'status', 'pack_id', 'pack_version'])
          .where('framework_id', '=', active.framework_id)
          .where('edition', '=', body.targetEdition)
          .executeTakeFirst();
        if (!target) throw new ValidationError([{ path: 'body.targetEdition', message: `Edition ${body.targetEdition} of ${active.framework_name} is not installed` }]);
        if (target.id === active.id) throw new ValidationError([{ path: 'body.targetEdition', message: `The system already uses edition ${body.targetEdition}` }]);
        if (target.status === 'withdrawn') {
          throw new ConflictError(`Edition ${body.targetEdition} of ${active.framework_name} is withdrawn`, { messageKey: 'ms.edition_withdrawn' });
        }
        const newer =
          (await this.supersedes(trx, active.framework_id, target.id, active.id)) || (target.status === 'current' && active.status !== 'current');
        if (!newer) {
          throw new ConflictError(
            `Edition ${body.targetEdition} of ${active.framework_name} does not supersede edition ${active.edition}, which the system uses`,
            {
              messageKey: 'ms.transition_not_newer',
              messages: {
                en: `A transition moves only to a newer edition: ${active.framework_name}:${body.targetEdition} does not supersede ${active.framework_name}:${active.edition}.`,
                id: `Transisi hanya berpindah ke edisi yang lebih baru: ${active.framework_name}:${body.targetEdition} tidak menggantikan ${active.framework_name}:${active.edition}.`,
              },
            },
          );
        }
        await trx
          .updateTable('management_system')
          .set({ status: 'transitioning', transition_target_version_id: target.id, updated_by: userId })
          .where('id', '=', current.id)
          .execute();
        await trx
          .updateTable('management_system_version')
          .set({ ended_at: today, updated_by: userId })
          .where('management_system_id', '=', current.id)
          .where('role', '=', 'transition_target')
          .where('ended_at', 'is', null)
          .where('deleted_at', 'is', null)
          .execute();
        await trx
          .insertInto('management_system_version')
          .values({ management_system_id: current.id, framework_version_id: target.id, role: 'transition_target', activated_at: today, created_by: userId, updated_by: userId })
          .execute();
        const ends = active.transition_ends_at;
        const name = `${active.framework_name}:${target.edition}`;
        await trx
          .insertInto('ms_alert')
          .values({
            management_system_id: current.id,
            kind: 'transition',
            tone: 'info',
            text_en: `Transition to ${name} in progress${ends ? `; the current edition's transition period ends on ${fmtDay(ends)}` : ''}.`,
            text_id: `Transisi ke ${name} sedang berjalan${ends ? `; masa transisi edisi saat ini berakhir pada ${fmtDay(ends, 'id')}` : ''}.`,
            source_ref: JSON.stringify({ frameworkVersionId: target.id }),
            created_by: userId,
            updated_by: userId,
          })
          .execute();
        await this.audit.record(trx, {
          action: 'ms.transition',
          msId: current.id,
          entityType: 'management_system',
          entityId: current.id,
          entityCode: current.code,
          before: { status: current.status, transition_target: null },
          after: { status: 'transitioning', transition_target: `${target.pack_id} ${target.pack_version}` },
        });
        return {
          ok: true,
          changed: [current.slug],
          message: [`${current.code} is transitioning to ${name}`, `${current.code} sedang bertransisi ke ${name}`],
        };
      }

      // transitioning to certified: the target becomes the active edition. Only a transition audit of this transition
      // counts: one created or scheduled after it started (an earlier transition's audit does not).
      if (!current.transition_target_version_id) throw new TransitionNotAllowedError(current.status, body.to);
      const started = await this.transitionStart(trx, current.id, current.transition_target_version_id);
      const recommended = started
        ? await trx
            .selectFrom('audit_event')
            .select('id')
            .where('management_system_id', '=', current.id)
            .where('event_type', '=', 'transition')
            .where('outcome', 'in', ['recommended', 'recommended_with_conditions'])
            .where('deleted_at', 'is', null)
            .where((eb) => eb.or([eb('created_at', '>=', started.at), eb('scheduled_at', '>=', started.day)]))
            .executeTakeFirst()
        : undefined;
      if (!recommended) {
        throw new ConflictError('No transition audit of this system has recommended certification yet', {
          messageKey: 'ms.transition_audit_required',
          messages: {
            en: 'Record the transition audit with a recommended outcome before completing the transition.',
            id: 'Catat audit transisi dengan hasil direkomendasikan sebelum menyelesaikan transisi.',
          },
        });
      }
      const target = await trx
        .selectFrom('ref.framework_version')
        .select(['id', 'edition', 'pack_id', 'pack_version'])
        .where('id', '=', current.transition_target_version_id)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('management_system_version')
        .set({ role: 'previous', ended_at: today, updated_by: userId })
        .where('management_system_id', '=', current.id)
        .where('role', '=', 'active')
        .where('ended_at', 'is', null)
        .where('deleted_at', 'is', null)
        .execute();
      const promoted = await trx
        .updateTable('management_system_version')
        .set({ role: 'active', updated_by: userId })
        .where('management_system_id', '=', current.id)
        .where('role', '=', 'transition_target')
        .where('framework_version_id', '=', target.id)
        .where('ended_at', 'is', null)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(promoted.numUpdatedRows) === 0) {
        await trx
          .insertInto('management_system_version')
          .values({ management_system_id: current.id, framework_version_id: target.id, role: 'active', activated_at: today, created_by: userId, updated_by: userId })
          .execute();
      }
      await trx
        .updateTable('management_system')
        .set({ status: 'certified', framework_version_id: target.id, transition_target_version_id: null, updated_by: userId })
        .where('id', '=', current.id)
        .execute();
      await trx
        .updateTable('ms_alert')
        .set({ resolved_at: new Date(), updated_by: userId })
        .where('management_system_id', '=', current.id)
        .where('kind', 'in', ['transition', 'withdrawn_edition'])
        .where('resolved_at', 'is', null)
        .execute();
      await this.audit.record(trx, {
        action: 'ms.transition',
        msId: current.id,
        entityType: 'management_system',
        entityId: current.id,
        entityCode: current.code,
        before: { status: current.status, edition: `${active.pack_id} ${active.edition}` },
        after: { status: 'certified', edition: `${target.pack_id} ${target.edition}` },
      });
      const name = `${active.framework_name}:${target.edition}`;
      return { ok: true, changed: [current.slug], message: [`${current.code} is certified on ${name}`, `${current.code} tersertifikasi pada ${name}`] };
    });
  }

  /**
   * Whether `targetId` supersedes `activeId` (TS 6.3), directly or through a chain of supersessions among the editions
   * of the framework (`ref.framework_version.supersedes_version_id`).
   */
  private async supersedes(trx: Trx, frameworkId: string, targetId: string, activeId: string): Promise<boolean> {
    const editions = await trx.selectFrom('ref.framework_version').select(['id', 'supersedes_version_id']).where('framework_id', '=', frameworkId).execute();
    const superseded = new Map(editions.map((e) => [e.id, e.supersedes_version_id]));
    const seen = new Set<string>();
    for (let id = superseded.get(targetId) ?? null; id !== null && !seen.has(id); id = superseded.get(id) ?? null) {
      if (id === activeId) return true;
      seen.add(id);
    }
    return false;
  }

  /**
   * When the system's open transition started: the open `transition_target` version row of the target edition
   * (`activated_at` and the time it was written), else the newest `ms.transition` entry of the system. Null when
   * neither exists.
   */
  private async transitionStart(trx: Trx, msId: string, targetVersionId: string): Promise<{ day: string; at: Date } | null> {
    const row = await trx
      .selectFrom('management_system_version')
      .select(['activated_at', 'created_at'])
      .where('management_system_id', '=', msId)
      .where('role', '=', 'transition_target')
      .where('framework_version_id', '=', targetVersionId)
      .where('ended_at', 'is', null)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (row) return { day: row.activated_at, at: row.created_at };
    const entry = await trx
      .selectFrom('audit_trail')
      .select('occurred_at')
      .where('action', '=', 'ms.transition')
      .where('entity_type', '=', 'management_system')
      .where('entity_id', '=', msId)
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    return entry ? { day: entry.occurred_at.toISOString().slice(0, 10), at: entry.occurred_at } : null;
  }

  /** The system by id or slug, locked for the rest of the transaction; 404 when there is none. */
  private async row(trx: Trx, by: { id: string } | { slug: string }): Promise<MsRow> {
    let query = trx
      .selectFrom('management_system')
      .select([
        'id', 'slug', 'code', 'name', 'status', 'framework_version_id', 'transition_target_version_id', 'scope_statement', 'certification_body',
        'color', 'default_storage_repository_id', 'position', 'created_at',
      ])
      .where('deleted_at', 'is', null);
    query = 'id' in by ? query.where('id', '=', by.id) : query.where('slug', '=', by.slug);
    const found = await query.forUpdate().executeTakeFirst();
    if (!found) throw new NotFoundError('Unknown management system');
    return found;
  }

  /** TS 6.2: `setup` to `implementing` needs at least one MS Manager. */
  private async assertManagerAssigned(trx: Trx, msId: string): Promise<void> {
    const manager = await trx
      .selectFrom('user_ms_role')
      .select('id')
      .where('management_system_id', '=', msId)
      .where('role', '=', 'ms_manager')
      .where('approval_status', '=', 'active')
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())]))
      .executeTakeFirst();
    if (!manager) {
      throw new ConflictError('Assign an MS Manager before the system starts implementing', {
        messageKey: 'ms.manager_required',
        messages: {
          en: 'Assign at least one MS Manager before the system moves to implementing.',
          id: 'Tetapkan minimal satu Manajer SM sebelum sistem berpindah ke tahap implementasi.',
        },
      });
    }
  }

  /** TS 6.2: a system is archived only without an active certification cycle. */
  private async assertNoActiveCycle(trx: Trx, msId: string): Promise<void> {
    const cycle = await trx
      .selectFrom('certification_cycle')
      .select('id')
      .where('management_system_id', '=', msId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (cycle) {
      throw new ConflictError('The system has an active certification cycle; close it before archiving', {
        messageKey: 'ms.active_cycle',
        messages: {
          en: 'Close the active certification cycle before archiving the system.',
          id: 'Tutup siklus sertifikasi yang aktif sebelum mengarsipkan sistem.',
        },
      });
    }
  }
}
