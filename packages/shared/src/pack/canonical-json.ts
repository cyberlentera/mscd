// Canonical JSON (D-15, E.8, F.11, D.5): object keys sorted recursively by UTF-16 code units, no whitespace, numbers
// and strings as JSON.stringify writes them. This is the form RFC 8785 describes for documents made of plain JSON
// values. Licences and audit anchors are signed over it; the gateway binds credentials to the SHA-256 of the
// canonical repository config.

/** Thrown for a value that has no JSON form (undefined at the top, functions, symbols, bigint, non-finite numbers). */
export class CanonicalJsonError extends TypeError {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || '(root)'}`);
    this.name = 'CanonicalJsonError';
  }
}

function serialise(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite number', path);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`Unsupported value of type ${typeof value}`, path);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError('Circular structure', path);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return '[' + obj.map((item, i) => (item === undefined ? 'null' : serialise(item, `${path}[${i}]`, seen))).join(',') + ']';
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError('Only plain objects and arrays are allowed', path);
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialise(record[k], path ? `${path}.${k}` : k, seen)).join(',') + '}';
  } finally {
    seen.delete(obj);
  }
}

/**
 * Canonical JSON text of a plain JSON value. Object members whose value is undefined are left out (as JSON.stringify
 * does); undefined array elements become null. Throws `CanonicalJsonError` for values without a JSON form.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new CanonicalJsonError('Undefined value', '');
  return serialise(value, '', new Set());
}

/** Canonical JSON of an object without the listed top-level members (for example `signature`). */
export function canonicalJsonWithout(value: Readonly<Record<string, unknown>>, omit: readonly string[]): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!omit.includes(k)) copy[k] = v;
  return canonicalJson(copy);
}
