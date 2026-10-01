// The routes of the API data source follow the shared route table (packages/shared, WP-05): same method and path for
// every call of the H.4 table, and request bodies the shared schemas accept.
import { describe, expect, it } from 'vitest';
import { API_ROUTES, API_ROUTE_IDS } from '../../src/data/api/wire';
import { routeById } from '../../../../packages/shared/src/api/routes';
import { AssignmentRequest, CompleteActionRequest } from '../../../../packages/shared/src/api/records';
import { BulkReminderRequest, ReminderRequest } from '../../../../packages/shared/src/api/reminders';
import { ActivityTransitionRequest, ApplicabilityTransitionRequest } from '../../../../packages/shared/src/api/implementation';
import { DocumentTransitionRequest } from '../../../../packages/shared/src/api/documents';
import { BrowseQuery, DocumentVersionRequest, EvidenceFileRequest, UploadIntentRequest } from '../../../../packages/shared/src/api/files';
import { ExportRequest } from '../../../../packages/shared/src/api/exports';
import { AuditorAccessRequest } from '../../../../packages/shared/src/api/auditor-access';
import { EvidencePackRequest } from '../../../../packages/shared/src/api/evidence-packs';
import { MoveRequest } from '../../../../packages/shared/src/api/storage';
import { DemoPersonaRequest, SwitchOrgRequest } from '../../../../packages/shared/src/api/me';
import { UiMsSnapshot, UiOrgSnapshot } from '../../../../packages/shared/src/ui/snapshot';
import { TaskList } from '../../../../packages/shared/src/api/ui';
import { Me } from '../../../../packages/shared/src/api/me';
import { meOf, readRoutes, sourceWith, uuidOf, wireOf } from './fixtures';

// Test data of many shapes (wire snapshots, view models) is read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

describe('API data source routes', () => {
  it('match the method and path of the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(API_ROUTES)) {
      const def = routeById(API_ROUTE_IDS[name as keyof typeof API_ROUTES]);
      expect(def, name).toBeDefined();
      expect([def!.method, def!.path], name).toEqual([method, path]);
    }
  });

  it('the test fixtures are valid wire snapshots of the shared contract', async () => {
    const fx = await wireOf();
    expect(UiOrgSnapshot.safeParse(fx.org).error).toBeUndefined();
    for (const snap of Object.values(fx.ms)) expect(UiMsSnapshot.safeParse(snap).error).toBeUndefined();
    expect(TaskList.safeParse(fx.tasks).error).toBeUndefined();
    expect(Me.safeParse(meOf()).error).toBeUndefined();
  });

  it('every request body of a command is accepted by the shared schema', async () => {
    const fx = await wireOf();
    const env = sourceWith({ ...readRoutes(fx, meOf()) });
    const snap = (await env.ds.load()) as AnyRecord;
    env.calls.length = 0;
    const ev = snap.bundles.isms.evs[0];
    const act = snap.bundles.isms.phases[0].acts[0];
    const file = { src: 'sp', index: 0, ref: { repositoryId: 'sp', externalItemId: 'demo-sp-picker-1', externalVersionId: '3.0' } };
    const checks: [() => Promise<unknown>, { safeParse(v: unknown): { error?: unknown } }][] = [
      [() => env.ds.markComplete('isms:req:A.8.13'), ApplicabilityTransitionRequest],
      [() => env.ds.verify('isms:req:A.8.13', 'implemented'), ApplicabilityTransitionRequest],
      [() => env.ds.verify(act.key, 'verified'), ActivityTransitionRequest],
      [() => env.ds.recordBlocker(act.key, 'A.8.12', 'Blocked by gate item A.8.12'), ActivityTransitionRequest],
      [() => env.ds.assign('isms:soa:A.8.13', 'none', null), AssignmentRequest],
      [() => env.ds.assign('isms:doc:POL-01', 'bagus', '2026-10-20'), AssignmentRequest],
      [() => env.ds.remind('isms:doc:POL-01', 'rina'), ReminderRequest],
      [() => env.ds.remind('isms:x:R-777', 'rina'), ReminderRequest],
      [() => env.ds.remindAll('isms'), BulkReminderRequest],
      [() => env.ds.completeRecordAction(snap.tasks[0].key), CompleteActionRequest],
      [() => env.ds.startReview('isms:doc:POL-01'), DocumentTransitionRequest],
      [() => env.ds.linkFile(`isms:ev:${ev.code}`, file), EvidenceFileRequest],
      [() => env.ds.linkFile('isms:doc:POL-01', file), DocumentVersionRequest],
      [() => env.ds.pageAction('isms', 'exportReadiness'), ExportRequest],
      [() => env.ds.pageAction('isms', 'exportBoard'), ExportRequest],
      [() => env.ds.pageAction('isms', 'auditorAccess', 'lead@certifier.co.id'), AuditorAccessRequest],
      [() => env.ds.pageAction('isms', 'evidencePack'), EvidencePackRequest],
      [() => env.ds.repositoryAction(snap.REPOS[0].id, 'test'), { safeParse: (v: unknown) => (v === undefined ? {} : { error: 'unexpected body' }) }],
      [() => env.ds.switchPersona('owner').catch(() => null), DemoPersonaRequest],
      [() => env.ds.switchOrg('bsd').catch(() => null), SwitchOrgRequest],
    ];
    for (const [run, schema] of checks) {
      env.calls.length = 0;
      await run();
      const sent = env.calls.find((c) => c.method !== 'GET');
      expect(sent, String(run)).toBeDefined();
      expect(schema.safeParse(sent!.body).error, `${sent!.method} ${sent!.path}`).toBeUndefined();
    }
    // Upload intent and browse query.
    env.calls.length = 0;
    await env.ds.uploadFile(`isms:ev:${ev.code}`, new File(['x'], 'a.pdf'));
    expect(UploadIntentRequest.safeParse(env.calls[0].body).error).toBeUndefined();
    env.calls.length = 0;
    await env.ds.listPickerFiles(`isms:ev:${ev.code}`, 'sp').catch(() => null);
    expect(BrowseQuery.safeParse(Object.fromEntries(new URL(env.calls[0].url, 'http://x').searchParams)).error).toBeUndefined();
    const od = snap.REPOS.find((r: AnyRecord) => (r.actions ?? []).includes('moveToLibrary'));
    if (od) {
      env.calls.length = 0;
      await env.ds.repositoryAction(od.id, 'moveToLibrary', 'isms');
      expect(MoveRequest.safeParse(env.calls[0].body).error).toBeUndefined();
    }
    expect(uuidOf('x')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
