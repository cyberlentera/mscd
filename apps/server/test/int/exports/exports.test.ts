// Exports (build plan D.3 "Page actions", E.2 `export.build`, F.13, F.15; WP-24) on the demo template with a real
// storage gateway on SeaweedFS (the Managed Vault holds the asynchronous exports):
// - the synchronous SoA and document register in XLSX and CSV, read back with exceljs: every column, every row the
//   user may see (ScopePolicy: a restricted document is missing for Top Management), a title or justification
//   `=HYPERLINK(...)` stays text;
// - `POST /exports` for the readiness report, the portfolio board (one section per system with `export.run`, counted
//   as PDF pages with pdf-lib), the SoA and the audit trail; the task, its download through FileResponder, the audit
//   entries and the `export_ready` notification;
// - the D.3 permission rules, the creator-only task routes, the permission re-check at download and in the job, the
//   format rules and the expiry of export files.
import ExcelJS from 'exceljs';
import type { BackgroundTask, CommandResult, Page } from '@mscd/shared';
import { sql } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, signIn, startStorageStack, userId, type FilesClient, type StorageStack } from '../files/helpers';
import { createWp24App, ORG_IDS, type DemoOrg, type Wp24App } from '../notifications/helpers';

const EVIL = '=HYPERLINK("http://evil.example/steal","click me")';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function readSheet(raw: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheet');
  return sheet;
}

function rowValues(sheet: ExcelJS.Worksheet, n: number): unknown[] {
  const values = sheet.getRow(n).values as unknown[];
  return values.slice(1);
}

async function pageCount(raw: Buffer): Promise<number> {
  return (await PDFDocument.load(raw)).getPageCount();
}

