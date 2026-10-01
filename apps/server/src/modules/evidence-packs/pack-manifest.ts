// The two manifests of an evidence pack (build plan E.7 step 4, A-09, A-10, TS 5.6): a CSV with one row per evidence
// record of the pack, and a PDF with a cover (system, event, date), summary counts, the evidence table and the
// exceptions section. The CSV neutralises formulas (F.15); the PDF uses the standard Helvetica fonts of pdf-lib,
// so text outside Latin-1 is replaced.
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { toSafeCsv } from '../../common/spreadsheet-safe';

/** One manifest row (the CSV columns of E.7 step 4). */
export interface ManifestItem {
  evidenceCode: string;
  title: string;
  requirementCodes: string[];
  producedAt: string | null;
  externalVersionId: string | null;
  hashAlgorithm: string | null;
  hashValue: string | null;
  linkStatus: string | null;
  copyLocation: string | null;
  deleted: boolean;
  exceptionReason: string | null;
}

export interface ManifestCover {
  organisation: string;
  systemCode: string;
  systemName: string;
  edition: string | null;
  event: string | null;
  packLabel: string;
  packFolder: string;
  builtOn: string;
  cycleStart: string | null;
}

export const MANIFEST_CSV_COLUMNS = [
  'evidence_code',
  'requirement_codes',
  'produced_at',
  'external_version_id',
  'hash_algorithm',
  'hash_value',
  'link_status',
  'copy_location',
  'deleted',
  'exception_reason',
] as const;

/** The CSV manifest (UTF-8, header row, formula-safe cells). */
export function manifestCsv(items: readonly ManifestItem[]): Buffer {
  const rows = items.map((item) => [
    item.evidenceCode,
    item.requirementCodes.join(';'),
    item.producedAt ?? '',
    item.externalVersionId ?? '',
    item.hashAlgorithm ?? '',
    item.hashValue ?? '',
    item.linkStatus ?? '',
    item.copyLocation ?? '',
    item.deleted ? 'true' : 'false',
    item.exceptionReason ?? '',
  ]);
  return Buffer.from(toSafeCsv(rows, MANIFEST_CSV_COLUMNS), 'utf8');
}

// ---------------------------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------------------------

const PAGE = { width: 841.89, height: 595.28 }; // A4 landscape
const MARGIN = 40;
const LINE = 13;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.82, 0.84, 0.87);

/** Text the standard fonts can draw (WinAnsi): other characters become `?`. */
export function pdfSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^ -ÿ]/g, '?');
}

function fit(font: PDFFont, size: number, text: string, width: number): string {
  let value = pdfSafe(text);
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  while (value.length > 1 && font.widthOfTextAtSize(`${value}...`, size) > width) value = value.slice(0, -1);
  return `${value}...`;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;

  constructor(
    private readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    private readonly footer: string,
  ) {
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pageNo += 1;
    this.y = PAGE.height - MARGIN;
    this.page.drawText(fit(this.regular, 8, `${this.footer}   Page ${this.pageNo}`, PAGE.width - 2 * MARGIN), { x: MARGIN, y: MARGIN / 2, size: 8, font: this.regular, color: MUTED });
  }

  ensure(height: number): boolean {
    if (this.y - height >= MARGIN) return false;
    this.newPage();
    return true;
  }

  text(value: string, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {}): void {
    const size = options.size ?? 10;
    this.ensure(size + 4);
    const font = options.bold ? this.bold : this.regular;
    const x = options.x ?? MARGIN;
    this.page.drawText(fit(font, size, value, options.width ?? PAGE.width - x - MARGIN), { x, y: this.y - size, size, font, color: options.color ?? INK });
    this.y -= size + 4;
  }

  gap(h: number): void {
    this.y -= h;
  }

  rule(): void {
    this.ensure(4);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE.width - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 4;
  }
}

interface Column {
  title: string;
  width: number;
  value: (item: ManifestItem) => string;
}

