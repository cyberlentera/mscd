// Area `audit-events` (owner from wave 9: WP-35): audit events (BR-42), preparation tasks (BR-43, A-23) and cycle
// items (TS 6.8) (D.2, D.3, C.13).
import { z } from 'zod';
import { AuditEventType, AuditOutcome, TaskProgressStatus } from '../enums.js';
import { CommandResult, IsoDate, MsParams, MsRecordParams, PersonId, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

const Note = z.string().trim().min(1).max(2000);

const auditEventShape = {
  eventType: AuditEventType,
  nameEn: z.string().trim().min(1).max(200),
  nameId: z.string().trim().min(1).max(200),
  shortLabel: z.string().trim().min(1).max(80),
  scheduledAt: IsoDate,
  auditDays: z.int().min(1).max(365).optional(),
  leadAuditorName: z.string().trim().min(1).max(150).optional(),
  expectedFocus: z.string().trim().max(4000).optional(),
  prepWindowDays: z.int().min(0).max(365).optional(),
};

export const AuditEventCreateRequest = named(
  'AuditEventCreateRequest',
  z.strictObject(auditEventShape),
  'POST /ms/{ms}/audit-events body',
  {
    valid: [{ eventType: 'stage1', nameEn: 'Stage 1 audit', nameId: 'Audit tahap 1', shortLabel: 'Stage 1', scheduledAt: '2027-02-10', auditDays: 1, prepWindowDays: 60 }],
    invalid: [{ eventType: 'stage3', nameEn: 'x', nameId: 'x', shortLabel: 'x', scheduledAt: '2027-02-10' }, { eventType: 'stage1', nameEn: 'x', nameId: 'x', shortLabel: 'x', scheduledAt: '2027-02-10', prepWindowDays: 400 }],
  },
);
export type AuditEventCreateRequest = z.infer<typeof AuditEventCreateRequest>;

export const AuditEventPatch = named(
  'AuditEventPatch',
  z.strictObject({
    eventType: auditEventShape.eventType.optional(),
    nameEn: auditEventShape.nameEn.optional(),
    nameId: auditEventShape.nameId.optional(),
    shortLabel: auditEventShape.shortLabel.optional(),
    scheduledAt: IsoDate.optional(),
    auditDays: auditEventShape.auditDays.nullable(),
    leadAuditorName: auditEventShape.leadAuditorName.nullable(),
    expectedFocus: auditEventShape.expectedFocus.nullable(),
    prepWindowDays: auditEventShape.prepWindowDays,
    outcome: AuditOutcome.nullable().optional(),
    outcomeSummary: z.string().trim().max(4000).nullable().optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/audit-events/{id} body; moving the date flags violating preparation tasks and notifies their holders (BR-42, A-26)',
  { valid: [{ scheduledAt: '2026-11-19' }, { outcome: 'recommended', outcomeSummary: 'Certified, 1 OFI' }], invalid: [{}, { outcome: 'passed' }] },
);
export type AuditEventPatch = z.infer<typeof AuditEventPatch>;

export const PrepTaskCreate = named(
  'PrepTaskCreate',
  z.strictObject({ title: z.string().trim().min(1).max(255), ownerHandle: PersonId, dueAt: IsoDate, status: TaskProgressStatus.optional(), note: Note.optional() }),
  'POST /ms/{ms}/audit-events/{id}/prep-tasks body; the due date must be before the audit (BR-43)',
  { valid: [{ title: 'Brief auditees on sampling focus', ownerHandle: 'rina', dueAt: '2026-11-09' }], invalid: [{ title: '', ownerHandle: 'rina', dueAt: '2026-11-09' }, { title: 'x', ownerHandle: 'rina' }] },
);
export type PrepTaskCreate = z.infer<typeof PrepTaskCreate>;

export const PrepTaskPatch = named(
  'PrepTaskPatch',
  z.strictObject({ title: z.string().trim().min(1).max(255).optional(), ownerHandle: PersonId.optional(), dueAt: IsoDate.optional(), status: TaskProgressStatus.optional(), note: Note.nullable().optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/prep-tasks/{id} body; status changes follow C.13 (blocked needs a note, A-23)',
  { valid: [{ status: 'done' }, { status: 'blocked', note: 'Waiting for the certifier' }, { dueAt: '2026-11-01' }], invalid: [{}, { status: 'finished' }] },
);
export type PrepTaskPatch = z.infer<typeof PrepTaskPatch>;

export const CycleItemPatch = named(
  'CycleItemPatch',
  z.strictObject({ status: TaskProgressStatus.optional(), note: Note.nullable().optional(), ownerHandle: PersonId.optional(), dueAt: IsoDate.optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/cycle-items/{id} body (TS 6.8, C.13)',
  { valid: [{ status: 'in_progress' }, { note: '5 of 7 inputs prepared', ownerHandle: 'hendra' }], invalid: [{}, { status: 'progress' }] },
);
export type CycleItemPatch = z.infer<typeof CycleItemPatch>;

export const auditEventsCreateRoute = defineRoute({
  id: 'audit-events.create',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/audit-events',
  summary: 'Plan an audit event',
  auth: 'session',
  permission: 'audit_event.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: AuditEventCreateRequest,
  response: CommandResult,
  status: 201,
  errors: [422],
  idempotent: true,
});

export const auditEventsUpdateRoute = defineRoute({
  id: 'audit-events.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/audit-events/:id',
  summary: 'Change an audit event; count is the number of holders notified of a date change (BR-42)',
  auth: 'session',
  permission: 'audit_event.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: AuditEventPatch,
  response: CommandResult,
  errors: [404, 412, 422],
  ifMatch: true,
});

export const prepTasksCreateRoute = defineRoute({
  id: 'prep-tasks.create',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/audit-events/:id/prep-tasks',
  summary: 'Add a preparation task to an audit event (BR-43)',
  auth: 'session',
  permission: 'audit_event.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: PrepTaskCreate,
  response: CommandResult,
  status: 201,
  errors: [404, 422],
  idempotent: true,
});

export const prepTasksUpdateRoute = defineRoute({
  id: 'prep-tasks.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/prep-tasks/:id',
  summary: 'Update a preparation task (status per C.13; BR-43 for the due date)',
  auth: 'session',
  permission: 'prep_task.update',
  machine: 'audit_prep_task.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: PrepTaskPatch,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const cycleItemsUpdateRoute = defineRoute({
  id: 'cycle-items.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/cycle-items/:id',
  summary: 'Update a cycle requirement item (status per C.13)',
  auth: 'session',
  permission: 'cycle_item.update',
  machine: 'cycle_requirement_status.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: CycleItemPatch,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const routes: RouteDef[] = [auditEventsCreateRoute, auditEventsUpdateRoute, prepTasksCreateRoute, prepTasksUpdateRoute, cycleItemsUpdateRoute];
