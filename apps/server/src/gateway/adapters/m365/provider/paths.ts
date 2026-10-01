// Folder paths, names and ids of the provider adapters (build plan D.5 root enforcement, WP-15). Paths are folder
// names from the drive root joined with `/` (`Compliance/ISMS/Evidence/2026/Q3`), as `ObjectMetadata.folderPath`
// reports them. Path segments are passed to the provider only through `encodeURIComponent`, and `.` and `..` are
// refused because URL parsers would resolve them before a request leaves.
import { badRequest } from '../../../problems';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters OneDrive and SharePoint refuse in names; Google Drive accepts them, but portable names avoid them. */
const NAME_FORBIDDEN = /["*:<>?/\\|]/;
export const MAX_NAME_LENGTH = 255;
export const MAX_PATH_DEPTH = 64;

/** Splits a folder path into names; empty segments (leading, trailing or double slashes) are ignored. */
export function pathSegments(path: string | null | undefined, what = 'folder path'): string[] {
  if (path === null || path === undefined) return [];
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    const segment = raw.trim();
    if (segment === '') continue;
    if (segment === '.' || segment === '..' || CONTROL.test(segment) || segment.includes('\\') || segment.length > MAX_NAME_LENGTH) {
      throw badRequest(`The ${what} is not valid: "${truncateName(raw)}" is not an allowed folder name`);
    }
    segments.push(segment);
  }
  if (segments.length > MAX_PATH_DEPTH) throw badRequest(`The ${what} is deeper than ${MAX_PATH_DEPTH} folders`);
  return segments;
}

/** A file or folder name the adapters create: no path separators, reserved characters, controls, `.` or `..`. */
export function checkItemName(name: string, what = 'file name'): string {
  const trimmed = name.trim();
  if (
    trimmed === '' ||
    trimmed !== name ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.') ||
    name.length > MAX_NAME_LENGTH ||
    CONTROL.test(name) ||
    NAME_FORBIDDEN.test(name)
  ) {
    throw badRequest(`The ${what} "${truncateName(name)}" is not valid: avoid " * : < > ? / \\ |, control characters and a leading, trailing or final dot or space`);
  }
  return name;
}

export function joinPath(segments: readonly string[]): string {
  return segments.join('/');
}

/** Path segments encoded for a URL path (`a%20b/c`). */
export function encodePath(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function sameName(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `path` starts with every segment of `prefix` (equal paths included). */
export function startsWithPath(path: readonly string[], prefix: readonly string[], caseInsensitive: boolean): boolean {
  if (path.length < prefix.length) return false;
  return prefix.every((segment, index) => sameName(segment, path[index]!, caseInsensitive));
}

export function samePath(a: readonly string[], b: readonly string[], caseInsensitive: boolean): boolean {
  return a.length === b.length && startsWithPath(a, b, caseInsensitive);
}

function truncateName(name: string): string {
  const printable = name.replace(new RegExp(CONTROL.source, 'g'), '?');
  return printable.length > 60 ? `${printable.slice(0, 57)}...` : printable;
}
