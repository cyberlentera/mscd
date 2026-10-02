// Self-Assessment Workbench and Audit Activity Planner (build plan D.3 "Registers and workflows: audit side", C.13
// `self_assessment.status`, PRD 8.1, WP-37) on the `tst` ISMS: one row per finding condition of the edition, an
// assessment with evidence, a gap that needs an owner and a target date, a finding raised from a gap once only;
// audit activities generated from the pack templates of the event type (matching the templates, existing codes
// skipped), and planning an activity.
import { AuditActivityItem, SelfAssessmentItem, pageOf, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditOf, createAuditApp, rowsOf, SELF, sessionFor, systemOf, TODAY, verifyChain, type AuditApp, type Client } from './helpers';

describe('self-assessment and audit activities', () => {
  const db = useTestDatabase('demo');
  let ctx: AuditApp;
  let rina: Client;
  let maya: Client;
  let bagus: Client;
  let hendra: Client;
  let conditions: { code: string; classification: string; requirement_code: string | null; text: string }[];
  let evidenceCode: string;

  beforeAll(async () => {
    ctx = await createAuditApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    const system = await systemOf(db, 'tst', 'isms');
    conditions = await rowsOf(db, 'tst', sql`select code, classification, requirement_code, text from ref.finding_condition where framework_version_id = ${system.editionId} order by code`);
    const [evidence] = await rowsOf<{ code: string }>(
      db,
      'tst',
      sql`select e.evidence_code as code from evidence e join entity_ms_link l on l.entity_type = 'evidence' and l.entity_id = e.id and l.management_system_id = ${system.id}
           where e.deleted_at is null order by e.evidence_code limit 1`,
    );
    evidenceCode = evidence!.code;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('self-assessment', () => {
    it('lists one not-assessed row per finding condition of the edition', async () => {
      expect(conditions.length).toBeGreaterThan(0);
      const page = await hendra.get<Page<SelfAssessmentItem>>(SELF('isms'));
      expect(page.status).toBe(200);
      expect(pageOf(SelfAssessmentItem).safeParse(page.body).success).toBe(true);
      expect(page.body.total).toBe(conditions.length);
      expect(page.body.items.map((i) => i.conditionCode)).toEqual(conditions.map((c) => c.code));
      expect(page.body.items.every((i) => i.status === 'not_assessed' && i.ref === null)).toBe(true);
      expect(page.body.items[0]).toMatchObject({ classification: conditions[0]!.classification, text: conditions[0]!.text, requirementCode: conditions[0]!.requirement_code });
    });

    it('records an assessment with evidence and filters by status and text', async () => {
      const code = conditions[0]!.code;
      const saved = await maya.request('PUT', `${SELF('isms')}/${code}`, { status: 'conforming', note: 'Risk assessment approved', evidenceCodes: [evidenceCode] });
      expect(saved.status).toBe(200);
      expect(saved.body.ref).toMatchObject({ entityType: 'self_assessment', code });
      const page = await hendra.get<Page<SelfAssessmentItem>>(`${SELF('isms')}?status=conforming`);
      expect(page.body.items).toEqual([expect.objectContaining({ conditionCode: code, status: 'conforming', evidence: [evidenceCode], assessedAt: TODAY, note: 'Risk assessment approved' })]);
      // The same status again changes only the other fields.
      expect((await maya.request('PUT', `${SELF('isms')}/${code}`, { status: 'conforming', evidenceCodes: [] })).status).toBe(200);
      expect((await hendra.get<Page<SelfAssessmentItem>>(`${SELF('isms')}?q=${encodeURIComponent(conditions[0]!.text.split(' ')[1]!)}`)).body.items[0]).toMatchObject({ evidence: [] });

      expect((await maya.request('PUT', `${SELF('isms')}/${code}`, { status: 'conforming', evidenceCodes: ['EV-NOPE'] })).status).toBe(422);
      expect((await maya.request('PUT', `${SELF('isms')}/FC-NOPE`, { status: 'conforming', evidenceCodes: [] })).status).toBe(404);
      expect((await bagus.request('PUT', `${SELF('isms')}/${code}`, { status: 'gap', ownerHandle: 'bagus', targetFixAt: '2026-12-01', evidenceCodes: [] })).status).toBe(403);
      expect((await auditOf(db, 'tst', saved.body.ref!.id))[0]).toMatchObject({ action: 'self_assessment.updated', actor: 'maya' });
    });

    it('needs an owner and a target date for a gap and raises a finding from it once', async () => {
      const condition = conditions[1]!;
      const url = `${SELF('isms')}/${condition.code}`;
      expect((await maya.request('PUT', url, { status: 'gap', evidenceCodes: [] })).status).toBe(400);
      expect((await maya.request('PUT', url, { status: 'gap', ownerHandle: 'none', targetFixAt: '2026-12-01', evidenceCodes: [] })).status).toBe(400);
      const gap = await maya.request('PUT', url, { status: 'gap', ownerHandle: 'bagus', targetFixAt: '2026-12-01', note: 'Programme not completed', evidenceCodes: [] });
      expect(gap.status).toBe(200);
      const id = gap.body.ref!.id;

      // Only a gap raises a finding.
      const conforming = conditions[0]!;
      const [stored] = await rowsOf<{ id: string }>(db, 'tst', sql`select s.id from self_assessment s join ref.finding_condition c on c.id = s.finding_condition_id where c.code = ${conforming.code}`);
      expect((await maya.post(`/api/v1/ms/isms/self-assessments/${stored!.id}/raise-finding`, { classification: 'minor' })).status).toBe(422);

      const raised = await maya.post(`/api/v1/ms/isms/self-assessments/${id}/raise-finding`, { classification: condition.classification === 'major' ? 'major' : 'minor' });
      expect(raised.status).toBe(201);
      expect(raised.body.ref).toMatchObject({ entityType: 'finding', code: 'SA-2026-01' });
      const [finding] = await rowsOf<Record<string, unknown>>(db, 'tst', sql`select * from finding where id = ${raised.body.ref!.id}`);
      expect(finding).toMatchObject({ source: 'self_assessment', title: condition.text, clause_ref: condition.requirement_code, due_at: '2026-12-01', status: 'open' });
      expect((await maya.post(`/api/v1/ms/isms/self-assessments/${id}/raise-finding`, { classification: 'minor' })).status).toBe(409);
      const page = await hendra.get<Page<SelfAssessmentItem>>(`${SELF('isms')}?status=gap`);
      expect(page.body.items).toEqual([expect.objectContaining({ conditionCode: condition.code, owner: 'bagus', targetFixAt: '2026-12-01', findingCode: 'SA-2026-01' })]);
      // The gap's owner (a Domain Owner, own scope) sees the row; others do not.
      expect((await bagus.get<Page<SelfAssessmentItem>>(SELF('isms'))).body.items.map((i) => i.conditionCode)).toEqual([condition.code]);
    });
  });

  describe('audit activity planner', () => {
    let event: { id: string; event_type: string };
    let templates: { code: string; title: string; clause_ref: string | null; key_questions: string | null; evidence_to_request: string | null }[];

    beforeAll(async () => {
      const system = await systemOf(db, 'tst', 'isms');
      // An event of the system whose type has templates in the edition.
      const [row] = await rowsOf<{ id: string; event_type: string }>(
        db,
        'tst',
        sql`select e.id, e.event_type from audit_event e
             where e.management_system_id = ${system.id} and e.deleted_at is null
               and exists (select 1 from ref.audit_activity_template t where t.framework_version_id = ${system.editionId} and t.event_type = e.event_type)
             order by e.scheduled_at desc limit 1`,
      );
      if (!row) {
        // No seeded event of a templated type: plan a Stage 1 audit through the database.
        const [created] = await rowsOf<{ id: string; event_type: string }>(
          db,
          'tst',
          sql`insert into audit_event (management_system_id, event_type, name_en, name_id, short_label, scheduled_at)
              values (${system.id}, 'stage1', 'Stage 1 audit', 'Audit tahap 1', 'Stage 1', '2027-02-01') returning id, event_type`,
        );
        event = created!;
      } else {
        event = row;
      }
      templates = await rowsOf(
        db,
        'tst',
        sql`select code, title, clause_ref, key_questions, evidence_to_request from ref.audit_activity_template
             where framework_version_id = ${system.editionId} and event_type = ${event.event_type} order by sort_order, code`,
      );
    });

    const url = () => `/api/v1/ms/isms/audit-events/${event.id}/activities`;

    it('generates the activities of the event type from the templates and skips existing codes', async () => {
      expect(templates.length).toBeGreaterThan(0);
      expect((await bagus.post(`${url()}/generate`)).status).toBe(403);
      const generated = await rina.post(`${url()}/generate`);
      expect(generated.status).toBe(200);
      expect(generated.body).toMatchObject({ ok: true, count: templates.length, changed: ['isms'] });
      const list = await hendra.get<AuditActivityItem[]>(url());
      expect(z.array(AuditActivityItem).safeParse(list.body).success).toBe(true);
      expect(list.body.map((a) => ({ code: a.templateCode, title: a.title, clause: a.clauseRef, questions: a.keyQuestions, evidence: a.evidenceToRequest }))).toEqual(
        templates.map((t) => ({ code: t.code, title: t.title, clause: t.clause_ref, questions: t.key_questions, evidence: t.evidence_to_request })),
      );
      expect(list.body.every((a) => a.status === 'planned' && a.auditee === null)).toBe(true);
      const again = await rina.post(`${url()}/generate`);
      expect(again.body).toMatchObject({ count: 0 });
      expect((await hendra.get<AuditActivityItem[]>(url())).body).toHaveLength(templates.length);
      expect((await rina.get('/api/v1/ms/isms/audit-events/00000000-0000-4000-8000-000000000999/activities')).status).toBe(404);
    });

    it('plans an activity: auditee (a member), date, status and note', async () => {
      const [first] = (await hendra.get<AuditActivityItem[]>(url())).body;
      const patchUrl = `/api/v1/ms/isms/audit-activities/${first!.ref.id}`;
      const planned = await rina.patch(patchUrl, { auditeeHandle: 'bagus', scheduledAt: '2027-02-10', note: 'Bring the scope statement' });
      expect(planned.status).toBe(200);
      expect((await rina.patch(patchUrl, { auditeeHandle: 'sari' })).body).toMatchObject({ status: 422, rule: 'NOT-A-MEMBER' });
      expect((await rina.patch(patchUrl, { status: 'done' })).status).toBe(200);
      const after = (await hendra.get<AuditActivityItem[]>(url())).body[0];
      expect(after).toMatchObject({ auditee: 'bagus', scheduledAt: '2027-02-10', status: 'done', note: 'Bring the scope statement' });
      expect((await auditOf(db, 'tst', first!.ref.id)).map((a) => a.action)).toEqual(['audit_activity.updated', 'audit_activity.updated', 'audit_activity.updated']);
      // The auditee (own scope) sees the activity they hold.
      expect((await bagus.get<AuditActivityItem[]>(url())).body.map((a) => a.ref.id)).toEqual([first!.ref.id]);
      expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
    });
  });
});
