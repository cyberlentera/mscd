// Text and CSV decoding for pack datasets: UTF-8 without a byte order mark, LF line endings, RFC 4180 fields.
import { parse } from 'csv-parse/sync';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes a dataset file; throws an Error naming the encoding problem. */
export function decodeDatasetText(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('starts with a byte order mark');
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error('is not valid UTF-8');
  }
  if (text.includes('\r')) throw new Error('has carriage returns (LF line endings only)');
  return text;
}

export interface CsvRecord {
  /** Line where the record ends (1-based). */
  readonly line: number;
  readonly fields: string[];
}

/**
 * Parses CSV text (RFC 4180, LF record separator, double-quote quoting) into records with their line numbers. Empty
 * lines are records with one empty field, so a header check or a field count check reports them. Throws an Error
 * for a stray or unterminated quote.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const rows = parse(text, {
    info: true,
    delimiter: ',',
    record_delimiter: ['\n'],
    quote: '"',
    escape: '"',
    relax_column_count: true,
    relax_quotes: false,
    skip_empty_lines: false,
    trim: false,
    bom: false,
    cast: false,
  }) as unknown as { info: { lines: number }; record: string[] }[];
  return rows.map((row) => ({ line: row.info.lines, fields: row.record }));
}
