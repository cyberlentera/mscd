// Area `reminders` (owner from wave 9: WP-35): single and bulk reminders (D.2, D.3, E.5, BR-50).
import { z } from 'zod';
import { CommandResult, Handle, Instant, MsId, RecordKey, RecordRef, commandResultWith, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { RecordEntityType } from './records.js';

const EXAMPLE_REF = { module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-014' } as const;

export const ReminderRequest = named(
  'ReminderRequest',
  z.union([
    z.strictObject({ ms: MsId, ref: RecordRef.extend({ entityType: RecordEntityType }), recipient: Handle }),
    z.strictObject({ ms: MsId, recordKey: RecordKey, recipient: Handle }),
  ]),
  'POST /reminders body: the system (the record must belong to it), the record by ref or by record key, and the recipient',
  {
    valid: [{ ms: 'isms', ref: EXAMPLE_REF, recipient: 'bagus' }, { ms: 'isms', recordKey: 'isms:x:R-014', recipient: 'bagus' }],
    invalid: [{ ref: EXAMPLE_REF, recipient: 'bagus' }, { ms: 'isms', ref: { ...EXAMPLE_REF, entityType: 'app_user' }, recipient: 'bagus' }, { ms: 'isms', recordKey: 'isms:x:R-014', recipient: 'none' }],
  },
);
export type ReminderRequest = z.infer<typeof ReminderRequest>;

export const BulkReminderRequest = named('BulkReminderRequest', z.strictObject({ ms: MsId, scope: z.literal('open_chain_items') }), 'POST /reminders/bulk body: remind every holder of an open chain item of the system', {
  valid: [{ ms: 'isms', scope: 'open_chain_items' }],
  invalid: [{ ms: 'isms' }, { ms: 'isms', scope: 'everyone' }],
});
export type BulkReminderRequest = z.infer<typeof BulkReminderRequest>;

export const BulkReminderResult = named(
  'BulkReminderResult',
  commandResultWith(z.object({ skipped: z.array(z.object({ recipient: Handle, recordKey: RecordKey, lastSentAt: Instant })) })),
  'Result of a bulk reminder: count sent and the reminders skipped by the 72-hour throttle (BR-50)',
  {
    valid: [{ ok: true, changed: [], count: 8, message: ['Reminders sent to 8 holders', 'Pengingat dikirim ke 8 pemegang'], data: { skipped: [{ recipient: 'dewi', recordKey: 'isms:x:R-027', lastSentAt: '2026-09-28T02:00:00Z' }] } }],
    invalid: [{ ok: true, changed: [], data: { skipped: [{ recipient: 'dewi' }] } }],
  },
);
export type BulkReminderResult = z.infer<typeof BulkReminderResult>;

export const remindersSendRoute = defineRoute({
  id: 'reminders.send',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/reminders',
  summary: 'Send a reminder about one record to its holder (BR-50 throttle of 72 hours)',
  auth: 'session',
  permission: 'reminder.send',
  scope: 'ms',
  msSource: 'body',
  body: ReminderRequest,
  response: CommandResult,
  errors: [404, 422],
});

export const remindersBulkRoute = defineRoute({
  id: 'reminders.bulk',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/reminders/bulk',
  summary: 'Remind every holder of an open chain item of the system',
  auth: 'session',
  permission: 'reminder.send',
  scope: 'ms',
  msSource: 'body',
  body: BulkReminderRequest,
  response: BulkReminderResult,
  errors: [404],
});

export const routes: RouteDef[] = [remindersSendRoute, remindersBulkRoute];
