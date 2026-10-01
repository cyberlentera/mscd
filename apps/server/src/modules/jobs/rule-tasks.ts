// Tasks opened and closed by the jobs that evaluate business rules (build plan D-29, C.6 `task`): BR-10 (expired
// document), BR-11 (expired or critical evidence), BR-15 (overdue finding) and BR-31 (unverifiable evidence). One
// open task per rule and entity (`task_open_uq`); a task closes (`done`, actor system) when its condition clears.
// Also reads which rules a system's edition activates (`ref.rule_activation`, WP-20 runs only activated rules).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AUDIT_WRITER, MEMBERSHIP_SERVICE, SYSTEM_USER_ID, type AuditWriter, type MembershipService, type Trx } from '../../common/tokens';

export type RuleTaskRule = 'BR-10' | 'BR-11' | 'BR-15' | 'BR-31';

export interface RuleTaskInput {
  rule: RuleTaskRule;
  entityType: string;
  entityId: string;
  entityCode: string | null;
  msId: string | null;
  ownerUserId: string | null;
  dueAt: string | null;
  title: { en: string; id: string };
}

export interface OpenedTask {
  id: string;
  /** False when an open task of the rule and entity already existed (it is kept, owner and due date refreshed). */
  created: boolean;
}

/** Active rule ids per management system id (`ref.rule_activation` of the system's edition). */
export type ActiveRules = ReadonlyMap<string, ReadonlySet<string>>;

@Injectable()
export class RuleTaskService {
  constructor(
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
  ) {}

  /**
   * Opens the task of a rule and entity, or refreshes the open one (owner and due date follow the record). A record
   * owner who is no longer an active member leaves the task unassigned (BR-45).
   */
  async open(trx: Trx, input: RuleTaskInput): Promise<OpenedTask> {
    const owner = input.ownerUserId && (await this.members.isMember(trx, input.ownerUserId)) ? input.ownerUserId : null;
    const row = await trx
      .insertInto('task')
      .values({
        management_system_id: input.msId,
        source_rule: input.rule,
        entity_type: input.entityType,
        entity_id: input.entityId,
        entity_code: input.entityCode,
        title_en: input.title.en,
        title_id: input.title.id,
        owner_user_id: owner,
        due_at: input.dueAt,
        status: 'open',
        created_by: SYSTEM_USER_ID,
        updated_by: SYSTEM_USER_ID,
      })
      .onConflict((oc) =>
        oc
          .columns(['source_rule', 'entity_type', 'entity_id'])
          .where('status', '=', 'open')
          .where('deleted_at', 'is', null)
          .doUpdateSet((eb) => ({
            owner_user_id: eb.ref('excluded.owner_user_id'),
            due_at: eb.ref('excluded.due_at'),
            updated_at: sql<Date>`CASE WHEN task.owner_user_id IS DISTINCT FROM excluded.owner_user_id
                                         OR task.due_at IS DISTINCT FROM excluded.due_at THEN now() ELSE task.updated_at END`,
          })),
      )
      .returning(['id', sql<boolean>`xmax = 0`.as('created')])
      .executeTakeFirstOrThrow();
    return { id: row.id, created: row.created };
  }

  /**
   * Closes the open tasks of `rule` on entities of `entityType` that are not in `stillOpen` (their condition
   * cleared). With `within` only tasks on those entities are considered (a recompute of part of the data).
   * Returns the closed tasks.
   */
  async closeCleared(
    trx: Trx,
    rule: RuleTaskRule,
    entityType: string,
    stillOpen: ReadonlySet<string>,
    within?: ReadonlySet<string>,
  ): Promise<{ id: string; entity_id: string; entity_code: string | null; management_system_id: string | null }[]> {
    if (within && within.size === 0) return [];
    let query = trx
      .selectFrom('task')
      .select(['id', 'entity_id', 'entity_code', 'management_system_id'])
      .where('source_rule', '=', rule)
      .where('entity_type', '=', entityType)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null);
    if (within) query = query.where('entity_id', 'in', [...within]);
    const open = await query.execute();
    const cleared = open.filter((t) => !stillOpen.has(t.entity_id));
    if (cleared.length === 0) return [];
    await trx
      .updateTable('task')
      .set({ status: 'done', closed_by: SYSTEM_USER_ID, closed_at: sql<Date>`now()`, updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
      .where(
        'id',
        'in',
        cleared.map((t) => t.id),
      )
      .execute();
    for (const task of cleared) {
      await this.audit.record(trx, {
        action: 'task.completed',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        msId: task.management_system_id,
        entityType: 'task',
        entityId: task.id,
        entityCode: task.entity_code,
        before: { status: 'open' },
        after: { status: 'done', reason: `${rule} condition cleared` },
      });
    }
    return cleared;
  }
}

/** Active rules of every system of the organisation of `trx`. */
export async function activeRulesBySystem(trx: Trx): Promise<ActiveRules> {
  const rows = await trx
    .selectFrom('management_system as ms')
    .innerJoin('ref.rule_activation as ra', 'ra.framework_version_id', 'ms.framework_version_id')
    .select(['ms.id as ms_id', 'ra.rule_id'])
    .where('ms.deleted_at', 'is', null)
    .where('ra.active', '=', true)
    .execute();
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = map.get(row.ms_id);
    if (!set) map.set(row.ms_id, (set = new Set()));
    set.add(row.rule_id);
  }
  return map;
}

/** True when `rule` is active in at least one of `msIds` (or, for records of no system, in any system). */
export function ruleActive(rules: ActiveRules, rule: string, msIds: readonly string[]): boolean {
  const systems = msIds.length > 0 ? msIds : [...rules.keys()];
  return systems.some((id) => rules.get(id)?.has(rule) === true);
}
