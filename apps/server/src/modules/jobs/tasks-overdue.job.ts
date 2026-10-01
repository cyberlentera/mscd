// `tasks.overdue` (E.2): daily at 00:15 local time per organisation (`to:<org>:<date>`).
// - Audit preparation tasks and cycle items past `due_at` in `not_started` or `in_progress` become `overdue`
//   (TS 6.7, 6.8, C.13 system transition); their owners get `task_overdue` once per item.
// - Approved documents whose `next_review_at` lies before today become `expired` (BR-10) and their owners get
//   `document_expired`; every expired document has an open BR-10 task for its owner.
// - Findings past `due_at` and not closed get a BR-15 task; the finding owner and the system's MS Managers get
//   `finding_overdue` when the task opens.
// - Completed due diligence past `valid_until` becomes `expired`.
// - BR-10 and BR-15 tasks whose condition cleared are closed (`done`, actor system).
// Rules run only where the system's edition activates them (`ref.rule_activation`).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fmtDay } from '../../common/dates';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import { activeRulesBySystem, ruleActive, RuleTaskService, type ActiveRules } from './rule-tasks';
import { msManagersOf, notificationSent } from './job-support';
import { TenantJobRunner } from './tenant-job';

export interface TasksOverdueResult {
  prepTasksOverdue: number;
  cycleItemsOverdue: number;
  documentsExpired: number;
  br10TasksOpened: number;
  br15TasksOpened: number;
  tasksClosed: number;
  dueDiligenceExpired: number;
  notifications: number;
}

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, kind: 'system' as const };

function emptyResult(): TasksOverdueResult {
  return {
    prepTasksOverdue: 0,
    cycleItemsOverdue: 0,
    documentsExpired: 0,
    br10TasksOpened: 0,
    br15TasksOpened: 0,
    tasksClosed: 0,
    dueDiligenceExpired: 0,
    notifications: 0,
  };
}