describe('exports (D.3, E.2, F.13, F.15)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: Wp24App;
  const clients = new Map<string, FilesClient>();

  const as = async (handle: string, org: DemoOrg): Promise<FilesClient> => {
    const key = `${handle}@${org}`;
    let client = clients.get(key);
    if (!client) {
      client = await signIn(ctx, db, handle, org);
      clients.set(key, client);
    }
    return client;
  };

  /** Requests an export, runs `export.build` in process and returns the finished task. */
  const exportAndBuild = async (client: FilesClient, org: DemoOrg, body: Record<string, unknown>): Promise<BackgroundTask> => {
    const answer = await client.post<CommandResult>('/api/v1/exports', body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(202);
    const taskId = answer.body.taskId!;
    const queued = await client.get<BackgroundTask>(`/api/v1/exports/${taskId}`);
    expect(queued.body).toMatchObject({ id: taskId, kind: 'export', status: 'queued' });
    expect(queued.body.downloadUrl).toBeUndefined();
    const built = await ctx.exportJob.build(ORG_IDS[org], taskId);
    expect(built.status, built.error).toBe('succeeded');
    const done = await client.get<BackgroundTask>(`/api/v1/exports/${taskId}`);
    expect(done.status).toBe(200);
    return done.body;
  };

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createWp24App(db, { gatewayUrl: stack.gateway.url });
    // Hostile text in tenant data: a document title and a control justification of tst.
    await inOrg(db, 'tst', async (trx) => {
      const doc = await trx.selectFrom('document').select('id').where('deleted_at', 'is', null).orderBy('doc_code').limit(1).executeTakeFirstOrThrow();
      await trx.updateTable('document').set({ title: EVIL }).where('id', '=', doc.id).execute();
      const entry = await trx
        .selectFrom('applicability_entry')
        .select('id')
        .where('deleted_at', 'is', null)
        .where('is_applicable', '=', true)
        .orderBy('id')
        .limit(1)
        .executeTakeFirstOrThrow();
      await trx.updateTable('applicability_entry').set({ inclusion_justification: EVIL }).where('id', '=', entry.id).execute();
    });
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('exports the SoA as XLSX with every column; a hostile justification stays text', async () => {
    const rina = await as('rina', 'tst');
    const answer = await rina.get('/api/v1/ms/isms/applicability/export?format=xlsx');
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe(XLSX_TYPE);
    expect(String(answer.headers['content-disposition'])).toMatch(/^attachment; filename="ISMS-statement-of-applicability-2026-09-29\.xlsx"/);
    expect(answer.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(answer.headers['x-content-type-options']).toBe('nosniff');

    const sheet = await readSheet(answer.raw);
    expect(rowValues(sheet, 1)).toEqual([
      'ID', 'Title', 'Theme', 'Applicable', 'Justification', 'Status', 'Owner', 'Implementing document', 'Frequency', 'Last evidence', 'Freshness', 'Integrity',
    ]);
    const screen = await rina.get<Page<{ id: string; st: string; lastEvidence: string | null }>>('/api/v1/ms/isms/applicability?pageSize=200');
    expect(sheet.rowCount - 1).toBe(screen.body.total);
    const ids = [];
    for (let n = 2; n <= sheet.rowCount; n += 1) ids.push(sheet.getRow(n).getCell(1).value);
    expect(ids).toEqual(screen.body.items.map((r) => r.id));

    // The hostile justification is a string cell with a leading quote, never a formula.
    let hostile: ExcelJS.Cell | undefined;
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === 'string' && cell.value.includes('HYPERLINK')) hostile = cell;
    }));
    expect(hostile).toBeDefined();
    expect(hostile!.value).toBe(`'${EVIL}`);
    expect(hostile!.type).toBe(ExcelJS.ValueType.String);
    expect(hostile!.formula).toBeUndefined();

    // Last evidence is a typed date cell; status and applicability are words.
    const withEvidence = screen.body.items.findIndex((r) => r.lastEvidence !== null);
    expect(withEvidence).toBeGreaterThanOrEqual(0);
    const evidenceCell = sheet.getRow(withEvidence + 2).getCell(10);
    expect(evidenceCell.value).toBeInstanceOf(Date);
    expect((evidenceCell.value as Date).toISOString().slice(0, 10)).toBe(screen.body.items[withEvidence]!.lastEvidence);
    const statuses = new Set<unknown>();
    for (let n = 2; n <= sheet.rowCount; n += 1) statuses.add(sheet.getRow(n).getCell(6).value);
    expect(statuses.has('Implemented')).toBe(true);
    const applicable = new Set<unknown>();
    for (let n = 2; n <= sheet.rowCount; n += 1) applicable.add(sheet.getRow(n).getCell(4).value);
    expect([...applicable].sort()).toEqual(['No', 'Yes']);

    const audit = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ action: string; after_data: { type: string; format: string } }>`
        select action, after_data from audit_trail where action = 'export.downloaded' order by seq`.execute(trx)).rows,
    );
    expect(audit.at(-1)!.after_data).toMatchObject({ type: 'soa', format: 'xlsx' });
  });

  it('exports the document register (UI 1.6 columns) as XLSX and CSV; formulas are neutralised in both', async () => {
    const rina = await as('rina', 'tst');
    const xlsx = await rina.get('/api/v1/ms/isms/documents/export?format=xlsx');
    expect(xlsx.status).toBe(200);
    const sheet = await readSheet(xlsx.raw);
    expect(rowValues(sheet, 1)).toEqual(['ID', 'Title', 'Type', 'Version', 'Status', 'Approved', 'Next review', 'Owner', 'Shared', 'System']);
    const screen = await rina.get<Page<{ id: string; title: string }>>('/api/v1/ms/isms/documents?pageSize=200');
    expect(sheet.rowCount - 1).toBe(screen.body.total);
    const titleCell = sheet.getRow(2 + screen.body.items.findIndex((d) => d.title === EVIL)).getCell(2);
    expect(titleCell.value).toBe(`'${EVIL}`);
    expect(titleCell.type).toBe(ExcelJS.ValueType.String);
    expect(titleCell.formula).toBeUndefined();

    const csv = await rina.get('/api/v1/ms/isms/documents/export?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(String(csv.headers['content-disposition'])).toMatch(/document-register-2026-09-29\.csv/);
    const text = csv.raw.toString('utf8').replace(/^﻿/, '');
    expect(text.split('\r\n')[0]).toBe('ID,Title,Type,Version,Status,Approved,Next review,Owner,Shared,System');
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example/steal"",""click me"")"`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);

    // Indonesian headers on request.
    const id = await rina.call('GET', '/api/v1/ms/isms/documents/export?format=csv', undefined, { 'accept-language': 'id-ID,id;q=0.9,en;q=0.5' });
    expect(id.raw.toString('utf8').replace(/^﻿/, '').split('\r\n')[0]).toBe('ID,Judul,Jenis,Versi,Status,Disetujui,Tinjauan berikutnya,Pemilik,Dibagikan,Sistem');
  });

  it('respects ScopePolicy: a restricted document is missing for Top Management; Domain Owners may not export', async () => {
    const bagusId = await userId(db, 'bagus');
    const code = await inOrg(db, 'tst', async (trx) => {
      const doc = await trx.selectFrom('document').select(['id', 'doc_code']).where('deleted_at', 'is', null).orderBy('doc_code', 'desc').limit(1).executeTakeFirstOrThrow();
      await trx.updateTable('document').set({ classification: 'restricted', owner_user_id: bagusId }).where('id', '=', doc.id).execute();
      return doc.doc_code;
    });
    const codes = async (client: FilesClient) => {
      const sheet = await readSheet((await client.get('/api/v1/ms/isms/documents/export?format=xlsx')).raw);
      const out: unknown[] = [];
      for (let n = 2; n <= sheet.rowCount; n += 1) out.push(sheet.getRow(n).getCell(1).value);
      return out;
    };
    expect(await codes(await as('rina', 'tst'))).toContain(code);
    expect(await codes(await as('hendra', 'tst'))).not.toContain(code);
    expect((await (await as('bagus', 'tst')).get('/api/v1/ms/isms/documents/export?format=xlsx')).status).toBe(403);
    expect((await (await as('bagus', 'tst')).post('/api/v1/exports', { type: 'portfolio_board', format: 'pdf' })).status).toBe(403);
    expect((await (await as('rina', 'tst')).get('/api/v1/ms/isms/documents/export?format=pdf')).status).toBe(400);
  });

  it('builds the readiness report PDF, serves it to its creator only, audited, with an export_ready notification', async () => {
    const rina = await as('rina', 'tst');
    const task = await exportAndBuild(rina, 'tst', { type: 'readiness', ms: 'isms', format: 'pdf' });
    expect(task).toMatchObject({ status: 'succeeded', progress: 100, downloadUrl: `/api/v1/exports/${task.id}/download` });
    expect(task.result).toMatchObject({ type: 'readiness', format: 'pdf', fileName: 'ISMS-readiness-report-2026-09-29.pdf' });

    const file = await rina.get(task.downloadUrl!);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(String(file.headers['content-disposition'])).toMatch(/^attachment; filename="ISMS-readiness-report-2026-09-29\.pdf"/);
    expect(file.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await pageCount(file.raw)).toBeGreaterThanOrEqual(1);

    // Stored in the Managed Vault under exports/<taskId>/, kept 7 days.
    const stored = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ kind: string; format: string; folder_path: string; adapter: string; days: number }>`
        select f.kind, f.format, o.folder_path, r.adapter, round(extract(epoch from (f.expires_at - f.created_at)) / 86400)::int as days
        from export_file f join storage_object o on o.id = f.storage_object_id join storage_repository r on r.id = o.storage_repository_id
        where f.background_task_id = ${task.id}::uuid`.execute(trx)).rows,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'readiness', format: 'pdf', adapter: 'managed_vault', days: 7 });
    expect(stored[0]!.folder_path).toContain(`exports/${task.id}`);

    // Another user sees neither the task nor the file.
    const hendra = await as('hendra', 'tst');
    expect((await hendra.get(`/api/v1/exports/${task.id}`)).status).toBe(404);
    expect((await hendra.get(task.downloadUrl!)).status).toBe(404);

    const trail = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ action: string; actor_kind: string }>`
        select action, actor_kind from audit_trail where (entity_id = ${task.id}::uuid or after_data->>'taskId' = ${task.id}) order by seq`.execute(trx)).rows,
    );
    expect(trail.map((a) => a.action)).toEqual(['export.created', 'export.downloaded']);
    const notified = await inOrg(db, 'tst', (trx) =>
      trx.selectFrom('notification').select(['kind', 'title_en', 'digest']).where('kind', '=', 'export_ready').where(sql<string>`entity_ref->>'id'`, '=', task.id).execute(),
    );
    expect(notified).toEqual([{ kind: 'export_ready', title_en: 'Export ready: Readiness report', digest: false }]);

    // A second run of the job leaves the finished task alone.
    expect((await ctx.exportJob.build(ORG_IDS.tst, task.id)).status).toBe('skipped');
  });

  it('builds the portfolio board with one section per system where the requester holds export.run', async () => {
    const rina = await as('rina', 'ndt');
    const board = await exportAndBuild(rina, 'ndt', { type: 'portfolio_board', format: 'pdf' });
    const file = await rina.get(board.downloadUrl!);
    expect(file.status).toBe(200);
    expect(String(file.headers['content-disposition'])).toMatch(/ndt-portfolio-board-2026-09-29\.pdf/);
    expect(await pageCount(file.raw)).toBe(4);
    const text = file.raw.toString('latin1');
    expect(text).toContain('%PDF-');

    // Sari is MS Manager of qms only (Domain Owner elsewhere): one section.
    const sari = await as('sari', 'ndt');
    const hers = await exportAndBuild(sari, 'ndt', { type: 'portfolio_board', format: 'pdf' });
    expect(await pageCount((await sari.get(hers.downloadUrl!)).raw)).toBe(1);

    // portfolio_board takes no system; other types need one; formats follow the type.
    expect((await rina.post('/api/v1/exports', { type: 'portfolio_board', ms: 'isms', format: 'pdf' })).status).toBe(400);
    expect((await rina.post('/api/v1/exports', { type: 'readiness', format: 'pdf' })).status).toBe(400);
    expect((await rina.post('/api/v1/exports', { type: 'readiness', ms: 'isms', format: 'xlsx' })).status).toBe(400);
    expect((await rina.post('/api/v1/exports', { type: 'audit_trail', ms: 'isms', format: 'pdf' })).status).toBe(400);
  });

  it('exports the SoA and the audit trail through POST /exports; the audit trail needs audit_trail.read', async () => {
    const rina = await as('rina', 'tst');
    const soa = await exportAndBuild(rina, 'tst', { type: 'soa', ms: 'isms', format: 'csv' });
    const csv = await rina.get(soa.downloadUrl!);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.raw.toString('utf8').replace(/^﻿/, '').split('\r\n')[0]).toBe(
      'ID,Title,Theme,Applicable,Justification,Status,Owner,Implementing document,Frequency,Last evidence,Freshness,Integrity',
    );

    expect((await (await as('hendra', 'tst')).post('/api/v1/exports', { type: 'audit_trail', ms: 'isms', format: 'csv' })).status).toBe(403);
    const trail = await exportAndBuild(rina, 'tst', { type: 'audit_trail', ms: 'isms', format: 'csv' });
    const file = await rina.get(trail.downloadUrl!);
    expect(file.status).toBe(200);
    const lines = file.raw.toString('utf8').split('\r\n');
    expect(lines[0]).toMatch(/^seq,occurred_at,/);
    expect(lines.length).toBeGreaterThan(2);
  });

  it('checks the permission again in the job and at download; expired files are gone', async () => {
    const sari = await as('sari', 'ndt');
    const sariId = await userId(db, 'sari');
    const done = await exportAndBuild(sari, 'ndt', { type: 'soa', ms: 'qms', format: 'xlsx' });
    const pending = await sari.post<CommandResult>('/api/v1/exports', { type: 'document_register', ms: 'qms', format: 'xlsx' });
    expect(pending.status).toBe(202);

    const removed = await inOrg(db, 'ndt', async (trx) =>
      (await sql<{ id: string }>`
        update user_ms_role set deleted_at = now()
        where user_id = ${sariId}::uuid and role = 'ms_manager' and deleted_at is null
          and management_system_id = (select id from management_system where slug = 'qms')
        returning id`.execute(trx)).rows,
    );
    expect(removed.length).toBeGreaterThan(0);
    expect((await sari.get(done.downloadUrl!)).status).toBe(403);
    const failed = await ctx.exportJob.build(ORG_IDS.ndt, pending.body.taskId!);
    expect(failed.status).toBe('failed');
    const task = await sari.get<BackgroundTask>(`/api/v1/exports/${pending.body.taskId}`);
    expect(task.body).toMatchObject({ status: 'failed' });
    expect(task.body.error).toMatch(/no longer holds/);
    await inOrg(db, 'ndt', (trx) => trx.updateTable('user_ms_role').set({ deleted_at: null }).where('id', 'in', removed.map((r) => r.id)).execute());
    expect((await sari.get(done.downloadUrl!)).status).toBe(200);

    // After seven days the file is no longer served.
    await inOrg(db, 'ndt', (trx) => trx.updateTable('export_file').set({ expires_at: new Date(Date.now() - 1000) }).where('background_task_id', '=', done.id).execute());
    expect((await sari.get(done.downloadUrl!)).status).toBe(404);
    expect((await sari.get(`/api/v1/exports/${pending.body.taskId}/download`)).status).toBe(409);
  });
});
