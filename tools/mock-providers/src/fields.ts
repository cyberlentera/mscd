// Google APIs partial responses: the `fields` parameter selects what a response contains, for example
// `files(id,name,parents),nextPageToken` or `owners/emailAddress`. Without `fields`, Drive returns a small
// default set per method, so an adapter that forgets to ask for `sha256Checksum` does not get it.

export type FieldTree = Map<string, FieldTree | true>;

export class FieldsSyntaxError extends Error {}

const NAME = /[A-Za-z0-9_*@.$-]/;

export function parseFields(spec: string): FieldTree {
  let index = 0;

  const readName = (): string => {
    const start = index;
    while (index < spec.length && NAME.test(spec[index])) index += 1;
    if (index === start) throw new FieldsSyntaxError(`Invalid field selection at position ${start + 1}: ${spec}`);
    return spec.slice(start, index);
  };

  const skipSpaces = () => {
    while (index < spec.length && spec[index] === ' ') index += 1;
  };

  const parseList = (nested: boolean): FieldTree => {
    const tree: FieldTree = new Map();
    for (;;) {
      skipSpaces();
      const path = [readName()];
      while (spec[index] === '/') {
        index += 1;
        path.push(readName());
      }
      let sub: FieldTree | true = true;
      if (spec[index] === '(') {
        index += 1;
        sub = parseList(true);
        if (spec[index] !== ')') throw new FieldsSyntaxError(`Invalid field selection, missing ")": ${spec}`);
        index += 1;
      }
      insert(tree, path, sub);
      skipSpaces();
      if (spec[index] === ',') {
        index += 1;
        continue;
      }
      if (index === spec.length || (nested && spec[index] === ')')) return tree;
      throw new FieldsSyntaxError(`Invalid field selection at position ${index + 1}: ${spec}`);
    }
  };

  const tree = parseList(false);
  if (index !== spec.length) throw new FieldsSyntaxError(`Invalid field selection: ${spec}`);
  return tree;
}

function insert(tree: FieldTree, path: string[], leaf: FieldTree | true): void {
  let node = tree;
  path.forEach((name, i) => {
    const last = i === path.length - 1;
    const existing = node.get(name);
    if (last) {
      if (existing === true) return;
      if (leaf === true || existing === undefined) {
        node.set(name, leaf);
      } else {
        for (const [key, value] of leaf) insert(existing, [key], value);
      }
      return;
    }
    if (existing === true) return;
    const next: FieldTree = existing ?? new Map();
    node.set(name, next);
    node = next;
  });
}

export function applyFields(value: unknown, tree: FieldTree | true): unknown {
  if (tree === true) return value;
  if (Array.isArray(value)) return value.map((entry) => applyFields(entry, tree));
  if (typeof value !== 'object' || value === null) return value;
  const star = tree.get('*');
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const selected = tree.get(key) ?? star;
    if (selected !== undefined && entry !== undefined) result[key] = applyFields(entry, selected);
  }
  return result;
}

/** Applies `fields` when given, else the method's default selection. */
export function selectFields(value: unknown, fields: string | null, defaults: string): unknown {
  return applyFields(value, parseFields(fields && fields.trim() !== '' ? fields : defaults));
}
