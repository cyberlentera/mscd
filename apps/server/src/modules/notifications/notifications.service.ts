// In-app notifications of the session user (build plan D.3, E.6): `GET /notifications?unread=` (newest first,
// paginated) and `POST /notifications/{id}/read` (the recipient only; anyone else gets 404). A notification belongs
// to its recipient alone, so no other scope applies.
import { Injectable } from '@nestjs/common';
import { RecordRef, type Notification, type NotificationsQuery, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';

interface ListedRow {
  id: string;
  kind: Notification['kind'];
  title_en: string;
  title_id: string;
  body_en: string;
  body_id: string;
  entity_ref: unknown;
  created_at: Date;
  read_at: Date | null;
  ms: string | null;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
  ) {}

  async list(principal: Principal, query: NotificationsQuery): Promise<Page<Notification>> {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const unreadOnly = query.unread === true;
      const where = sql`n.recipient_user_id = ${principal.user.id}::uuid and n.deleted_at is null${unreadOnly ? sql` and n.read_at is null` : sql``}`;
      const total = await sql<{ n: string }>`select count(*) as n from notification n where ${where}`.execute(trx);
      const { rows } = await sql<ListedRow>`
        select n.id, n.kind, n.title_en, n.title_id, n.body_en, n.body_id, n.entity_ref, n.created_at, n.read_at, ms.slug as ms
        from notification n
        left join management_system ms on ms.id = n.management_system_id
        where ${where}
        order by n.created_at desc, n.id desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`.execute(trx);
      return {
        items: rows.map((r) => this.toNotification(r)),
        page: query.page,
        pageSize: query.pageSize,
        total: Number(total.rows[0]?.n ?? 0),
      };
    });
  }

  /** Marks a notification read; reading it again keeps the first time. 404 unless the caller is the recipient. */
  async markRead(principal: Principal, id: string): Promise<void> {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await trx
        .selectFrom('notification')
        .select(['id', 'read_at'])
        .where('id', '=', id)
        .where('recipient_user_id', '=', principal.user.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('No such notification');
      if (row.read_at) return;
      const now = this.clock.now();
      await trx.updateTable('notification').set({ read_at: now, updated_at: now, updated_by: principal.user.id }).where('id', '=', id).execute();
    });
  }

  private toNotification(row: ListedRow): Notification {
    const ref = RecordRef.safeParse(row.entity_ref);
    return {
      id: row.id,
      kind: row.kind,
      title: [row.title_en, row.title_id],
      body: [row.body_en, row.body_id],
      ...(row.ms ? { ms: row.ms } : {}),
      ...(ref.success ? { ref: ref.data } : {}),
      createdAt: new Date(row.created_at).toISOString(),
      readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    };
  }
}
