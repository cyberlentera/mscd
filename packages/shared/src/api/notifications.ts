// Area `notifications` (owner from wave 9: WP-24): in-app notifications of the session user (D.2, D.3, E.6).
import { z } from 'zod';
import { NotificationKind } from '../enums.js';
import { IdParams, Instant, MsId, NoBody, Pair, QueryBoolean, RecordRef, Uuid, defineRoute, named, pageOf, pageQueryShape } from './common.js';
import type { RouteDef } from './common.js';

export const Notification = named(
  'Notification',
  z.object({
    id: Uuid, kind: NotificationKind, title: Pair, body: Pair, ms: MsId.nullable().optional(), ref: RecordRef.optional(), createdAt: Instant, readAt: Instant.nullable(),
  }),
  'In-app notification (D.2, E.6)',
  {
    valid: [{ id: '9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', kind: 'reminder', title: ['Reminder', 'Pengingat'], body: ['Reminder: Annual reassessment for Privileged credential misuse, due 10 Sep 2026', 'Pengingat: penilaian ulang tahunan untuk Privileged credential misuse, jatuh tempo 10 Sep 2026'], ms: 'isms', createdAt: '2026-09-29T02:00:00Z', readAt: null }],
    invalid: [{ id: '9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', kind: 'sms', title: ['a', 'b'], body: ['a', 'b'], createdAt: '2026-09-29T02:00:00Z', readAt: null }],
  },
);
export type Notification = z.infer<typeof Notification>;

export const NotificationsQuery = named('NotificationsQuery', z.strictObject({ ...pageQueryShape, unread: QueryBoolean.optional() }), 'GET /notifications query', {
  valid: [{}, { unread: 'true' }],
  invalid: [{ unread: 'yes' }],
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

export const notificationsListRoute = defineRoute({
  id: 'notifications.list',
  owner: 'WP-24',
  method: 'GET',
  path: '/api/v1/notifications',
  summary: 'Notifications of the session user, newest first',
  auth: 'session',
  query: NotificationsQuery,
  response: pageOf(Notification),
  errors: [],
});

export const notificationsReadRoute = defineRoute({
  id: 'notifications.read',
  owner: 'WP-24',
  method: 'POST',
  path: '/api/v1/notifications/:id/read',
  summary: 'Mark a notification read (its recipient only)',
  auth: 'session',
  params: IdParams,
  response: NoBody,
  status: 204,
  errors: [404],
});

export const routes: RouteDef[] = [notificationsListRoute, notificationsReadRoute];
