// List helpers of the per-screen read endpoints (build plan D.1 Lists, TS 9.1 "Filters and search as parameters").
import type { Page } from '@mscd/shared';

/**
 * Server search (`q`): every whitespace-separated word of the query occurs, case-insensitively, in the record's
 * searchable parts (code, title, owner name, note), the rule of the web's `match` (UI 2.5).
 */
export function matchesQuery(q: string, parts: readonly (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = parts.filter((p): p is string => !!p).join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** One page (1-based) of a list, `Page<T>` of D.2. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length };
}
