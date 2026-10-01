// `audit-prep.generate` (E.2, TS 4.9, 6.7, PRD 9.4): daily at 00:30 local time per organisation (`ap:<org>:<date>`).
// For the next audit event of every system whose preparation window is open (`scheduled_at - prep_window_days <=
// today`) and that has no preparation tasks yet, creates the tasks of the edition's `ref.prep_task_template` with
// `due_at = scheduled_at - days_before_audit`, skipping `skip_on_first_audit` templates when the system has no
// earlier audit event (BR-44). The owner is the system's primary MS Manager, who gets one `prep_task_assigned`
// notification (digest) per event.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays, fmtDay } from '../../common/dates';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import { primaryMsManagerOf } from './job-support';
import { TenantJobRunner } from './tenant-job';

export interface AuditPrepResult {
  events: { eventId: string; msId: string; created: number; skippedFirstAudit: number }[];
  tasksCreated: number;
}

@Injectable()
@JobHandler('audit-prep.generate', { concurrency: 2, scope: 'tenant' })
export class AuditPrepGenerateJob implements JobHandlerInstance<'audit-prep.generate'> {
  private readonly logger = new Logger('audit-prep.generate');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async handle(job: JobRun<'audit-prep.generate'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, events: result.events.length, tasksCreated: result.tasksCreated }, 'audit-prep.generate done');
  }

  async run(orgId: string | null, requestId?: string): Promise<AuditPrepResult> {
    const org = await this.runner.organisation(orgId, 'audit-prep.generate');
    if (!org) return { events: [], tasksCreated: 0 };
    const today = await this.clock.today(org.id);
    return this.runner.run(org, (trx) => this.generate(trx, today), requestId);
  }

  private async generate(trx: Trx, today: string): Promise<AuditPrepResult> {
    // The next event of every system (the earliest not before today).
    const events = await trx
      .selectFrom('audit_event as e')
      .innerJoin('management_system as ms', 'ms.id', 'e.management_system_id')
      .select([
        'e.id',
        'e.management_system_id',
        'e.scheduled_at',
        'e.prep_window_days',
        'e.name_en',
        'e.name_id',
        'e.short_label',
        'ms.framework_version_id',
        'ms.code as ms_code',
        sql<boolean>`EXISTS (SELECT 1 FROM audit_event p WHERE p.management_system_id = e.management_system_id
                              AND p.deleted_at IS NULL AND p.scheduled_at < e.scheduled_at)`.as('has_earlier'),
        sql<boolean>`EXISTS (SELECT 1 FROM audit_prep_task t WHERE t.audit_event_id = e.id AND t.deleted_at IS NULL)`.as('has_tasks'),
      ])
      .where('e.deleted_at', 'is', null)
      .where('ms.deleted_at', 'is', null)
      .where('ms.status', '<>', 'archived')
      .where('e.scheduled_at', '>=', today)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('audit_event as n')
              .select('n.id')
              .whereRef('n.management_system_id', '=', 'e.management_system_id')
              .where('n.deleted_at', 'is', null)
              .where('n.scheduled_at', '>=', today)
              .where((eb) => eb.or([eb('n.scheduled_at', '<', eb.ref('e.scheduled_at')), eb.and([eb('n.scheduled_at', '=', eb.ref('e.scheduled_at')), eb('n.id', '<', eb.ref('e.id'))])])),
          ),
        ),
      )
      .orderBy('ms.position')
      .orderBy('e.scheduled_at')
      .execute();

    const result: AuditPrepResult = { events: [], tasksCreated: 0 };
    for (const event of events) {
      if (event.has_tasks) continue;
      if (addDays(event.scheduled_at, -event.prep_window_days) > today) continue;
      const templates = await trx
        .selectFrom('ref.prep_task_template')
        .select(['code', 'title', 'days_before_audit', 'skip_on_first_audit', 'sort_order'])
        .where('framework_version_id', '=', event.framework_version_id)
        .orderBy('sort_order')
        .orderBy('code')
        .execute();
      if (templates.length === 0) continue;
      const owner = await primaryMsManagerOf(trx, event.management_system_id);
      let created = 0;
      let skipped = 0;
      for (const template of templates) {
        if (template.skip_on_first_audit && !event.has_earlier) {
          skipped += 1;
          continue;
        }
        const row = await trx
          .insertInto('audit_prep_task')
          .values({
            audit_event_id: event.id,
            management_system_id: event.management_system_id,
            template_code: template.code,
            title: template.title,
            owner_user_id: owner,
            due_at: addDays(event.scheduled_at, -template.days_before_audit),
            status: 'not_started',
            position: template.sort_order,
            created_by: SYSTEM_USER_ID,
            updated_by: SYSTEM_USER_ID,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          action: 'register.created',
          actor: { userId: SYSTEM_USER_ID, kind: 'system' },
          msId: event.management_system_id,
          entityType: 'audit_prep_task',
          entityId: row.id,
          entityCode: template.code,
          after: { title: template.title, template: template.code, auditEventId: event.id, ownerUserId: owner },
        });
        created += 1;
      }
      result.events.push({ eventId: event.id, msId: event.management_system_id, created, skippedFirstAudit: skipped });
      result.tasksCreated += created;
      if (owner && created > 0) {
        await this.notifications.create(trx, {
          recipientUserId: owner,
          kind: 'prep_task_assigned',
          msId: event.management_system_id,
          digest: true,
          title: { en: `Audit preparation: ${event.name_en}`, id: `Persiapan audit: ${event.name_id}` },
          body: {
            en: `${created} preparation task(s) for ${event.name_en} on ${fmtDay(event.scheduled_at, 'en')} are assigned to you.`,
            id: `${created} tugas persiapan untuk ${event.name_id} pada ${fmtDay(event.scheduled_at, 'id')} ditugaskan kepada Anda.`,
          },
          ref: { module: 'audit', entityType: 'audit_event', id: event.id, code: event.short_label.slice(0, 80) },
          createdBy: SYSTEM_USER_ID,
        });
      }
    }
    return result;
  }
}
