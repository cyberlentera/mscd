// The C.13 transition tables: states, permissions and rules exist, and the rows the plan names are present.
import { describe, expect, it } from 'vitest';
import {
  MACHINES, MACHINE_ENTITIES, PERMISSION_MATRIX, REJECTIONS, RULE_IDS, TRANSITIONS, WORK_PACKAGE_IDS, machinePermissions,
  rejectionFor, routeById, transitionsFor, transitionsVia,
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
          for (const p of t.allOf ?? []) {
            expect(PERMISSION_MATRIX[p], p).toBeDefined();
            expect(t.permission, 'allOf needs a permission').not.toBeNull();
          }
        }
      });

      it('rejects with a known rule only pairs that have no row on the same route', () => {
        for (const r of machine.rejections) {
          const via = r.via ?? null;
          expect(r.entity).toBe(entity);
          expect(machine.states).toContain(r.from);
          expect(machine.states).toContain(r.to);
          expect(RULE_IDS, r.rule).toContain(r.rule);
          expect(r.note.length).toBeGreaterThan(10);
          if (r.via) expect(routeById(r.via), r.via).toBeDefined();
          expect(transitionsVia(entity, r.from, r.to, via), `${r.from} to ${r.to} via ${via} has rows and a rejection`).toEqual([]);
          expect(rejectionFor(entity, r.from, r.to, via)).toBe(r);
        }
        const keys = machine.rejections.map((r) => `${r.via ?? ''}>${r.from}>${r.to}`);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('splits the rows of each pair between the transition route and dedicated routes', () => {
        for (const t of machine.transitions) {
          const forRoute = transitionsVia(entity, t.from, t.to, t.via ?? null);
          expect(forRoute, `${t.from} to ${t.to}`).toContain(t);
          for (const other of forRoute) expect(other.via ?? null).toBe(t.via ?? null);
        }
      });

      it('has no duplicate rows', () => {
        const keys = machine.transitions.map((t) => `${t.from}>${t.to}>${t.permission}>${Boolean(t.own)}`);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('lists the permissions of the rows each route performs', () => {
        const routesOf = new Set(machine.transitions.map((t) => t.via ?? null));
        for (const via of routesOf) {
          const expected = new Set(machine.transitions.filter((t) => (t.via ?? null) === via).map((t) => t.permission).filter((p): p is Permission => p !== null));
          expect(new Set(machinePermissions(entity, via)), `${via ?? 'transition route'}`).toEqual(expected);
        }
        expect(machinePermissions(entity)).toEqual(machinePermissions(entity, null));
      });
    });
  }

  it('flattens every row into TRANSITIONS and every rejection into REJECTIONS', () => {
    expect(TRANSITIONS.length).toBe(MACHINE_ENTITIES.reduce((n, e) => n + MACHINES[e].transitions.length, 0));
    expect(REJECTIONS.length).toBe(MACHINE_ENTITIES.reduce((n, e) => n + MACHINES[e].rejections.length, 0));
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
    expectRow(e, ['not_started', 'complete', 'activity.transition', true, ['BR-12', 'BR-40']]);
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

  it('implementation activity: every row that starts work from not_started checks the gate lock (BR-12, A.4 5.12)', () => {
    const rows = MACHINES['implementation_activity_progress.status'].transitions.filter((t) => t.from === 'not_started');
    const starting = rows.filter((t) => t.to !== 'blocked');
    expect(starting.map((t) => t.to).sort()).toEqual(['complete', 'in_progress']);
    for (const t of starting) expect(t.rules, `not_started to ${t.to}`).toContain('BR-12');
    // Recording a blocker starts no work: C.13 and D-13 name BR-12 only for starting an activity.
    for (const t of rows.filter((x) => x.to === 'blocked')) expect(t.rules).toEqual(['BR-39']);
  });

  it('document', () => {
    const e = 'document.status';
    expectRow(e, ['draft', 'in_review', 'document.review', true]);
    expectRow(e, ['expired', 'in_review', 'document.review', true]);
    expectRow(e, ['in_review', 'approved', 'document.approve', false, ['BR-16']]);
    expectRow(e, ['in_review', 'draft', 'document.approve']);
    expectRow(e, ['approved', 'expired', null, false, ['BR-10']]);
    expectNoRow(e, 'draft', 'approved');
    for (const from of ['draft', 'approved', 'expired']) {
      expectRow(e, [from, 'in_review', 'document.version.create', true]);
      expect(transitionsVia(e, from, 'in_review', 'documents.versions').map((t) => t.permission)).toEqual(['document.version.create']);
    }
    expect(transitionsVia(e, 'approved', 'in_review', null)).toEqual([]);
    expect(transitionsVia(e, 'draft', 'in_review', null).map((t) => t.permission)).toEqual(['document.review']);
    expectNoRow(e, 'in_review', 'in_review');
    expect(machinePermissions(e)).not.toContain('document.version.create');
    expect(machinePermissions(e, 'documents.versions')).toEqual(['document.version.create']);
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
    expect(rejectionFor(e, 'residual_accepted', 'closed', null)).toBeUndefined();
    for (const from of ['approved', 'in_progress', 'delayed']) expectRow(e, [from, 'proposed', 'risk.manage']);
    for (const from of ['proposed', 'approved', 'in_progress', 'delayed', 'implemented']) {
      expectNoRow(e, from, 'closed');
      expect(rejectionFor(e, from, 'closed', null)?.rule, `${from} to closed`).toBe('BR-04');
    }
    expect(rejectionFor(e, 'proposed', 'implemented', null)).toBeUndefined();
    expect(machinePermissions(e)).not.toContain('risk.residual.accept');
    expect(machinePermissions(e, 'risks.residual-acceptance')).toEqual(['risk.residual.accept']);
  });

  it('risk treatment: residual acceptance answers 422 BR-04 for every treatment that is not implemented (D.3)', () => {
    const e = 'risk_treatment.status';
    const via = 'risks.residual-acceptance';
    expect(transitionsVia(e, 'implemented', 'residual_accepted', via).map((t) => t.permission)).toEqual(['risk.residual.accept']);
    expect(rejectionFor(e, 'implemented', 'residual_accepted', via)).toBeUndefined();
    for (const from of ['proposed', 'approved', 'in_progress', 'delayed', 'residual_accepted', 'closed']) {
      expect(transitionsVia(e, from, 'residual_accepted', via), from).toEqual([]);
      expect(rejectionFor(e, from, 'residual_accepted', via)?.rule, `${from} to residual_accepted`).toBe('BR-04');
      // The transition route never performs residual acceptance and names no rule for it: 409 there.
      expect(rejectionFor(e, from, 'residual_accepted', null), `${from} on the transition route`).toBeUndefined();
    }
    // Closing is rejected on the transition route only.
    expect(rejectionFor(e, 'implemented', 'closed', via)).toBeUndefined();
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
    expectRow(e, [null, 'setup', 'ms.admin', false, ['BR-21', 'LIC-MS']]);
    expect(transitionsFor(e, null, 'setup')[0]).toMatchObject({ allOf: ['pack.activate'], via: 'admin.ms.create' });
    expectRow(e, ['setup', 'implementing', 'ms.admin']);
    expect(transitionsVia(e, 'setup', 'implementing', 'admin.ms.update').map((t) => t.permission)).toEqual(['ms.admin']);
    expect(transitionsVia(e, 'setup', 'implementing', null)).toEqual([]);
    for (const from of ['setup', 'implementing', 'certified', 'transitioning']) {
      expectRow(e, [from, 'archived', 'ms.admin']);
      expect(transitionsVia(e, from, 'archived', 'admin.ms.update').map((t) => t.permission), `${from} to archived`).toEqual(['ms.admin']);
      expect(transitionsVia(e, from, 'archived', null), `${from} to archived on ms.transition`).toEqual([]);
    }
    expect(machinePermissions(e, 'admin.ms.update')).toEqual(['ms.admin']);
    expect(machinePermissions(e)).toEqual(['ms.transition']);
    expectRow(e, ['certified', 'transitioning', 'ms.transition', false, ['LIC-FEATURE']]);
    expectRow(e, ['transitioning', 'certified', 'ms.transition']);
    expectRow(e, ['implementing', 'certified', null]);
  });
});