@Injectable()
@JobHandler('tasks.overdue', { concurrency: 2, scope: 'tenant' })
export class TasksOverdueJob implements JobHandlerInstance<'tasks.overdue'> {
  private readonly logger = new Logger('tasks.overdue');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly tasks: RuleTaskService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async handle(job: JobRun<'tasks.overdue'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...result }, 'tasks.overdue done');
  }

  async run(orgId: string | null, requestId?: string): Promise<TasksOverdueResult> {
    const org = await this.runner.organisation(orgId, 'tasks.overdue');
    if (!org) return emptyResult();
    const today = await this.clock.today(org.id);
    return this.runner.run(
      org,
      async (trx) => {
        const result = emptyResult();
        const rules = await activeRulesBySystem(trx);
        result.prepTasksOverdue = await this.overdueItems(trx, today, 'audit_prep_task', result);
        result.cycleItemsOverdue = await this.overdueItems(trx, today, 'cycle_requirement_status', result);
        await this.documents(trx, today, rules, result);
        await this.findings(trx, today, rules, result);
        result.dueDiligenceExpired = await this.dueDiligence(trx, today);
        return result;
      },
      requestId,
    );
  }

  /** Prep tasks or cycle items past their due date become `overdue`; owners are notified once per item. */
  private async overdueItems(trx: Trx, today: string, table: 'audit_prep_task' | 'cycle_requirement_status', result: TasksOverdueResult): Promise<number> {
    const due = await trx
      .selectFrom(table)
      .select(['id', 'title', 'owner_user_id', 'management_system_id', 'due_at', 'status'])
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['not_started', 'in_progress'])
      .where('due_at', '<', today)
      .orderBy('due_at')
      .orderBy('id')
      .execute();
    if (due.length === 0) return 0;
    await trx
      .updateTable(table)
      .set({ status: 'overdue', updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
      .where(
        'id',
        'in',
        due.map((d) => d.id),
      )
      .execute();
    const isPrep = table === 'audit_prep_task';
    for (const item of due) {
      await this.audit.record(trx, {
        action: isPrep ? 'prep_task.updated' : 'cycle_item.updated',
        actor: SYSTEM_ACTOR,
        msId: item.management_system_id,
        entityType: table,
        entityId: item.id,
        before: { status: item.status },
        after: { status: 'overdue' },
      });
      if (!item.owner_user_id || (await notificationSent(trx, 'task_overdue', item.id, item.owner_user_id))) continue;
      const created = await this.notifications.create(trx, {
        recipientUserId: item.owner_user_id,
        kind: 'task_overdue',
        msId: item.management_system_id,
        title: { en: `Task overdue: ${item.title}`, id: `Tugas terlambat: ${item.title}` },
        body: {
          en: `${item.title} was due on ${fmtDay(item.due_at, 'en')} and is now overdue.`,
          id: `${item.title} jatuh tempo pada ${fmtDay(item.due_at, 'id')} dan kini terlambat.`,
        },
        ref: { module: 'audit', entityType: table, id: item.id, code: item.title.slice(0, 80) },
        createdBy: SYSTEM_USER_ID,
      });
      if (created) result.notifications += 1;
    }
    return due.length;
  }

  /** BR-10: expired documents and their tasks. */
  private async documents(trx: Trx, today: string, rules: ActiveRules, result: TasksOverdueResult): Promise<void> {
    const docs = await trx
      .selectFrom('document as d')
      .select([
        'd.id',
        'd.doc_code',
        'd.title',
        'd.status',
        'd.owner_user_id',
        'd.next_review_at',
        sql<string[]>`coalesce((SELECT array_agg(l.management_system_id ORDER BY l.is_primary DESC, l.created_at)
                                  FROM entity_ms_link l
                                 WHERE l.entity_type = 'document' AND l.entity_id = d.id AND l.deleted_at IS NULL), '{}')`.as('ms_ids'),
      ])
      .where('d.deleted_at', 'is', null)
      .where((eb) => eb.or([eb('d.status', '=', 'expired'), eb.and([eb('d.status', '=', 'approved'), eb('d.next_review_at', '<', today)])]))
      .orderBy('d.doc_code')
      .execute();
    const expiredIds = new Set<string>();
    for (const doc of docs) {
      if (!ruleActive(rules, 'BR-10', doc.ms_ids)) continue;
      const msId = doc.ms_ids[0] ?? null;
      if (doc.status === 'approved') {
        await trx
          .updateTable('document')
          .set({ status: 'expired', updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
          .where('id', '=', doc.id)
          .execute();
        await this.audit.record(trx, {
          action: 'document.transition',
          actor: SYSTEM_ACTOR,
          msId,
          entityType: 'document',
          entityId: doc.id,
          entityCode: doc.doc_code,
          before: { status: 'approved' },
          after: { status: 'expired', rule: 'BR-10' },
        });
        result.documentsExpired += 1;
        if (doc.owner_user_id) {
          const created = await this.notifications.create(trx, {
            recipientUserId: doc.owner_user_id,
            kind: 'document_expired',
            msId,
            title: { en: `Document expired: ${doc.doc_code} ${doc.title}`, id: `Dokumen kedaluwarsa: ${doc.doc_code} ${doc.title}` },
            body: {
              en: `The review date ${fmtDay(doc.next_review_at, 'en')} has passed, so ${doc.doc_code} is expired (BR-10). Start a review to approve it again.`,
              id: `Tanggal tinjauan ${fmtDay(doc.next_review_at, 'id')} telah lewat, sehingga ${doc.doc_code} kedaluwarsa (BR-10). Mulai tinjauan untuk menyetujuinya kembali.`,
            },
            ref: { module: 'implementation', entityType: 'document', id: doc.id, code: doc.doc_code },
            createdBy: SYSTEM_USER_ID,
          });
          if (created) result.notifications += 1;
        }
      }
      expiredIds.add(doc.id);
      const task = await this.tasks.open(trx, {
        rule: 'BR-10',
        entityType: 'document',
        entityId: doc.id,
        entityCode: doc.doc_code,
        msId,
        ownerUserId: doc.owner_user_id,
        dueAt: doc.next_review_at,
        title: { en: `Review expired document ${doc.doc_code}`, id: `Tinjau dokumen kedaluwarsa ${doc.doc_code}` },
      });
      if (task.created) result.br10TasksOpened += 1;
    }
    result.tasksClosed += (await this.tasks.closeCleared(trx, 'BR-10', 'document', expiredIds)).length;
  }

  /** BR-15: overdue findings and their tasks. */
  private async findings(trx: Trx, today: string, rules: ActiveRules, result: TasksOverdueResult): Promise<void> {
    const overdue = await trx
      .selectFrom('finding')
      .select(['id', 'code', 'title', 'owner_user_id', 'management_system_id', 'due_at'])
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'closed')
      .where('due_at', '<', today)
      .orderBy('code')
      .execute();
    const open = new Set<string>();
    for (const finding of overdue) {
      if (!ruleActive(rules, 'BR-15', [finding.management_system_id])) continue;
      open.add(finding.id);
      const task = await this.tasks.open(trx, {
        rule: 'BR-15',
        entityType: 'finding',
        entityId: finding.id,
        entityCode: finding.code,
        msId: finding.management_system_id,
        ownerUserId: finding.owner_user_id,
        dueAt: finding.due_at,
        title: { en: `Close overdue finding ${finding.code}`, id: `Tutup temuan terlambat ${finding.code}` },
      });
      if (!task.created) continue;
      result.br15TasksOpened += 1;
      const recipients = new Set<string>(await msManagersOf(trx, finding.management_system_id));
      if (finding.owner_user_id) recipients.add(finding.owner_user_id);
      for (const recipient of recipients) {
        const created = await this.notifications.create(trx, {
          recipientUserId: recipient,
          kind: 'finding_overdue',
          msId: finding.management_system_id,
          title: { en: `Finding overdue: ${finding.code}`, id: `Temuan terlambat: ${finding.code}` },
          body: {
            en: `${finding.code} ${finding.title} was due on ${fmtDay(finding.due_at, 'en')} and is not closed (BR-15).`,
            id: `${finding.code} ${finding.title} jatuh tempo pada ${fmtDay(finding.due_at, 'id')} dan belum ditutup (BR-15).`,
          },
          ref: { module: 'audit', entityType: 'finding', id: finding.id, code: finding.code },
          createdBy: SYSTEM_USER_ID,
        });
        if (created) result.notifications += 1;
      }
    }
    result.tasksClosed += (await this.tasks.closeCleared(trx, 'BR-15', 'finding', open)).length;
  }

  /** Completed due diligence past `valid_until` becomes `expired`. */
  private async dueDiligence(trx: Trx, today: string): Promise<number> {
    const rows = await trx
      .selectFrom('due_diligence')
      .select(['id', 'management_system_id'])
      .where('deleted_at', 'is', null)
      .where('status', '=', 'completed')
      .where('valid_until', '<', today)
      .execute();
    if (rows.length === 0) return 0;
    await trx
      .updateTable('due_diligence')
      .set({ status: 'expired', updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    for (const row of rows) {
      await this.audit.record(trx, {
        action: 'register.updated',
        actor: SYSTEM_ACTOR,
        msId: row.management_system_id,
        entityType: 'due_diligence',
        entityId: row.id,
        before: { status: 'completed' },
        after: { status: 'expired' },
      });
    }
    return rows.length;
  }
}
