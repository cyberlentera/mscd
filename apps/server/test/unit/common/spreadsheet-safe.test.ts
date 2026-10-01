// F.15: CSV and XLSX writers neutralise formulas. `=HYPERLINK("http://x")` and `@SUM(1)` round-trip through both
// formats as text with a leading single quote; numbers and dates stay typed.
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { addSafeRow, createSafeCsvStream, csvCell, neutraliseFormula, toSafeCsv, xlsxCellValue } from '../../../src/common/spreadsheet-safe';

const HYPERLINK = '=HYPERLINK("http://x")';
const SUM = '@SUM(1)';

describe('formula neutralisation (F.15)', () => {
  it('prefixes text that starts with = + - @ tab or carriage return', () => {
    for (const text of [HYPERLINK, SUM, '+1+2', '-3', '\tcmd', '\rcmd']) expect(neutraliseFormula(text)).toBe(`'${text}`);
    for (const text of ['Policy', 'A.5.23', ' =x', '', "'quoted"]) expect(neutraliseFormula(text)).toBe(text);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(new Date('2026-09-29T00:00:00Z'))).toBe('2026-09-29T00:00:00.000Z');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ formula: 'SUM(A1)' })).toBe('{"formula":"SUM(A1)"}');
  });

  it('round-trips through CSV as text', () => {
    const text = toSafeCsv([[HYPERLINK, SUM, 42, -7, true, null]], ['a', 'b', 'c', 'd', 'e', 'f']);
    const rows = parse(text, { columns: true }) as Record<string, string>[];
    expect(rows).toEqual([{ a: `'${HYPERLINK}`, b: `'${SUM}`, c: '42', d: '-7', e: 'true', f: '' }]);
  });

  it('streams formula-safe CSV', async () => {
    const stream = createSafeCsvStream(['title', 'count']);
    stream.write([HYPERLINK, 3]);
    stream.end();
    let text = '';
    for await (const chunk of stream) text += String(chunk);
    expect(parse(text, { columns: true })).toEqual([{ title: `'${HYPERLINK}`, count: '3' }]);
  });

  it('round-trips through XLSX as string cells, never formulas', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Export');
    const when = new Date('2026-09-29T00:00:00Z');
    addSafeRow(sheet, [HYPERLINK, SUM, 42, when, { formula: 'SUM(A1:A2)' }]);
    expect(xlsxCellValue(-1)).toBe(-1);
    const buffer = await workbook.xlsx.writeBuffer();
    const read = new ExcelJS.Workbook();
    await read.xlsx.load(buffer as ArrayBuffer);
    const row = read.getWorksheet('Export')!.getRow(1);
    expect(row.getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(1).value).toBe(`'${HYPERLINK}`);
    expect(row.getCell(2).value).toBe(`'${SUM}`);
    expect(row.getCell(3).type).toBe(ExcelJS.ValueType.Number);
    expect(row.getCell(4).type).toBe(ExcelJS.ValueType.Date);
    expect(row.getCell(5).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(5).value).toBe('{"formula":"SUM(A1:A2)"}');
    for (let i = 1; i <= 5; i += 1) expect(row.getCell(i).formula).toBeFalsy();
  });
});
