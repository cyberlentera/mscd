// The C.13 transition tables: states, permissions and rules exist, and the rows the plan names are present.
import { describe, expect, it } from 'vitest';
import {
  MACHINES, MACHINE_ENTITIES, PERMISSION_MATRIX, RULE_IDS, TRANSITIONS, WORK_PACKAGE_IDS, machinePermissions, transitionsFor,
} from '../src/index.js';
import type { MachineEntity, Permission } from '../src/index.js';
import { planSection } from './helpers.js';

/** A row expectation: from, to, permission (null for the system), own flag, rules that must be present. */
type Row = [from: string | null, to: string, permission: Permission | null, own?: boolean, rules?: string[]];

function expectRow(entity: MachineEntity, [from, to, permission, own = false, rules = []]: Row): void {
  const found = transitionsFor(entity, from, to).filter((t) => t.permission === permission && Boolean(t.own) === own);
  expect(found.length, `${entity}: ${from} to ${to} by ${permission}${own ? ' (own)' : ''}`).toBe(1);
  for (const rule of rules) expect(found[0]?.rules, `${entity}: ${from} to ${to}`).toContain(rule);
}

function expectNoRow(entity: MachineEntity, from: string | null, to: string): void {
  expect(transitionsFor(entity, from, to), `${entity}: ${from} to ${to}`).toEqual([]);
}

