// The review calendar feed (build plan D.3, PRD 9.1 Document Review Calendar): an iCalendar (RFC 5545) document with
// one all-day event per review date, for the overdue documents and those due within the next four months. Lines end
// with CRLF, text values are escaped, and lines longer than 75 octets are folded.
import { addDays } from '../../common/dates';

export interface CalendarDocument {
  code: string;
  title: string;
  /** Next review date, `YYYY-MM-DD`. */
  reviewAt: string;
  status: string;
  owner: string | null;
}

export interface CalendarInput {
  /** Stable part of the event ids: organisation and system. */
  uidPrefix: string;
  calendarName: string;
  today: string;
  now: Date;
  documents: readonly CalendarDocument[];
  language: 'en' | 'id';
}

/** The last date the feed covers: today plus four calendar months (PRD 9.1). */
export function feedHorizon(today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const month = m - 1 + 4;
  const year = y + Math.floor(month / 12);
  const monthIndex = month % 12;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Documents of the feed: overdue (review date before today) and due from today up to the horizon. */
export function feedDocuments<T extends { reviewAt: string }>(documents: readonly T[], today: string): T[] {
  const horizon = feedHorizon(today);
  return documents.filter((d) => d.reviewAt !== '' && d.reviewAt <= horizon);
}

/** RFC 5545 TEXT escaping. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds one content line at 75 octets (continuation lines start with a space), never inside a UTF-8 sequence. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    const limit = out.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      out.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function compactDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The calendar text. */
export function reviewCalendar(input: CalendarInput): string {
  const en = input.language === 'en';
  const byDate = new Map<string, CalendarDocument[]>();
  for (const doc of feedDocuments(input.documents, input.today)) {
    const list = byDate.get(doc.reviewAt) ?? [];
    list.push(doc);
    byDate.set(doc.reviewAt, list);
  }
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cyberlentera//MSCD//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(input.calendarName)}`,
  ];
  for (const date of [...byDate.keys()].sort()) {
    const docs = byDate.get(date)!.sort((a, b) => a.code.localeCompare(b.code));
    const overdue = date < input.today;
    const prefix = overdue ? (en ? 'Overdue review' : 'Tinjauan terlambat') : en ? 'Document review' : 'Tinjauan dokumen';
    const summary = docs.length === 1 ? `${prefix}: ${docs[0]!.code} ${docs[0]!.title}` : `${prefix}: ${docs.map((d) => d.code).join(', ')}`;
    const description = docs
      .map((d) => `${d.code} ${d.title}${d.owner ? ` (${en ? 'owner' : 'pemilik'} ${d.owner})` : ''}${d.status === 'expired' ? (en ? ', expired' : ', kedaluwarsa') : ''}`)
      .join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${input.uidPrefix}-review-${compactDate(date)}@mscd`,
      `DTSTAMP:${stamp(input.now)}`,
      `DTSTART;VALUE=DATE:${compactDate(date)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(date, 1))}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(description)}`,
      'TRANSP:TRANSPARENT',
      `CATEGORIES:${escapeText(en ? 'Document review' : 'Tinjauan dokumen')}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
