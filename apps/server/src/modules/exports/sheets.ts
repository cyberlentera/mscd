// The spreadsheet exports (build plan D.3, F.15): the Statement of Applicability and the document register, as XLSX
// (exceljs) or CSV. Every text cell goes through the formula-safe helpers of `common/spreadsheet-safe.ts`, so a title
// such as `=HYPERLINK(...)` stays text with a leading quote and is never a formula; dates are typed date cells in
// XLSX and `YYYY-MM-DD` text in CSV.
import ExcelJS from 'exceljs';
import { addSafeRow, toSafeCsv } from '../../common/spreadsheet-safe';

export type SheetFormat = 'xlsx' | 'csv';

/** One spreadsheet: a title for the sheet, its columns and rows (strings, numbers, booleans, ISO dates or null). */
export interface SheetData {
  sheetName: string;
  columns: readonly { header: string; width: number; date?: boolean }[];
  rows: readonly (readonly (string | number | boolean | null)[])[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` value as a UTC date (exceljs writes it as a date serial without a time zone shift). */
function dateCell(value: string | number | boolean | null): Date | string | number | boolean | null {
  return typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00.000Z`) : value;
}

/** The sheet as XLSX bytes: bold frozen header row, column widths, typed date cells. */
export async function sheetXlsx(sheet: SheetData, meta: { creator: string; created: Date }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.creator;
  workbook.created = meta.created;
  workbook.modified = meta.created;
  const worksheet = workbook.addWorksheet(sheet.sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  worksheet.columns = sheet.columns.map((c) => ({ width: c.width, ...(c.date ? { style: { numFmt: 'yyyy-mm-dd' } } : {}) }));
  const header = addSafeRow(worksheet, sheet.columns.map((c) => c.header));
  header.font = { bold: true };
  for (const row of sheet.rows) {
    addSafeRow(worksheet, row.map((value, i) => (sheet.columns[i]?.date ? dateCell(value) : value)));
  }
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The sheet as UTF-8 CSV (with a byte order mark, so spreadsheet programs read the text as UTF-8). */
export function sheetCsv(sheet: SheetData): Buffer {
  const text = toSafeCsv(sheet.rows, sheet.columns.map((c) => c.header));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

export async function sheetBytes(sheet: SheetData, format: SheetFormat, meta: { creator: string; created: Date }): Promise<Buffer> {
  return format === 'xlsx' ? sheetXlsx(sheet, meta) : sheetCsv(sheet);
}
