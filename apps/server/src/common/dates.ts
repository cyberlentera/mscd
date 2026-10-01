// Date helpers of the server (build plan D-07, A-22, G.5). Dates without time are local dates of the organisation,
// written `YYYY-MM-DD`; arithmetic on them is done in UTC so a daylight saving change never shifts a day. Instants
// are `Date` objects and are shown in the organisation time zone.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const MONTHS: Readonly<Record<'en' | 'id', readonly string[]>> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  id: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
};

/** True for a valid calendar date `YYYY-MM-DD`. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function utcMidnight(iso: string): number {
  if (!isIsoDate(iso)) throw new TypeError(`Not a date YYYY-MM-DD: ${JSON.stringify(iso)}`);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function isoOfUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The date `days` days after `iso` (negative for earlier). */
export function addDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new TypeError(`addDays: days must be an integer, got ${days}`);
  return isoOfUtc(utcMidnight(iso) + days * DAY_MS);
}

/** Whole days from `from` to `to` (positive when `to` is later), as the UI's `dd()` counts them (UI 1.19). */
export function diffDays(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

/** The local date of an instant in a time zone (IANA name), `YYYY-MM-DD`. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** G.5 `fmtDay`: `DD Mon YYYY` with a two-digit day (`02 Feb 2026`); `-` for an empty value. */
export function fmtDay(iso: string | null | undefined, lang: 'en' | 'id' = 'en'): string {
  if (!iso) return '-';
  const ms = utcMidnight(iso);
  const date = new Date(ms);
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[lang][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** G.5 `fmtDayTime`: `DD Mon YYYY HH:mm` in the organisation time zone; `-` for an empty value. */
export function fmtDayTime(instant: Date | string | null | undefined, timeZone: string, lang: 'en' | 'id' = 'en'): string {
  if (instant === null || instant === undefined || instant === '') return '-';
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new TypeError(`fmtDayTime: not an instant: ${String(instant)}`);
  const p = zonedParts(date, timeZone);
  return `${p.day} ${MONTHS[lang][Number(p.month) - 1]} ${p.year} ${p.hour}:${p.minute}`;
}

/** Midnight at the start of a local date in a time zone, as an instant. */
export function startOfLocalDay(iso: string, timeZone: string): Date {
  const midnightUtc = utcMidnight(iso);
  // The offset may differ across the day (daylight saving); two passes settle on the right instant.
  let guess = midnightUtc - offsetMs(new Date(midnightUtc), timeZone);
  guess = midnightUtc - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === '24' ? '00' : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of a time zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** True when `timeZone` is an IANA time zone this Node build knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}
