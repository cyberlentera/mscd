// ETag and If-Match helpers (build plan D.1 Concurrency). A record's ETag is weak and derived from `updated_at`:
// `W/"<epoch milliseconds>"`. `If-Match` is optional on transitions and assignment; when present and stale the
// command answers 412 `precondition-failed`.
import type { RecordRef } from '@mscd/shared';
import { PreconditionFailedError } from './problems';

/** The weak ETag of a record version: `W/"<updated_at in epoch milliseconds>"`. */
export function etagOf(updatedAt: Date | string | number): string {
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : typeof updatedAt === 'number' ? updatedAt : new Date(updatedAt).getTime();
  if (!Number.isFinite(ms)) throw new TypeError(`etagOf: not a timestamp: ${String(updatedAt)}`);
  return `W/"${Math.trunc(ms)}"`;
}

/** Opaque part of an entity tag without the weak prefix and quotes (`W/"123"` and `"123"` give `123`). */
function opaque(tag: string): string {
  const trimmed = tag.trim().replace(/^W\//, '');
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Parses an `If-Match` header: `*`, or the list of entity tags. Undefined or empty gives null (no precondition).
 * Commas inside quoted tags are respected.
 */
export function parseIfMatch(header: string | string[] | undefined): '*' | string[] | null {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value === undefined || value.trim() === '') return null;
  if (value.trim() === '*') return '*';
  const tags: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      if (current.trim()) tags.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tags.push(current.trim());
  return tags;
}

/** True when the `If-Match` header allows a change of the record whose current version is `updatedAt` (weak comparison). */
export function ifMatchSatisfied(header: string | string[] | undefined, updatedAt: Date | string | number): boolean {
  const tags = parseIfMatch(header);
  if (tags === null || tags === '*') return true;
  const current = opaque(etagOf(updatedAt));
  return tags.some((tag) => opaque(tag) === current);
}

/** Throws 412 `precondition-failed` when `If-Match` is present and names another version (D.1). */
export function assertIfMatch(header: string | string[] | undefined, updatedAt: Date | string | number, ref?: RecordRef | string): void {
  if (!ifMatchSatisfied(header, updatedAt)) throw new PreconditionFailedError(ref);
}
