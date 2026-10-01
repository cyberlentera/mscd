// Storage routing (build plan A-37, BR-38, A-50, D.3 routing routes). A rule maps (system or the whole
// organisation, classification, object kind) to a repository and a mode; at most one rule per scope is active.
// `resolve` picks the most specific active rule (system, then classification, then object kind), then the lowest
// `priority`; without a rule, the system's default repository.
//
// Approval: a change that would put new restricted files into the SaaS Managed Vault (BR-38) needs a confirmation
// and then a second Tenant Admin; a change by a Tenant Admin who is MS Manager of an affected system needs another
// Tenant Admin when the organisation has two or more (four-eyes, A-50). With a single Tenant Admin a BR-38 change
// stays pending and the answer says so; a four-eyes change is applied with an audit entry. A pending change to an
// active rule is a new row that supersedes the old one when approved. A pending row becomes active only through
// approve, or when its own requester edits it into a change that needs no approval; anyone else gets 409. Every
// edit of a pending row by its requester supersedes that row and adds the edited change as a new row, so an
// approval always names the version the approver saw (approving an edited version's old id answers 409).
import { Inject, Injectable } from '@nestjs/common';
import type { Classification, CommandResult, Messages, ObjectKind, RoutingRulePatch, RoutingRuleRequest, RoutingRuleView, StorageMode } from '@mscd/shared';
import { sql, type Selectable } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { ConfirmationRequiredError, ConflictError, ForbiddenError, NotFoundError, ProblemError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import type { StorageRoutingRuleTable } from '../../db/types/tenant-storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import type { RepositoryRow } from './repository-view';
import { activeTenantAdmins, adminRolesOf, managedSystemIds, vaultIsProviderCloud } from './storage-policy';

type RuleRow = Selectable<StorageRoutingRuleTable>;

/** The routing decision for a new file (A-37). */
export interface RoutingDecision {
  repository: RepositoryRow;
  mode: StorageMode;
  /** The rule that decided, or null for the system's default repository. */
  ruleId: string | null;
}

const BR38_MESSAGES: Messages = {
  en: "Restricted files will be stored in the provider's cloud. This change needs a second approval.",
  id: 'File terbatas akan disimpan di cloud penyedia. Perubahan ini memerlukan persetujuan kedua.',
};

interface SystemRef {
  id: string;
  slug: string;
  code: string;
}

interface RuleValues {
  msId: string | null;
  classification: Classification | null;
  objectKind: ObjectKind | null;
  repository: RepositoryRow;
  mode: StorageMode;
  priority: number;
  note: string | null;
}

function businessRule(messageKey: string, messages: Messages, rule?: 'BR-38'): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages, ...(rule ? { rule } : {}) });
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly scope: TenantScope,
    private readonly config: MscdConfig,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /**
   * The repository and mode for a new file of a system (A-37): the most specific active rule, else the system's
   * default repository with its primary mode (the vault stores; other repositories use their first mode).
   */
  async resolve(trx: Trx, input: { msId: string; classification?: Classification | null; objectKind?: ObjectKind | null }): Promise<RoutingDecision> {
    const rule = await trx
      .selectFrom('storage_routing_rule as r')
      .innerJoin('storage_repository as repo', 'repo.id', 'r.storage_repository_id')
      .select(['r.id', 'r.mode', 'r.storage_repository_id'])
      .where('r.deleted_at', 'is', null)
      .where('r.approval_status', '=', 'active')
      .where('repo.deleted_at', 'is', null)
      .where((eb) => eb.or([eb('r.management_system_id', '=', input.msId), eb('r.management_system_id', 'is', null)]))
      .where((eb) =>
        input.classification
          ? eb.or([eb('r.classification', '=', input.classification), eb('r.classification', 'is', null)])
          : eb('r.classification', 'is', null),
      )
      .where((eb) =>
        input.objectKind ? eb.or([eb('r.object_kind', '=', input.objectKind), eb('r.object_kind', 'is', null)]) : eb('r.object_kind', 'is', null),
      )
      .orderBy(sql`(r.management_system_id is not null)`, 'desc')
      .orderBy(sql`(r.classification is not null)`, 'desc')
      .orderBy(sql`(r.object_kind is not null)`, 'desc')
      .orderBy('r.priority', 'asc')
      .orderBy('r.created_at', 'asc')
      .executeTakeFirst();
    if (rule) {
      const repository = await trx.selectFrom('storage_repository').selectAll().where('id', '=', rule.storage_repository_id).executeTakeFirstOrThrow();
      return { repository, mode: rule.mode, ruleId: rule.id };
    }
    const system = await trx
      .selectFrom('management_system')
      .select('default_storage_repository_id')
      .where('id', '=', input.msId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!system) throw new NotFoundError('No such management system');
    let repository = await trx
      .selectFrom('storage_repository')
      .selectAll()
      .where('id', '=', system.default_storage_repository_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    // A-41: the organisation's Managed Vault is the default until another repository is chosen.
    repository ??= await trx
      .selectFrom('storage_repository')
      .selectAll()
      .where('adapter', '=', 'managed_vault')
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .executeTakeFirst();
    if (!repository) throw new NotFoundError('The organisation has no storage repository');
    return { repository, mode: repository.modes[0]!, ruleId: null };
  }

  /** Every rule of the organisation with its approval state. */
  async list(principal: Principal): Promise<RoutingRuleView[]> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const rows = await trx
        .selectFrom('storage_routing_rule as r')
        .innerJoin('storage_repository as repo', 'repo.id', 'r.storage_repository_id')
        .leftJoin('management_system as ms', 'ms.id', 'r.management_system_id')
        .leftJoin('platform.app_user as req', 'req.id', 'r.requested_by')
        .leftJoin('platform.app_user as app', 'app.id', 'r.approved_by')
        .select([
          'r.id',
          'ms.slug as ms',
          'r.classification',
          'r.object_kind',
          'repo.slug as repository',
          'r.mode',
          'r.priority',
          'r.note',
          'r.approval_status',
          'req.handle as requestedBy',
          'app.handle as approvedBy',
          'r.created_at',
        ])
        .where('r.deleted_at', 'is', null)
        .orderBy(sql`ms.position nulls first`)
        .orderBy('r.priority')
        .orderBy('r.created_at')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        ms: row.ms ?? null,
        classification: row.classification,
        objectKind: row.object_kind,
        repository: row.repository,
        mode: row.mode,
        priority: row.priority,
        note: row.note,
        approvalStatus: row.approval_status,
        requestedBy: row.requestedBy ?? null,
        approvedBy: row.approvedBy ?? null,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  /** `POST /admin/storage/routing-rules`. */
  async create(principal: Principal, body: RoutingRuleRequest): Promise<CommandResult> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = body.ms ? await this.systemBySlug(trx, body.ms) : null;
      const repository = await this.repositoryBySlug(trx, body.repository);
      const values: RuleValues = {
        msId: system?.id ?? null,
        classification: body.classification ?? null,
        objectKind: body.objectKind ?? null,
        repository,
        mode: body.mode,
        priority: body.priority,
        note: body.note ?? null,
      };
      this.checkMode(values);
      const approval = await this.approvalFor(trx, principal, values, body.confirm === true);
      const id = await this.insertRule(trx, principal, values, approval.pending ? 'pending_approval' : 'active');
      if (!approval.pending) await this.supersede(trx, id, values);
      await this.recordRequest(trx, id, null, values, approval);
      return this.result(id, approval, approval.affected);
    });
  }

  /** `PATCH /admin/storage/routing-rules/{id}`. */
  async update(principal: Principal, id: string, patch: RoutingRulePatch): Promise<CommandResult> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      // Locked like approve and reject, so an edit and a decision on the same row never interleave.
      const rule = await this.ruleById(trx, id, { forUpdate: true });
      if (rule.approval_status !== 'active' && rule.approval_status !== 'pending_approval') {
        throw new ConflictError(`The rule is ${rule.approval_status}; add a new rule instead`);
      }
      // A pending change is decided through approve or reject (A-50, BR-38). Only its requester may still edit it,
      // and the approval check below runs for that same person, so an edit never activates a change that waits
      // for a second Tenant Admin.
      if (rule.approval_status === 'pending_approval' && rule.requested_by !== principal.user.id) {
        throw new ConflictError('The routing change is waiting for approval; approve or reject it, or add a new rule', {
          messageKey: 'storage.routing.pending',
          messages: {
            en: 'This routing change is waiting for approval. Approve or reject it; only the person who asked for it can still edit it.',
            id: 'Perubahan routing ini menunggu persetujuan. Setujui atau tolak; hanya orang yang memintanya yang masih dapat mengubahnya.',
          },
        });
      }
      const repository = patch.repository
        ? await this.repositoryBySlug(trx, patch.repository)
        : await trx.selectFrom('storage_repository').selectAll().where('id', '=', rule.storage_repository_id).executeTakeFirstOrThrow();
      const values: RuleValues = {
        msId: rule.management_system_id,
        classification: patch.classification === undefined ? rule.classification : patch.classification,
        objectKind: patch.objectKind === undefined ? rule.object_kind : patch.objectKind,
        repository,
        mode: patch.mode ?? rule.mode,
        priority: patch.priority ?? rule.priority,
        note: patch.note === undefined ? rule.note : patch.note,
      };
      this.checkMode(values);
      const approval = await this.approvalFor(trx, principal, values, patch.confirm === true);
      const keyChanged = values.classification !== rule.classification || values.objectKind !== rule.object_kind;
      let targetId = rule.id;
      if (rule.approval_status === 'pending_approval') {
        // The edited request replaces the pending row: an approver who loaded the earlier version approves its id
        // and gets 409, so an approval never activates content the approver did not see.
        await this.setStatus(trx, principal, rule, 'superseded');
        targetId = await this.insertRule(trx, principal, values, approval.pending ? 'pending_approval' : 'active');
        if (!approval.pending) await this.supersede(trx, targetId, values);
      } else if (approval.pending) {
        if (keyChanged) {
          throw new ConflictError('This change needs approval; the classification or object kind of an active rule cannot change in the same request, add a new rule instead');
        }
        // The active rule keeps routing until a second Tenant Admin approves the replacement.
        targetId = await this.insertRule(trx, principal, values, 'pending_approval');
      } else {
        const changed = await trx
          .updateTable('storage_routing_rule')
          .set({
            classification: values.classification,
            object_kind: values.objectKind,
            storage_repository_id: repository.id,
            mode: values.mode,
            priority: values.priority,
            note: values.note,
            approval_status: 'active',
            requested_by: principal.user.id,
            approved_by: null,
            updated_by: principal.user.id,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', rule.id)
          .where('approval_status', '=', rule.approval_status)
          .executeTakeFirst();
        if (Number(changed.numUpdatedRows) === 0) throw new ConflictError('The routing rule changed meanwhile; reload and try again');
        await this.supersede(trx, rule.id, values);
      }
      await this.recordRequest(trx, targetId, rule, values, approval);
      return this.result(targetId, approval, approval.affected);
    });
  }

  /** `POST /admin/storage/routing-rules/{id}/approve`: a Tenant Admin other than the requester. */
  async approve(principal: Principal, id: string): Promise<CommandResult> {
    return this.decide(principal, id, 'approve');
  }

  /** `POST /admin/storage/routing-rules/{id}/reject`. */
  async reject(principal: Principal, id: string): Promise<CommandResult> {
    return this.decide(principal, id, 'reject');
  }

  // -------------------------------------------------------------------------------------------------------------

  private async decide(principal: Principal, id: string, decision: 'approve' | 'reject'): Promise<CommandResult> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const rule = await this.ruleById(trx, id, { forUpdate: true });
      if (rule.approval_status === 'superseded') {
        throw new ConflictError('The routing change was replaced by a newer version; decide on the current one', {
          messageKey: 'storage.routing.superseded',
          messages: {
            en: 'This routing change was edited or replaced after you loaded it. Reload the rules and decide on the current version.',
            id: 'Perubahan routing ini diubah atau diganti setelah Anda memuatnya. Muat ulang aturan dan putuskan versi yang berlaku.',
          },
        });
      }
      if (rule.approval_status !== 'pending_approval') throw new ConflictError(`The rule is ${rule.approval_status}, not waiting for approval`);
      const repository = await trx.selectFrom('storage_repository').selectAll().where('id', '=', rule.storage_repository_id).executeTakeFirstOrThrow();
      const values: RuleValues = {
        msId: rule.management_system_id,
        classification: rule.classification,
        objectKind: rule.object_kind,
        repository,
        mode: rule.mode,
        priority: rule.priority,
        note: rule.note,
      };
      const br38 = this.isBr38(principal, values);
      if (rule.requested_by === principal.user.id) {
        throw businessRule(
          'storage.routing.same_person',
          { en: 'The person who asked for this routing change cannot decide on it', id: 'Orang yang meminta perubahan routing ini tidak dapat memutuskannya' },
          br38 ? 'BR-38' : undefined,
        );
      }
      const roles = await adminRolesOf(trx, principal.org!.id, principal.user.id);
      if (!roles.includes('tenant_admin')) throw new ForbiddenError('Only a second Tenant Admin decides on a routing change (BR-38)');
      const systems = await this.affectedSystems(trx, values.msId);
      if (decision === 'approve') {
        await trx
          .updateTable('storage_routing_rule')
          .set({ approval_status: 'active', approved_by: principal.user.id, updated_by: principal.user.id, updated_at: sql<Date>`now()` })
          .where('id', '=', rule.id)
          .execute();
        await this.supersede(trx, rule.id, values);
      } else {
        await trx
          .updateTable('storage_routing_rule')
          .set({ approval_status: 'rejected', approved_by: principal.user.id, updated_by: principal.user.id, updated_at: sql<Date>`now()` })
          .where('id', '=', rule.id)
          .execute();
      }
      await this.audit.record(trx, {
        action: decision === 'approve' ? 'storage.routing.approved' : 'storage.routing.rejected',
        msId: values.msId,
        entityType: 'storage_routing_rule',
        entityId: rule.id,
        entityCode: this.code(values),
        after: { requestedBy: rule.requested_by, br38 },
      });
      return {
        ok: true,
        changed: systems.map((s) => s.slug),
        message:
          decision === 'approve'
            ? ['Routing change approved and active', 'Perubahan routing disetujui dan aktif']
            : ['Routing change rejected', 'Perubahan routing ditolak'],
        data: { id: rule.id, approvalStatus: decision === 'approve' ? 'active' : 'rejected' },
      };
    });
  }

  private checkMode(values: RuleValues): void {
    if (!values.repository.modes.includes(values.mode)) {
      throw businessRule('storage.routing.mode', {
        en: `The repository ${values.repository.name} does not offer the mode ${values.mode}`,
        id: `Repositori ${values.repository.name} tidak menyediakan mode ${values.mode}`,
      });
    }
    if (values.repository.read_only) {
      throw businessRule('storage.routing.read_only', {
        en: `The repository ${values.repository.name} is read-only; new files cannot go there`,
        id: `Repositori ${values.repository.name} hanya-baca; file baru tidak dapat disimpan di sana`,
      });
    }
  }

  /** BR-38: the rule sends new restricted files into the provider's Managed Vault. */
  private isBr38(principal: Principal, values: RuleValues): boolean {
    return (
      values.repository.adapter === 'managed_vault' &&
      (values.classification === null || values.classification === 'restricted') &&
      vaultIsProviderCloud(this.config, principal)
    );
  }

  private async approvalFor(
    trx: Trx,
    principal: Principal,
    values: RuleValues,
    confirmed: boolean,
  ): Promise<{ pending: boolean; br38: boolean; fourEyes: boolean; singleAdmin: boolean; affected: SystemRef[] }> {
    const affected = await this.affectedSystems(trx, values.msId);
    const br38 = this.isBr38(principal, values);
    if (br38 && !confirmed) {
      throw new ConfirmationRequiredError(
        affected.map((s) => s.code),
        { rule: 'BR-38', messages: BR38_MESSAGES },
      );
    }
    const admins = await activeTenantAdmins(trx, principal.org!.id);
    const others = admins.filter((id) => id !== principal.user.id);
    const managed = new Set(await managedSystemIds(trx, principal.user.id));
    const actorRoles = await adminRolesOf(trx, principal.org!.id, principal.user.id);
    const managesAffected = affected.some((s) => managed.has(s.id));
    // Four-eyes (A-50): a Tenant Admin who is MS Manager of an affected system needs another Tenant Admin, when there is one.
    const fourEyes = actorRoles.includes('tenant_admin') && managesAffected && admins.length >= 2;
    return { pending: br38 || fourEyes, br38, fourEyes, singleAdmin: others.length === 0, affected };
  }

  /** The systems a rule routes for: its system, or every system of the organisation. */
  private async affectedSystems(trx: Trx, msId: string | null): Promise<SystemRef[]> {
    let query = trx.selectFrom('management_system').select(['id', 'slug', 'code']).where('deleted_at', 'is', null);
    if (msId) query = query.where('id', '=', msId);
    return query.orderBy('position').orderBy('slug').execute();
  }

  /** Inserts a rule requested by the principal; returns its id. */
  private async insertRule(trx: Trx, principal: Principal, values: RuleValues, status: 'active' | 'pending_approval'): Promise<string> {
    const inserted = await trx
      .insertInto('storage_routing_rule')
      .values({
        management_system_id: values.msId,
        classification: values.classification,
        object_kind: values.objectKind,
        storage_repository_id: values.repository.id,
        mode: values.mode,
        priority: values.priority,
        note: values.note,
        approval_status: status,
        requested_by: principal.user.id,
        created_by: principal.user.id,
        updated_by: principal.user.id,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  /** Moves a locked rule from the status it was read with to another; 409 when it changed meanwhile. */
  private async setStatus(trx: Trx, principal: Principal, rule: RuleRow, status: 'superseded'): Promise<void> {
    const changed = await trx
      .updateTable('storage_routing_rule')
      .set({ approval_status: status, updated_by: principal.user.id, updated_at: sql<Date>`now()` })
      .where('id', '=', rule.id)
      .where('approval_status', '=', rule.approval_status)
      .executeTakeFirst();
    if (Number(changed.numUpdatedRows) === 0) throw new ConflictError('The routing rule changed meanwhile; reload and try again');
  }

  /** Activating a rule supersedes the other active rules of the same scope. */
  private async supersede(trx: Trx, keepId: string, values: RuleValues): Promise<void> {
    await trx
      .updateTable('storage_routing_rule')
      .set({ approval_status: 'superseded', updated_at: sql<Date>`now()` })
      .where('id', '!=', keepId)
      .where('approval_status', '=', 'active')
      .where('deleted_at', 'is', null)
      .where((eb) => (values.msId ? eb('management_system_id', '=', values.msId) : eb('management_system_id', 'is', null)))
      .where((eb) => (values.classification ? eb('classification', '=', values.classification) : eb('classification', 'is', null)))
      .where((eb) => (values.objectKind ? eb('object_kind', '=', values.objectKind) : eb('object_kind', 'is', null)))
      .execute();
  }

  private async recordRequest(
    trx: Trx,
    id: string,
    before: RuleRow | null,
    values: RuleValues,
    approval: { pending: boolean; br38: boolean; fourEyes: boolean; singleAdmin: boolean },
  ): Promise<void> {
    const after = {
      classification: values.classification,
      objectKind: values.objectKind,
      repository: values.repository.slug,
      mode: values.mode,
      priority: values.priority,
      note: values.note,
      approvalStatus: approval.pending ? 'pending_approval' : 'active',
      br38: approval.br38,
      fourEyes: approval.fourEyes,
      // The rule this request replaces when it is a new row (an edited pending request, or a change to an active rule).
      ...(before && before.id !== id ? { replaces: before.id } : {}),
    };
    await this.audit.record(trx, {
      action: 'storage.routing.requested',
      msId: values.msId,
      entityType: 'storage_routing_rule',
      entityId: id,
      entityCode: this.code(values),
      before: before
        ? { classification: before.classification, objectKind: before.object_kind, mode: before.mode, priority: before.priority, note: before.note }
        : null,
      after,
    });
    if (!approval.pending) {
      // Applied without a second person: no approval needed, or the organisation has a single Tenant Admin (A-50).
      await this.audit.record(trx, {
        action: 'storage.routing.approved',
        msId: values.msId,
        entityType: 'storage_routing_rule',
        entityId: id,
        entityCode: this.code(values),
        after: { approval: approval.singleAdmin ? 'single_tenant_admin' : 'not_required' },
      });
    }
  }

  private result(id: string, approval: { pending: boolean; br38: boolean; singleAdmin: boolean }, affected: SystemRef[]): CommandResult {
    let message: [string, string];
    if (!approval.pending) message = ['Routing rule saved', 'Aturan routing disimpan'];
    else if (approval.singleAdmin) {
      message = [
        'Waiting for a second Tenant Admin; this organisation has only one, so the change cannot be activated yet',
        'Menunggu Tenant Admin kedua; organisasi ini hanya memiliki satu, sehingga perubahan belum dapat diaktifkan',
      ];
    } else message = ['Routing change waiting for approval by another Tenant Admin', 'Perubahan routing menunggu persetujuan Tenant Admin lain'];
    return {
      ok: true,
      changed: approval.pending ? [] : affected.map((s) => s.slug),
      message,
      data: { id, approvalStatus: approval.pending ? 'pending_approval' : 'active', ...(approval.br38 ? { rule: 'BR-38' } : {}) },
    };
  }

  private code(values: RuleValues): string {
    return [values.classification ?? 'any', values.objectKind ?? 'any', values.repository.slug].join(':').slice(0, 80);
  }

  private async ruleById(trx: Trx, id: string, options: { forUpdate?: boolean } = {}): Promise<RuleRow> {
    let query = trx.selectFrom('storage_routing_rule').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
    if (options.forUpdate) query = query.forUpdate();
    const rule = await query.executeTakeFirst();
    if (!rule) throw new NotFoundError('No such routing rule');
    return rule;
  }

  private async systemBySlug(trx: Trx, slug: string): Promise<SystemRef> {
    const system = await trx.selectFrom('management_system').select(['id', 'slug', 'code']).where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
    if (!system) throw new NotFoundError('No such management system');
    return system;
  }

  private async repositoryBySlug(trx: Trx, slug: string): Promise<RepositoryRow> {
    const repository = await trx.selectFrom('storage_repository').selectAll().where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
    if (!repository) throw new NotFoundError('No such storage repository');
    return repository;
  }
}
