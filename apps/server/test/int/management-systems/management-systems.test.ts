// Management system administration (TS 6.2, C.13, D-30): creation on an installed edition with the activity copies,
// BR-21 and LIC-MS, the ms.admin status moves (setup to implementing, archive), the edition transitions of
// POST /ms/{ms}/transitions (feature edition_transition) and their permissions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { addMember, createPackApp, devLicence, grantRole, installDevPacks, orgIdentities, type PackApp } from '../packs/fixtures';

const as = (who: string) => ({ [FAKE_PRINCIPAL_HEADER]: who });
const BASE = { scopeStatement: 'Head office and data centre', defaultRepository: 'vault', color: '#e8731a' };

describe('management systems (TS 6.2, C.13, D-30)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let users: { ta: string; mm: string; do: string };
  let app: PackApp;

  const tenantRows = <T>(fn: Parameters<typeof inScope<T>>[2]) => inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, fn);
  const create = (body: Record<string, unknown>, who = 'ta@ndt') => app.app.inject({ method: 'POST', url: '/api/v1/admin/management-systems', headers: as(who), payload: body });
  const patch = (id: string, body: Record<string, unknown>, who = 'ta@ndt') => app.app.inject({ method: 'PATCH', url: `/api/v1/admin/management-systems/${id}`, headers: as(who), payload: body });
  const transition = (ms: string, body: Record<string, unknown>, who = 'mm@ndt') => app.app.inject({ method: 'POST', url: `/api/v1/ms/${ms}/transitions`, headers: as(who), payload: body });
  const licence = (overrides: Record<string, unknown>) =>
    app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as('ta@ndt'), payload: devLicence(tenant.id, overrides) }).then((r) => expect(r.statusCode).toBe(200));

  beforeAll(async () => {
    tenant = await createTenant(db, 'ndt');
    users = {
      ta: await addMember(db, 'ta.ndt', tenant.id, ['tenant_admin']),
      mm: await addMember(db, 'mm.ndt', tenant.id),
      do: await addMember(db, 'do.ndt', tenant.id),
    };
    await installDevPacks(db, ['ISO27001-2022', 'ISO9001-2015', 'ISO9001-2026', 'ISO22301-2019', 'ISO37001-2016', 'ISO37001-2025']);
    app = await createPackApp(db, { identities: orgIdentities(tenant, users, ['isms', 'qms', 'bcms', 'abms', 'qms2']) });
    await licence({ frameworks: ['ISO27001', 'ISO9001', 'ISO37001'], max_management_systems: 3, features: ['integrated_mode'] });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('creates a system on an installed edition and copies the activity templates (D-30)', async () => {
    const created = await create({ slug: 'isms', code: 'ISMS', name: 'Information security management system', packId: 'ISO27001-2022', edition: '2022', certificationBody: 'Garuda Cert', ...BASE });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      slug: 'isms', code: 'ISMS', frameworkCode: 'ISO27001', frameworkName: 'ISO/IEC 27001', edition: '2022', packId: 'ISO27001-2022', packVersion: '1.2.0',
      transitionTargetEdition: null, applicabilityTarget: 'catalogue_item', status: 'setup', certificationBody: 'Garuda Cert', defaultRepository: 'vault', position: 0,
    });
    const id = created.json().id as string;
    const copies = await tenantRows((trx) =>
      trx.selectFrom('implementation_activity_progress').select(['phase_no', 'activity_no', 'title', 'is_gate_phase', 'template_pack_version', 'status', 'output_document_code']).where('management_system_id', '=', id).orderBy('phase_no').orderBy('activity_no').execute(),
    );
    expect(copies).toHaveLength(69);
    expect(copies[0]).toEqual({ phase_no: 1, activity_no: 1, title: 'Secure top management mandate', is_gate_phase: false, template_pack_version: '1.2.0', status: 'not_started', output_document_code: null });
    expect(new Set(copies.filter((c) => c.is_gate_phase).map((c) => c.phase_no))).toEqual(new Set([4]));
    const versions = await tenantRows((trx) => trx.selectFrom('management_system_version').select(['role', 'activated_at', 'ended_at']).where('management_system_id', '=', id).execute());
    expect(versions).toEqual([{ role: 'active', activated_at: '2026-09-29', ended_at: null }]);
    const readiness = await tenantRows((trx) => trx.selectFrom('clause_readiness').select('clause_group').where('management_system_id', '=', id).orderBy('clause_group').execute());
    expect(readiness.map((r) => r.clause_group)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    const audit = await tenantRows((trx) => trx.selectFrom('audit_trail').select(['action', 'management_system_id', 'edition', 'after_data']).where('action', '=', 'ms.created').execute());
    expect(audit).toEqual([expect.objectContaining({ management_system_id: id, edition: 'ISO27001-2022 1.2.0', after_data: expect.objectContaining({ activities_copied: 69 }) })]);

    const list = await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((m: { slug: string }) => m.slug)).toEqual(['isms']);
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('mm@ndt') })).statusCode).toBe(403);
    expect((await create({ slug: 'qms2', code: 'QMS2', name: 'x', packId: 'ISO9001-2026', edition: '2026', ...BASE }, 'mm@ndt')).statusCode).toBe(403);
  });

  it('refuses an unlicensed framework (BR-21), a duplicate, unknown references, a withdrawn edition and the system over the limit (LIC-MS)', async () => {
    const unlicensed = await create({ slug: 'bcms', code: 'BCMS', name: 'Business continuity', packId: 'ISO22301-2019', edition: '2019', ...BASE });
    expect(unlicensed.statusCode).toBe(422);
    expect(unlicensed.json()).toMatchObject({ rule: 'BR-21', messages: { en: "This framework is not yet included in your organisation's licence. Contact your administrator." } });
    expect((await create({ slug: 'isms', code: 'ISMS2', name: 'x', packId: 'ISO27001-2022', edition: '2022', ...BASE })).statusCode).toBe(409);
    const unknownEdition = await create({ slug: 'qms', code: 'QMS', name: 'x', packId: 'ISO9001-2015', edition: '2008', ...BASE });
    expect(unknownEdition.statusCode).toBe(400);
    expect(unknownEdition.json().errors[0].path).toBe('body.edition');
    const unknownRepository = await create({ slug: 'qms', code: 'QMS', name: 'x', packId: 'ISO9001-2015', edition: '2015', ...BASE, defaultRepository: 'nowhere' });
    expect(unknownRepository.statusCode).toBe(400);
    const withdrawn = await create({ slug: 'abms', code: 'ABMS', name: 'x', packId: 'ISO37001-2016', edition: '2016', ...BASE });
    expect(withdrawn.statusCode).toBe(409);
    expect(withdrawn.json()).toMatchObject({ messageKey: 'ms.edition_withdrawn' });

    const abms = await create({ slug: 'abms', code: 'ABMS', name: 'Anti-bribery', packId: 'ISO37001-2025', edition: '2025', ...BASE, color: '#7a3fbf' });
    expect(abms.statusCode).toBe(201);
    const beta = await tenantRows((trx) => trx.selectFrom('ms_alert').select(['kind', 'tone']).where('management_system_id', '=', abms.json().id).execute());
    expect(beta).toEqual([{ kind: 'beta', tone: 'info' }]);
    expect((await create({ slug: 'qms', code: 'QMS', name: 'Quality', packId: 'ISO9001-2015', edition: '2015', ...BASE })).statusCode).toBe(201);
    const over = await create({ slug: 'qms2', code: 'QMS2', name: 'Quality 2', packId: 'ISO9001-2026', edition: '2026', ...BASE });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({ rule: 'LIC-MS' });
  });

  it('moves setup to implementing only with an MS Manager, and archives only without an active cycle', async () => {
    const [isms] = (await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { id: string; slug: string }[];
    expect(isms!.slug).toBe('isms');
    const noManager = await patch(isms!.id, { status: 'implementing' });
    expect(noManager.statusCode).toBe(409);
    expect(noManager.json()).toMatchObject({ messageKey: 'ms.manager_required' });
    await grantRole(db, tenant, isms!.id, users.mm);
    const implementing = await patch(isms!.id, { status: 'implementing', color: '#123456', scopeStatement: 'Whole company' });
    expect(implementing.statusCode).toBe(200);
    expect(implementing.json()).toMatchObject({ status: 'implementing', color: '#123456', scopeStatement: 'Whole company' });
    const updated = await tenantRows((trx) => trx.selectFrom('audit_trail').select(['before_data', 'after_data']).where('action', '=', 'ms.updated').execute());
    expect(updated.at(-1)).toEqual({
      before_data: { status: 'setup', color: '#e8731a', scope_statement: 'Head office and data centre' },
      after_data: { status: 'implementing', color: '#123456', scope_statement: 'Whole company' },
    });

    const abms = ((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { id: string; slug: string }[]).find((m) => m.slug === 'abms')!;
    const cycle = await tenantRows((trx) =>
      trx.insertInto('certification_cycle').values({ management_system_id: abms.id, cycle_start: '2026-01-01', cycle_end: '2029-01-01', status: 'active' }).returning('id').executeTakeFirstOrThrow(),
    );
    const blocked = await patch(abms.id, { status: 'archived' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ messageKey: 'ms.active_cycle' });
    await tenantRows((trx) => trx.updateTable('certification_cycle').set({ status: 'closed' }).where('id', '=', cycle.id).execute());
    expect((await patch(abms.id, { status: 'archived' })).json()).toMatchObject({ status: 'archived' });
    expect((await patch(abms.id, { color: '#000000' })).statusCode).toBe(409);
    expect((await patch(abms.id, { status: 'implementing' })).statusCode).toBe(409);
    expect((await patch('5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c', { color: '#000000' })).statusCode).toBe(404);
    expect((await patch(abms.id, { color: '#000000' }, 'do@ndt')).statusCode).toBe(403);

    // An archived system no longer counts against max_management_systems.
    expect((await create({ slug: 'qms2', code: 'QMS2', name: 'Quality 2', packId: 'ISO9001-2026', edition: '2026', ...BASE })).statusCode).toBe(201);
  });

  it('runs an edition transition with the edition_transition feature and a recommended transition audit', async () => {
    const qms = ((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { id: string; slug: string }[]).find((m) => m.slug === 'qms')!;
    expect((await transition('qms', { to: 'transitioning', targetEdition: '2026' })).statusCode).toBe(409); // still in setup
    await tenantRows((trx) => trx.updateTable('management_system').set({ status: 'certified' }).where('id', '=', qms.id).execute());
    // implementing to certified is the system-only C.13 row (the certification cycle sets it), never this route.
    const implementingToCertified = async () => {
      const refused = await transition('isms', { to: 'certified' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().type).toBe('https://mscd.cyberlentera.com/problems/transition-not-allowed');
      expect(refused.json().detail).toBe('Transition from implementing to certified is not allowed');
    };
    await implementingToCertified();

    const noFeature = await transition('qms', { to: 'transitioning', targetEdition: '2026' });
    expect(noFeature.statusCode).toBe(422);
    expect(noFeature.json()).toMatchObject({ rule: 'LIC-FEATURE', messageKey: 'licence.feature.edition_transition' });
    await licence({ frameworks: ['ISO27001', 'ISO9001', 'ISO37001'], max_management_systems: 3, features: ['integrated_mode', 'edition_transition'] });
    await implementingToCertified();

    expect((await transition('qms', { to: 'transitioning', targetEdition: '2026' }, 'ta@ndt')).statusCode).toBe(403);
    expect((await transition('qms', { to: 'transitioning', targetEdition: '2019' })).statusCode).toBe(400);
    expect((await transition('qms', { to: 'transitioning', targetEdition: '2015' })).statusCode).toBe(400);
    expect((await transition('nope', { to: 'certified' })).statusCode).toBe(404);
    const started = await transition('qms', { to: 'transitioning', targetEdition: '2026' });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ ok: true, changed: ['qms'], message: ['QMS is transitioning to ISO 9001:2026', 'QMS sedang bertransisi ke ISO 9001:2026'] });
    let view = ((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { slug: string }[]).find((m) => m.slug === 'qms');
    expect(view).toMatchObject({ status: 'transitioning', edition: '2015', transitionTargetEdition: '2026' });
    expect((await transition('qms', { to: 'transitioning', targetEdition: '2026' })).statusCode).toBe(409);

    const noAudit = await transition('qms', { to: 'certified' });
    expect(noAudit.statusCode).toBe(409);
    expect(noAudit.json()).toMatchObject({ messageKey: 'ms.transition_audit_required' });
    // A recommended transition audit of an earlier transition (created and held before this one started) does not count.
    await tenantRows((trx) =>
      trx
        .insertInto('audit_event')
        .values({
          management_system_id: qms.id, event_type: 'transition', name_en: 'Earlier transition audit', name_id: 'Audit transisi sebelumnya', short_label: 'Transition',
          scheduled_at: '2025-01-15', outcome: 'recommended', created_at: new Date('2025-01-20T08:00:00Z'),
        })
        .execute(),
    );
    const oldAudit = await transition('qms', { to: 'certified' });
    expect(oldAudit.statusCode).toBe(409);
    expect(oldAudit.json()).toMatchObject({ messageKey: 'ms.transition_audit_required' });
    await tenantRows((trx) =>
      trx
        .insertInto('audit_event')
        .values({ management_system_id: qms.id, event_type: 'transition', name_en: 'Transition audit', name_id: 'Audit transisi', short_label: 'Transition', scheduled_at: '2026-09-01', outcome: 'recommended' })
        .execute(),
    );
    const done = await transition('qms', { to: 'certified' });
    expect(done.statusCode).toBe(200);
    view = ((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { slug: string }[]).find((m) => m.slug === 'qms');
    expect(view).toMatchObject({ status: 'certified', edition: '2026', packId: 'ISO9001-2026', transitionTargetEdition: null });
    // TS 6.3: never back to an older edition (2015 is in transition and 2026 supersedes it).
    const backwards = await transition('qms', { to: 'transitioning', targetEdition: '2015' });
    expect(backwards.statusCode).toBe(409);
    expect(backwards.json()).toMatchObject({ messageKey: 'ms.transition_not_newer' });

    const versions = await tenantRows((trx) =>
      trx
        .selectFrom('management_system_version as v')
        .innerJoin('ref.framework_version as f', 'f.id', 'v.framework_version_id')
        .select(['f.edition', 'v.role', 'v.ended_at'])
        .where('v.management_system_id', '=', qms.id)
        .orderBy('v.created_at')
        .execute(),
    );
    expect(versions).toEqual([
      { edition: '2015', role: 'previous', ended_at: '2026-09-29' },
      { edition: '2026', role: 'active', ended_at: null },
    ]);
    const alerts = await tenantRows((trx) => trx.selectFrom('ms_alert').select(['kind', 'resolved_at']).where('management_system_id', '=', qms.id).where('kind', '=', 'transition').execute());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolved_at).not.toBeNull();
    const audit = await tenantRows((trx) => trx.selectFrom('audit_trail').select(['before_data', 'after_data']).where('action', '=', 'ms.transition').orderBy('seq').execute());
    expect(audit.map((a) => [(a.before_data as { status: string }).status, (a.after_data as { status: string }).status])).toEqual([
      ['certified', 'transitioning'],
      ['transitioning', 'certified'],
    ]);
  });

  it('moves a system on a withdrawn edition to the current edition of its framework, which records no supersession', async () => {
    // ISO 37001:2025 (current, pre-release) names no superseded edition; 2016 is withdrawn.
    const abms = ((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { id: string; slug: string }[]).find((m) => m.slug === 'abms')!;
    await tenantRows(async (trx) => {
      const old = await trx.selectFrom('ref.framework_version').select('id').where('pack_id', '=', 'ISO37001-2016').executeTakeFirstOrThrow();
      await trx.updateTable('management_system').set({ status: 'certified', framework_version_id: old.id }).where('id', '=', abms.id).execute();
    });
    const started = await transition('abms', { to: 'transitioning', targetEdition: '2025' });
    expect(started.statusCode).toBe(200);
    const view = ((await app.app.inject({ method: 'GET', url: '/api/v1/admin/management-systems', headers: as('ta@ndt') })).json() as { slug: string }[]).find((m) => m.slug === 'abms');
    expect(view).toMatchObject({ status: 'transitioning', edition: '2016', transitionTargetEdition: '2025' });
  });
});
