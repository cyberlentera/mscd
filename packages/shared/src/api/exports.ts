// Area `exports` (owner from wave 9: WP-24): asynchronous exports, synchronous register exports and the review
// calendar feed (D.2, D.3 "Page actions", E.2 export.build, F.13, F.15).
import { z } from 'zod';
import { BackgroundTaskKind, BackgroundTaskStatus, ExportFormat, ExportKind } from '../enums.js';
import { BinaryBody, CommandResult, MsId, MsParams, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

export const ExportRequest = named(
  'ExportRequest',
  z.strictObject({ type: ExportKind, ms: MsId.optional(), format: ExportFormat })
    .refine((r) => (r.type === 'portfolio_board') === (r.ms === undefined), { message: 'portfolio_board is organisation-wide; every other type needs ms', path: ['ms'] }),
  'POST /exports body: portfolio_board needs export.run in at least one system; audit_trail needs audit_trail.read in ms; other types export.run in ms',
  { valid: [{ type: 'portfolio_board', format: 'pdf' }, { type: 'readiness', ms: 'isms', format: 'pdf' }, { type: 'audit_trail', ms: 'isms', format: 'csv' }], invalid: [{ type: 'readiness', format: 'pdf' }, { type: 'portfolio_board', ms: 'isms', format: 'pdf' }, { type: 'soa', ms: 'isms', format: 'docx' }] },
);
export type ExportRequest = z.infer<typeof ExportRequest>;

export const BackgroundTask = named(
  'BackgroundTask',
  z.object({
    id: Uuid, kind: BackgroundTaskKind, status: BackgroundTaskStatus, progress: z.int().min(0).max(100), result: z.unknown().optional(),
    error: z.string().optional(), downloadUrl: z.string().optional(),
  }),
  'State of a background task (background_task)',
  { valid: [{ id: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b', kind: 'export', status: 'succeeded', progress: 100, downloadUrl: '/api/v1/exports/8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b/download' }], invalid: [{ id: 'x', kind: 'export', status: 'done', progress: 100 }] },
);
export type BackgroundTask = z.infer<typeof BackgroundTask>;

export const TaskIdParams = named('TaskIdParams', z.strictObject({ taskId: Uuid }), 'Path parameter {taskId}', {
  valid: [{ taskId: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b' }],
  invalid: [{ taskId: '42' }],
});
export type TaskIdParams = z.infer<typeof TaskIdParams>;

export const SheetExportQuery = named('SheetExportQuery', z.strictObject({ format: z.enum(['xlsx', 'csv']) }), 'Query of the synchronous SoA and document register exports', {
  valid: [{ format: 'xlsx' }],
  invalid: [{ format: 'pdf' }, {}],
});
export type SheetExportQuery = z.infer<typeof SheetExportQuery>;

export const CalendarFeed = named(
  'CalendarFeed',
  CommandResult.extend({ downloadUrl: z.string().startsWith('/api/v1/ms/') }),
  'Result of creating a review calendar feed: the feed URL with its token, shown once (D.2)',
  { valid: [{ ok: true, changed: [], downloadUrl: '/api/v1/ms/isms/surveillance/reviews.ics?token=Q2FsZW5kYXItVG9rZW4tMDEyMzQ1Njc4OWFiY2RlZg' }], invalid: [{ ok: true, changed: [] }] },
);
export type CalendarFeed = z.infer<typeof CalendarFeed>;

export const CalendarFeedQuery = named('CalendarFeedQuery', z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) }), 'Query of the calendar feed: the feed token', {
  valid: [{ token: 'Q2FsZW5kYXItVG9rZW4tMDEyMzQ1Njc4OWFiY2RlZg' }],
  invalid: [{}, { token: 'short' }],
});
export type CalendarFeedQuery = z.infer<typeof CalendarFeedQuery>;

export const IcsText = named('IcsText', z.string().startsWith('BEGIN:VCALENDAR'), 'iCalendar text (text/calendar)', {
  valid: ['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'],
  invalid: ['<html>', ''],
});

export const exportsCreateRoute = defineRoute({
  id: 'exports.create',
  owner: 'WP-24',
  method: 'POST',
  path: '/api/v1/exports',
  summary: 'Queue an export (portfolio board, readiness, SoA, document register, audit trail); answers 202 with taskId',
  auth: 'session',
  permissionBy: {
    source: 'body',
    member: 'type',
    cases: {
      'portfolio_board': { permission: 'export.run', scope: 'any_ms' },
      'audit_trail': { permission: 'audit_trail.read', scope: 'ms' },
      '*': { permission: 'export.run', scope: 'ms' },
    },
  },
  msSource: 'body',
  body: ExportRequest,
  response: CommandResult,
  status: 202,
  errors: [404, 422, 429],
  idempotent: true,
  readOnlyAllowed: true,
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});

export const exportsGetRoute = defineRoute({
  id: 'exports.get',
  owner: 'WP-24',
  method: 'GET',
  path: '/api/v1/exports/:taskId',
  summary: 'State of an export (its creator only)',
  auth: 'session',
  params: TaskIdParams,
  response: BackgroundTask,
  errors: [404],
});

export const exportsDownloadRoute = defineRoute({
  id: 'exports.download',
  owner: 'WP-24',
  method: 'GET',
  path: '/api/v1/exports/:taskId/download',
  summary: 'Download a finished export as an attachment (creator only; permission checked again)',
  auth: 'session',
  params: TaskIdParams,
  response: BinaryBody,
  responseType: 'application/octet-stream',
  file: true,
  errors: [404, 409],
});

export const exportsSoaRoute = defineRoute({
  id: 'exports.soa',
  owner: 'WP-24',
  method: 'GET',
  path: '/api/v1/ms/:ms/applicability/export',
  summary: 'Statement of Applicability as XLSX or CSV, formula-neutralised (F.15)',
  auth: 'session',
  permission: 'export.run',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  query: SheetExportQuery,
  response: BinaryBody,
  responseType: 'application/octet-stream',
  file: true,
  errors: [404, 429],
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});

export const exportsDocumentsRoute = defineRoute({
  id: 'exports.documents',
  owner: 'WP-24',
  method: 'GET',
  path: '/api/v1/ms/:ms/documents/export',
  summary: 'Document register as XLSX or CSV, formula-neutralised (F.15)',
  auth: 'session',
  permission: 'export.run',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  query: SheetExportQuery,
  response: BinaryBody,
  responseType: 'application/octet-stream',
  file: true,
  errors: [404, 429],
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});

export const calendarFeedCreateRoute = defineRoute({
  id: 'calendar-feed.create',
  owner: 'WP-24',
  method: 'POST',
  path: '/api/v1/ms/:ms/calendar-feed',
  summary: 'Create the review calendar feed of the user for the system (replaces an older token)',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  response: CalendarFeed,
  status: 201,
  errors: [404],
});

export const calendarFeedRevokeRoute = defineRoute({
  id: 'calendar-feed.revoke',
  owner: 'WP-24',
  method: 'POST',
  path: '/api/v1/ms/:ms/calendar-feed/revoke',
  summary: 'Revoke the review calendar feed of the user for the system',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  response: CommandResult,
  errors: [404],
});

export const calendarFeedIcsRoute = defineRoute({
  id: 'calendar-feed.ics',
  owner: 'WP-24',
  method: 'GET',
  path: '/api/v1/ms/:ms/surveillance/reviews.ics',
  summary: 'Review calendar (text/calendar) for a valid, unrevoked token whose user still holds ms.read',
  auth: 'public',
  params: MsParams,
  query: CalendarFeedQuery,
  response: IcsText,
  responseType: 'text/calendar',
  file: true,
  errors: [404, 429],
  rateLimits: [{ key: 'token', max: 60, windowSeconds: 3600 }],
});

export const routes: RouteDef[] = [
  exportsCreateRoute, exportsGetRoute, exportsDownloadRoute, exportsSoaRoute, exportsDocumentsRoute,
  calendarFeedCreateRoute, calendarFeedRevokeRoute, calendarFeedIcsRoute,
];
