// Spreadsheet formula neutralisation (build plan F.15). Every CSV and XLSX writer (exports, register exports, the
// audit trail CSV) passes cell values through these helpers: text that starts with `=`, `+`, `-`, `@`, a tab or a
// carriage return is prefixed with a single quote, so a spreadsheet never evaluates it; in XLSX it is also written
// as a string cell, never a formula. Numbers, booleans and dates stay typed cells.
import { stringify, type Stringifier } from 'csv-stringify';
import { stringify as stringifySync } from 'csv-stringify/sync';
import type { CellValue, Row, Worksheet } from 'exceljs';

const FORMULA_START = /^[=+\-@\t\r]/;

/** The text with a leading single quote when it would start a formula (F.15). */
export function neutraliseFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** A value as the text of one CSV cell: empty for null, ISO 8601 for dates, JSON for objects, formulas neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'string') return neutraliseFormula(value);
  return neutraliseFormula(JSON.stringify(value));
}

/** Options of a formula-safe CSV writer: header row, quoting per RFC 4180, every value through `csvCell`. */
function safeCsvOptions(columns?: readonly string[]) {
  return {
    header: columns !== undefined,
    columns: columns ? [...columns] : undefined,
    eof: true,
    record_delimiter: 'windows' as const,
    cast: {
      string: (value: string) => csvCell(value),
      number: (value: number) => csvCell(value),
      bigint: (value: bigint) => csvCell(value),
      boolean: (value: boolean) => csvCell(value),
      date: (value: Date) => csvCell(value),
      object: (value: object) => csvCell(value),
    },
  };
}

/** A streaming CSV writer whose header and cells are formula-safe; write arrays (or objects keyed by column). */
export function createSafeCsvStream(columns?: readonly string[]): Stringifier {
  const stringifier = stringify(safeCsvOptions(columns));
  return stringifier;
}

/** Formula-safe CSV text of rows (arrays of cell values), with an optional header row. */
export function toSafeCsv(rows: readonly (readonly unknown[])[], columns?: readonly string[]): string {
  // csv-stringify casts every value, header names included; undefined becomes an empty cell.
  return stringifySync(rows.map((row) => row.map((cell) => (cell === undefined ? null : cell))), safeCsvOptions(columns));
}

/** A value as an exceljs cell value: typed numbers, booleans and dates; text neutralised; never a formula. */
export function xlsxCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') return neutraliseFormula(value);
  // Objects (including exceljs formula objects such as {formula: ...}) are written as their JSON text.
  return neutraliseFormula(JSON.stringify(value));
}

/** Appends one row of formula-safe cells to a worksheet and returns it. */
export function addSafeRow(worksheet: Worksheet, values: readonly unknown[]): Row {
  return worksheet.addRow(values.map((value) => xlsxCellValue(value)));
}
