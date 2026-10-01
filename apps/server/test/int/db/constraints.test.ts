// Business rules the schema enforces on its own (C.4 triggers, C.6 CHECK constraints and indexes): BR-43, the
// one-primary rule of A-29, NULLS NOT DISTINCT uniqueness (A-28), RTO within MTPD, BR-04 residual acceptance and the
// corrective action verification rules BR-08 and BR-09.
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, addUser, expectPgError, inScope, rolledBack, type FrameworkFixture } from './helpers';

describe('schema rules', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let fw: FrameworkFixture;
  let msId: string;
  let otherMsId: string;
  let owner: string;
  let implementer: string;
  let verifier: string;

  beforeAll(async () => {
    tenant = await createTenant(db, 'rules');
    fw = await addFramework(db.migrator);
    msId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'isms');
    otherMsId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'qms');
    owner = await addUser(db.migrator, 'owner.user', [tenant.id]);
    implementer = await addUser(db.migrator, 'implementer.user', [tenant.id]);
    verifier = await addUser(db.migrator, 'verifier.user', [tenant.id]);
  });

  const scope = () => ({ orgId: tenant.id, schema: tenant.schemaName, userId: owner });

  describe('BR-43: preparation tasks finish before the audit', () => {
    let eventId: string;
    let earlierEventId: string;

    beforeAll(async () => {
      await inScope(db.app, scope(), async (trx) => {
        const values = { management_system_id: msId, event_type: 'surveillance' as const, name_en: 'Surveillance', name_id: 'Surveilans', short_label: 'S1' };
        eventId = (await trx.insertInto('audit_event').values({ ...values, scheduled_at: '2026-11-20' }).returning('id').executeTakeFirstOrThrow()).id;
        earlierEventId = (await trx.insertInto('audit_event').values({ ...values, scheduled_at: '2026-10-15' }).returning('id').executeTakeFirstOrThrow()).id;
      });
    });

    it('accepts a task due before the audit date and rejects one due on or after it', async () => {
      const task = await inScope(db.app, scope(), (trx) =>
        trx
          .insertInto('audit_prep_task')
          .values({ audit_event_id: eventId, management_system_id: msId, title: 'Management review', owner_user_id: owner, due_at: '2026-11-19' })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      for (const due of ['2026-11-20', '2026-12-01']) {
        await expectPgError(
          rolledBack(db.app, scope(), (trx) =>
            trx.insertInto('audit_prep_task').values({ audit_event_id: eventId, management_system_id: msId, title: 'Late', due_at: due }).execute(),
          ),
          '23514',
          /BR-43: preparation task due .* is not before the audit on 2026-11-20/,
        );
      }
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.updateTable('audit_prep_task').set({ due_at: '2026-11-25' }).where('id', '=', task.id).execute()),
        '23514',
        /BR-43/,
      );
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.updateTable('audit_prep_task').set({ audit_event_id: earlierEventId }).where('id', '=', task.id).execute()),
        '23514',
        /is not before the audit on 2026-10-15/,
      );
      // Other columns change freely; moving the audit earlier does not fail (BR-42 flags the task instead, A-26).
      await inScope(db.app, scope(), async (trx) => {
        await trx.updateTable('audit_prep_task').set({ status: 'in_progress' }).where('id', '=', task.id).execute();
        await trx.updateTable('audit_event').set({ scheduled_at: '2026-11-01' }).where('id', '=', eventId).execute();
      });
    });
  });

  describe('A-29: one primary management system per shared entity', () => {
    async function newRisk(code: string): Promise<string> {
      return inScope(db.app, scope(), async (trx) =>
        (await trx.insertInto('risk').values({ code, title: code, risk_profile_code: 'iso27001', owner_user_id: owner }).returning('id').executeTakeFirstOrThrow()).id,
      );
    }

    it('rejects at commit a link set without a primary system', async () => {
      const riskId = await newRisk('R-NOPRIMARY');
      await expectPgError(
        inScope(db.app, scope(), (trx) =>
          trx.insertInto('entity_ms_link').values({ entity_type: 'risk', entity_id: riskId, management_system_id: msId, is_primary: false }).execute(),
        ),
        '23514',
        /Entity risk .* has no primary management system/,
      );
    });

    it('accepts one primary with further secondary links, and rejects a second primary or losing the primary', async () => {
      const riskId = await newRisk('R-SHARED');
      await inScope(db.app, scope(), async (trx) => {
        await trx.insertInto('entity_ms_link').values({ entity_type: 'risk', entity_id: riskId, management_system_id: msId, is_primary: true }).execute();
        await trx.insertInto('entity_ms_link').values({ entity_type: 'risk', entity_id: riskId, management_system_id: otherMsId, is_primary: false }).execute();
      });
      await expectPgError(
        rolledBack(db.app, scope(), (trx) =>
          trx.updateTable('entity_ms_link').set({ is_primary: true }).where('entity_id', '=', riskId).where('management_system_id', '=', otherMsId).execute(),
        ),
        '23505',
        /entity_ms_link_primary_uq/,
      );
      await expectPgError(
        inScope(db.app, scope(), (trx) =>
          trx.updateTable('entity_ms_link').set({ is_primary: false }).where('entity_id', '=', riskId).where('management_system_id', '=', msId).execute(),
        ),
        '23514',
        /has no primary management system/,
      );
      // Moving the primary inside one transaction is fine: the check is deferred to commit.
      await inScope(db.app, scope(), async (trx) => {
        await trx.updateTable('entity_ms_link').set({ is_primary: false }).where('entity_id', '=', riskId).where('management_system_id', '=', msId).execute();
        await trx.updateTable('entity_ms_link').set({ is_primary: true }).where('entity_id', '=', riskId).where('management_system_id', '=', otherMsId).execute();
      });
    });
  });

  describe('A-28: NULLS NOT DISTINCT uniqueness', () => {
    it('rejects a second applicability entry for the same target (requirement_id null in both)', async () => {
      const entry = { management_system_id: msId, target_type: 'catalogue_item' as const, catalogue_item_id: fw.catalogueItemId };
      await inScope(db.app, scope(), (trx) => trx.insertInto('applicability_entry').values(entry).execute());
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.insertInto('applicability_entry').values(entry).execute()),
        '23505',
        /applicability_entry_target_uq/,
      );
      // The same target in another system is a different entry.
      await rolledBack(db.app, scope(), (trx) => trx.insertInto('applicability_entry').values({ ...entry, management_system_id: otherMsId }).execute());
    });

    it('rejects a second organisation-wide freshness threshold (management_system_id null in both)', async () => {
      await inScope(db.app, scope(), (trx) => trx.insertInto('freshness_threshold').values({ frequency_code: 'monthly' }).execute());
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.insertInto('freshness_threshold').values({ frequency_code: 'monthly' }).execute()),
        '23505',
        /freshness_threshold_uq/,
      );
      await rolledBack(db.app, scope(), (trx) => trx.insertInto('freshness_threshold').values({ frequency_code: 'monthly', management_system_id: msId }).execute());
    });
  });

  describe('RTO within MTPD', () => {
    it('rejects rto_hours above mtpd_hours on prioritised activities and business impact analyses', async () => {
      const base = { management_system_id: msId, title: 'Payments' };
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.insertInto('prioritized_activity').values({ ...base, code: 'PA-1', mtpd_hours: 4, rto_hours: 8 }).execute()),
        '23514',
        /violates check constraint "prioritized_activity_check"/,
      );
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.insertInto('business_impact_analysis').values({ ...base, code: 'BIA-1', mtpd_hours: 24, rto_hours: 48 }).execute()),
        '23514',
        /violates check constraint "business_impact_analysis_check"/,
      );
      await rolledBack(db.app, scope(), async (trx) => {
        const activity = await trx.insertInto('prioritized_activity').values({ ...base, code: 'PA-2', mtpd_hours: 8, rto_hours: 8 }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('business_impact_analysis').values({ ...base, code: 'BIA-2', prioritized_activity_id: activity.id, mtpd_hours: 24, rto_hours: 4 }).execute();
      });
    });
  });

  describe('BR-04: the implementer never accepts the residual risk', () => {
    it('rejects an acceptance by the treatment implementer and accepts one by another person', async () => {
      const riskId = await inScope(db.app, scope(), async (trx) =>
        (await trx.insertInto('risk').values({ code: 'R-RESIDUAL', title: 'Residual', risk_profile_code: 'iso27001', owner_user_id: owner }).returning('id').executeTakeFirstOrThrow()).id,
      );
      const acceptance = { risk_id: riskId, implemented_by_user_id: implementer, accepted_at: '2026-09-29' };
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.insertInto('residual_acceptance').values({ ...acceptance, accepted_by_user_id: implementer }).execute()),
        '23514',
        /violates check constraint "residual_acceptance_check"/,
      );
      await rolledBack(db.app, scope(), (trx) => trx.insertInto('residual_acceptance').values({ ...acceptance, accepted_by_user_id: owner }).execute());
      // A treatment marked implemented must name its implementer.
      await expectPgError(
        rolledBack(db.app, scope(), (trx) =>
          trx
            .insertInto('risk_treatment')
            .values({ management_system_id: msId, code: 'RT-X', title: 'Encrypt', risk_id: riskId, status: 'implemented', target_type: 'requirement', requirement_id: fw.requirementId })
            .execute(),
        ),
        '23514',
        /violates check constraint "risk_treatment_check"/,
      );
    });
  });

  describe('BR-08 and BR-09: corrective action verification', () => {
    const base = () => ({
      management_system_id: msId,
      title: 'Automate access reviews',
      owner_user_id: owner,
      implemented_by_user_id: implementer,
      implemented_at: '2026-09-20',
    });

    it('rejects verification by the implementer, by the owner, or on the implementation date', async () => {
      // Unnamed table CHECK constraints are numbered in declaration order (C.6 tenant/0005).
      const cases: [string, Record<string, string>, string][] = [
        ['CA-SELF', { verified_by_user_id: implementer, verified_at: '2026-09-25' }, 'corrective_action_check'],
        ['CA-OWNER', { verified_by_user_id: owner, verified_at: '2026-09-25' }, 'corrective_action_check1'],
        ['CA-SAMEDAY', { verified_by_user_id: verifier, verified_at: '2026-09-20' }, 'corrective_action_check2'],
      ];
      for (const [code, verification, constraint] of cases) {
        await expectPgError(
          rolledBack(db.app, scope(), (trx) => trx.insertInto('corrective_action').values({ ...base(), code, ...verification }).execute()),
          '23514',
          new RegExp(`violates check constraint "${constraint}"`),
        );
      }
    });

    it('accepts verification by a third person on a later date, and a closed action needs a recorded verification', async () => {
      await rolledBack(db.app, scope(), (trx) =>
        trx
          .insertInto('corrective_action')
          .values({ ...base(), code: 'CA-OK', status: 'closed', verified_by_user_id: verifier, verified_at: '2026-09-25', effective: true })
          .execute(),
      );
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.insertInto('corrective_action').values({ ...base(), code: 'CA-OPEN', status: 'closed' }).execute()),
        '23514',
        /violates check constraint "corrective_action_check3"/,
      );
      // A later verification of an existing action follows the same rules.
      const id = await inScope(db.app, scope(), async (trx) =>
        (await trx.insertInto('corrective_action').values({ ...base(), code: 'CA-LATER' }).returning('id').executeTakeFirstOrThrow()).id,
      );
      await expectPgError(
        rolledBack(db.app, scope(), (trx) => trx.updateTable('corrective_action').set({ verified_by_user_id: implementer, verified_at: '2026-09-30' }).where('id', '=', id).execute()),
        '23514',
        /violates check constraint "corrective_action_check"/,
      );
      await rolledBack(db.app, scope(), (trx) =>
        trx.updateTable('corrective_action').set({ verified_by_user_id: verifier, verified_at: '2026-09-30' }).where('id', '=', id).execute(),
      );
    });
  });

  it('keeps business ids unique among non-deleted rows only', async () => {
    const first = await inScope(db.app, scope(), (trx) =>
      trx.insertInto('context_issue').values({ code: 'CI-REUSE', title: 'First' }).returning('id').executeTakeFirstOrThrow(),
    );
    // Soft delete (C.1) in a later transaction, so the set_updated_at trigger moves updated_at past created_at.
    await inScope(db.app, scope(), async (trx) => {
      await trx.updateTable('context_issue').set({ deleted_at: new Date() }).where('id', '=', first.id).execute();
      await trx.insertInto('context_issue').values({ code: 'CI-REUSE', title: 'Second' }).execute();
    });
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => trx.insertInto('context_issue').values({ code: 'CI-REUSE', title: 'Third' }).execute()),
      '23505',
      /context_issue_code_uq/,
    );
    const updated = await inScope(db.app, scope(), (trx) =>
      sql<{ changed: boolean }>`select updated_at > created_at as changed from context_issue where code = 'CI-REUSE' and deleted_at is not null`.execute(trx),
    );
    expect(updated.rows).toEqual([{ changed: true }]);
  });
});
