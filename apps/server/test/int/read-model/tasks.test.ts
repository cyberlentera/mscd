// My Tasks with stored tasks (build plan D-29, C.9 "Tasks", D.2 `TaskList`): an open `task` row of the person whose
// record is already one of their chain items does not add an item; one on another record adds a `task` item keyed
// `<ms>:task:<uuid>`; closed tasks and other people's tasks never show.
import type { TaskList, UiMsSnapshot } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { createReadModelApp, ORG_IDS, sessionFor, userId, type ReadModelApp } from './helpers';

describe('GET /tasks merges stored tasks (D-29)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let isms: UiMsSnapshot;

  beforeAll(async () => {
    ctx = await createReadModelApp(db);
    isms = (await (await sessionFor(ctx, db, 'rina', 'ndt')).get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function addTask(values: { owner: string; entityType: string; entityId: string; code: string; due: string | null; status?: 'open' | 'done'; rule?: 'BR-11' | 'BR-31' }): Promise<string> {
    return inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const ms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('task')
        .values({
          management_system_id: ms.id,
          source_rule: values.rule ?? 'BR-11',
          entity_type: values.entityType,
          entity_id: values.entityId,
          entity_code: values.code,
          title_en: `Submit valid evidence for ${values.code}`,
          title_id: `Serahkan evidence yang berlaku untuk ${values.code}`,
          owner_user_id: await userId(db, values.owner),
          due_at: values.due,
          status: values.status ?? 'open',
          closed_at: values.status === 'done' ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  it('keeps the counts when every open task matches a chain item, and adds tasks on other records', async () => {
    const bagus = await sessionFor(ctx, db, 'bagus', 'ndt');
    const before = (await bagus.get<TaskList>('/api/v1/tasks')).body;
    expect(before.counts.total).toBe(31);

    // A task on an evidence record that is already one of bagus's chain items.
    const held = isms.bundle.chain.items.find((i) => i.kind === 'ev' && i.h === 'bagus')!;
    const heldRef = isms.refs[held.refKey!]!;
    await addTask({ owner: 'bagus', entityType: 'evidence', entityId: heldRef.id, code: held.id, due: '2026-09-01' });
    expect((await bagus.get<TaskList>('/api/v1/tasks')).body.counts).toEqual(before.counts);

    // A task on bagus's evidence that is not a chain item (fresh and verifiable), overdue.
    const chainEvidence = new Set(isms.bundle.chain.items.filter((i) => i.kind === 'ev').map((i) => i.id));
    const quiet = isms.bundle.evs.find((e) => e.owner === 'bagus' && !chainEvidence.has(e.code))!;
    const quietRef = isms.refs[`isms:ev:${quiet.code}`]!;
    const id = await addTask({ owner: 'bagus', entityType: 'evidence', entityId: quietRef.id, code: quiet.code, due: '2026-09-20' });
    // Closed tasks and tasks of someone else never show.
    await addTask({ owner: 'bagus', entityType: 'evidence', entityId: quietRef.id, code: quiet.code, due: null, status: 'done' });
    await addTask({ owner: 'dewi', entityType: 'evidence', entityId: quietRef.id, code: quiet.code, due: '2026-10-02', rule: 'BR-31' });

    const after = (await bagus.get<TaskList>('/api/v1/tasks')).body;
    expect(after.counts).toEqual({ ...before.counts, total: before.counts.total + 1, overdue: before.counts.overdue + 1 });
    const task = after.items.find((i) => i.kind === 'task')!;
    expect(task).toEqual({
      key: `isms:task:${id}`,
      ms: 'isms',
      kind: 'task',
      id,
      title: [quiet.code, quiet.code],
      act: [`Submit valid evidence for ${quiet.code}`, `Serahkan evidence yang berlaku untuk ${quiet.code}`],
      due: '2026-09-20',
      st: 'overdue',
      after: false,
      stage: null,
    });
    // Items are sorted by due date (no due date last).
    const dues = after.items.map((i) => i.due ?? '9999-12-31');
    expect(dues).toEqual([...dues].sort());
  });

  it('gives a person without a role in any system an empty list', async () => {
    const staff = await sessionFor(ctx, db, 'staff02', 'ndt');
    const response = await staff.get<TaskList>('/api/v1/tasks');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], counts: { total: 0, overdue: 0, week: 0, later: 0 } });
  });
});