function table(w: Writer, columns: readonly Column[], items: readonly ManifestItem[]): void {
  const header = () => {
    let x = MARGIN;
    for (const column of columns) {
      w.page.drawText(fit(w.bold, 8, column.title, column.width - 4), { x, y: w.y - 8, size: 8, font: w.bold, color: MUTED });
      x += column.width;
    }
    w.y -= LINE;
    w.rule();
  };
  w.ensure(LINE * 3);
  header();
  for (const item of items) {
    if (w.ensure(LINE)) header();
    let x = MARGIN;
    for (const column of columns) {
      w.page.drawText(fit(w.regular, 8, column.value(item), column.width - 4), { x, y: w.y - 8, size: 8, font: w.regular, color: INK });
      x += column.width;
    }
    w.y -= LINE;
  }
}

/** The PDF manifest. */
export async function manifestPdf(cover: ManifestCover, items: readonly ManifestItem[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Evidence pack ${cover.systemCode} ${cover.packLabel}`));
  doc.setSubject('MSCD evidence pack manifest');
  doc.setProducer('MSCD');
  doc.setCreator('MSCD');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold, `${cover.organisation} - ${cover.systemCode} evidence pack ${cover.packLabel}`);

  const copied = items.filter((i) => !i.exceptionReason).length;
  const exceptions = items.filter((i) => i.exceptionReason);
  const deleted = items.filter((i) => i.deleted).length;

  // Cover
  w.gap(60);
  w.text('Evidence pack manifest', { size: 22, bold: true });
  w.gap(8);
  w.text(`${cover.systemCode} - ${cover.systemName}`, { size: 14 });
  w.text(cover.organisation, { size: 12, color: MUTED });
  w.gap(16);
  const facts: [string, string][] = [
    ['Audit event', cover.event ?? 'None (built on demand)'],
    ['Pack', cover.packLabel],
    ['Built on', cover.builtOn],
    ['Edition', cover.edition ?? '-'],
    ['Certification cycle from', cover.cycleStart ?? '-'],
    ['Pack folder', cover.packFolder],
  ];
  for (const [label, value] of facts) {
    w.text(label, { size: 9, color: MUTED });
    w.text(value, { size: 11 });
    w.gap(2);
  }
  w.gap(10);
  w.text('Summary', { size: 13, bold: true });
  w.text(`Evidence records: ${items.length}`);
  w.text(`Copied into the pack: ${copied}`);
  w.text(`Exceptions: ${exceptions.length}`);
  w.text(`Deleted after the cycle start (flagged): ${deleted}`);

  // Evidence table
  w.newPage();
  w.text('Evidence', { size: 13, bold: true });
  w.gap(4);
  table(
    w,
    [
      { title: 'Evidence', width: 70, value: (i) => i.evidenceCode },
      { title: 'Requirements', width: 110, value: (i) => i.requirementCodes.join(', ') },
      { title: 'Produced', width: 60, value: (i) => i.producedAt ?? '-' },
      { title: 'Version', width: 50, value: (i) => i.externalVersionId ?? '-' },
      { title: 'Hash', width: 150, value: (i) => (i.hashValue ? `${i.hashAlgorithm ?? ''} ${i.hashValue}` : '-') },
      { title: 'Status', width: 80, value: (i) => `${i.linkStatus ?? 'system link'}${i.deleted ? ', deleted' : ''}` },
      { title: 'Copy', width: PAGE.width - 2 * MARGIN - 520, value: (i) => i.copyLocation ?? 'Not copied' },
    ],
    items,
  );

  // Exceptions
  w.gap(12);
  w.ensure(LINE * 4);
  w.text('Exceptions', { size: 13, bold: true });
  w.gap(4);
  if (exceptions.length === 0) {
    w.text('None: every evidence record of the pack was copied.');
  } else {
    table(
      w,
      [
        { title: 'Evidence', width: 70, value: (i) => i.evidenceCode },
        { title: 'Title', width: 230, value: (i) => i.title },
        { title: 'Status', width: 90, value: (i) => i.linkStatus ?? 'system link' },
        { title: 'Reason', width: PAGE.width - 2 * MARGIN - 390, value: (i) => i.exceptionReason ?? '' },
      ],
      exceptions,
    );
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
