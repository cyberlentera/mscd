// A small flowing PDF writer for the export reports (portfolio board, readiness report), built on pdf-lib with the
// standard Helvetica fonts: headings, paragraphs, label and value lines, tables with a repeated header row, explicit
// page breaks and a footer with the page number on every page. Text the standard fonts cannot draw (outside
// WinAnsi) is replaced by `?`.
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait
const MARGIN = 42;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.82, 0.84, 0.87);
const SHADE = rgb(0.95, 0.96, 0.97);

/** Text the standard fonts can draw (WinAnsi): control characters become spaces, other characters `?`. */
export function pdfText(text: string): string {
  return (
    text
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/[^ -ÿ]/g, '?')
  );
}

export interface TableColumn {
  header: string;
  /** Share of the usable width (the shares of a table are scaled to fill it). */
  width: number;
  align?: 'left' | 'right';
}

export class PdfReport {
  private constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly footer: string,
  ) {}

  private page!: PDFPage;
  private y = 0;

  static async create(meta: { title: string; subject?: string; footer: string; createdAt: Date }): Promise<PdfReport> {
    const doc = await PDFDocument.create();
    doc.setTitle(pdfText(meta.title));
    if (meta.subject) doc.setSubject(pdfText(meta.subject));
    doc.setProducer('MSCD');
    doc.setCreator('MSCD');
    doc.setCreationDate(meta.createdAt);
    doc.setModificationDate(meta.createdAt);
    const report = new PdfReport(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), meta.footer);
    report.newPage();
    return report;
  }

  get usableWidth(): number {
    return PAGE.width - 2 * MARGIN;
  }

  /** Starts a new page (also used to begin a section on a page of its own). */
  newPage(): void {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  /** True when the current page has nothing on it yet. */
  get pageEmpty(): boolean {
    return this.y === PAGE.height - MARGIN;
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN + 24) this.newPage();
  }

  private fit(font: PDFFont, size: number, text: string, width: number): string {
    const safe = pdfText(text);
    if (font.widthOfTextAtSize(safe, size) <= width) return safe;
    let cut = safe;
    while (cut.length > 0 && font.widthOfTextAtSize(`${cut}...`, size) > width) cut = cut.slice(0, -1);
    return `${cut}...`;
  }

  /** Words of `text` broken into lines that fit `width`. */
  private wrap(font: PDFFont, size: number, text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of pdfText(text).split(/\n/)) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
        const next = line === '' ? word : `${line} ${word}`;
        if (font.widthOfTextAtSize(next, size) <= width) {
          line = next;
        } else {
          if (line !== '') lines.push(line);
          line = font.widthOfTextAtSize(word, size) <= width ? word : this.fit(font, size, word, width);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  title(text: string, subtitle?: string): void {
    this.ensure(48);
    this.page.drawText(this.fit(this.bold, 18, text, this.usableWidth), { x: MARGIN, y: this.y - 18, size: 18, font: this.bold, color: INK });
    this.y -= 26;
    if (subtitle) {
      for (const line of this.wrap(this.regular, 10, subtitle, this.usableWidth)) {
        this.page.drawText(line, { x: MARGIN, y: this.y - 10, size: 10, font: this.regular, color: MUTED });
        this.y -= 13;
      }
    }
    this.y -= 8;
  }

  heading(text: string): void {
    this.ensure(34);
    this.y -= 6;
    this.page.drawText(this.fit(this.bold, 12.5, text, this.usableWidth), { x: MARGIN, y: this.y - 12.5, size: 12.5, font: this.bold, color: INK });
    this.y -= 17;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE.width - MARGIN, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= 7;
  }

  paragraph(text: string, options: { muted?: boolean; size?: number } = {}): void {
    const size = options.size ?? 9.5;
    for (const line of this.wrap(this.regular, size, text, this.usableWidth)) {
      this.ensure(size + 3);
      this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font: this.regular, color: options.muted ? MUTED : INK });
      this.y -= size + 3;
    }
    this.y -= 4;
  }

  /** Label and value lines, the labels in a column of their own. */
  facts(rows: readonly (readonly [string, string])[]): void {
    const labelWidth = 150;
    for (const [label, value] of rows) {
      const lines = this.wrap(this.regular, 9.5, value === '' ? '-' : value, this.usableWidth - labelWidth);
      this.ensure(12.5 * lines.length);
      this.page.drawText(this.fit(this.bold, 9.5, label, labelWidth - 8), { x: MARGIN, y: this.y - 9.5, size: 9.5, font: this.bold, color: MUTED });
      for (const line of lines) {
        this.page.drawText(line, { x: MARGIN + labelWidth, y: this.y - 9.5, size: 9.5, font: this.regular, color: INK });
        this.y -= 12.5;
      }
    }
    this.y -= 6;
  }

  /** A table; cells are cut to their column, the header row repeats on every page; an empty table prints `empty`. */
  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[], empty = 'None'): void {
    const total = columns.reduce((sum, c) => sum + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.usableWidth);
    const size = 8.5;
    const rowHeight = 13;
    const header = () => {
      this.page.drawRectangle({ x: MARGIN, y: this.y - rowHeight + 3, width: this.usableWidth, height: rowHeight, color: SHADE });
      let x = MARGIN;
      columns.forEach((column, i) => {
        this.page.drawText(this.fit(this.bold, size, column.header, widths[i]! - 6), { x: x + 3, y: this.y - size, size, font: this.bold, color: MUTED });
        x += widths[i]!;
      });
      this.y -= rowHeight;
    };
    this.ensure(rowHeight * 2);
    header();
    if (rows.length === 0) {
      this.page.drawText(pdfText(empty), { x: MARGIN + 3, y: this.y - size, size, font: this.regular, color: MUTED });
      this.y -= rowHeight + 6;
      return;
    }
    for (const row of rows) {
      if (this.y - rowHeight < MARGIN + 24) {
        this.newPage();
        header();
      }
      let x = MARGIN;
      columns.forEach((column, i) => {
        const text = this.fit(this.regular, size, row[i] ?? '', widths[i]! - 6);
        const width = this.regular.widthOfTextAtSize(text, size);
        const left = column.align === 'right' ? x + widths[i]! - 3 - width : x + 3;
        this.page.drawText(text, { x: left, y: this.y - size, size, font: this.regular, color: INK });
        x += widths[i]!;
      });
      this.y -= rowHeight;
      this.page.drawLine({ start: { x: MARGIN, y: this.y + 2 }, end: { x: PAGE.width - MARGIN, y: this.y + 2 }, thickness: 0.3, color: RULE });
    }
    this.y -= 8;
  }

  /** Footer on every page, then the PDF bytes. */
  async finish(): Promise<Buffer> {
    const pages = this.doc.getPages();
    pages.forEach((page, i) => {
      const label = pdfText(`${this.footer}  |  Page ${i + 1} of ${pages.length}`);
      page.drawText(label, { x: MARGIN, y: MARGIN - 18, size: 7.5, font: this.regular, color: MUTED });
    });
    return Buffer.from(await this.doc.save());
  }
}
