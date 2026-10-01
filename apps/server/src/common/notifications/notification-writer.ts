// In-app notifications (build plan E.6). `NotificationWriter.create(trx, ...)` checks that the recipient is an active
// member of the organisation (MembershipService), inserts the `notification` row in the caller's tenant transaction
// and, for notifications that are not digest-only, queues `notifications.dispatch` in the same transaction, so the
// email goes out only when the change commits.
import { Inject, Injectable } from '@nestjs/common';
import type { Messages, Pair } from '@mscd/shared';
import { JOB_QUEUE, type JobQueue } from '../jobs/job-queue';
import { currentRequestContext } from '../request-context';
import {
  MEMBERSHIP_SERVICE,
  SYSTEM_USER_ID,
  type MembershipService,
  type NotificationInput,
  type NotificationWriter,
  type Trx,
} from '../tokens';

function texts(value: Pair | Messages): { en: string; id: string } {
  return Array.isArray(value) ? { en: value[0], id: value[1] } : { en: value.en, id: value.id };
}

@Injectable()
export class TenantNotificationWriter implements NotificationWriter {
  constructor(
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {}

  async create(trx: Trx, input: NotificationInput): Promise<string | null> {
    if (!(await this.members.isMember(trx, input.recipientUserId, { allowGuests: true }))) return null;
    const title = texts(input.title);
    const body = texts(input.body);
    const context = currentRequestContext();
    const createdBy = input.createdBy !== undefined ? input.createdBy : (context?.userId ?? SYSTEM_USER_ID);
    const row = await trx
      .insertInto('notification')
      .values({
        recipient_user_id: input.recipientUserId,
        management_system_id: input.msId ?? null,
        kind: input.kind,
        title_en: title.en,
        title_id: title.id,
        body_en: body.en,
        body_id: body.id,
        entity_ref: input.ref ? JSON.stringify(input.ref) : null,
        digest: input.digest ?? false,
        created_by: createdBy,
        updated_by: createdBy,
      })
      .returning(['id', 'organization_id'])
      .executeTakeFirstOrThrow();
    if (!input.digest) {
      await this.jobs.send(
        'notifications.dispatch',
        {
          orgId: row.organization_id,
          requestId: context?.requestId,
          requestedBy: createdBy ?? undefined,
          payload: { notificationIds: [row.id] },
        },
        { singletonKey: `nd:${row.organization_id}:${row.id}`, retryLimit: 5 },
        trx,
      );
    }
    return row.id;
  }
}
