// Date helpers of the UI (UI 1.19), bound to one "today". The sample source binds them to the sample's TODAY_S and the
// API source to the organisation's local date from the server (D-07), so every screen counts days the same way.
// Dates are local `YYYY-MM-DD` strings; P() parses them as local midnight. Imports nothing, so Node can use it too.

const MON = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  id: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns the helpers bound to `today`:
 * TODAY_S (the date itself), P(s) (local Date of an IsoDate), iso(d) (IsoDate of a Date), dd(s) (whole days from
 * today, negative in the past), addD(s, n) (IsoDate n days after s) and fmt(s, l) ('29 Sep 2026', Indonesian month
 * names for l = 'id', '-' for an empty value).
 * @param {string} today IsoDate
 */
export function makeDates(today) {
  if (typeof today !== 'string' || !ISO_DATE.test(today) || Number.isNaN(new Date(today + 'T00:00:00').getTime())) {
    throw new TypeError('makeDates: today must be a date in the form YYYY-MM-DD, got ' + JSON.stringify(today));
  }
  const TODAY = new Date(today + 'T00:00:00');
  const P = (s) => new Date(s + 'T00:00:00');
  const dd = (s) => Math.round((P(s) - TODAY) / 864e5);
  // Local-date ISO string; toISOString() would shift the day in non-UTC timezones.
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addD = (s, n) => { const d = P(s); d.setDate(d.getDate() + n); return iso(d); };
  const fmt = (s, l) => { if (!s) return '-'; const d = P(s); return d.getDate() + ' ' + (MON[l] || MON.en)[d.getMonth()] + ' ' + d.getFullYear(); };
  return { TODAY_S: today, P, iso, dd, fmt, addD };
}