describe('machines', () => {
  it('cover every entity of C.13', () => {
    const table = planSection('### C.13 State machines', '## D. API contract');
    const planned = [...table.matchAll(/^\| `([a-z_]+\.[a-z_]+)`(?:, `([a-z_]+\.[a-z_]+)`)? \((WP-\d\d)\)/gm)]
      .flatMap((m) => [[m[1], m[3]], ...(m[2] ? [[m[2], m[3]]] : [])]) as [string, string][];
    expect(planned.map(([e]) => e).sort()).toEqual([...MACHINE_ENTITIES].sort());
    for (const [entity, owner] of planned) expect(MACHINES[entity as MachineEntity].owner, entity).toBe(owner);
  });

  for (const entity of MACHINE_ENTITIES) {
    describe(entity, () => {
      const machine = MACHINES[entity];

      it('uses only its own states, known permissions and known rules', () => {
        expect(machine.entity).toBe(entity);
        expect(WORK_PACKAGE_IDS).toContain(machine.owner);
        expect(machine.transitions.length).toBeGreaterThan(0);
        for (const t of machine.transitions) {
          expect(t.entity).toBe(entity);
          if (t.from !== null) expect(machine.states, `from ${t.from}`).toContain(t.from);
          expect(machine.states, `to ${t.to}`).toContain(t.to);
          expect(t.from, 'no self transition').not.toBe(t.to);
          if (t.permission) expect(PERMISSION_MATRIX[t.permission], t.permission).toBeDefined();
          else expect(t.note, `system row ${t.from} to ${t.to} explains its trigger`).toBeTruthy();
          if (t.own) {
            expect(t.permission, 'own rows need a permission').not.toBeNull();
            expect(PERMISSION_MATRIX[t.permission as Permission].own.length, `${t.permission} has own holders`).toBeGreaterThan(0);
          }
          for (const rule of t.rules) expect(RULE_IDS, rule).toContain(rule);
        }
      });

      it('has no duplicate rows', () => {
        const keys = machine.transitions.map((t) => `${t.from}>${t.to}>${t.permission}>${Boolean(t.own)}`);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('lists the permissions of its rows', () => {
        const expected = new Set(machine.transitions.map((t) => t.permission).filter((p): p is Permission => p !== null));
        expect(new Set(machinePermissions(entity))).toEqual(expected);
      });
    });
  }

  it('flattens every row into TRANSITIONS', () => {
    expect(TRANSITIONS.length).toBe(MACHINE_ENTITIES.reduce((n, e) => n + MACHINES[e].transitions.length, 0));
  });
});

describe('C.13 rows', () => {
  it('applicability entry', () => {
    const e = 'applicability_entry.implementation_status';
    expectRow(e, [null, 'not_started', 'applicability.manage']);
    expectRow(e, ['not_started', 'planned', 'applicability.manage']);
    for (const from of ['not_started', 'planned', 'partially_implemented']) expectRow(e, [from, 'complete', 'applicability.complete', true]);
    expectRow(e, ['planned', 'partially_implemented', 'applicability.complete', true]);
    expectRow(e, ['complete', 'implemented', 'applicability.verify', false, ['BR-01', 'VERIFY-SELF']]);
    expectRow(e, ['complete', 'partially_implemented', 'applicability.verify']);
    expectRow(e, ['partially_implemented', 'implemented', 'applicability.verify', false, ['BR-01']]);
    for (const from of ['not_started', 'planned', 'partially_implemented', 'complete', 'implemented']) {
      expectRow(e, [from, 'not_applicable', 'applicability.manage']);
      expect(transitionsFor(e, from, 'not_applicable')[0]?.requires).toContain('exclusionJustification');
    }
    expectRow(e, ['implemented', 'partially_implemented', null]);
    expectNoRow(e, 'not_started', 'implemented');
    const complete = transitionsFor(e, 'planned', 'complete')[0];
    expect(complete?.sets).toEqual(['completed_by_user_id', 'completed_at']);
  });

  it('implementation activity', () => {
    const e = 'implementation_activity_progress.status';
    expectRow(e, ['not_started', 'in_progress', 'activity.transition', true, ['BR-12']]);
    expectRow(e, ['not_started', 'complete', 'activity.transition', true, ['BR-40']]);
    expectRow(e, ['in_progress', 'complete', 'activity.transition', true, ['BR-40']]);
    expectRow(e, ['complete', 'verified', 'activity.verify', false, ['VERIFY-SELF']]);
    expectRow(e, ['complete', 'in_progress', 'activity.verify']);
    for (const from of ['not_started', 'in_progress', 'complete']) {
      expectRow(e, [from, 'blocked', 'activity.transition', true, ['BR-39']]);
      expectRow(e, [from, 'blocked', 'activity.verify', false, ['BR-39']]);
    }
    expectNoRow(e, 'verified', 'blocked');
    expectRow(e, ['blocked', 'in_progress', 'activity.transition', true]);
  });

  it('document', () => {
    const e = 'document.status';
    expectRow(e, ['draft', 'in_review', 'document.review', true]);
    expectRow(e, ['expired', 'in_review', 'document.review', true]);
    expectRow(e, ['in_review', 'approved', 'document.approve', false, ['BR-16']]);
    expectRow(e, ['in_review', 'draft', 'document.approve']);
    expectRow(e, ['approved', 'expired', null, false, ['BR-10']]);
    expectNoRow(e, 'draft', 'approved');
  });

  it('risk treatment', () => {
    const e = 'risk_treatment.status';
    expectRow(e, ['proposed', 'approved', 'risk.manage']);
    expectRow(e, ['approved', 'in_progress', 'risk.treatment.update', true]);
    expectRow(e, ['in_progress', 'delayed', null]);
    expectRow(e, ['in_progress', 'delayed', 'risk.treatment.update', true]);
    expectRow(e, ['delayed', 'in_progress', 'risk.treatment.update', true]);
    expectRow(e, ['in_progress', 'implemented', 'risk.treatment.update', true]);
    expectRow(e, ['delayed', 'implemented', 'risk.treatment.update', true]);
    expectRow(e, ['implemented', 'residual_accepted', 'risk.residual.accept', true, ['BR-04']]);
    expect(transitionsFor(e, 'implemented', 'residual_accepted')[0]?.via).toBe('risks.residual-acceptance');
    expectRow(e, ['residual_accepted', 'closed', 'risk.manage']);
    for (const from of ['approved', 'in_progress', 'delayed']) expectRow(e, [from, 'proposed', 'risk.manage']);
    expectNoRow(e, 'implemented', 'closed');
  });

  it('finding', () => {
    const e = 'finding.status';
    expectRow(e, ['open', 'in_progress', 'finding.manage']);
    expectRow(e, ['open', 'closed', 'finding.manage', false, ['BR-06', 'BR-07', 'BR-08']]);
    expectRow(e, ['in_progress', 'closed', 'finding.manage', false, ['BR-06', 'BR-07', 'BR-08']]);
    expectRow(e, ['closed', 'in_progress', 'finding.manage']);
  });

  it('corrective action', () => {
    const e = 'corrective_action.status';
    const steps = ['correction', 'rca', 'systemic_check', 'action', 'effectiveness_verification'];
    for (let i = 0; i < steps.length - 1; i += 1) {
      expectRow(e, [steps[i] as string, steps[i + 1] as string, 'corrective_action.update', true]);
      expectRow(e, [steps[i] as string, steps[i + 1] as string, 'corrective_action.manage']);
      if (i + 2 < steps.length) expectNoRow(e, steps[i] as string, steps[i + 2] as string);
    }
    expect(transitionsFor(e, 'action', 'effectiveness_verification')[0]?.sets).toContain('implemented_by_user_id');
    expectRow(e, ['effectiveness_verification', 'closed', 'corrective_action.verify', false, ['BR-09', 'BR-08']]);
    expectRow(e, ['effectiveness_verification', 'action', 'corrective_action.verify']);
    for (const from of steps) expectRow(e, [from, 'cancelled', 'corrective_action.manage']);
  });

  it('management review', () => {
    const e = 'management_review.status';
    expectRow(e, ['planned', 'held', 'management_review.manage']);
    expectRow(e, ['held', 'closed', 'management_review.manage', false, ['BR-13', 'BR-14']]);
    expectNoRow(e, 'planned', 'closed');
  });

  it('self-assessment', () => {
    const e = 'self_assessment.status';
    for (const to of ['not_assessed', 'conforming', 'gap', 'not_applicable']) expectRow(e, [null, to, 'self_assessment.manage']);
    expect(transitionsFor(e, 'conforming', 'gap')[0]?.requires).toEqual(['ownerHandle', 'targetFixAt']);
  });

  it('audit prep tasks and cycle items', () => {
    for (const [e, p] of [['audit_prep_task.status', 'prep_task.update'], ['cycle_requirement_status.status', 'cycle_item.update']] as const) {
      expectRow(e, ['not_started', 'in_progress', p, true]);
      expectRow(e, ['in_progress', 'done', p, true]);
      for (const from of ['not_started', 'in_progress', 'done', 'overdue']) expectRow(e, [from, 'blocked', p, true]);
      expectRow(e, ['blocked', 'in_progress', p, true]);
      expectRow(e, ['overdue', 'in_progress', p, true]);
      expectRow(e, ['overdue', 'done', p, true]);
      expectRow(e, ['not_started', 'overdue', null]);
      expectRow(e, ['in_progress', 'overdue', null]);
      expectNoRow(e, 'done', 'overdue');
    }
  });

  it('role grant approval', () => {
    const e = 'user_ms_role.approval_status';
    expectRow(e, ['pending_approval', 'active', 'user.manage', false, ['SOD-SELF-GRANT']]);
    expectRow(e, ['pending_approval', 'rejected', 'user.manage', false, ['SOD-SELF-GRANT']]);
    expectNoRow(e, 'rejected', 'active');
  });

  it('management system', () => {
    const e = 'management_system.status';
    expectRow(e, [null, 'setup', 'ms.admin']);
    expectRow(e, ['setup', 'implementing', 'ms.admin']);
    for (const from of ['setup', 'implementing', 'certified', 'transitioning']) expectRow(e, [from, 'archived', 'ms.admin']);
    expectRow(e, ['certified', 'transitioning', 'ms.transition', false, ['LIC-FEATURE']]);
    expectRow(e, ['transitioning', 'certified', 'ms.transition']);
    expectRow(e, ['implementing', 'certified', null]);
  });
});
